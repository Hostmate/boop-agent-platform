# Boop Safe Writes — Draft / Confirm — First Write

Fecha: 2026-08-16  
Capability: `crm.update_lead_status.v1`  
Scope: staging interno, canary tenant 15/user 43. Producción fuera de alcance.

## 1. Estado y alcance

Primera escritura de Product Data implementada bajo Draft/Confirm. El único cambio permitido es el estado agregado de un lead seleccionado. No incluye oportunidades, notas, tareas, mensajes, asignaciones, Skills, Memory, Automations ni Multi-Agent.

## 2. Decisión arquitectónica

El Execution Agent solo prepara un `WriteIntent` firmado e inmutable. Confirmar y cancelar son comandos HTTP deterministas. El commit no está registrado como Tool, no puede ser invocado por el modelo y consume cero inferencias, tokens y coste LLM.

## 3. Invariantes

Antes de confirmar, `RE_Leads`, `RE_Lead_Status_Log` y el ledger de commits permanecen sin cambios. Una firma no concede autoridad. Toda decisión vuelve a comprobar sesión, tenant, usuario, versión de permisos, canary, permiso y precondiciones.

## 4. Auditoría reuse-first de Boop

Boop upstream ya ofrecía `save_draft`, `list_drafts`, `send_draft`, `reject_draft`, Convex y estados pending/sent/rejected/expired. `send_draft` marcaba sent y lanzaba otro Execution Agent con payload libre para realizar la acción. Ese camino no es apto para Product Data porque el commit continuaba mediado por LLM, sin actor-bound signature, precondiciones ni fencing transaccional.

## 5. Matriz KEEP / ADAPT / EXTEND / REPLACE

| Primitiva | Decisión | Resultado |
|---|---|---|
| Convex y realtime de Boop | KEEP | mismo control plane y cliente autenticado |
| Concepto save/reject/expire | ADAPT | `WriteIntent` authority-bound y status más preciso |
| Foundation `SignedDraft`, hashes, tokens, risk, preconditions | EXTEND | HMAC, sesión, permissionsVersion, target/op y estados safe-write |
| `send_draft` upstream | REPLACE para Product Data | confirmación determinista; nunca Execution Agent |
| Registry, Profile, Policy y ToolScope | KEEP/EXTEND | una Tool draft R1 y permiso `crm.write` |
| Events/Runs/Attempts | KEEP | mismo lifecycle y trazabilidad |
| HMAC de Eva | ADAPT | canonicalización/HMAC SHA-256, sin reutilizar su contrato de dominio |
| Renderer Hostmate de blocks | EXTEND | block genérico `action_confirmation` |
| `leadService.updateStatus` | EXTEND | variante canónica precondicionada, atómica e idempotente |

Estimación estricta: Draft backend upstream Boop 35%; frontend Draft upstream 10%; Foundation Signed Draft 70%. La reutilización global del control plane/lifecycle/policy es mayor, pero no se mezcla con esos porcentajes.

## 6. Capability y versión

`crm.update_lead_status.v1@1`, owner `crm`, capability `crm.lead.status.prepare`, mode `draft`, risk `R1`, idempotency `required`, availability `active` solo bajo gate.

## 7. ActorContext

El actor procede del bridge Hostmate, token RS256 de cinco minutos y validación Convex. El draft fija tenant efectivo, actor, sesión lógica, `permissionsVersion` y override efectivo. Hostmate persiste `agent_platform_session_id` en la familia del refresh token para que una rotación normal no invalide el draft; logout/revocación elimina la familia. Ninguno aparece en el input JSON de la Tool.

## 8. Permiso real de escritura

`crm.write` es distinto de `crm.read`. Solo se emite para la intersección exacta de los allowlists safe-write. Prepare y commit lo exigen; superadmin conserva el comportamiento del policy central, pero el canary sigue siendo obligatorio.

## 9. EntityRef y provenance

La Tool exige `contextRefs.selected.lead` o una EntityRef `crm.lead` emitida por la UI y reautorizada. Un ID escrito en el mensaje no se parsea como autoridad. Falta de selección produce `needs_input` y cero drafts.

## 10. Vocabulario canónico

Los únicos estados son `new`, `contacted`, `qualified` y `visit_scheduled`. Alias ES/CA/EN se normalizan de forma determinista. Alias desconocidos o múltiples producen `needs_input`. Un no-op produce respuesta explícita y ningún draft.

## 11. Transiciones

