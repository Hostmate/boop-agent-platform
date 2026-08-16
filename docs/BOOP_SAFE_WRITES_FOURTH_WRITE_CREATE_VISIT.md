# Boop Safe Writes V4 — `visits.create_visit.v1@1`

## 1. Domain readiness

`VISITS_DOMAIN_HARDENING: GO` fue revalidado antes de implementar. `prepareVisitCreate` es la autoridad read-only y `commitVisitCreate` repite resolución y restricciones con datos frescos. Web, API y preview consumen esas primitives. El commit toma locks estables `tenant + agent + day`, reevalúa HARD dentro de la transacción, resuelve una Opportunity exacta, duración y elegibilidad canónicas, inserta efectos internos de forma atómica, y solo después despacha el outbox. La idempotencia de dominio está respaldada por `RE_Visit_Creation_Requests`.

## 2. Agent Platform contract

La capability final es `visits.create_visit.v1@1`, `mode=draft`, `operationType=create`, `operation=visit.create`. V1 solo crea una visita individual. Group Visit, recurrencia, batch, reschedule, cancel, update, múltiples leads, múltiples inmuebles y múltiples agentes responden `needs_input`/unsupported; nunca se reconducen silenciosamente.

## 3. Ownership and profile

Owner `visits`, profile `visits@1`, ToolScope exacto `[visits.create_visit.v1@1]`. No se añadió ninguna otra Tool ni se expuso la capability a Skills o Multi-Agent.

## 4. Permission and risk

La Policy de producto sigue siendo admin-only: administradores del tenant y superadmin con tenant efectivo. Un agente normal conserva DENY. No existe `visits.write` nuevo y `crm.write` no se usa como autoridad del dominio. El Tool exige `visits.read` para acceder al contexto, pero `actorAllowed` y el backend exigen rol canónico admin/superadmin. Riesgo `R2`, porque el plan puede incluir Calendar, WhatsApp y reminder. Confirmación humana es siempre obligatoria.

## 5. Provenance

Prepare exige Lead `crm.lead` y Property `property.property` seleccionadas desde resultados o detalle previos de la misma conversación. Un mensaje del usuario, un ID manual, teléfono, referencia libre, snapshot o “último” elemento no otorgan provenance. La Preparation Engine soporta ahora relaciones múltiples y verifica que cada EntityRef aparezca en un mensaje assistant autorizado. El backend reautoriza ambas referencias en Prepare y Confirm.

## 6. Temporal

`VisitCandidate` contiene exclusivamente `startDate`, `startTime`, `startAtUtc`, `timezone`, `temporalPhrase`, `referenceTime` e `inference=0`. Se reutiliza el parser determinista de Tasks, extendido a offsets escritos `un/uno/dos/tres` y `one/two/three`. Soporta hoy/mañana, weekdays, fecha ISO o DD/MM/YYYY, offsets y hora exacta en ES/CA/EN. “mañana”, dayparts y “a las 8” quedan ambiguos. No hay parsing LLM.

## 7. Opportunity

Agent Platform nunca recibe ni elige `opportunityId`. El backend envía Lead + Property autorizados a Visits con `assignment.kind=opportunity`. El dominio resuelve exactamente una Opportunity del tenant, `crm_scope=inmueble`, no merged y sin commercial outcome. Cero produce `OPPORTUNITY_NOT_FOUND`, más de una `OPPORTUNITY_AMBIGUOUS` y cualquier cambio respecto al Draft `OPPORTUNITY_MISMATCH`/stale.

## 8. Duration

La duración no viene del usuario ni del modelo. Visits resuelve override de inmueble, setting uniforme, setting por clase o fallback canónico. Prepare proyecta minutos, fuente y clase en el intent firmado. Confirm recalcula y una diferencia genera `VISIT_PRECONDITION_FAILED`; nunca se confirma una duración distinta de la mostrada.

## 9. Property eligibility

Agent Platform no replica listas de estados. `prepareVisitCreate` y `commitVisitCreate` aplican `assertPropertyEligibleForVisit`: estado canónico `activo`, no borrada y `accepts_visit_presencial`. Un cambio entre Prepare y Confirm vuelve stale el Draft y no crea Visit.

## 10. HARD and advisory constraints

HARD conserva exactamente la autoridad Visits: instante válido/futuro, elegibilidad, tipo presencial y solapamiento intervalar del mismo agente. Advisory conserva `TRAVEL_BUFFER` y `EXTERNAL_CALENDAR_BUSY`; un advisory se muestra y permite Confirm. Un HARD en Prepare no produce Draft confirmable. Confirm vuelve a evaluar HARD bajo lock.

