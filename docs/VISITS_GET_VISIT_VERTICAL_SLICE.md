# `visits.get_visit.v1` vertical slice

## 1. Fuentes canónicas de detalle

La visita individual se lee con `visit.service.getById(tenantId, visitId, false)` sobre `RE_Visits`. La visita grupal legacy se lee con `group-visit.service.getById(tenantId, groupVisitId)` sobre `RE_Group_Visits`. La última reprogramación individual se obtiene con la nueva lectura acotada `visit-events.service.getLatestRescheduleEvent`. MySQL/Prisma siguen detrás de servicios Hostmate; no existe un Prisma Product Tool ni una segunda fachada de persistencia.

## 2. Individual vs group visits

El contrato es una unión discriminada por `kind`. `visits.visit` resuelve la variante `individual`, incluidas las reservas modernas de slots con capacidad mayor que uno. `visits.group_visit` resuelve la variante `group` de las tablas legacy y sólo expone capacidad y contadores agregados. Las dos rutas conservan identidad y estados propios; no se simula una variante con la otra.

## 3. Authorization

El `EntityRef` sólo localiza. En cada request, Hostmate deriva tenant, usuario y rol del JWT firmado. Para agent, una visita individual exige que su lead atribuido esté asignado actualmente al actor; una visita grupal exige al menos un lead registrado asignado actualmente. Admin puede leer dentro del tenant efectivo. Superadmin usa exactamente el tenant efectivo firmado, no un tenant enviado por la tool. Reasignación, merge y relaciones obsoletas se revalidan. Atribución ambigua por fallback deniega al agent; admin recibe detalle tenant-scoped sin `crm.lead`.

## 4. Tool ownership/profile compatibility

`visits.get_visit.v1` pertenece a Visits, es compatible con perfiles `visits` y `crm`, usa `mode=read`, riesgo `R0`, capability `visits.visit.detail` y permiso `visits.read`. Ownership de tool no obliga a crear un Visits Execution Run: una tarea CRM compuesta puede importar la tool de Visits dentro de un único run CRM.

## 5. Contract

El input estricto es exclusivamente:

```ts
{ visit: EntityRef<"visits.visit" | "visits.group_visit"> }
```

No admite nombre, búsqueda, lead, `visitId`, tenant, actor, filtros ni paginación. La referencia solicitada debe coincidir en ID y kind con la respuesta del servicio. `NOT_FOUND`, `PERMISSION_DENIED` y `STALE_REFERENCE` se conservan como errores tipados.

## 6. Services reused

El facade `agent-platform-visit-detail.service` usa `visit.service.resolveLeadAttributions`, `lead.service.getById` mediante la autorización compartida, `visit.service.getById`, `group-visit.service.getById` y `visit-events.service.getLatestRescheduleEvent`. Se corrigieron joins auxiliares de agente/inmueble para incluir `tenant_id`. No se usa `group-visit.service.getRegistrations`, porque devuelve tokens y PII de participantes.

## 7. DTO

Ambas variantes incluyen fecha/hora ISO, timezone en el Product Tool, estado real, tipo, duración, inmueble opcional, lead opcional y comercial. Individual añade confirmación, estado de slot grupal y última reprogramación separada. Group añade `registration.status` sólo cuando corresponde inequívocamente al lead autorizado, `capacity`, `registeredCount` y `availableCapacity`. Se excluyen timeline, eventos completos, metadata, notas, dynamic answers, calificación, proveedores, Google IDs, tokens, tenant IDs, logs, datos de participantes y filas completas.

## 8. EntityRefs

La taxonomía queda fijada en `visits.visit`, `visits.group_visit`, `crm.lead` y `property.property`. El inmueble sólo emite `property.property` cuando Hostmate ha resuelto su primary key tenant-scoped; `reference` sigue siendo un atributo, no autoridad. Los deep links de visita y la acción de selección son controles separados.

## 9. contextRefs

`contextRefs` dejó de ser un array ambiguo y ahora tiene forma semántica:

```ts
{
  selected: { lead?: EntityRef; visit?: EntityRef };
  referenced: EntityRef[];
}
```

`selected` mantiene el foco conversacional; `referenced` registra las entidades del último resultado. Los bloques y `ExecutionResult.entities` siguen siendo el resultado visible. El resolver conserva compatibilidad de lectura con mensajes antiguos que tengan un array.

## 10. Selected lead + selected visit semantics

Seleccionar una visita mantiene el lead ya seleccionado. Seleccionar un lead nuevo limpia una visita anterior. Un detalle directo puede recuperar el lead autorizado devuelto por Hostmate y persistir ambos. Ninguna de esas referencias evita la reautorización en la siguiente request.

## 11. Composition

Los recorridos soportados son: lista → selección explícita/ordinal → detalle; visita ya seleccionada → detalle; y búsqueda única → próximas visitas → primera visita → detalle. “La segunda” usa el orden exacto del último `entity_list`. “Cuéntame más” reutiliza la visita seleccionada. Si la búsqueda devuelve cero o varios leads no se elige uno por inferencia.

