# Boop Safe Writes V3 — Structured Task Creation

## 1. Objetivo

Validar que el Safe Write Engine generalizado soporta una creación estructurada con relación, asignación y semántica temporal. El resultado es un canary de staging; no es una autorización de producción ni de una cuarta write.

## 2. Task domain audit

El producto ya tenía `RE_Lead_Tasks`, `task.service.ts`, `/api/v2/tasks` y `LeadTasks.tsx`. La tarea pertenece a tenant y lead, admite título, descripción, fecha, responsable, estado, prioridad, autor y timestamps. La creación manual era admin-only, validaba tenant/lead y responsable activo. No generaba activity, notificaciones, calendar jobs ni analytics.

## 3. Tool ownership decision

Tasks tiene tabla, API y servicio propios. Por ello el owner es `tasks`, aunque V1 use un lead CRM como target. El nombre final es `tasks.create_task.v1@1`; no se fuerza `crm.create_task.v1` ni se crea un perfil nuevo.

## 4. Canonical model/service

Se reutiliza `RE_Lead_Tasks` y se añade `commitAgentPlatformTaskCreate` al servicio canónico `task.service.ts`. No hay Prisma/SQL desde el Runtime Boop, tabla paralela ni Task approval engine. El único SQL de Task está encapsulado en el Domain Service existente.

## 5. Current Task creation flow

El flujo manual `POST /api/v2/tasks` continúa operativo con `CreateLeadTaskSchema`. Se amplía de forma compatible con `due_time`; date-only sigue válido. La UI real muestra y permite hora opcional. No se modifican complete, cancel ni delete.

## 6. Safe Write reuse

Se reutilizan ActorContext, perfil, Policy, provenance, dispatch, Preparation Engine, Convex Draft repository, canonical hashing, HMAC, expiry, same-actor confirmation, commit fencing, durable receipt, eventos y realtime. No existe un segundo lifecycle.

## 7. Tool contract

Input estricto: `{ lead: EntityRef<"crm.lead">, candidate: TaskCandidate }`. No acepta tenant, IDs manuales, `assignedUserId`, status, priority, force ni auto-confirm. Output: lead autoritativo, candidate revalidado, assignee server-side, defaults y telemetry.

## 8. Profile/risk/permission

Perfil `crm@1`, objective class `task.manage`, capability `tasks.task.prepare`, owner `tasks`, mode `draft`, riesgo `R1`. Permission existente `crm.write` más política canónica admin/superadmin, igual que la ruta manual actual. No se inventa `tasks.write`.

## 9. Target provenance

V1 exige `contextRefs.selected.lead` o EntityRef explícita seleccionada. No busca lead durante la write y rechaza `lead 123`/`lead #123`. Prepare y Confirm vuelven a resolver tenant, existencia, deleted/merged y acceso.

## 10. Assignment

`assigned_to = ActorContext.userId` se decide en servidor y se firma. El actor debe seguir activo en el tenant al confirmar. Asignar a Marta queda fuera: requerirá resolución de persona, tenant membership, permiso, ambigüedad y confirmación explícita.

## 11. TaskCandidate

Campos: `title`, `dueDate`, `dueTime?`, `dueAtUtc?`, `timezone`, `temporalPhrase`, `referenceTime`, `inference: 0`. No contiene autoridad. Los defaults autoritativos son `status=pending`, `priority=medium`, `description=null`.

## 12. Deterministic parsing

Parser cerrado en español, catalán e inglés para hoy/mañana, offsets de días, weekdays, ISO, DD/MM/YYYY y hora 24 h. Normaliza acentos antes de reconocer verbos; el E2E detectó y corrigió el caso exacto “Créame”. No interpreta frases fuera del allowlist.

## 13. LLM candidate extraction

Desactivada en V1. El 100% de Prepare usa parser determinista; modelo: ninguno; inference calls: 0. Una futura extracción LLM solo podría proponer TaskCandidate y tendría que pasar el mismo schema y temporal resolver.

