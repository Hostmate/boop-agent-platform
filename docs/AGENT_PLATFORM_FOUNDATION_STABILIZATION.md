# Agent Platform Foundation Stabilization

Date: 2026-08-15. Scope is Foundation plus the four approved read-only capabilities. No product/database write capability, Memory, Automation, production deploy, feature enablement, or destructive migration is included.

## 1. Initial state

Boop was clean at `448197c58f...` on the cumulative feature chain. Hostmate's old product worktree was clean but based on an obsolete merge base with 35 unrelated feature commits and 550 newer `main` commits. The user's dirty primary Hostmate worktree was not modified. The temporary Boop baseline clone remains reference-only.

## 2. Integrated branches and commits

Stable branches are `Hostmate/boop-agent-platform:codex/agent-platform-integration` and `Hostmate/Plataforma-Real-Estate:codex/agent-platform-integration`. Boop preserves `76b0f3c` (Foundation), `6a8a571`/`0226615` (search), `e718bc3` (context), `e33c913` (lead visits), and `448197c` (visit detail). Hostmate was rebuilt from current `origin/main` with clean cherry-picks `3e4b639c`, `e67e5be5`, `261c41f9`, `43fc9b41`, `e0ba6bb8`, and `eff22b10`.

## 3. Git topology

```text
Boop 31979130 baseline -> Foundation -> search -> context -> lead visits -> visit detail -> stabilization
Hostmate current origin/main -> bridge -> UI -> docs -> context -> lead visits -> visit detail -> stabilization
```

Both branches are single integration heads. No merge to `main`/`develop` and no production push occurred. Obsolete/reference worktrees are not primary working copies; unrelated user changes were preserved.

## 4. Experimental code

- KEEP: generic runtime/control-plane contracts, four Product Tools/adapters, Convex schema/functions, OpenRouter adapter, vertical slice and integrated UI.
- TEST-ONLY: ephemeral RSA/JWKS and direct real-service adapters in `agent-platform-read-regression-e2e.ts`.
- REMOVE: superseded `crm-search-leads-live-e2e.ts`, its hard-coded spike-worktree path and partial scenario. No local debug/JWKS server ships in the runtime.

## 5. Boop Core delta

The baseline-to-integration audit has 47 changed files. Only two are upstream Core: `server/runtimes/tool.ts` (strict generic Zod boundary) and `convex/schema.ts` (control-plane table registration). CRM/Visits behavior remains under `server/hostmate`; tests/docs/config are separate. No domain logic was moved into Core.

## 6. Final contracts

`ActorContext` is immutable/server-created. `ExecutionResult` owns status, summary, typed errors, entities, blocks and data. `EntityRef` is a non-authoritative locator. Product tools carry owner, compatible profiles, version, capability, permission, risk and strict schemas. Runs persist exact ToolScope, profile/skill versions and registry hash. Events/usage are redacted and correlated. Authority never comes from model input. The unsupported CRM status `pending` was removed to match Hostmate's canonical `LeadStatus`; “tareas pendientes” remains a context intent.

## 7. Context model decision

```ts
type ConversationContextRefs = {
  selected: Readonly<Record<string, EntityRef | undefined>>;
  referenced: readonly EntityRef[];
};
```

Keys are semantic roles owned by extensions (`lead`, `visit`, later `property`/`demand`), not domains enumerated by Core. This preserves one focus per role and is clearer than unordered `focus[]`. The pre-production legacy array reader was removed because no production data exists. Stored values are structurally filtered. The model scales to Properties/Demand Matching without another shared-contract change.

## 8. Canonical Visit -> Lead attribution

`visit.service.resolveLeadAttributions` and `listByLead` share one SQL primitive. Fixed precedence: opportunity, newest booking token, newest legacy `RE_Leads.visit_id`, then phone only for exactly one active tenant lead. Legacy groups use the newest explicit registration per lead. Comments and a SQL characterization test lock the order and ambiguity guard.

## 9. Orphan group registration

Read-only production audit found one registration total and one orphan lead reference: registration 8, group visit 7, tenant 9, lead 4472; no orphan group visit or cross-tenant mismatch. The table has no foreign keys. UI still displays snapshot name/phone, so deletion/backfill would risk useful history.

Decision: C, mark orphan in a later reviewed non-destructive migration (nullable marker/reason or health projection), preserve snapshot display, and deny agents because assignment cannot be proven. Tenant admins may see the tenant-scoped visit aggregate without a lead reference. Add referential governance for new writes after product review.

## 10. Type debt

`appendIgDmOpenTracking` existed only on the obsolete feature base. Current Hostmate `main` uses the real exported `appendUtmMsg` in all three call sites. No DM behavior change was needed. Full API typecheck exposed/fixed only the Agent Platform `pending` status mismatch.

## 11. Performance

Baseline: lead list 1.5–2.6 s; detail 2.6 s, with about 426 ms attribution and 1.6 s legacy detail. Quick safe win: tenant-scoped attribution, detail and latest-event reads now run concurrently; current lead authorization still gates return. Group attribution/detail also run concurrently. Tests prove launch and authorization ordering.

Future: profile `lead.service.list`; add a bounded detail projection; after staging `EXPLAIN`, consider indexes on `RE_Booking_Tokens(tenant_id, visit_id, created_at, id)`, `RE_Leads(tenant_id, visit_id, id)`, and group registration attribution columns. Existing `(tenant_id, client_phone)` helps fallback. Ignore tiny event/group tables until volume warrants it.

## 12. Dependency security

The exact 15-package classification is in `BOOP_DEPENDENCY_SECURITY_BASELINE.md`. No critical/high is reachable through the current request path, so the lockfile was not changed. A slim runtime artifact and controlled dependency PR are production gates.

