# Boop Safe Writes V4 — Visit Creation Domain Compatibility Spike

## 1. Objetivo

Auditar si `visits.create_visit.v1@1` puede ser la cuarta Safe Write sin reducir las garantías ya demostradas por Status, Note y Task. El spike concluye `ADJUST`: no se registra, implementa, activa ni despliega la capability porque el dominio actual no ofrece una frontera canónica que combine creación individual, restricciones transaccionales y side effects controlados.

## 2. Visit domain audit

La auditoría cubrió `RE_Visits`, `RE_Visit_Events`, booking tokens, property slots, visitas grupales, rutas/controllers, `visit.service.ts`, `booking.service.ts`, routing, duración, calendarios, reminders, WhatsApp, notificaciones, opportunity lifecycle y UI manual. La conclusión no se basa en las Tools read-only del Agent Platform.

Hallazgos determinantes:

- `POST /api/v2/visits` es el flujo manual actual y exige `requireRole('admin')`.
- `visitService.createManual` es el servicio de dominio existente, pero inserta antes de varios side effects y no comprueba disponibilidad ni solapamientos.
- `POST /api/v2/visits/preview-routing` calcula solapamiento, buffer y viaje, pero solo alimenta un banner informativo.
- `CreateVisitModal` permite pulsar «Crear visita» aun cuando el preview responde `state=block`.
- no existe lock, nivel serializable, constraint UNIQUE/exclusion ni claim de recurso que proteja dos Drafts distintos para el mismo intervalo.
- una creación manual auto-confirmada puede crear notificaciones, evento de Google Calendar con asistente externo, WhatsApp y reminder.

## 3. Canonical models

El modelo individual canónico es Prisma `ReVisits`, tabla `RE_Visits`. Guarda `visit_datetime DATETIME`, `duration_minutes`, `agent_id`, `status`, snapshots del inmueble y cliente, `opportunity_id`, `slot_id`, `token` y `google_event_id`.

No existen columnas `lead_id` ni `property_id` en `RE_Visits`. La atribución fuerte de una visita individual a Lead e inmueble se realiza mediante `opportunity_id`; `property_ref`, `property_title`, `property_address`, `client_name` y `client_phone` son snapshots, no EntityRefs de autoridad.

`RE_Visit_Events` es un modelo aparte para eventos de lifecycle, especialmente reprogramación/cambio de estado. `createManual` no crea una fila `visit_created` en esta tabla.

## 4. Individual vs group

Individual y Group Visit son modelos y flujos distintos. Individual usa `RE_Visits`. El flujo grupal legacy usa `RE_Group_Visits` y `RE_Group_Visit_Registrations`; además, la arquitectura más nueva unifica capacidad pública mediante `RE_Property_Slots` y múltiples filas `RE_Visits` enlazadas por `slot_id`.

Una V1 individual puede definirse conceptualmente sin Group Visit, pero la reserva/capacidad basada en slots y la convivencia de dos arquitecturas grupales impiden asumir que cualquier fecha para un inmueble es un recurso individual libre. Group Visit queda fuera de scope y no se reconduce a individual.

## 5. Current manual creation flow

Flujo real: `CreateVisitModal` → `POST /api/v2/visits` → `visitService.createManual`.

Con `opportunity_id`, el servicio:

1. resuelve una Opportunity tenant-scoped, activa, no fusionada y `crm_scope=inmueble`;
2. deriva Lead e inmueble de esa Opportunity;
3. exige Lead no borrado con teléfono e inmueble no borrado con referencia;
4. valida, si existe, un `agent_id` activo del tenant;
5. inserta `RE_Visits` directamente;
6. ejecuta notificación, Calendar, asociación Lead↔Property, mensajes de sistema/funnel y avance de Opportunity;
7. si el comercial elegido es el actor creador, usa status `confirmed` y ejecuta confirmation effects.

Sin `opportunity_id` existe un path legacy por referencia de inmueble y último Lead por teléfono. Ese path es ambiguo e inaceptable para una write basada en EntityRefs.

## 6. Relations

Para una futura capability segura, Lead y Property deberán llegar como EntityRefs seleccionadas y autorizadas. El backend deberá resolver exactamente una Opportunity activa, no fusionada, del mismo tenant, con ese `lead_id` y `property_id`. Si no existe o hay más de una, la operación debe responder `needs_input`/conflict, nunca inferir por teléfono, referencia o visita histórica.