## 14. Timezone

Regla V1: `Europe/Madrid`, la timezone server-authoritative del canary. Se almacena fecha/hora local para producto y `due_at_utc` para instante inequívoco. Timezones distintas devuelven `needs_input` en esta versión.

## 15. Relative dates

Se resuelven contra `Date.now()` del Runtime antes de firmar. El Draft contiene fecha absoluta, reference time y zona. “mañana a las 10” en 2026-08-16 produjo `2026-08-17`, `10:00 Europe/Madrid`, `2026-08-17T08:00:00Z`.

## 16. Ambiguous dates

Time-only, dayparts, fechas imposibles, fines de semana vagos, múltiples tareas y temporal no soportado producen `needs_input`; no hay Draft. Horas DST inexistentes también fallan. No se adivina AM/PM.

## 17. Temporal signing

Fecha, hora, UTC, zona, frase original resuelta y reference time están dentro de `structuredPayload` y del args hash. Alterar cualquiera invalida HMAC o `DRAFT_ARGS_CHANGED`. Confirm nunca reinterpreta lenguaje natural.

## 18. Structured WriteIntent

Necesidad genérica demostrada: `WriteIntentEnvelope.structuredPayload?`, canonicalizado y firmado. Status y Note omiten el campo y conservan firmas/contratos. Task usa `operationType=create`, `operation=task.create`, `requestedValue=title` y payload estructurado.

## 19. Draft rendering

Se reutiliza `action_confirmation`. Muestra Task, fecha, hora/zona opcional, assignee, estado, prioridad, target/riesgo y botones compartidos. No existe `task_confirmation`. El mensaje stale se hizo domain-neutral.

## 20. Preconditions

Se firman `lead.assigned_agent_id`, `task.assignee_user_id` y `task.due_at_utc` (o fecha date-only). Confirm verifica lead existente/no merged/no deleted, assignment sin cambios, actor activo, rol/permission/gates y temporal aún válido.

## 21. Stale temporal behavior

Si `dueAtUtc <= now`, o la fecha date-only ya es anterior al día actual de Madrid, Confirm devuelve stale/`PRECONDITION_FAILED`, crea 0 Task y obliga a regenerar. No se crea una tarea ya vencida.

## 22. Confirmation

Siempre humana, mismo actor, misma session lineage y permissionsVersion. Draft TTL: 10 minutos. Auto-confirm language se rechaza. Cancel y expiry son terminales; refresh token rotation mantiene el session id estable y permite confirmar.

## 23. Deterministic commit

El commit recibe exclusivamente el SignedWriteIntent cargado server-side. Revalida schema, firma, actor, args hash y preconditions; llama al Domain Service sin OpenRouter ni LLM. Path: Runtime registry → Hostmate facade → `task.service` → MySQL.

## 24. Transaction/idempotency

Una transacción MySQL ReadCommitted contiene claim de `RE_Agent_Write_Commits`, locks de lead/actor, Task INSERT y result receipt. Double click, concurrencia, retry y lost response devuelven la misma Task; un Draft produce como máximo una fila.

## 25. Resulting EntityRef

El receipt devuelve `{ type: "tasks.task", id }`. Staging demostró `tasks.task:<id>` en commit y replay. No se inventa `crm.task`.

## 26. Failure recovery

Antes de mutar, errores de firma/actor/permission/args fallan cerrados. Cambios de assignment, lead o tiempo marcan Draft stale. El fencing de Convex y el receipt durable resuelven concurrencia y respuestas perdidas.

## 27. Side effects

Task INSERT y receipt únicamente. No se añadieron activity feed, notification, reminder scheduler, calendar, analytics, message, note ni status log. Es coherente con la creación manual existente.

## 28. Security

Tenant cerrado por ActorContext y SQL, selected EntityRef, admin policy, self-assignment server-side, strict schemas, HMAC, args hash, expiry, session/version, locks e idempotency. Se rechazan manual IDs, secretos etiquetados, HTML, mixed actions, batches y auto-confirm.