El aggregate histórico permite las transiciones entre los cuatro estados; no existe una matriz adicional en el endpoint canónico. Safe Write preserva esa regla, pero añade current-status y current-assignment como precondiciones obligatorias.

## 12. Domain Service canónico

El commit llama `leadService.commitAgentPlatformLeadStatus`, extensión del servicio propietario. No hay SQL de negocio en el runtime ni un servicio paralelo.

## 13. Efectos laterales canónicos

Cambio de `RE_Leads.status`, fila `RE_Lead_Status_Log` con source `agent_platform` y mensaje de sistema best-effort, igual que la ruta histórica. Status, histórico y receipt idempotente comparten transacción; el mensaje se emite después del commit.

## 14. Riesgo y confirmación

Clasificación `R1` reutilizando la taxonomía Foundation. En esta fase toda escritura R1 exige confirmación explícita, aunque el policy histórico solo exigiera automáticamente R2 para algunos modos.

## 15. Contrato Tool

Input estricto: `{ lead: EntityRef<crm.lead>, requestedStatus: CanonicalLeadStatus }`. Rechaza tenant, usuario, rol, permisos, ID libre, patch, force, precondiciones, firma e idempotency key. Output: snapshot mínimo autorizado, no-op y telemetría.

## 16. Prepare

Prepare reautoriza sesión y permisos en el callback Hostmate, vuelve a resolver el lead por tenant y asignación, obtiene status/assignee y retorna snapshot. El runtime genera el draft; no se produce ninguna mutación MySQL.

## 17. WriteIntent genérico

El contrato incluye actor, source run, profile, Tool/version/scope, EntityRef target, operation, requested value, preconditions, args hash, idempotency key, risk, policy decision, expiry y token hash. No existe un `LeadStatusDraft` específico.

## 18. Hash, firma y secreto

JSON canónico por claves ordenadas, SHA-256 para args/token y HMAC-SHA-256 para el envelope completo. Comparación timing-safe. El secreto vive como Docker secret staging montado read-only en API y runtime; la firma nunca se presenta como autoridad ni se expone completa en UI/eventos.

## 19. Lifecycle

`proposed → confirmed → committing → committed`; terminales alternativos `cancelled`, `expired`, `failed` y `stale`. Convex valida ownership y transición; el run permanece `awaiting_confirmation` hasta terminal.

## 20. Expiración

TTL V1: diez minutos. Confirm/cancel vencidos materializan `expired`; un draft caducado no puede reactivarse ni commitirse.

## 21. Preconditions

Se firman `lead.status` y `lead.assigned_agent_id`. El servicio bloquea la fila con `SELECT … FOR UPDATE`, comprueba tenant, existencia, merge, deleted, assignment y ambos valores antes de mutar.

## 22. Confirmación

La UI envía solo draftId y token opaco al bridge. El bridge reautoriza la sesión y emite un Actor token fresco. Runtime verifica owner, firma, token, sesión lógica y versión antes de la transición atómica. Una rotación sintética real de refresh token en staging conservó el session binding y eliminó después sus filas de prueba.

## 23. Commit determinista

El runtime llama un endpoint interno cerrado con el intent firmado. Hostmate vuelve a verificar firma/actor/expiry y ejecuta el Domain Service. No hay prompt, modelo, Tool call ni contenido editable.

## 24. Idempotencia durable

`RE_Agent_Write_Commits` conserva tenant, actor, draft, idempotency key, Tool/version, args hash, target y resultado. El receipt se inserta en la misma transacción que Product Data e histórico. Reintentos compatibles devuelven `idempotent=true`.

## 25. Confirmación concurrente

Convex hace claim atómico `confirmed → committing`. Un segundo click durante 30 segundos recibe in-progress. Un claim abandonado puede recuperarse después; el ledger MySQL impide una segunda mutación.

## 26. Cancelación

Solo `proposed` puede cancelarse. `cancelled` es terminal e idempotente. Cancel no toca Product Data ni invoca el modelo. Por ser una acción terminal no escalante, el mismo actor/tenant puede cancelar después de reautenticarse; Confirm sigue ligado a la sesión y versión exactas del Prepare.

## 27. Stale y conflictos

Cualquier cambio externo de status o assignment invalida precondiciones. El draft termina `stale`, registra `draft.stale` y `write.failed`, no sobrescribe el valor actual y no usa last-write-wins.

## 28. Tamper, replay y aislamiento

Firma inválida, token alterado, otro actor, otra sesión, otra versión, otro tenant, target/valor/expiry modificados, draft cancelado/caducado o replay incompatible fallan cerrados. Los campos authority-like se eliminan antes del contrato o son rechazados por Zod strict.