## 11. Prepare

La ruta interna `/visits/prepare-visit` aplica gate, actor admin/superadmin y acceso Lead/Property, valida el instante canónico y llama una sola vez a `prepareVisitCreate`. Product Data permanece sin cambios. El resultado contiene Opportunity, Agent, duración, status inicial, constraints y plan real de efectos.

## 12. WriteIntent

Se reutiliza `WriteIntentEnvelope`; no existe `VisitDraft`. El target es Lead y `relatedEntities` contiene Property. El payload firmado incluye Opportunity, Agent, instante, timezone, duración/fuente/clase, status inicial, snapshot HARD, advisories y planes atómico/post-commit/externo. También liga actor, tenant, sesión, permissionsVersion, profile, Tool/version, ToolScope, TTL y hash de argumentos.

## 13. Side effects

La card lista solo efectos planificados. Siempre muestra creación interna; Calendar aparece con agente; WhatsApp y reminder solo cuando el status inicial canónico es `confirmed`. Los efectos internos obligatorios quedan dentro de la transacción. Calendar, WhatsApp y reminder se materializan como comandos `RE_Visit_Create_Effects` y se despachan después del commit.

## 14. Confirmation

`action_confirmation` se reutiliza sin crear `visit_confirmation`. Muestra Lead, inmueble, fecha, hora, duración, comercial, status, warnings y acciones posteriores. Cancelar es terminal. La frase “confírmala tú” se elimina solo del parse temporal y aun así produce Draft pendiente.

## 15. Confirm recheck

Confirm carga el Draft canónico, valida token, firma, mismo actor, tenant, session lineage, permissionsVersion, TTL, feature gate y Policy. Reautoriza Lead y Property y llama `/visits/commit-visit`. El backend valida de nuevo HMAC/args/preconditions y `commitVisitCreate` resuelve fresh Opportunity, Agent, duración, status, elegibilidad, side-effect plan y HARD constraints.

## 16. TOCTOU

Prueba staging: Prepare libre, inserción controlada de otra Visit solapada y Confirm. Resultado `DRAFT_STALE`/constraint failure, cero Visit adicional y cero efecto externo del Draft. El lock estable y el recheck transaccional cierran la carrera.

## 17. Concurrency

Dos Drafts distintos del mismo agente a 17:00–18:00 y 17:30–18:30, confirmados concurrentemente: exactamente uno committed y uno `VISIT_CONSTRAINT_FAILED`. Dos recursos independientes con agentes distintos: dos commits. No existe lock global; solo se serializan días/agentes que comparten recurso.

## 18. Idempotency

El UUID del Draft es la idempotency key de dominio. `RE_Agent_Write_Commits` se reclama y adjunta dentro de la misma transacción que Visit, internals y outbox. Double click, replay y lost response devuelven el mismo Visit. Prueba concurrente: una Visit, un Agent receipt y una unidad de cada comando de efecto.

## 19. Outbox

`RE_Visit_Create_Effects` tiene clave única por Visit/effect, claim de estado y contador de intentos. El dispatcher no ve filas antes del DB commit. En fixture sin proveedores: Calendar y WhatsApp quedaron `skipped` observables; reminder `succeeded`. Replay y nuevo dispatch no duplicaron comandos ni reminder. El recovery runner existe; staging mantiene cron OFF.

## 20. Resulting EntityRef

Commit devuelve `{type:"visits.visit", id}` y la taxonomía visible es `visits.visit:<id>`. No se creó un tipo paralelo.

## 21. UI

La UI generalizó `action_confirmation` con `warnings` y `sideEffects`. No renderiza efectos ausentes. La prueba React cubre una tarjeta R2 de Visit, labels finales, warnings y acciones reales. El shell fue actualizado de tres a cuatro Safe Writes.

## 22. AI Platform

Runs y eventos registran `visits.create_visit.v1@1`, `visits@1`, ToolScope unitario, R2, refs, payload firmado, constraints Prepare, lifecycle y resultado. `write.committed` proyecta EntityRef y detalles de efectos. Tokens, HMAC y secretos no se exponen. El parse Visit informa inferencia/tokens/coste cero.

## 23. Realtime

Convex conserva Draft y transiciones `proposed`, `cancelled`, `stale`, `failed`, `committed`; refresh/session rotation mantiene el Draft. Confirm concurrente espera el lease corto y devuelve terminal idempotente. Side-effect details se guardan con el resultado de commit y en el evento visible.

## 24. Security

HMAC-SHA256 usa JSON canónico y compare timing-safe. Lead, Property, Opportunity, Agent, datetime, duración, status, efectos, TTL, actor, session, tenant, permissionsVersion y args están firmados. Tampering, cross-user, cross-tenant, permission change, stale references y auto-confirm fallan antes de Product Data.

