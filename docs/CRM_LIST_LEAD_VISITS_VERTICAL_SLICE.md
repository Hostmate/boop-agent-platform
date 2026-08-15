# CRM List Lead Visits vertical slice

Status: implemented and validated as the third read-only capability. The canonical Product Tool is owned by Visits, can be imported into a CRM Execution Run, and remains feature-gated and undeployed.

## 1. Investigación Lead ↔ Visits

`RE_Visits` has no `lead_id`. The audit covered Prisma, `visit.service.ts`, visit routes, booking, opportunities, lead creation, rescheduling and both group-visit systems. Production read-only counts confirmed individual visits linked through opportunities or booking tokens, historical rows without an explicit relation, modern group slots represented as ordinary `RE_Visits`, and legacy group registrations stored separately.

`RE_Leads.visit_id` is singular and historical. It remains useful as one strong legacy edge but cannot represent a complete visit history.

## 2. Relación canónica encontrada

The canonical attribution implemented in `visit.service.listByLead` is:

1. `RE_Visits.opportunity_id → RE_Opportunities.lead_id`.
2. Latest `RE_Booking_Tokens.visit_id → lead_id` when no valid opportunity edge exists.
3. Legacy `RE_Leads.visit_id` when neither stronger edge exists.
4. Same-tenant phone fallback only for a visit with no strong edge, attributed to the latest active lead using that phone.
5. Legacy group visits through `RE_Group_Visit_Registrations.lead_id → RE_Group_Visits`.

Strong edges always win, preventing a shared/reused phone from moving a visit. Modern group slots are not unioned separately because their bookings already produce `RE_Visits`, avoiding duplicates. Reprogramming updates the same visit and writes `RE_Visit_Events`; the list returns the current visit date/status, not an invented `rescheduled` status.

## 3. Decisión de ownership CRM vs Visits

Ownership is Visits because relation resolution, ordering, state normalization and pagination are visit-domain responsibilities. The final tool is `visits.list_lead_visits.v1`, with `ownerDomain: "visits"` and `compatibleProfiles: ["crm", "visits"]`. A CRM run may receive it for this objective through registry scoping; no duplicate CRM handler exists. Tool ownership and compatible profiles remain separate concepts.

## 4. Tool contract

Version `1`, namespace/name `visits.list_lead_visits`, capability `visits.lead.list`, permission `crm.read`, mode `read`, risk `R0`.

```ts
{
  lead: EntityRef<"crm.lead">;
  scope?: "upcoming" | "past" | "all";
  status?: VisitStatus;
}
```

The schema is strict. It rejects text search, `leadId`, tenant/user/role/owner/assignment fields, invented states and caller-controlled pagination. The backend fixes the absolute limit at 10.

## 5. Permission scope

- `agent`: the lead must currently be assigned to `ActorContext.userId`.
- `admin`: tenant-wide within the signed effective tenant.
- `superadmin`: still locked to the signed effective tenant.
- Foreign/unknown lead: `NOT_FOUND`; unassigned/reassigned lead: `PERMISSION_DENIED`; merged lead: `STALE_REFERENCE`.

Every call resolves and authorizes the lead before `visit.service.listByLead` runs. An EntityRef is continuity data, never authorization evidence.

## 6. Services reused

The shared authorization helper uses `lead.service.getById`. The thin Agent Platform facade then calls the new canonical `visit.service.listByLead` operation. SQL/Prisma stay in the Visits domain service; the Product Tool and Agent Platform facade contain neither. `crm.get_lead_context.v1` continues using only its bounded linked-next-visit summary.

## 7. DTO

The allowlisted DTO contains lead identity, timezone, at most ten visits, current date/time, real status, property title/reference/address, assigned agent name, visit type, duration, confirmation state, group markers, and metadata `{scope, status, total, returned, hasMore, limit}`. Telemetry exposes facade and visit-service latency.

It excludes tenant IDs, relation-source internals, raw rows, notes, tokens, Google/provider payloads, logs and other technical fields.

## 8. EntityRefs

Input is exactly `crm.lead`. Individual results emit `visits.visit`; legacy group results emit `visits.group_visit`. Each ref has a stable ID, compact label and existing Visits deep link. The service response ID must match the requested lead ref. These refs prepare future single-visit read/write tools without implementing them now.

## 9. Status/filter model

The real individual status enum is `pending | confirmed | cancelled | completed | floating | cancelled_by_agent | no_agents_available | cancelled_by_client | no_show | rejected`. Legacy group registration/group state is normalized into the compatible current visit states while retaining compact group status fields.

`scope=upcoming` applies `visit_datetime >= NOW()`, `past` applies `< NOW()`, and `all` is unbounded temporally but still limited to 10 rows. Status is optional and exact. `rescheduled` is not exposed because it is an event type, not a current visit status.

## 10. Composition