La relación persistida sería `RE_Visits.opportunity_id`; los datos de Lead/Property se copiarían como snapshots mediante el servicio de dominio. No se acepta ID manual, referencia libre ni búsqueda automática durante la write.

## 7. Permissions

La creación manual actual es admin-only. `requireRole('admin')` no concede acceso al rol `agent`; el superadmin efectivo debe operar bajo una identidad/ruta compatible con la policy de producto. El token actual del Agent Platform concede `visits.read`, pero no existe un permiso canónico `visits.write`; el canary Safe Writes solo añade `crm.write` a actores allowlisted.

Decisión: no inventar `visits.write`, no reutilizar `crm.write` como equivalencia y no ampliar Agent. Una futura implementación necesita una decisión explícita de producto y un permiso canónico respaldado por la misma policy que la UI/API.

## 8. Risk

`R1` solo sería defendible para una creación interna reversible y sin comunicaciones externas. El flujo canónico actual puede enviar una invitación de Google Calendar al email del Lead (`sendUpdates=externalOnly`), WhatsApp de confirmación y programar un reminder, además de mutar CRM. Por tanto, sin separación explícita, la operación es como mínimo `R2` dentro de la taxonomía existente.

No se asigna riesgo final a una capability inexistente. La recomendación es separar primero `create internal visit` de `notify client`, con contrato de dominio explícito; después reclasificar.

## 9. Side effects

| Side effect | Manual Visit | Agent Visit V1 | decisión del spike |
| --- | --- | --- | --- |
| Visit row | Sí | No implementado | requiere frontera transaccional |
| Visit Event | No en `createManual` | No implementado | no inventarlo |
| Lead update/association | Sí, asociación + mensajes | No implementado | conservar solo vía dominio |
| Opportunity | Sí, `visit_scheduled` | No implementado | debe ser atómico o recuperable |
| Booking Token | No | No | no añadir |
| Notification | `visit_created`; también `visit_confirmed` | No implementado | side effect interno conocido |
| WhatsApp | Sí si auto-confirm y template listo | Prohibido en V1 sin decisión | STOP externo |
| Email | No email directo | No | Calendar puede invitar por email |
| Reminder | Sí si auto-confirm | Prohibido sin diseño | STOP diferido/externo |
| Calendar | Best effort si hay agente; puede invitar Lead | Prohibido sin diseño | STOP externo |
| Analytics/funnel | Fila `RE_Lead_Messages` `visit_request` | No implementado | side effect conocido |

## 10. Scheduling

`RE_Visits` guarda un único inicio (`visit_datetime`) y una duración; no guarda `end_datetime`. El final se deriva como inicio + duración. Puede haber visita sin agente (`floating`) y el schema permite `visit_datetime` nullable, aunque la creación manual exige fecha/hora. El modelo individual no tiene FK obligatoria a Property o Lead, y el path legacy permite crear sin relación fuerte.

La V1 propuesta exigiría Lead, Property, agente server-controlled, fecha y hora exactas, pero esa V1 no se activa mientras no haya enforcement canónico de restricciones.

## 11. Conflicts

El dominio contiene una regla explícita en routing: el solapamiento con otra visita nunca se relaja. `checkHardFilters` también contempla buffer y viaje entre inmuebles diferentes y permite back-to-back en el mismo inmueble.

Sin embargo, esa regla no se aplica en `createManual`; el preview puede fallar abierto si no puede leer datos y el submit ignora `block`. El booking público comprueba en varios paths coincidencia exacta de hora, no siempre solapamiento por intervalos, y tampoco encapsula check+insert con una garantía de concurrencia. Por ello las reglas observadas son inconsistentes entre presentación, creación manual y reserva pública.

## 12. Availability

Routing puede consultar visitas del agente, configuración de routing, coordenadas, buffers, viaje y busy externo de Google Calendar. Property slots exponen capacidad para reservas públicas. No existe una única función canónica `assertVisitCanBeCreated` usada por Prepare y por commit.

La disponibilidad de inmueble tampoco está unificada: booking rechaza `desactivado`, `vendido`, `reservado` y `alquilado`; `createManual` solo exige `deleted_at=null`. El spike no elige una regla nueva.

## 13. Duration

