# Boop Skills Generalization — Second Skill

Validation date: 2026-08-16. Scope: staging-only, read-only, single-agent execution.

## 1. Objective

Validate that Hostmate can add a second real Skill without duplicating a large deterministic executor, widening Product Tool authority, or introducing a workflow engine. The accepted shape remains `SKILL.md → Skill Registry → generic deterministic helpers → small adapter → scoped Product Tools`.

## 2. First Skill baseline

`prepare-visit-brief@1` was the baseline: `profile=visits`, root `visits.get_visit.v1@1`, optional dependent reads `crm.get_lead_context.v1@1` and `property.get_property.v1@1`, generic `brief` output, and partial completion when a related entity is absent. Its pre-generalization adapter was 245 physical LOC.

## 3. Second Skill audit

The DTO audit confirmed `crm.get_lead_context.v1` already returns bounded, actor-authorized summaries for the lead, masked contact data, assigned agent, opportunity, active demand, pending tasks, related property and next visit. The property and visit summaries do not expose downstream `EntityRef`s suitable for a second Tool call. Therefore additional visit/property reads would either be redundant or require reconstructing untrusted refs. The useful and safer product is `prepare-lead-brief@1` with one root read only.

## 4. SKILL.md

The canonical `.agents/skills/prepare-lead-brief/SKILL.md` is 45 physical LOC and is mirrored byte-for-byte under `.claude/skills/`. It owns the procedure: require `contextRefs.selected.lead`, call the root Tool exactly once, prioritize factual CRM data, render missing blocks explicitly, never search substitutes, never infer unsupported advice, and never write.

## 5. Registry metadata

The active definition adds only metadata already justified by both Skills: ID/version/source/hash, compatible profile, objective class, required Tool capability, security class, feature gate and trusted source. The CRM profile adds `prepare-lead-brief` plus `lead.prepare_brief`. No DAG, step graph, YAML workflow or state-machine metadata was added.

## 6. Generic execution helpers

`execution-helpers.ts` contains 266 one-time physical LOC shared by both adapters. It resolves the selected context role, creates interaction/execution runs, resolves Registry + Profile + Policy, enforces the exact Tool allowlist, emits lifecycle events, reauthorizes each Tool call, handles `needs_input`/partial/authority failures, persists version/hash and records zero-inference deterministic completion.

`runtime-dispatcher.ts` adds a 64-LOC composition registry for small adapters and a generic tenant/user/Skill gate. The HTTP runtime dispatches an abstract classified Skill ID and no longer branches on either concrete Skill name. This is adapter registration, not an execution engine.

## 7. Skill-specific code

`prepare-lead-brief.ts` is 127 physical LOC. Its specific responsibilities are DTO-to-brief mapping, missing-section semantics and the one-root-Tool procedure. `prepare-visit-brief.ts` is now 148 LOC after moving shared lifecycle, scope, policy, context and error behavior to the helper.

## 8. Comparison between Skills

| Dimension | prepare-visit-brief | prepare-lead-brief |
| --- | --- | --- |
| root entity | `selected.visit` | `selected.lead` |
| profile | `visits@1` | `crm@1` |
| root Tool | `visits.get_visit.v1@1` | `crm.get_lead_context.v1@1` |
| optional Tools | lead context, property detail | none |
| parallel reads | independent related lead/property reads | none required |
| partial behavior | missing lead/property | missing commercial/property/visit summaries |
| output | generic `brief` | generic `brief` |
| specific code LOC | 148 now; 245 baseline | 127 |

The second adapter is 48.2% smaller than the first-Skill baseline and 14.2% smaller than the refactored first adapter. The first adapter itself fell 39.6% from its baseline.

## 9. ToolScope

The exact effective ToolScope is `crm.get_lead_context.v1@1`. Search, list, visit detail, property detail, Memory and all write capabilities are absent. Registry requirements, Profile compatibility, actor permissions and Policy all have to agree; Skill prose cannot widen the result.

## 10. Profile

The Skill uses `crm@1`. Its root and objective are lead preparation, so no new Execution Profile was introduced.

## 11. Context selection

`contextRefs.selected.lead` is mandatory. An explicit lead utterance selects the lead Skill even when selected lead and visit roles coexist; an explicit visit utterance selects the visit Skill. `Prepárame esto` and mixed lead+visit requests do not select either Skill arbitrarily. Missing lead context returns `needs_input` without a Product Tool call or fallback search.

## 12. Partial handling

Missing opportunity/demand/tasks marks the commercial block unavailable; missing summarized property and next visit mark those blocks unavailable. The lead and preparation blocks remain useful. No arbitrary search or ID reconstruction fills gaps. Staging Lead A produced `partial` with missing property and visit, exactly matching the root DTO.

## 13. Memory interaction

Explicit User Memory V1 is unchanged and is not in either Skill ToolScope. Automatic extraction, tenant Memory, consolidation and automations remain disabled. No Memory preference changes procedure, authorization, ToolScope or Product Data reads.

## 14. Policy

Both Skills still resolve through Profile + Skill Registry + Tool Registry + Policy. Every Tool invocation reauthorizes against current actor/tenant state. Authority failures abort safely rather than being converted into ordinary partial data.

## 15. Security

