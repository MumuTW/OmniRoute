/**
 * resolveComboTargetPipeline — the target-resolution phase of handleComboChat (combo.ts).
 *
 * Sits between the dispatch prelude (pinned model / fusion / chaos / pipeline / nested
 * execute-mode / round-robin) and the attempt loop. It turns the raw combo definition
 * into the final `orderedTargets` array the attempt loop iterates, in this order:
 *
 *   1. provider-wildcard expansion of the combo + the combos collection (#2562)
 *   2. weighted step-group resolution + sticky-weighted eligibility
 *   3. request-tag routing
 *   4. known-context-overflow early return
 *   5. smart/pipeline-enabled dispatch (auto strategy)
 *   6. auto-strategy candidate build / scoring / ordering, or per-strategy ordering
 *   7. prompt-cache strategy affinity, session stickiness, eval scores,
 *      request compatibility, context requirements
 *   8. task-aware reordering
 *   9. prompt-cache affinity application
 *  10. the parallel pre-screen (priority strategy only)
 *
 * Behaviour is byte-identical to the inline block it replaces — the two early exits
 * (context overflow, pipeline dispatch, auto-strategy `earlyResponse`) become an
 * `{ earlyResponse }` result so the host decides to return them, and the values the
 * attempt loop still consumes (`orderedTargets`, `stickyWeightedLimit`,
 * `getWeightedStepKeyForTarget`, `sticky`, `preScreenMap`) are returned instead of
 * closed over.
 *
 * See _tasks/quality/2026-06-19-DESIGN-godfiles-decomposition.md §4.
 */
import { isModelLocked } from "../accountFallback.ts";
import { parseAutoPrefix } from "../autoCombo/autoPrefix.ts";
import { handlePipelineCombo, buildPipelineResponse } from "../autoCombo/pipelineRouter.ts";
import type { resolveComboSetupConfig } from "../comboConfig.ts";
import { orderTargetsByEvalScores } from "../evalRouting.ts";
import { parseModel } from "../model.ts";
import { isProviderInCooldown } from "../providerCooldownTracker.ts";
import {
  classifyTask,
  getConversationCacheKey,
  isTaskRoutingStrategy,
  reorderByTaskWeight,
} from "../taskAwareRouting.ts";
import { errorResponseWithComboDiagnostics } from "../../utils/error.ts";
import { getCircuitBreaker } from "../../../src/shared/utils/circuitBreaker";
import type { ResilienceSettings } from "../../../src/lib/resilience/settings";
import { applyStrategyOrdering } from "./applyStrategyOrdering.ts";
import { clampComboDepth } from "./comboPredicates.ts";
import {
  filterTargetsByRequestCompatibility,
  resolveComboTargets,
  resolveWeightedStepGroups,
  resolveWeightedTargets,
} from "./comboStructure.ts";
import { applyContextRequirements } from "./contextRequirements.ts";
import { getKnownContextOverflow } from "./knownContextOverflow.ts";
import {
  applyPromptCacheAffinity,
  expandPromptCacheAffinityTargets,
  resolvePromptCacheAffinityKey,
  shouldProtectOriginalFirst,
} from "./promptCacheAffinity.ts";
import {
  expandProviderWildcardsInCombo,
  expandProviderWildcardsInCollection,
} from "./providerWildcard.ts";
import { preScreenTargets, type PreScreenResult } from "./quotaStrategies.ts";
import { resolveAutoStrategyOrder, type ResolveAutoStrategyDeps } from "./resolveAutoStrategy.ts";
import {
  MAX_RR_COUNTERS,
  clampStickyWeightedTargetLimit,
  getStickyWeightedExecutionKey,
  weightedStickyTargets,
} from "./rrState.ts";
import {
  applySessionStickiness,
  normalizeStickinessMessages,
  resolveDisableSessionStickiness,
  type ApplyStickinessResult,
} from "./sessionStickiness.ts";
import { applyRequestTagRouting } from "./autoStrategy.ts";
import type {
  ComboCollectionLike,
  ComboLike,
  ComboLogger,
  ComboRelayOptions,
  ComboRuntimeStep,
  HandleSingleModel,
  IsModelAvailable,
  ResolvedComboTarget,
} from "./types.ts";