`RE_Visits.duration_minutes` tiene default 60. `visit-duration.service.ts` puede resolver override por inmueble, modo tenant uniforme o por clase, con defaults por clase y fallback exportado 30. Booking usa slot → resolver property/tenant → legacy 60.

`createManual` no llama al resolver, no persiste una duración explícita y crea Calendar con 60 minutos fijos. No hay por tanto un valor canónico único para la creación manual. Una futura V1 no puede inventar 30/60; antes debe alinearse el servicio manual con una sola resolución server-side y firmar el valor final.

## 14. Timezone

La agenda de Visits usa `DATETIME` como wall-clock local de España. `parseVisitWallClockDateTime`, los formatters wall-clock y `visitWallClockToInstant` aplican `Europe/Madrid`. El serializador HTTP evita tratar esos campos como instantes UTC ordinarios.

Una futura write deberá firmar fecha, hora, zona e instante resuelto, rechazar horas DST inexistentes y no reinterpretar lenguaje natural al confirmar. El spike no modifica esta primitive.

## 15. Capability contract

Contrato recomendado, no registrado:

```text
visits.create_visit.v1@1
owner=visits
profile=visits@1
mode=draft
ToolScope=[visits.create_visit.v1@1]
operationType=create
operation=visit.create
```

Input futuro: Lead EntityRef seleccionada + Property EntityRef seleccionada + `VisitCandidate`. Sin búsquedas, IDs, tenant, agente, status, Opportunity, side-effect flags ni auto-confirm aportados por el modelo.

## 16. Provenance

Lead y Property deben provenir de `contextRefs.selected` o de EntityRefs explícitas con provenance vigente. Prepare debe autorizar ambas dentro del tenant, internalizar IDs y resolver la Opportunity. Confirm debe repetir autorización, assignment del Lead, estado del inmueble y relación Opportunity. Snapshots y referencias comerciales no sustituyen provenance.

## 17. VisitCandidate

Contrato mínimo futuro:

```ts
type VisitCandidate = {
  startDate: string;       // YYYY-MM-DD
  startTime: string;       // HH:mm exacto
  startAtUtc: string;      // instante resuelto y verificable
  timezone: "Europe/Madrid";
  temporalPhrase: string;
  referenceTime: string;
  inference: 0;
};
```

Duration, assignee, Opportunity, status y constraints son server-authoritative y no deben entrar desde el LLM. La duración solo se añadirá al payload estructurado después de que el dominio defina un resolver único.

## 18. Temporal reuse

El parser determinista de Tasks puede reutilizar fechas relativas, weekdays, fechas explícitas, hora 24 h, zona y ambigüedad. Visits exige hora exacta: «mañana» y «mañana por la tarde» deben dar `needs_input`. No se acepta daypart, AM/PM ambiguo, pasado, batch, recurring ni reschedule. Parsing/inference no se implementaron porque el spike paró antes del vertical slice.

## 19. Safe Write reuse

Si se desbloquea el dominio, se reutilizarían Registry, Preparation Engine, WriteIntent, hashing, HMAC, Draft lifecycle, actor/session/version, confirmation, fencing, receipts, events, realtime, `action_confirmation` y AI Platform. El motor actual no es el bloqueo.

No se modificó ninguna primitive genérica porque el requisito nuevo —reserva concurrente de un recurso temporal— debe resolverse primero en el dominio Visits, no dentro de Convex ni mediante idempotencia del Draft.

## 20. WriteIntent

No hubo cambios. Un futuro intent tendría `target`/relations para Lead y Property, payload con valores temporales y defaults resueltos, y preconditions de assignment, Opportunity, Property, Agent, duration/config y constraints. El hash/HMAC deberá cubrir todos esos campos y el TTL.

No se añade ahora un `constraintFingerprint` genérico: un snapshot ayuda a explicar el Draft, pero no sustituye el recheck transaccional.

## 21. Signing

La firma actual es suficiente en estructura: canonicalization, SHA-256, HMAC-SHA256 y compare timing-safe. Para Visits debería cubrir EntityRefs, IDs internalizados, Opportunity, agente server-side, datetime, duración, defaults, side-effect mode, preconditions, operation y expiry. Confirm debe rechazar cualquier alteración antes de tocar Product Data.

## 22. Constraints Prepare

Modelo futuro: comprobar Lead/Property/Opportunity, agente activo, estado de inmueble, duración resuelta, fecha futura, horario/slot y reglas de solapamiento/buffer/viaje. El resultado sería un snapshot informativo firmado, no una reserva.