## 25. Evaluation corpus

`evals/safe-writes/visits-create-visit-v1.ts` genera 200 escenarios (50 ground-truth templates × 4 variantes) dentro del objetivo 180–240. Cubre ES/CA/EN, temporal/ambigüedad, provenance, Opportunity, Property, constraints, concurrencia, lifecycle, seguridad y side effects.

## 26. Metrics

Cada escenario declara `shouldDraft`, risk, Lead, Property, Opportunity, Agent, start, duration, HARD, advisories, plan, Confirm, Visit/receipt/effect counts. Tests: Draft precision 100%, temporal accuracy 100%, ambiguity 100%, Prepare/Confirm constraint accuracy 100%; mutation pre-confirm, unauthorized Visit, duplicate Visit/receipt/effect, invalid HARD commit, cross-user/tenant, tamper, permission bypass, auto-confirm y direct-LLM commit: cero.

## 27. Browser E2E

El harness live de staging ejecutó A–J contra el mismo API/runtime/Convex desplegado: Draft sin mutación, cancel, commit, refresh, double click, TOCTOU, Property stale, assignment stale, advisory visible y hora ambigua. La UI real de staging se inspeccionó en Chrome; 390×844 tuvo `scrollWidth=390`, sin overflow. La tarjeta real se cubre además por test de componente con payload R2; la sesión Chrome disponible era un agente normal y confirmó correctamente DENY para creación admin-only.

## 28. Concurrent-Draft proof

La suite de esquema MySQL completo pasó 6/6 en `realestate_staging`: same-agent different-Draft produjo 1 commit + 1 conflict; different-agent produjo 2 commits; same-Draft produjo una Visit + un receipt; fallo del receipt hizo rollback de todas las filas.

## 29. Side-effect proof

Fixtures `example.test`, números no reales y tenant sintético, sin conexiones de proveedores. No se hizo llamada externa antes de commit. Calendar/WhatsApp/reminder nacieron del outbox. Los no conectados fueron `skipped` y reminder fue único. Replay del dominio no recreó filas; el dispatcher no volvió a reclamar efectos terminales.

## 30. Cleanup

La prueba restauró password del admin, assignment, estado Property y Opportunity. Eliminó Visits, reminders, effect rows, notifications, mensajes/historial/funnel, relationships, receipts, creation requests, locks, entidades y usuarios sintéticos. Readback staging: Leads 0, Properties 0, Agents 0, Visits 0, Agent receipts 0 y orphan effects 0. Todos los Drafts creados quedaron terminales.

## 31. Regressions

Runtime completo: 35 files/218 tests. API: 149 files, 1397 passed y 50 skipped. Web: 36 files/174 tests. Shared: 249 tests. Lead Status, Lead Note, Task, seis reads, dos Skills, Explicit User Memory y `lead.analyze_opportunities` permanecen verdes.

## 32. Safe Write reuse

Safe Writes aporta intent, security binding, confirmation, lifecycle, receipt e idempotency cross-system. La única generalización necesaria fue relaciones múltiples, provenance assistant-only, riesgo configurable y proyección de detalles. No contiene scheduling, Opportunity, duración, elegibilidad ni efectos Visits.

## 33. Boop reuse and Core delta

Interaction/Execution Agent, profiles, registries, Policy, ActorContext, EntityRefs, events, Convex y AI Platform se reutilizan. Los cambios están bajo `server/hostmate`; archivos Boop Core, Memory, Skills y Multi-Agent: cero. El ajuste R2 aclara que una Tool `mode=draft` prepara de forma read-only y que la confirmación pertenece al commit separado.

## 34. Production blockers

Producción no fue desplegada, migrada ni habilitada. Staging usa runtime `visit-safe-write-20260816-r1` y API/Web `visit-safe-write-20260816-r2`, ambos 1/1 y con crons OFF. Antes de producción, el recovery runner del Visit outbox debe conectarse a un worker/cron dedicado; no se deben activar todos los crons del proceso web.

## 35. Recommendation

`CONSTRAINT_AWARE_WRITE_GENERALIZATION: GENERALIZED`. La cuarta Safe Write demuestra composición limpia: Safe Write Engine gobierna intención/confirmación/seguridad/idempotencia/lifecycle y Visits Domain gobierna relaciones/duración/scheduling/concurrencia/side effects. Recomendación: cerrar primero el worker dedicado del outbox y después iniciar una fase exclusivamente semántica para evaluar reschedule/cancel; no implementar aún una quinta write.