## 29. Evaluation corpus

130 escenarios con ground truth: 100 positivos (10 acciones × 10 temporales) y 30 negativos multilingües/adversariales. Resultado: temporal 100/100, texto 100/100, ambigüedad 30/30, hallucinated-field rate 0%, inference paths 0.

## 30. Metrics

Canary real: Prepare determinista 1202.16 ms end-to-end; Confirm 730.15 ms. Coste OpenRouter en Prepare/Confirm: USD 0. No se registraron inference usage rows para Task.

## 31. Browser E2E

Chrome real confirmó inventory copy, selección/provenance, actor-agent permission denial y 390×844 (`scrollWidth=clientWidth=390`, sin overflow). El renderer Task compartido se verificó con integración React. El admin 42 ejecutó A–I contra los endpoints reales: A Draft/DB unchanged; B cancel/0; C 1 Task+receipt; D 10:00/08:00Z; E refresh+confirm; F double click/1; G replay/1; H assignment stale/0; I ambiguity/no Draft.

## 32. Cost/latency

Ruta determinista: latencia de red+Convex+MySQL, 0 tokens y 0 coste de modelo. Ruta inferred: no implementada, 0%. Confirm: 0 LLM y 0 coste. No se optimizó prematuramente el canary.

## 33. Comparison with previous writes

Status firma un valor canónico y actualiza; Note firma texto exacto y crea; Task firma un candidato estructurado y crea una entidad resultante. Las tres comparten motor, Draft, lifecycle, confirmation, registry, receipt y renderer.

## 34. LOC/generalization

Task-specific production: 550 líneas netas aproximadas (298 Boop + 252 Hostmate); parser+temporal resolver: 104 LOC. Safe Write genérico: 9 LOC en Boop más extracción del receipt Hostmate a helper genérico de 45 LOC. Generic LLM candidate extraction: 0 LOC. Core Boop upstream fuera de `server/hostmate`: 0 LOC.

## 35. Cleanup

El harness borra por draft IDs exactos todas las Tasks y receipts creados, restaura assignment 43 y hace logout. Snapshot final: Task 0, task receipt 0, note 0, status fixture original. Password admin 42 restaurada byte-for-byte; archivos temporales eliminados.

## 36. Regressions

Status y Note conservan schema y signatures sin `structuredPayload`. Lecturas, Skills, Memory y Multi-Agent no cambian. UI manual Task date-only continúa compatible; build API/Web y suite Hostmate pasan.

## 37. Tests

Vitest completo: 212 tests Boop y 1.688 Hostmate (1.900 passed; 44 integraciones condicionadas skipped). Typecheck/build de Boop, Prisma, Shared, API y Web verdes. Staging A–I pasó dos veces y cleanup se verificó. El wrapper global `npm test` de Hostmate conserva una deuda previa del catálogo i18n del Agent Platform (202 cadenas); las suites de código se ejecutaron directamente con Turbo y quedaron verdes, sin regeneración masiva ajena a esta fase.

## 38. Core delta

No se tocó el Core original de Boop, automations, memory core, provider routing ni OpenRouter adapter. El delta reside en la capa derivada Hostmate y en la integración canónica del producto.

## 39. Production blockers

No se aplicó migración ni imagen a producción. Antes de producción: review/rollout de `20260816_agent_platform_task_temporal.sql`, definir canary/observabilidad productivos, confirmar que admin-only sigue siendo la política deseada y repetir gate con fixture product-safe. Los advisories npm preexistentes no se actualizaron en esta fase.

## 40. Recommendation

GO para uso interno controlado en staging de `tasks.create_task.v1@1`. La tercera write prueba structured creation sin engine paralelo. No implementar aún una cuarta write; la candidata recomendada para el próximo spike es `visits.create_visit.v1`, por aportar disponibilidad/slot preconditions y side effects distintos, no Task update/complete/delete.