Estado actual: no implementable con precisión 100%, porque no hay una única autoridad de disponibilidad y `createManual` no consume el preview.

## 23. Constraints Confirm

Confirm debería repetir toda autorización y constraint con datos frescos dentro de la misma frontera de commit. El preview de routing no sirve como Confirm recheck: es un endpoint admin de UX, puede quedar disabled/fail-open, busca alternativas y no bloquea el insert.

Estado actual: no existe un path canónico que revalide y cree de forma indivisible.

## 24. TOCTOU

El caso «Prepare libre → otra visita ocupa el intervalo → Confirm» no está protegido. Volver a llamar al preview antes del insert seguiría dejando una carrera entre check e insert. Draft idempotency solo protege el mismo Draft; no serializa dos Drafts diferentes.

Esta ausencia activa explícitamente una STOP condition. No se ejecutó un E2E que pretendiera certificar una propiedad que el esquema no puede garantizar.

## 25. Concurrency

Estrategias válidas a evaluar en una fase de producto/dominio:

- transaction `SERIALIZABLE` con recheck y retry bien probado;
- lock estable de recurso `(tenant, agent, day)` antes del overlap query;
- tabla/claim de intervalos con constraint apropiado;
- primitive canónica ya adoptada por property slots.

MySQL no ofrece una exclusion constraint de rangos equivalente a PostgreSQL de forma directa. La elección debe pertenecer a Visits y cubrir duración, status activos, slots, grupos y recursos externos. No se construyó un scheduling engine general.

## 26. Preconditions

Preconditions futuras mínimas: Lead existente/no borrado/no fusionado y assignment esperado; Property existente/visible/estado esperado; una Opportunity única y activa; actor-agent mapping activo; duración/config esperadas; datetime futuro; status inicial y side-effect mode; constraint snapshot explicable. Todas deben reautorizarse en Confirm.

## 27. Deterministic commit

Path requerido, aún inexistente:

```text
Signed Draft → actor/session/version → Policy → Lead + Property + Opportunity
→ duration/time validation → lock resource → constraints fresh
→ idempotency claim → canonical Visit service → Visit/CRM effects/receipt
→ commit → post-commit effects explicitly classified
```

El LLM no participaría en Confirm. `createManual` no cumple hoy esta secuencia.

## 28. Transaction boundary

`createManual` hace un `prisma.reVisits.create` y después múltiples operaciones independientes. Si notificación, asociación o lifecycle fallan, puede quedar una Visit parcial; Calendar/WhatsApp/reminder son best effort y externos. Tampoco incluye el receipt del Agent Platform.

Antes del GO se necesita un Domain Service con una transacción que abarque al menos constraint lock/recheck, Visit, side effects internos obligatorios y `RE_Agent_Write_Commits`. Los efectos externos deben ser post-commit/outbox, visibles y con su propia idempotencia, o quedar fuera de V1 por contrato de producto.

## 29. Idempotency

`RE_Agent_Write_Commits` ya resuelve double click, replay, lost response y concurrencia del mismo Draft para otras Safe Writes. Se reutilizaría. El servicio manual actual no acepta idempotency key ni receipt.

No se certifica idempotencia de Visit porque no existe implementación. En particular, un receipt no evita dos Visits de dos Drafts distintos que compiten por el mismo intervalo.

## 30. Result EntityRef

La taxonomía canónica ya existe: `{ type: "visits.visit", id }`, presentada como `visits.visit:<id>`. No debe crearse `crm.visit` ni una entidad Draft paralela. No se emitió ninguna EntityRef nueva durante el spike.

## 31. Failure recovery

Una futura implementación deberá fallar antes del insert para firma, actor, tenant, permission, provenance y preconditions inválidas; marcar stale en assignment/property/slot; recuperar same-Draft desde receipt; y no intentar compensar un mensaje externo ya enviado borrando la Visit. La necesidad de una política/outbox de efectos externos es precisamente uno de los bloqueos.

## 32. Confirmation UI

`action_confirmation` es reutilizable. El Draft futuro debería mostrar Lead, inmueble, fecha, hora, duración, comercial, constraint snapshot, riesgo y cada side effect externo. No se crea `visit_confirmation`.

No se añadió renderer porque no hay capability activable; enseñar una confirmación incompleta ocultaría WhatsApp/Calendar/reminder y sería inseguro.