## 12. Execution Run decision

La tarea “Busca a Juan, dime su próxima visita y cuéntame más” usa un único CRM Execution Run porque conserva un objetivo CRM continuo y sólo importa lecturas compatibles de Visits. Un objetivo independiente de agenda —por ejemplo optimizar el día, comparar rutas o coordinar varias visitas sin partir de un lead— debe abrir un Visits Execution Run separado. Ownership de tool y perfil de run son decisiones distintas.

## 13. Tool scoping

Los scopes exactos son: lead seleccionado + listar, `[visits.list_lead_visits.v1@1]`; visita seleccionada + detalle, `[visits.get_visit.v1@1]`; búsqueda + visitas, `[crm.search_leads.v1@1, visits.list_lead_visits.v1@1]`; búsqueda + próxima + detalle, `[crm.search_leads.v1@1, visits.list_lead_visits.v1@1, visits.get_visit.v1@1]`. No se registra ni se expone una quinta capability.

## 14. Deterministic paths

Seleccionar, resolver ordinal, listar desde un lead seleccionado y obtener detalle usan cero llamadas de modelo. El recorrido desde cero usa OpenRouter una sola vez para ejecutar `crm.search_leads`; listado, selección del primer resultado temporal y detalle son deterministas. El texto y las cards se renderizan desde DTOs validados, sin síntesis cosmética.

## 15. AI Chat

Las cards de `visits.visit` y `visits.group_visit` son seleccionables. “Seleccionar y ver detalle” envía el `EntityRef`; “Abrir … en la aplicación” navega por deep link y no cambia selección. Ambos controles tienen un target mínimo de 44 px. Las cards discriminan visita individual/grupal y muestran únicamente campos bounded.

## 16. AI Platform

Los eventos durables muestran profile, versión, scope exacto, input solicitado/sanitizado, EntityRefs de resultado, kind, servicios usados, latencia total, latencia de atribución, latencia del servicio de detalle, estado, provider/model cuando existe, inference count, tokens y coste. Los runs deterministas persisten sin modelo solicitado, sin usage y con `inferenceCount=0`.

## 17. Realtime/reconnect

Mensajes, selección semántica, runs, attempts, usage y eventos permanecen en Convex. Una reconstrucción del cliente, repositorio y vertical slice recupera `selected.lead` y `selected.visit`; “Cuéntame más” vuelve a invocar `get_visit` y reautoriza. No se usa Memory para este estado conversacional.

## 18. Performance

La atribución de detalle limita el SQL canónico al visit ID y kind. El listado reutiliza la misma expresión sobre el tenant y mantiene límite 10. Las lecturas de detalle y evento son de una fila. La telemetría separa `attributionLatencyMs`, `detailServiceLatencyMs`, `eventServiceLatencyMs` y latencia end-to-end del adapter. En el E2E real del 2026-08-15, el detalle midió 2.627,40 ms end-to-end, 425,66 ms de atribución y 1.613 ms de `visit.service.getById`; selección y reconnect consumieron cero inferencias. No hubo writes CRM/MySQL.

## 19. Tests

La cobertura incluye schema estricto, handler directo malicioso, sanitización, refs canónicas, variantes individual/group, permiso `visits.read`, tenant A/B en adapter, agent/admin/superadmin, no atribución, fallback ambiguo, reasignación, merge, missing/foreign visit, group aggregates, scopes exactos, selección directa, “La segunda”, cero inferencias, composición de tres tools y reconexión con doble selección. También se validaron contra producción, en lectura, una atribución individual por opportunity y una group por registration; ambas coincidieron con `listByLead`.

## 20. Riesgos

Las tablas grupales legacy pueden contener una inscripción apuntando a un lead inexistente; en el muestreo real ocurrió en group visit 7. Un agent queda denegado porque no puede demostrar asignación actual; admin puede leer el evento tenant-scoped, pero no recibe lead ni estado de inscripción asociado. El fallback por teléfono sigue siendo débil y sólo se acepta si existe exactamente un lead activo; el muestreo actual encontró cero casos ambiguos.

## 21. Deuda técnica

`visit.service.getById` sigue construyendo una respuesta legacy amplia para otras pantallas; el facade Agent Platform la reduce antes de cruzar el boundary, pero una futura refactorización del dominio podría ofrecer una proyección de detalle explícita. `RE_Group_Visits` y registrations continúan fuera del schema Prisma. El typecheck global de API conserva un fallo ajeno y previo en `dm-agent-v3/executor.ts`, que importa `appendIgDmOpenTracking` sin export existente.

## 22. Recomendación del siguiente paso

Detener la expansión de capabilities, ejecutar la revisión/aceptación de esta cuarta vertical slice y estabilizar la foundation: resolver la deuda de tipos ajena, decidir el tratamiento de inscripciones grupales huérfanas y preparar el posterior fork operativo sólo si esta revisión obtiene GO. No implementar todavía Property, demands, tasks, notes ni writes CRM.