## 29. Auditoría durable

Eventos: `draft.created`, `draft.confirmed`, `draft.cancelled`, `draft.expired`, `draft.stale`, `write.started`, `write.committed`, `write.failed`. Payloads contienen IDs, hashes y outcomes sanitizados; nunca token, firma completa ni PII sin máscara.

## 30. AI Chat

Block inline accesible `action_confirmation`, diff antes/después, riesgo, caducidad, Cancelar y Confirmar con targets de 44 px. No usa `window.confirm`, modal bloqueante, selección preactivada ni copy engañoso.

## 31. AI Platform

Runs reutilizan Interaction/Execution, profile `crm@1`, ToolScope exacto y status `awaiting_confirmation`. Execution detail recibe los eventos y no se creó otro panel de control.

## 32. Realtime y refresh

La card consulta `agentPlatform:getWriteIntentStatus`; cualquier transición Convex actualiza la UI realtime. Los estados `cancelled`, `committed` y `stale` aparecieron sin reload. Un draft `proposed` persistió tras reload, pudo confirmarse y el estado terminal volvió a persistir ocultando controles de replay.

## 33. Modelo, coste y latencia

Prepare es determinista: tool callback 58.45 ms en la traza y card visible en 1.59–1.87 s E2E. Confirm fue 912 ms; confirm tras refresh 1.333 s; doble click quedó terminal en 1.424 s. Todos registraron cero inferencias, 0/0 tokens, $0.000000 y 0 ms de modelo. OpenRouter, modelo y reasoning no participan.

## 34. Corpus

`evals/safe-writes/crm-update-lead-status-v1.json` contiene 80 escenarios: alias válidos, desconocidos, lecturas no-write, selección ausente, IDs manuales, authority injection y decisiones/replays.

## 35. Tests locales

Boop: 32 files/198 tests; corpus safe-write 80/80. Hostmate API: 147 files/1,261 tests, 12 suites de integración condicionadas omitidas; Web: 35 files/169 tests; Shared: 4 files/245 tests. La regresión enfocada de seis reads, dos Skills, Memory y Multi-Agent pasó 9 files/100 tests. Typecheck, API lint, builds API/Web/Shared/Prisma y `prisma validate` pasaron.

## 36. Browser E2E staging

Flows A–G pasaron con tenant 15/user 43 y lead 4995. A: draft visible con status/assignment/ledger/log sin cambios. B: cancel terminal y cero mutaciones. C: Confirm produjo exactamente una mutación, un histórico y un receipt. D: `proposed` sobrevivió reload y confirmó una vez. E: cambio externo `qualified → new` hizo `DRAFT_STALE`, preservó `new` y no añadió receipt. F: dos clicks simultáneos terminaron committed con un solo receipt/log. G: 390×844 sin overflow horizontal, card legible y controles de 44 px. No-op y status desconocido crearon cero drafts.

## 37. Fixture y cleanup

Baseline: lead 4995, Agent A 43, status original `visit_scheduled`. El script `v2/scripts/agent-platform-safe-write-staging-fixture.mjs` exige `realestate_staging`, IDs exactos, dry-run, `--apply`, cutoff UTC explícito y límites de filas. Cleanup final restauró `visit_scheduled` y eliminó 3 receipts, 4 status logs (incluido el cambio externo) y 3 mensajes system del ejercicio; verificaciones finales: receipts 0, logs 0, mensajes 0. Convex conserva 7 drafts auditables (`cancelled=2`, `committed=3`, `expired=1`, `stale=1`) y `active=0`. Ningún Agent realizó cleanup.

## 38. Producción y exclusiones

No se despliega, reinicia ni configura producción. Memory, Skills, Automations, Multi-Agent y seis capabilities read-only no cambian. No se crea otra capability ni se habilita un write general.

## 39. Gate y siguiente paso

Gate final: **GO**. Mutation-before-confirm=0, unauthorized=0, duplicate=0, stale-overwrite=0, draft precision=100%, confirmation correctness=100%, flows A–G, cleanup y regresiones están verdes. La arquitectura genérica sirve para una segunda write sin duplicar approval engine; cada capability aún debe aportar adapter, preconditions y Domain Service canónico. Recomendación —sin implementarla—: `crm.add_lead_note.v1`, efecto acotado que reutiliza EntityRef/permission/draft/commit, sujeto a auditar semántica append-only, visibilidad e idempotencia.