export interface ResolveComboTargetPipelineDeps {
  body: Record<string, unknown>;
  combo: ComboLike;
  strategy: string;
  config: ReturnType<typeof resolveComboSetupConfig>;
  settings?: Record<string, unknown> | null;
  allCombos?: ComboCollectionLike;
  relayOptions?: ComboRelayOptions | null;
  signal?: AbortSignal | null;
  apiKeyAllowedConnections: string[] | null;
  log: ComboLogger;
  resilienceSettings: ResilienceSettings;
  isModelAvailable?: IsModelAvailable;
  /** handleSingleModel already wrapped by buildTargetTimeoutRunner. */
  handleSingleModelWithTimeout: HandleSingleModel;
  /**
   * Dependency-injected `buildAutoCandidates` — it lives in `combo.ts` (the host of
   * this leaf), so importing it directly would create an import cycle.
   */
  buildAutoCandidates: ResolveAutoStrategyDeps["buildAutoCandidates"];
}

export interface ResolvedComboTargetPipeline {
  orderedTargets: ResolvedComboTarget[];
  /** Sticky-weighted target limit — the attempt loop records sticky success with it. */
  stickyWeightedLimit: number;
  /** Maps an attempted target back to its weighted step key (sticky-weighted write-back). */
  getWeightedStepKeyForTarget: (target: ResolvedComboTarget) => string | null;
  /** Session-stickiness result — the attempt loop reads `.messageHash` on success/failure. */
  sticky: ApplyStickinessResult;
  preScreenMap: Map<string, PreScreenResult>;
}

export type ResolveComboTargetPipelineResult =
  { earlyResponse: Response } | ResolvedComboTargetPipeline;

