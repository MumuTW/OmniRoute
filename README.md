# `automation` branch

This is an **orphan branch** — it shares no history with `main` or `release/*`, and
holds exactly one thing: the workflow that keeps this fork aligned with
[`cheaper-inference/OmniRoute`](https://github.com/cheaper-inference/OmniRoute)
(formerly `diegosouzapw/OmniRoute`).

## Why it is the default branch

GitHub schedules workflows **only from the repository's default branch**. Putting
`sync-fork.yml` on `main` or `release/vX.Y.Z` would add a commit those branches
don't have upstream, so they would immediately stop being fast-forwardable — which
defeats the entire purpose. Parking the workflow on a branch nothing else touches
keeps every real branch byte-identical to upstream.

## What the workflow does

Every 6 hours (and on manual dispatch) it walks upstream's `main` plus every
`release/vX.Y.Z` branch, and for each one:

- missing in the fork → creates it at upstream's SHA
- `behind` upstream → fast-forwards it via the `merge-upstream` API
- `identical` → leaves it alone
- `ahead` / `diverged` → **skips it** and warns; it never creates a merge commit

New upstream release branches are picked up automatically — no edit needed here
when upstream bumps to the next version.

## Token

Add a PAT with `repo` + `workflow` scope (or a fine-grained token with Contents
and Workflows read/write on this repo) as a repository secret named `SYNC_TOKEN`.
It is effectively required: `GITHUB_TOKEN` can never be granted the `workflows`
permission, so GitHub refuses any ref update that brings in `.github/workflows/**`
changes, and upstream `main` and `release/*` touch those files in almost every
batch. Without it the workflow falls back to `GITHUB_TOKEN`, and the run fails
with the API error for each branch it could not update.

## Local checkout

The workflow deliberately syncs **the remote only**. Fast-forwarding a local
checkout is left manual, because this repo is routinely worked by several parallel
sessions and worktrees; a background job running `git merge` in a shared checkout
would race them.

To bring a local branch up after a sync:

```bash
git fetch upstream --prune
git merge --ff-only upstream/release/vX.Y.Z
```
