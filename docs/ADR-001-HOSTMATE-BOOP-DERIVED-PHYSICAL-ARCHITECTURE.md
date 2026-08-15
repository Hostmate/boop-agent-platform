# ADR-001: Hostmate Boop-derived physical architecture

- Status: Accepted for Foundation; production rollout remains blocked
- Date: 2026-08-15
- Baseline: `raroque/boop-agent@31979130b1371acd9defbea115279a06c63c1fb4`
- Fork: `Hostmate/boop-agent-platform`

## Context

The compatibility spike proved custom-JWT Convex isolation, native Hostmate UI integration and a real OpenRouter streaming/tool loop together. The logical architecture remains the one defined in Hostmate's `docs/AI_AGENT_ARCHITECTURE.md`: a lightweight Interaction Agent coordinates ephemeral Execution Agent Runs on one generic runtime; Profiles, Skills, scoped Tools and Policy provide specialization and authority.

## Decision

Hostmate will use a recognizable Boop-derived Core behind explicit adapters:

- Convex is canonical only for agent-owned operational state: conversations, messages, interaction/execution runs, attempts, events, usage, memory and realtime projections.
- MySQL/Prisma is canonical for users, tenants, permissions, policies, profile/tool/skill governance, Signed Drafts, idempotency, automations governance and every Real Estate domain entity.
- The Express API creates `ActorContext`, issues short-lived RS256 Convex identity and authorizes all sensitive commands.
- OpenRouter is an adapter behind the Boop runtime contract. Models come from RuntimeConfig/profile policy; no domain handler contains a model ID.
- The React control plane is mounted natively at `/ai-platform`; no iframe or second application shell is used.
- Memory and Automations remain retained Boop features but are disabled until their privacy and durable-scheduler gates pass.

## Authority map

| Concern | Canonical store/authority | Convex content allowed |
| --- | --- | --- |
| Tenant, user, role, permissions | Hostmate auth + MySQL | signed claim refs only |
| Leads, properties, demands, visits, tasks, opportunities | MySQL + existing Domain Services | entity refs, no entity snapshots |
| Profiles, Tool/Skill Registry, policy and feature flags | reviewed code + MySQL governance | immutable version/hash refs |
| Conversations, runs, attempts, events, usage | Convex | canonical operational records |
| Signed Draft payload, approval, idempotency and commit result | MySQL | status/summary/hash projection only |
| Automation definition, ownership and policy | MySQL | run state/history projection |
| Memory and embeddings | Convex | scoped agent memory; never product truth |

There is no generic dual-write transaction. A projection is rebuilt from canonical state and never grants authority back to the caller.

## Code boundaries

| Boundary | Current location | Rule |
| --- | --- | --- |
| Upstream Boop Core | existing `server/`, `convex/`, `debug/` | keep recognizable; characterize before edits |
| Hostmate adapters | `server/hostmate/control-plane`, `server/hostmate/runtime`, `convex/agentPlatform*` | implement ports, auth and provider boundaries |
| Hostmate product extensions | `server/hostmate/profiles`, `skills`, `tools`, `policy`, `drafts` | may depend on Core contracts; Core never imports Real Estate services |
| Hostmate product UI | main app `features/agent-platform` and `/ai-platform` routes | native layout, permissions and design tokens |

## Foundation acceptance

This phase accepts contracts, tenant-first Convex schema/functions, lifecycle semantics, OpenRouter adapter, registries, Signed Draft state machine, Overview/Executions UI and characterization tests. It does not accept production deployment or real domain writes.

## Production gates

Managed issuer/JWKS and rotation, load/chaos tests, a separate worker, durable cancellation reconciliation, canonical MySQL draft persistence, security-baseline remediation, model capability tests and one read-only CRM vertical slice remain mandatory.
