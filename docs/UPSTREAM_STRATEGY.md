# Upstream strategy

## Remotes and baseline

- `origin`: `https://github.com/Hostmate/boop-agent-platform.git`
- `upstream`: `https://github.com/raroque/boop-agent.git`
- audited baseline: `31979130b1371acd9defbea115279a06c63c1fb4`
- license: upstream MIT notice remains in `LICENSE`

## Downstream delta budget

The target remains fewer than 15 directly modified upstream Core files. Foundation currently changes one existing Core file, `convex/schema.ts`; all other runtime/product work is additive under `server/hostmate`, `convex/agentPlatform*`, tests and docs. The Hostmate UI lives in the Hostmate application repository.

## Classification

- Upstream Boop Core: pre-existing runtime loops, provider contracts, RuntimeTool primitive, memory algorithms, automations model and dashboard components.
- Direct Hostmate Core patch: a minimal existing-file edit that cannot be expressed as an adapter, currently the additive Convex schema tables.
- Hostmate adapter: provider, persistence, auth, realtime or lifecycle integration implementing a Core port.
- Hostmate product extension: Profiles, Skills, Product Tools, Policy, Signed Drafts and Real Estate UI/handlers.

## Sync procedure

1. Fetch `upstream` and inspect commits since the recorded merge base.
2. Classify changes by runtime contracts, control plane, UI, dependencies and local-only features.
3. Create a rollback commit before merge/rebase work.
4. Merge upstream into a dedicated `codex/upstream-sync-*` branch.
5. Resolve Core conflicts without moving Hostmate logic into upstream files.
6. Run typecheck, full tests, debug build, Convex schema checks and Hostmate adapter tests.
7. Record changed Core-file count and unresolved behavior changes in the PR.

Sync monthly or for a relevant release. If repeated conflicts exceed 15 Core files or two engineering days per release, switch to selected upstream cherry-picks while preserving attribution and tests.