Selected lead follow-up calls only Visits. A direct “Busca a X y dime qué visitas tiene” creates one CRM Execution Run scoped to search plus visits: OpenRouter extracts the search once; a unique result feeds the Visits tool deterministically. Multiple or zero matches never trigger visits. Next/last selection is encoded by temporal scope and service ordering, without a synthesis inference.

## 11. Conversational context

The selected `crm.lead` ref is persisted in semantic message `contextRefs.selected.lead`, separately from result visit refs in `referenced`. A selected visit is stored independently in `selected.visit`, so lead and visit can coexist. After a visits answer, later lead follow-ups still resolve the lead; visit detail requires explicit/ordinal visit selection. Legacy array-shaped messages remain readable.

## 12. Tool scoping

- Lookup only: `[crm.search_leads.v1]`.
- Lookup plus context: `[crm.search_leads.v1, crm.get_lead_context.v1]`.
- Lookup plus visits: `[crm.search_leads.v1, visits.list_lead_visits.v1]`.
- Selected lead plus visits: `[visits.list_lead_visits.v1]`.

The registry never supplies the full CRM/Visits catalogs. No new Skill was added because filters, ordering and composition are deterministic; the existing ambiguous-lead skill applies only when search is in scope.

## 13. Deterministic operations

Temporal intent maps to `upcoming`, `past` or `all` in code. Explicit supported status words map to the real enum. The service sorts future visits ascending and past visits descending, so “próxima” and “última” use the first returned row. Zero results and `hasMore` wording are generated from structured metadata. Selected-ref execution records zero model calls.

## 14. AI Chat

AI Chat renders reusable `entity_list` visit cards with localized date/time, property, status, agent, type, duration/group metadata and deep links. Visit cards do not display the lead-selection action. Search candidate cards retain their explicit lead-selection control. The interface copy and examples now advertise context and visit queries.

## 15. AI Platform

Execution details expose Interaction/Execution hierarchy, exact mixed-domain tool scope, requested/sanitized inputs, sanitized result EntityRefs and counts, services, both latency measures, status, model/provider, inference count, tokens, cost and durable lifecycle events. The UI now renders each already-redacted event payload. Deterministic selected-lead runs display “Sin llamada de modelo” and inference count `0`.

## 16. Realtime/reconnect

Messages, semantic `contextRefs`, runs, attempts, usage and redacted events remain durable in Convex and reactive in both surfaces. Reconnect reconstructs both selected lead and selected visit when present. This context is conversational state, not permanent Memory.

## 17. Performance

Latest live E2E using real OpenRouter, Hostmate services, production MySQL read-only and local Convex/JWKS:

| Metric | Result |
|---|---:|
| Interaction | 16 ms |
| Execution | 5,630 ms |
| Lead search service | 1,544.59 ms |
| Lead-visits facade | 2,856.72 ms |
| Visit service | 2,443.38 ms |
| OpenRouter | 2,690 ms |
| Model calls, composed turn | 1 |
| Model calls, reconnect follow-up | 0 |
| Tokens | 159 input / 30 output |
| Cost | USD 0.0001695 |
| First-run Convex events | 13 |
| Follow-up execution events | 5 |
| Total inserted Convex records | 30 |
| Total Convex document writes including patches | 46 |
| CRM/Visit writes | 0 |

No performance optimization was introduced. Backend pagination returned 10 of 20 real visits with `hasMore=true`.

## 18. Tests

Fork: 110/110 tests plus TypeScript typecheck and debug build. Hostmate focused backend: 42/42 tests; web production build passes. Coverage includes Agent A/B/admin, reauthorization ordering, reassignment, unknown/cross-tenant/merged refs, strict input, DTO sanitization, zero/one/multiple, upcoming/past/status delegation, pagination, unique/ambiguous composition, selected-ref execution, pronoun continuity, minimal tool scope, zero extra inference and durable reconnect. Real MySQL execution validated the canonical relation, temporal/status filters, pagination and a legacy group registration. The complete E2E passed with one composed inference and a zero-inference post-refresh follow-up.

## 19. Riesgos

- Historical visits without a strong relation require phone fallback; the precedence rule limits but cannot eliminate all ambiguity in legacy data.
- The query spans historical tables with different collations. Explicit result-column collation was required for the union; no schema migration was made.
- Legacy and modern group-visit models coexist; the documented union prevents known duplicates but future schema changes must preserve that invariant.
- Runtime deployment, stable JWKS rotation and production browser smoke testing remain outside this slice.

## 20. Deuda técnica

Add a durable explicit `lead_id` relation for future visit writes only through a separately reviewed migration, backfill and integrity plan; do not silently replace historical precedence. Add query-plan/index telemetry if production latency becomes material. Add a group-visit detail deep link and managed end-to-end browser smoke test after runtime deployment.

## 21. Recomendación para siguiente capability

`visits.get_visit.v1` is now implemented as the read-only, visit-EntityRef-based detail capability described in `VISITS_GET_VISIT_VERTICAL_SLICE.md`. No reschedule/cancel/confirm write was added.