export async function resolveComboTargetPipeline(
  deps: ResolveComboTargetPipelineDeps
): Promise<ResolveComboTargetPipelineResult> {
  const {
    body,
    combo,
    strategy,
    config,
    settings,
    allCombos,
    relayOptions,
    signal,
    apiKeyAllowedConnections,
    log,
    resilienceSettings,
    isModelAvailable,
    handleSingleModelWithTimeout,
    buildAutoCandidates,
  } = deps;

  const isTargetSelectableForWeighted = async (target: ResolvedComboTarget): Promise<boolean> => {
    const rawModel = parseModel(target.modelStr).model || target.modelStr;
    if (target.provider && getCircuitBreaker(target.provider).getStatus().state === "OPEN")
      return false;
    if (
      resilienceSettings.providerCooldown.enabled &&
      Boolean(target.provider && target.provider !== "unknown") &&
      isProviderInCooldown(target.provider, target.connectionId ?? undefined, resilienceSettings)
    ) {
      return false;
    }
    if (
      target.provider &&
      rawModel &&
      isModelLocked(target.provider, target.connectionId || "", rawModel)
    ) {
      return false;
    }
    return isModelAvailable ? await isModelAvailable(target.modelStr, target) : true;
  };

  // #2562: Expand provider-wildcard steps (e.g. `fta/*`, `openai/gpt-4*`) into
  // concrete model entries sourced from the live synced-models catalog + registry.
  // Must run before any step-group / target resolution so that wildcard-originated
  // steps are treated identically to hand-authored entries by all downstream logic
  // (including the sticky-weighted eligibility pass below).
  const expandedCombo = await expandProviderWildcardsInCombo(combo);
  const expandedAllCombos = allCombos
    ? Array.isArray(allCombos)
      ? await expandProviderWildcardsInCollection(allCombos as ComboLike[])
      : {
          ...allCombos,
          combos: await expandProviderWildcardsInCollection(
            ((allCombos as { combos?: ComboLike[] }).combos || []) as ComboLike[]
          ),
        }
    : allCombos;

  const stickyWeightedLimit = clampStickyWeightedTargetLimit(
    (config as Record<string, unknown>).stickyWeightedLimit
  );
  if (
    strategy === "weighted" &&
    !weightedStickyTargets.has(combo.name) &&
    weightedStickyTargets.size >= MAX_RR_COUNTERS
  ) {
    const oldest = weightedStickyTargets.keys().next().value;
    if (oldest !== undefined) weightedStickyTargets.delete(oldest);
  }
  let stepGroups: Array<{ step: ComboRuntimeStep; targets: ResolvedComboTarget[] }> | undefined;
  const weightedEligibleKeys = new Set<string>();
  if (strategy === "weighted") {
    stepGroups = resolveWeightedStepGroups(expandedCombo, expandedAllCombos);
    for (const group of stepGroups) {
      const availability = await Promise.all(group.targets.map(isTargetSelectableForWeighted));
      if (availability.some(Boolean)) weightedEligibleKeys.add(group.step.executionKey);
    }
  }
  const rawStickyWeightedKey =
    strategy === "weighted" ? getStickyWeightedExecutionKey(combo.name, stickyWeightedLimit) : null;
  const stickyWeightedKey =
    rawStickyWeightedKey && weightedEligibleKeys.has(rawStickyWeightedKey)
      ? rawStickyWeightedKey
      : null;
  if (strategy !== "weighted" || stickyWeightedLimit <= 1) {
    weightedStickyTargets.delete(combo.name);
  } else if (rawStickyWeightedKey && !stickyWeightedKey) {
    weightedStickyTargets.delete(combo.name);
  }
  const weightedResolution =
    strategy === "weighted"
      ? resolveWeightedTargets(
          expandedCombo,
          expandedAllCombos,
          stickyWeightedKey,
          weightedEligibleKeys,
          stepGroups
        )
      : null;
  const getWeightedStepKeyForTarget = (target: ResolvedComboTarget): string | null => {
    if (!weightedResolution?.orderedSteps) return null;
    const step = weightedResolution.orderedSteps.find(
      (entry) =>
        target.executionKey === entry.executionKey ||
        target.executionKey.startsWith(entry.executionKey + ">")
    );
    return step?.executionKey || null;
  };
  let orderedTargets =
    strategy === "weighted"
      ? weightedResolution?.orderedTargets || []
      : resolveComboTargets(
          expandedCombo,
          expandedAllCombos,
          clampComboDepth(config.maxComboDepth)
        );

  orderedTargets = await applyRequestTagRouting(orderedTargets, body, log);

  const knownContextOverflow = getKnownContextOverflow(orderedTargets, body);
  if (knownContextOverflow) {
    const { requiredContextTokens, maxKnownContextTokens } = knownContextOverflow;
    log.warn(
      "COMBO",
      `Request context exceeds every known target limit (${requiredContextTokens} > ${maxKnownContextTokens} tokens)`
    );
    return {
      earlyResponse: errorResponseWithComboDiagnostics(
        400,
        `Request requires approximately ${requiredContextTokens} tokens, but the largest known context limit in this combo is ${maxKnownContextTokens} tokens. Reduce or compact the request context.`,
        {
          poolSize: orderedTargets.length,
          attempted: 0,
          excluded: orderedTargets.map((target) => ({
            provider: target.provider,
            model: target.modelStr,
            reason: "context_window",
          })),
          attemptOrder: [],
          terminalReason: "context_length_exceeded",
        },
        { code: "context_length_exceeded", type: "invalid_request_error" }
      ),
    };
  }

  if (strategy === "weighted") {
    log.info(
      "COMBO",
      `Weighted selection${stickyWeightedKey ? " (sticky)" : ""}${allCombos ? " with nested resolution" : ""}: ${orderedTargets.length} total targets`
    );
  } else if (allCombos) {
    log.info("COMBO", `${strategy} with nested resolution: ${orderedTargets.length} total targets`);
  }

  // Pipeline dispatch: route smart/pipeline-enabled combos through the multi-stage pipeline
  if (strategy === "auto") {
    const autoParsed = parseAutoPrefix(combo.name);
    const autoVariant = autoParsed.valid ? autoParsed.variant : undefined;
    if (autoVariant === "smart" || config.pipeline_enabled) {
      try {
        const pipelineRaw = await handlePipelineCombo({
          body,
          combo,
          handleChatCore: handleSingleModelWithTimeout,
          log: {
            info: log.info,
            warn: log.warn,
            error: log.error ?? log.warn,
          },
          settings: settings ?? {},
          signal: signal ?? undefined,
        });
        // handlePipelineCombo resolves to a PipelineResult (buffered text) or,
        // in the streaming-final-stage case, a Response. Callers downstream
        // (chat.ts → withSessionHeader) require a Response, so adapt the
        // PipelineResult here instead of leaking the raw object.
        return {
          earlyResponse:
            pipelineRaw instanceof Response
              ? pipelineRaw
              : buildPipelineResponse(pipelineRaw, body),
        };
      } catch (pipelineErr) {
        const pipelineMsg = pipelineErr instanceof Error ? pipelineErr.message : "";
        if (pipelineMsg === "PIPELINE_DISABLED") {
          log.info("COMBO", "Pipeline disabled, falling through to standard auto routing");
        } else if (pipelineMsg === "PIPELINE_TOKEN_THRESHOLD") {
          log.info(
            "COMBO",
            "Pipeline skipped (prompt below token threshold), falling through to standard auto routing"
          );
        } else {
          log.warn("COMBO", "Pipeline dispatch failed, falling through to standard auto routing", {
            err: pipelineErr,
          });
        }
      }
    }
  }

  // #4945 regression guard: when an "auto" combo uses an EXPLICIT router
  // (routingStrategy lkgp/cost/etc, not the default "rules" scorer), that router
  // pins orderedTargets[0]. The task-aware reordering below must then refine only
  // the fallback order, never override the router's primary choice.
  let autoUsedExplicitRouter = false;
  if (strategy === "auto") {
    const autoResult = await resolveAutoStrategyOrder({
      orderedTargets,
      body,
      combo,
      settings,
      config,
      relayOptions,
      resilienceSettings,
      log,
      buildAutoCandidates,
    });
    if ("earlyResponse" in autoResult) return { earlyResponse: autoResult.earlyResponse };
    orderedTargets = autoResult.orderedTargets;
    autoUsedExplicitRouter = autoResult.autoUsedExplicitRouter;
  } else {
    orderedTargets = await applyStrategyOrdering(strategy, orderedTargets, {
      combo,
      config,
      body,
      log,
      apiKeyAllowedConnections,
    });
  }
  // An explicit cache-optimized combo outranks the global cache-affinity default,
  // but only protects its ordering when this request actually produced a reusable
  // cache key. Cache misses retain the normal session/eval routing behavior.
  const cacheStrategyAffinityApplied =
    strategy === "cache-optimized" && applyPromptCacheAffinity(orderedTargets, body).applied;
  // #6168: session stickiness opt-out. Per-combo `config.disableSessionStickiness`
  // overrides the global `settings.disableSessionStickiness` fallback (default false,
  // preserving the #3825 prompt-cache/504 fix). When disabled, skip the reorder and
  // treat the result as a no-op so the recordStickyBinding write-back below is skipped.
  const disableSessionStickiness =
    cacheStrategyAffinityApplied ||
    resolveDisableSessionStickiness(
      config as Record<string, unknown> | null | undefined,
      settings as Record<string, unknown> | null | undefined
    );
  const _sticky = disableSessionStickiness
    ? ({ targets: orderedTargets, messageHash: null, stuck: false } as const)
    : await applySessionStickiness(
        orderedTargets,
        // #7270: normalize both wire shapes (.messages / Responses-API .input) so the
        // stickiness key is derivable on the /v1/responses surface, not just Chat Completions.
        normalizeStickinessMessages(body as { messages?: unknown; input?: unknown })
      );
  orderedTargets = _sticky.targets;
  if (!cacheStrategyAffinityApplied) {
    orderedTargets = orderTargetsByEvalScores(orderedTargets, config.evalRouting, log);
  }
  orderedTargets = filterTargetsByRequestCompatibility(orderedTargets, body, log);
  orderedTargets = applyContextRequirements(orderedTargets, config.contextRequirements, log);

  // Task-aware reordering: only active for strategies ["smart","task","task-aware","task_aware","auto"].
  // Additive — does not affect any of the other 15 strategies.
  if (isTaskRoutingStrategy(strategy)) {
    const task = classifyTask(body);
    const conversationCacheKey = getConversationCacheKey(body);
    const taskReordered = reorderByTaskWeight(orderedTargets, task);
    // #4945 regression guard: when an explicit auto router (lkgp/cost/…) pinned
    // orderedTargets[0], keep that primary choice and let task-aware refine only
    // the fallback tail — otherwise task weighting silently defeats the operator's
    // chosen LKGP/cost selection. reorderByTaskWeight returns the same target
    // objects (no clone), so identity filtering is safe.
    const pinnedFirst = autoUsedExplicitRouter ? orderedTargets[0] : undefined;
    const nextOrder = pinnedFirst
      ? [pinnedFirst, ...taskReordered.filter((t) => t !== pinnedFirst)]
      : taskReordered;
    if (nextOrder[0]?.modelStr !== orderedTargets[0]?.modelStr) {
      const reasons =
        Array.isArray(task.reasons) && task.reasons.length > 0
          ? ` (${task.reasons.join(",")})`
          : "";
      log.info(
        "COMBO",
        `task-route task=${task.level}${reasons} cacheKey=${conversationCacheKey ?? "none"} → ${nextOrder[0]?.modelStr}`
      );
    }
    orderedTargets = nextOrder;
  }

  // Prompt-cache locality is applied after request eligibility and task routing.
  // Session stickiness and explicit auto-router pins remain stronger continuity
  // decisions; quota, health, and circuit-breaker gates still run per attempt.
  const autoConfigForCacheWeight =
    strategy === "auto"
      ? ((combo.autoConfig ||
          ((config as Record<string, unknown>).auto &&
          typeof (config as Record<string, unknown>).auto === "object"
            ? (config as Record<string, unknown>).auto
            : null) ||
          config) as Record<string, unknown>)
      : null;
  const autoWeightsForCache =
    autoConfigForCacheWeight?.weights && typeof autoConfigForCacheWeight.weights === "object"
      ? (autoConfigForCacheWeight.weights as Record<string, unknown>)
      : null;
  const autoUsesCacheScore = Number(autoWeightsForCache?.cacheAffinity) > 0;
  const promptCacheAffinityEnabled =
    settings?.promptCacheAffinityEnabled !== false && !autoUsesCacheScore;
  const promptCacheAffinityTargets =
    promptCacheAffinityEnabled && resolvePromptCacheAffinityKey(body)
      ? await expandPromptCacheAffinityTargets(orderedTargets)
      : orderedTargets;
  const promptCacheAffinity = applyPromptCacheAffinity(
    promptCacheAffinityTargets,
    body,
    promptCacheAffinityEnabled
  );
  if (promptCacheAffinity.applied) {
    const protectedOriginal =
      shouldProtectOriginalFirst(_sticky.stuck, autoUsedExplicitRouter, strategy) &&
      orderedTargets[0];
    const protectedFirst = protectedOriginal
      ? (promptCacheAffinity.targets.find(
          (target) =>
            target === protectedOriginal ||
            target.executionKey === protectedOriginal.executionKey ||
            target.executionKey.startsWith(`${protectedOriginal.executionKey}@`)
        ) ?? protectedOriginal)
      : null;
    orderedTargets = protectedFirst
      ? [
          protectedFirst,
          ...promptCacheAffinity.targets.filter((target) => target !== protectedFirst),
        ]
      : promptCacheAffinity.targets;
    log.debug?.("COMBO", "Prompt-cache affinity applied", {
      source: promptCacheAffinity.source,
      fingerprint: promptCacheAffinity.fingerprint,
      targetCount: orderedTargets.length,
    });
  }

  // Parallel pre-screen: check provider profiles and model availability for all targets
  // Only runs for priority strategy where sequential checking causes latency
  const preScreenMap =
    strategy === "priority"
      ? await preScreenTargets(orderedTargets, isModelAvailable).catch(
          () => new Map<string, PreScreenResult>()
        )
      : new Map<string, PreScreenResult>();

  return {
    orderedTargets,
    stickyWeightedLimit,
    getWeightedStepKeyForTarget,
    sticky: _sticky,
    preScreenMap,
  };
}