## 33. AI Platform

Sin implementación no aparece `visits.create_visit.v1` en Inventory, runs ni Drafts. Una versión futura deberá exponer profile/ToolScope/risk/operation, EntityRefs, temporal final, constraint Prepare/Confirm, lifecycle, Visit result, side effects, latencia, tokens, inference y coste.

## 34. Realtime

El lifecycle actual soporta proposed/cancelled/stale/failed/committed y sería reutilizable. No se emitieron eventos Visit ni se creó Draft. Refresh no se probó para esta capability porque el spike se detuvo antes de registro/Prepare.

## 35. Evaluation corpus

No se generó el corpus de 160–220 casos: hacerlo antes de fijar las reglas canónicas produciría ground truth inventado. El futuro corpus deberá cubrir targets, temporal, duración, roles, constraints, lifecycle, idempotencia y seguridad con expected Visit/receipt/side effects explícitos.

## 36. Metrics

No hay métricas de precisión, latencia o concurrencia de una capability inexistente. Los únicos resultados verificables son estáticos: mutation-before-confirm=0, unauthorized Visit=0, duplicate Visit=0, duplicate receipt=0 e invalid conflict commit=0 durante este spike, porque no se ejecutó ninguna write.

No se presentan esos ceros como prueba de seguridad funcional.

## 37. Browser E2E

No ejecutado. Los flows A–J requieren una implementación segura. La UI manual sí fue auditada en código y demuestra que el banner `block` no deshabilita submit; esto basta para descartar su reutilización como constraint gate. No se tocaron fixtures ni staging.

## 38. Cleanup

No hubo Product Data, Drafts, receipts, Visits, Events, cambios de assignment/property ni side effects sintéticos que limpiar. Repositorios de integración conservan los cambios deliberados de documentación únicamente. Producción permanece intacta.

## 39. Regressions

No cambió runtime, Hostmate API/Web, Convex, registry, Tools, Skills, Memory ni Multi-Agent. Por tanto Task, Lead Note, Lead Status, seis reads, dos Skills, Explicit User Memory y `lead.analyze_opportunities` quedan sin delta de esta fase. Se ejecutarán sus gates completos cuando exista una implementación Visit que pueda afectarlos.

## 40. LOC/generalization

Visit-specific production LOC: 0. Generic Safe Write LOC modified: 0. Temporal/constraint helper LOC: 0. Core Boop files modified: 0. Backend/frontend reuse porcentual: no medible sin implementación.

`CONSTRAINT_AWARE_WRITE_GENERALIZATION=NOT_GENERALIZED`: no es un fallo del Safe Write Engine; la generalización no puede certificarse hasta que el dominio ofrezca constraint recheck y commit concurrente seguros.

## 41. Core delta

Core Boop, provider routing, OpenRouter, model configuration, Convex schema/functions, approval lifecycle y confirmation UI: sin cambios. Hostmate Product Data/API/Web: sin cambios. Solo se añade este informe de compatibilidad.

## 42. Production blockers

Bloqueos para un nuevo spike:

1. definir una única regla canónica de conflicto (interval overlap, estados, buffer/viaje, Google busy y slots);
2. alinear creación manual, preview y booking con esa autoridad;
3. elegir y probar locking/transaction para dos Drafts distintos;
4. unificar duración manual y booking;
5. definir estado válido del inmueble;
6. resolver Lead+Property a una Opportunity única;
7. separar o hacer explícitos Calendar invitation, WhatsApp y reminder;
8. crear permiso/policy canónicos sin ampliar Agent silenciosamente;
9. hacer Visit + side effects internos + receipt atómicos o recuperables.

No hay migración ni deploy de staging/producción en esta fase.

## 43. Recommendation

Resultado: `ADJUST`. No implementar `visits.create_visit.v1@1` todavía. La siguiente fase recomendada no es otra capability: es un hardening del dominio Visits que introduzca `prepareManualCreate`/`commitManualCreate` (nombres por decidir), una primitive de constraint transaccional y un modo de side effects explícito compartido por Web/API y Agent Platform.

Safe Writes no están listos para `reschedule_visit` ni `cancel_visit`: ambas operaciones heredan más side effects y reglas de lifecycle. Tras cerrar los bloqueos, repetir este mismo compatibility spike y solo entonces construir el corpus/E2E. No implementar una quinta write.