## 13. Stable JWKS design

- Independent issuer `https://<hostmate-api>/api/v2/agent-platform/<env>` and audience `hostmate-agent-platform-<env>`.
- Hostmate API is sole RS256 signer. Private keys live in EasyPanel managed secrets or KMS, never Git/Convex/browser. Convex, runtime and Hostmate callback verify stable HTTPS JWKS.
- Immutable version `kid`; JWKS publishes active+previous. Publish next, switch signer, remove previous after 5-minute token TTL plus cache/skew: minimum 15-minute overlap, 5-minute cache.
- ActorContext TTL 5 minutes, with session and `permissionsVersion`. Product callbacks reauthorize current assignment; staging must reject stale permissions versions/revoked sessions for fast revocation.
- Dev/staging/prod use separate keyrings, issuer/audience, Convex deployments and OpenRouter secrets. E2E JWKS is TEST-ONLY.

## 14. Managed runtime

Use a separate stateless EasyPanel service (proposed `it_re-agent-platform-runtime`) on the existing Hostmate VPS, not the web API and no cron/workers. One HTTP process/container exposes `/health/live`, `/health/ready`, compatibility `/health`, and `POST /v1/turn`. It drops readiness on SIGTERM, drains requests and has a 55 s shutdown timeout. Concurrency defaults to 8; overload returns 503/Retry-After. Horizontal replicas share Convex.

Config/secrets: Convex URL, internal Hostmate URL, OpenRouter key/models, verifier issuer/audience/JWKS, concurrency and shutdown timeout. Use slim Node 20+, stop-first/grace 60 s, structured non-secret logs, run/request correlation, latency/error/in-flight metrics. Deploy order: Convex functions/config, Hostmate API, runtime. No deployment occurred.

## 15. Convex readiness

All public functions derive actor from Convex auth and use tenant-first indexes. Conversation ownership is enforced. Stabilization validates owner/reference integrity for run/conversation/attempt/event/usage mutations; admins may read tenant-visible runs but cannot mutate/cancel another user's run. Lists are bounded (messages 200, runs 100, events 500, usage 50); cursor pagination is required before high-volume admin history.

Observed four-turn flow is roughly 50 inserted records plus 16 patches, about 16.5 writes/turn. At 20 users x 30 turns/day: ~9,900 writes/day; at 100 x 30: ~49,500/day or 1.5M/month. Reasonable for controlled use, but retention, dashboards and plan-specific load/cost validation are required.

## 16. Retention

- UX: redacted conversations/messages/contextRefs 180 days after activity.
- Debug: runs/attempts 90 days; detailed events/payloads 30 days, then terminal summaries/counts.
- Metrics: aggregate usage/cost/tokens 13 months; raw per-run usage 90 days.
- Discard: heartbeat/lease detail terminal + 7 days; verbose model/tool detail after 30 days.

Cleanup must be bounded, tenant-indexed, dry-run measured and legal-hold aware. No destructive job was activated. Memory is excluded.

## 17. UI stabilization

`/ai-platform`, `/chat`, `/executions` remain superadmin-routed and backend feature-gated. Empty/loading/error, realtime, durable reconnect and deep links exist. Navigation/chat controls now meet 44 px, mobile tabs scroll, send has an accessible label, errors do not echo internals, and copy reflects four capabilities. Event UI renders only `payloadRedacted`.

## 18. Four-capability E2E

One TEST-ONLY harness runs search -> reconnect/context -> reconnect/visits -> explicit selection + reconnect/detail for agent-policy and admin actors against real MySQL reads, real Hostmate facades, OpenRouter and Convex. It asserts exact scopes `[search]`, `[context]`, `[list visits]`, `[detail]`, inference counts `[1,0,0,0]`, durable lead/visit, realtime readback, one search and zero business writes. `HOSTMATE_REPO_PATH` points to the stable integration worktree.

## 19. Reproducible checks

```bash
# Boop
npm ci && npm test && npm run typecheck && npm run build:debug

# Hostmate, from v2/
npm ci
npm exec prisma generate --workspace=@re/prisma
npm run build --workspace=@re/shared && npm run build --workspace=@re/prisma
npm run lint --workspace=@re/api
npm test --workspace=@re/api -- --run src/routes/agent-platform.routes.test.ts src/routes/agent-platform-internal.routes.test.ts src/services/agent-platform-lead-context.service.test.ts src/services/agent-platform-lead-visits.service.test.ts src/services/agent-platform-visit-detail.service.test.ts src/services/visit.service.test.ts
npm run lint --workspace=@re/web && npm run build --workspace=@re/web

HOSTMATE_REPO_PATH=../Plataforma-Real-Estate-agent-platform-integration \
HOSTMATE_ENV_PATH=../Plataforma-Real-Estate/v2/.env \
AGENT_PLATFORM_CRM_MODEL=deepseek/deepseek-v4-flash-0731 \
AGENT_PLATFORM_REASONING_EFFORT=max \
npm run e2e:agent-platform-read-regression
```

## 20. Remaining blockers

Staging: stable separated JWKS/secrets, staging Convex config, managed runtime, permission-version revocation, a true agent-role assigned-lead fixture, deployed browser smoke, retention dry-run metrics. Production adds slim-artifact dependency remediation, key-rotation drill, cursor pagination, retention activation, load/cost/alerts, reviewed orphan/index migrations, and privacy/security review.

## 21. Readiness verdict

The code foundation is coherent and suitable for continuing read-only domain development after review. It is not approved for staging users or production until those operational blockers close.

## 22. Recommended phase

Package/exercise managed runtime, JWKS and Convex in staging with a real agent fixture. After that gate, begin one read-only Properties capability on these branches; do not start Demand/Tasks/Notes/writes concurrently.