Tests cover Skill-ID injection, arbitrary/mixed Skill requests, Tool widening, write requests, profile mismatch, feature gate off, tenant/user canary exclusion, permission changes during execution, fabricated/manual refs rejected by the authority-bound Product Tool, and cross-tenant/stale refs. Results: permission bypass 0, unauthorized Tool exposure 0, cross-tenant leakage 0.

## 16. Output

The existing generic `brief` block gained the reusable `commercial` section key. The lead brief contains Lead, Situación comercial, Inmueble, Próxima visita and Preparación sections. It renders only supplied facts and explicit absence notes.

## 17. AI Chat

Lead result cards expose `Prepárame este lead`. Staging rendered both complete structure and partial-state microcopy, retained the selected lead after refresh, and preserved existing visit CTA behavior.

## 18. AI Platform

Realtime execution detail displayed `prepare-lead-brief@1`, hash `c7bd31ee7eae1934367030f173fad9458359a65be16bde41625e6e57eed42e14`, `crm@1`, one exact Tool and the full lifecycle. The comparison visit run displayed `prepare-visit-brief@1`, hash `b7bba7a3504db21688be1edf7d668ec1e52e9a4e9feacec3af2d0d571848cfaa`, `visits@1` and its three permitted Tools.

## 19. Benchmark

Skills V2 contains 73 deterministic/adversarial utterances: 20 positive visit, 20 positive lead and 33 negatives/ambiguous/injection/adjacent intents. Measured selection precision is 100%, recall 100%, collision rate 0%, false positives 0 and false negatives 0.

## 20. Metrics

- Skill-specific implementation: 127 LOC for the second adapter.
- Generic reusable execution helper: 266 LOC once.
- Generic adapter dispatcher: 64 LOC once (330 generic LOC total with the execution helper).
- SKILL.md procedure: 45 LOC.
- Core delta: zero in Boop Execution Agent and Claude/Codex runtimes.
- Effective ToolScope accuracy: 100% in tests and staging traces.
- Partial correctness: 100% across complete/partial fixture assertions and the staging partial case.

## 21. Scalability LOC analysis

For a third Skill with the same deterministic read pattern, expected new code is approximately 45–130 adapter LOC plus its procedural `SKILL.md`, one adapter-factory registration and small Profile/Registry/classifier entries. Shared run lifecycle, context resolution, Policy, scoped Tool dispatch, telemetry, partial/authority handling and persistence require no duplication. This is sufficiently generalized for dozens of small deterministic Skills without a workflow engine; structurally different Skills may justify another narrow primitive only after a second concrete use case appears.

## 22. Browser E2E

Agent A passed: lead selection → lead brief; refresh → repeated lead brief; lead with partial context; selected lead+visit → explicit lead phrase selected lead Skill; same context → explicit visit phrase selected visit Skill; ambiguous `Prepárame esto` selected neither; realtime execution comparison; and a real 390×844 viewport. At 390×844 the measured document width was 390 px, the composer stayed visible, the lead search and CTA worked, and the full partial brief rendered without horizontal overflow.

## 23. Cost and latency

Representative lead trace: 302.3 ms Skill time, 77.7 ms root Tool, 446 ms execution envelope, 0 inference, 0 input/output tokens and $0. Representative visit trace: 547.9 ms Skill time, 130.4 ms root Tool, 92.1 ms lead read, property skipped because no ref, 663 ms envelope, 0 inference, 0 tokens and $0. Independent visit downstream reads use `Promise.allSettled` when both refs exist.

The browser validation window captured one real mobile-QA search sample: DeepSeek V4 Flash via StreamLake, 3,589 ms, zero timeouts. The monitor is intentionally in-memory and reset when the final `r2` runtime image rolled out; its fresh window is now 0/50 and `insufficient_data`. No synthetic traffic was generated.

## 24. Regressions

The six read-only Product Tools remain advertised and covered by the full suite. Explicit Memory remains green. No dependency was changed. Hostmate's root `npm test` still stops on the existing generated-i18n completeness gate (181 missing strings, including the new CTA); targeted web tests, lint and production build pass. No bulk translation regeneration was performed.

## 25. Tests

Boop: typecheck, runtime build and full Vitest suite pass. Hostmate: lint, shared/web/API Vitest suites, targeted Agent Platform UI tests and build pass; integration tests requiring external fixtures remain skipped by their existing guards. Remote staging liveness/readiness are 200 with zero active turns and both Skill capabilities advertised. A post-rollout authenticated API run against the final `r2` image returned a partial generic brief with zero errors.

## 26. Core delta

No changes were made to `server/execution-agent.ts`, `server/runtimes/claude.ts` or `server/runtimes/codex-app-server.ts`. Concrete adapters are registered only under `server/hostmate/skills/`; the Hostmate HTTP runtime contains one generic Skill dispatch path.

## 27. Risks

The OpenRouter SLO has 0/50 samples in the fresh `r2` in-memory window (one real sample was observed before rollout) and remains observational, not a release gate for deterministic Skills. The staging image is local to the VPS because the Docker Hub namespace rejected push authorization. The production service was not updated: its image and update timestamp predate this staging deployment; it independently reported 0/1 during final read-only observation and was deliberately not touched.

## 28. Recommendation on multi-agent

GO for the Skills generalization question: a third similar Skill no longer needs a large executor or Core branch. The architecture is sufficiently generalized to begin a separately scoped multi-agent design phase, but no multi-agent orchestration should be implemented automatically from this result.
