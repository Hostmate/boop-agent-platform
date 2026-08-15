# Agent Platform — Staging Operational Validation

Fecha de ejecución: 2026-08-15. Resultado técnico: **GO para uso interno en staging**. Infraestructura, seguridad, vertical slice y browser smoke autenticado quedan certificados. Producción sigue fuera de alcance y no fue modificada.

## 1. Estado inicial

- Boop: `codex/agent-platform-integration` en `f5f77c3d33a79329c21d630949a343bb2c66907c`, `origin/main...HEAD = 0/10` antes de añadir esta certificación.
- Hostmate: `codex/agent-platform-integration` en `7836efbd33b172fa7cd3ee4db4f7d9f3b46b3ce9`, limpio, `origin/main...HEAD = 0/11`.
- Boop `origin` apunta al fork Hostmate y `upstream` a `raroque/boop-agent`; Hostmate `origin` apunta a `Hostmate/Plataforma-Real-Estate`.
- No se actualizó Boop upstream ni se modificó `main`.
- El antiguo `it_re-v2-dev` estaba a `0/0`. `realestate_dev` no contenía el esquema de aplicación; se eligió la base existente `realestate_staging` sin modificar `realestate_dev`.

## 2. Infraestructura desplegada

- Hostmate API/Web: servicio Swarm `it_re-v2-dev`, imagen local de staging `hostmate/re-v2-agent-platform-staging:deeplink-fix-20260815`, `1/1`.
- Runtime: `it_re-agent-platform-runtime-staging`, imagen `hostmate/agent-platform-runtime-staging:deeplink-fix-20260815`, `1/1`.
- Convex: proyecto `r-closas/hostmate-agent-platform-staging`, deployment `different-mockingbird-928` en Europa (Irlanda).
- MySQL: `realestate_staging`, usuario técnico exclusivo de staging.
- Secretos: keyring RSA y OpenRouter montados como Docker secrets versionados. No están en Git, Convex, frontend, logs ni este documento.
- OpenRouter reutiliza únicamente la credencial que ya estaba configurada en el servicio dev/staging; no se copió una credencial de producción.

## 3. Topología de staging

```text
https://v2-dev.realestate.hostmate.es
  ├─ Web SPA
  ├─ Hostmate API /api/v2
  └─ JWKS /api/v2/agent-platform/.well-known/jwks.json
       ↓ red interna easypanel-it
it_re-agent-platform-runtime-staging:4310
       ├─ Convex different-mockingbird-928.eu-west-1.convex.cloud
       ├─ OpenRouter
       └─ Hostmate callbacks → domain services → realestate_staging
```

El runtime no tiene ingress público. Una ruta Traefik de staging, declarada en `deploy/hostmate-runtime/staging-traefik.yaml`, evita la página histórica de “servicio detenido” de EasyPanel y sólo afecta al hostname dev.

## 4. Convex

- `convex deploy --typecheck enable` completó functions, schema e índices tenant-first.
- Están desplegadas conversations, messages, runs, attempts, events, usage y contextRefs.
- JWT custom auth valida issuer, audience y JWKS reales.
- Una mutación con `expectedTenantId=16` firmada para tenant 15 fue rechazada con `ACTOR_TENANT_MISMATCH` antes de escribir.
- Realtime cloud observó un turno de 8 a 10 mensajes mediante tres callbacks.
- Un cliente nuevo recuperó dos mensajes después del reemplazo del runtime, demostrando durabilidad/reconnect.
- Un actor del tenant B recibió `CONVERSATION_FORBIDDEN` al consultar la conversación del tenant A.

## 5. JWKS

- Issuer: `https://v2-dev.realestate.hostmate.es/api/v2/agent-platform/staging`.
- Audience: `hostmate-agent-platform-staging`.
- Endpoint: `https://v2-dev.realestate.hostmate.es/api/v2/agent-platform/.well-known/jwks.json`.
- Active `kid`: `staging-20260815-active`.
- Previous `kid`: `staging-20260715-previous`.
- El endpoint HTTPS devuelve únicamente dos JWK públicas RSA/RS256 y usa cache público de 300 s.
- La private key activa sólo existe como EasyPanel/Docker secret. La private key anterior fue destruida tras conservar su clave pública, suficiente para la ventana de verificación.
- Convex, runtime y callbacks Hostmate verifican RS256, `kid`, issuer y audience.

## 6. permissionsVersion

- Vive en `RE_Settings` como `agent_platform_permissions_version:<userId>` dentro del tenant.
- Debe incrementarse al revocar o cambiar permisos efectivos del Agent Platform. La desactivación del tenant/usuario se aplica además mediante kill switches y allowlists.
- El access token Hostmate contiene la versión y un binding no reversible de la sesión refresh. El ActorContext de 5 minutos copia ambos.
- Runtime verifica firma y claims, y exige que la identidad resuelta por Convex coincida exactamente.
- Cada callback Hostmate vuelve a consultar usuario, tenant, flags, versión y sesión refresh vigente.
- Prueba: versión 1→2 invalidó inmediatamente el ActorContext antiguo en callback (`401`) y el access token antiguo en el bridge (`403`). Refresh emitió versión 2 y volvió a funcionar. Logout invalidó inmediatamente el ActorContext v2 en callback.
- Ventana máxima sin callback: TTL de 5 minutos. Con callback, la revocación observada es inmediata.

## 7. Managed runtime

- Node 20 Alpine, stateless, proceso separado, usuario no-root.
- Endpoints: `/health/live`, `/health/ready`, `/health`, `POST /v1/turn`.
- Concurrencia 8, shutdown 55 s, stop grace 60 s, restart `on-failure`, logs JSON con rotación 10 MB × 5.
- Configuración de Convex, Hostmate, JWKS, modelo y límites procede de environment/secrets.
- Expone exclusivamente `crm.search_leads.v1`, `crm.get_lead_context.v1`, `visits.list_lead_visits.v1` y `visits.get_visit.v1`.

## 8. Runtime artifact

- Bundle final: `dist-hostmate-runtime/start.mjs`, 1,638,989 bytes y 295 módulos de entrada.
- Imagen: 137,319,611 bytes incluyendo Node Alpine; `/app/node_modules` no existe en la capa final.
- La imagen final contiene el bundle, no Electron, Browser/Patchright, Apple, Sendblue, Composio ni runtimes locales Claude/Codex.
- Audit del lockfile completo: 11 high y 1 critical. Ninguno de los 12 paquetes high/critical aparece entre los inputs del bundle. Esto elimina esos findings del path reachable y de la imagen final, sin hacer upgrades masivos.
- Se corrigió el primer empaquetado ESM añadiendo `createRequire` al banner de esbuild y eliminando la carga de `dotenv` del entrypoint gestionado.

## 9. OpenRouter

- Modelo configurado por environment: `openai/gpt-4.1-mini`; no está hardcodeado en Core.
- Provider resuelto: OpenAI; no hubo fallback.
- La búsqueda real realizó streaming/tool calling y registró 182 input tokens, 15 output tokens y USD 0.0000968.
- Reasoning/cache fueron cero/no aplicables en esta muestra; finish reason, provider y resolved model quedaron persistidos.
- Los caminos de contexto y visitas fueron deterministas y no crearon usage/model events.
- Timeout, errores normalizados, presupuesto y cancelación por AbortSignal están cubiertos por el adapter y sus tests. El disconnect HTTP cancela el trabajo en curso.

## 10. Real agent fixture

- Tenant A: ID 15, “Hostmate Mobile Staging”.
- Agent A: user ID 43, rol real persistido `agent`, activo y allowlisted.
- Admin tenant A: user ID 42, rol real `admin`.
- Lead A: ID 4995, asignado a Agent A, referencia `AGENT-PLATFORM-STAGING-LEAD-A`.
- Lead B: ID 4996, mismo tenant, asignado al admin y no a Agent A.
- Visit A: ID 458, vinculada a Lead A y Agent A.
- Visit B: ID 459, vinculada a Lead B y no asignada a Agent A.
- Tenant B: ID 16, lead ID 4997 y user ID 44. Todos los datos son fixtures identificados como staging/test.

## 11. Feature flags

El acceso exige simultáneamente:

1. `AGENT_PLATFORM_ENABLED=true` en staging;
2. tenant y usuario en allowlists de environment;
3. `agent_platform_enabled=1` para el tenant;
4. usuario incluido en `agent_platform_user_ids`;
5. usuario real activo y sesión vigente.

Tenant 16 quedó finalmente con `agent_platform_enabled=0`. Su usuario pudo iniciar sesión en Hostmate, pero vio `agent_platform_enabled=false` y el bridge devolvió `AGENT_PLATFORM_FORBIDDEN`. El kill switch se puede aplicar sin redeploy mediante `RE_Settings`, y existe además el master switch de environment.

## 12. Browser smoke

- Login real como Agent A y bootstrap `/auth/me`: 200.
- Overview, AI Chat y Executions renderizan como SPA real. `/agent-platform/config` y dos renovaciones `/agent-platform/token` respondieron 200; Convex abrió `wss://different-mockingbird-928.eu-west-1.convex.cloud/api/1.42.1/sync`.
- Flujo visual completo: búsqueda de Lead A → contexto por pronombre → listado de visitas → selección → detalle → follow-up “Cuéntame más.”. Las cards mostraron únicamente lead 4995 y visita 458 con datos enmascarados.
- Refresh entre detalle y follow-up conservó conversación, lead y visita seleccionados; el nuevo detalle usó `visits.get_visit.v1` con 0 inferencias.
- Búsqueda visual de Lead B 4996 devolvió “No he encontrado leads con esos criterios” y no renderizó su card.
- Executions mostró Interaction Runs, Execution Runs, scopes exactos, lifecycle, provider/model, tokens, coste y caminos de 0 inferencias.
- Deep links certificados: lead → `/conversations?leadId=4995`, con conversación y ficha accesibles al comercial; visita → `/visits?visitId=458`, con el detalle abierto en calendario.
- Responsive certificado a 390×844: `scrollWidth=390` en Chat y Executions; select, envío y deep-link miden 44 px de alto.
- Captura CDP limpia posterior al fix: 0 `Network.loadingFailed`, 0 `Runtime.exceptionThrown`, bootstrap y assets 200.

## 13. Permission smoke

Agent A:

- búsqueda Lead A: 200, único ID 4995;
- contexto Lead A: 200;
- visitas Lead A: 200, visita 458;
- detalle visita 458: 200;
- contexto Lead B 4996: 403;
- visita B 459: 403;
- lead tenant B 4997: 404;
- body con `tenant_id`: 400 `INVALID_TOOL_INPUT`.

Admin tenant A pudo leer leads 4995 y 4996, pero obtuvo 404 para 4997. No se aceptó ningún tenant aportado por el cliente.

## 14. Realtime

- Suscripción WebSocket real: actualización observada de 8 a 10 mensajes.
- ContextRefs persistieron lead 4995 y visita 458 a lo largo de la conversación.
- Cliente reconectado y consulta después de restart recuperaron el estado durable.
- Actor tenant B no pudo leer la conversación tenant A.
- Evidencia visual simultánea: el run `b5cc6980-edcd-4cbb-a4aa-d79156fb2036` apareció `running` a los ~850 ms y cambió a `completed` a los ~4.05 s en una pestaña Executions ya abierta, sin reload.

## 15. Restart/shutdown

- Se forzó `docker service update --force` durante una búsqueda real.
- La request activa terminó con 200 en 2,651 ms.
- El proceso anterior registró `shutdown_started` y `shutdown_complete`; la réplica nueva volvió a `1/1` y anunció listener.
- Convex conservó los dos mensajes `user/assistant` de la conversación tras el restart.
- Durante arranque o dependencia caída, readiness es 503; el runtime no acepta turnos cuando `isReady=false`.

## 16. Concurrency

- Ráfaga segura de 12: 8 aceptadas y 4 rechazadas rápidamente.
- Tras corregir el proxy, ráfaga de 10: 8×200 y 2×503 `RUNTIME_BUSY`, ambos con `Retry-After: 1` extremo a extremo.
- Cada request creó UUID de conversación independiente y ActorContext por request; no hubo mezcla de resultados ni tenant.

## 17. Retention dry-run

Query read-only `agentPlatform:retentionDryRun`, ejecutada como admin tenant 15:

| Tipo | Política | Elegibles | Bytes estimados |
|---|---:|---:|---:|
| messages/contextRefs | 180 días | 0 | 0 |
| runs/attempts | 90 días | 0 | 0 |
| detailed events | 30 días | 0 | 0 |
| raw usage | 90 días | 0 | 0 |
| terminal lease detail | 7 días | 0 | 0 |

La respuesta incluye tenant/tipo/count/oldest/newest/estimatedBytes. No ejecuta patches ni deletes.

## 18. Convex writes

- Turno con inferencia/búsqueda: 26 document writes estimados.
- Cada follow-up determinista: 20.
- Secuencia de cuatro capabilities: media 21.5 writes/turn, superior a la proyección previa de ~16.5.
- La diferencia proviene principalmente de 2 escrituras por mensaje (insert + touch conversation), 7–11 events, 4 run patches y lifecycle de attempt; usage añade una escritura sólo con inferencia.
- No se observó una proyección escribiendo accidentalmente; no se optimizó en esta fase.
- Cero business writes: leads/visits conservaron timestamps de fixture `12:52:28`, estados/asignaciones originales y `RE_Lead_Messages` siguió en 0 para los tres leads tras todos los smokes.

## 19. Logging/observability

- `x-request-id` se propaga Hostmate `/turn` → runtime → OpenRouter metadata → callback Hostmate.
- Logs reales mostraron el mismo request ID en `/turn` y en `/crm/*` o `/visits/*`.
- Runtime emite `turn_completed`, `turn_rejected`, `turn_failed` y shutdown con JSON estructurado; los éxitos incluyen interaction/execution run IDs, no payloads.
- Escaneo de 152,598 bytes de logs: cero JWT, API keys OpenRouter, private keys, emails/teléfonos/nombres de fixture y headers Authorization.
- Los logs Hostmate conservan userId/tenantId/requestId y la IP de red como metadata operativa de seguridad; no registran bodies.
- Investigación: buscar requestId en logs `it_re-v2-dev`, enlazar interaction/execution IDs en Convex Runs/Events/Usage, revisar `it_re-agent-platform-runtime-staging` y la metadata de generación OpenRouter.

## 20. Health/readiness

- Hostmate `/health`: 200.
- Runtime `/health/live`: 200 si el proceso vive.
- Runtime `/health/ready`: 200 con JWKS, Convex y Hostmate disponibles; 503 con dependencias no disponibles.
- Runtime `/health`: 200 y lista exacta de cuatro capabilities.
- Config inválida: el artifact termina con exit 1 antes de escuchar.
- Prueba local con Convex/JWKS/Hostmate no disponibles: liveness levantó y readiness devolvió 503.
- Shutdown cambia `accepting=false`, detiene probes, drena y registra cierre; una nueva réplica recuperó readiness.

## 21. Performance

- Búsqueda con OpenRouter: aproximadamente 3.0 s en muestra nominal; 182/15 tokens; USD 0.0000968.
- Follow-ups 0-inference: aproximadamente 1.1–1.5 s.
- Carga concurrente aceptada: aproximadamente 3.3–3.5 s en la primera ráfaga; rechazos por capacidad en ~0.65 s.
- Restart con request activa: 2.651 s y resultado 200.
- No se definieron todavía SLOs de producción.
- La SPA no mostró bloqueo de CPU: tras cargar una conversación larga, `ScriptDuration=0.283 s`, `TaskDuration=0.463 s`, 7 layouts y 7 recalculados; heap 21.54/26.82 MB.
- El bundle principal cacheado cargó en 36.1 ms (`transferSize=0`). El warning de 5.22 MB/1.41 MB gzip permanece como deuda de code-splitting, no como causa del freeze observado.

## 22. Tests

- Convex deploy con typecheck y schema: PASS.
- Boop: typecheck PASS, bundle slim PASS, 20 archivos/122 tests PASS.
- Hostmate API: typecheck PASS, 145 archivos/1,226 tests PASS; 12 archivos/44 tests de integración condicionados por entorno quedaron skipped.
- Hostmate Web: 33 archivos/160 tests PASS, typecheck/lint PASS y build Vite PASS (1,999 módulos). Se mantiene el warning heredado de chunk principal de 5.22 MB/1.41 MB gzip.
- Pruebas reales: cuatro capabilities, OpenRouter, auth, revocación, tenant isolation, realtime, restart, concurrencia, retention y health: PASS.
- Browser UI completo: PASS/CERTIFICADO.

## 23. Security findings

- No se halló cross-tenant leakage en queries, mutations, callbacks ni realtime.
- ActorContext usa RS256 con key rotation, TTL 5 min, session binding y permissionsVersion.
- Runtime no confía únicamente en Convex: verifica JWT localmente y compara claims con la identidad Convex.
- Callbacks reautorizan contra estado actual de MySQL.
- Slim artifact excluye todos los paquetes high/critical detectados en el lockfile completo del path reachable/final image.
- El primer secret OpenRouter con modo 0400 no era legible por el usuario no-root; se corrigió a 0444 dentro del tmpfs de Docker secrets, manteniendo aislamiento por contenedor.

## 24. Problems

Resueltos durante el gate:

1. bundle ESM incompatible con requires CommonJS;
2. permisos del secret para usuario no-root;
3. EasyPanel mantenía el dominio dev en su página “not started”;
4. Hostmate no reenviaba `Retry-After` del runtime.
5. consulta browser de una conversación aún no creada usaba el contrato estricto del runtime y devolvía `CONVERSATION_FORBIDDEN`; se separó `listMessagesIfPresent` para UI manteniendo el contrato estricto del runtime;
6. `useEffect` devolvía implícitamente el valor de `scrollIntoView`; el controlador lo instrumenta como Promise y React intentaba ejecutarlo como cleanup (`TypeError: F is not a function`), dejando la SPA en blanco;
7. lead deep link apuntaba a la ruta admin `/leads`; ahora usa `/conversations?leadId=` y la selección explícita sobrevive aunque el lead no esté en el listado activo.

## 25. Blockers

- **Uso interno en staging:** ninguno.
- Antes de producción: publicar imágenes en un registry con digest inmutable e integrar la ruta staging en la configuración gestionada de EasyPanel. Son deudas operativas, no bloquean el uso interno del staging actual de un nodo.

## 26. GO/NO-GO staging

**GO para uso interno en staging.** Backend, seguridad, aislamiento, realtime, control plane y UX browser pasan. No autoriza producción ni merge a `main`.

## 27. Blockers production

- Registry/digest inmutable y configuración gestionada de ingress indicados en la sección 25.
- Runbook de rotación/rollback de JWKS y secretos respaldado por KMS o secret manager administrado.
- Pipeline reproducible con registry/digest, SBOM y escaneo del artifact final.
- SLOs, alertas, dashboards, presupuesto/coste, capacity planning y pruebas de fallo más amplias.
- Estrategia de migrations/retention ejecutable y aprobada; el dry-run no borra.
- Revisión de privacidad/log retention y del uso de IP como metadata.
- Revisión formal de seguridad y release/merge; producción permaneció `1/1` y no fue modificada.

## 28. Recomendación

El gate permite preparar Properties, pero únicamente después de una revisión separada de alcance, permisos, contratos read-only, UX y riesgo. No comenzar su implementación automáticamente ni mezclarla con este cierre.

## 29. Browser Smoke Certification

### Método

Navegador integrado autenticado con Agent A real, dos pestañas simultáneas para Chat/Executions, snapshots semánticos del DOM, screenshots, viewport explícito 390×844 y CDP para red, WebSocket, excepciones y métricas. No se usaron respuestas simuladas.

### Resultado por paso

| Paso | Evidencia | Resultado |
|---|---|---|
| Login y acceso | `/auth/me`, config y token 200 | PASS |
| Búsqueda Lead A | card 4995, run `bbb05036…` | PASS |
| Contexto “¿Qué sabemos de él?” | `crm.get_lead_context.v1`, run `592a10e3…` | PASS |
| Visitas | única visita 458, run `c7e86d72…` | PASS |
| Selección/detalle | `visits.get_visit.v1`, run `e80b8702…` | PASS |
| Refresh/continuidad | visita 458 recuperada, run `bfcb8769…`, 0 inferencias | PASS |
| Permisos visuales | Lead B 4996 no aparece | PASS |
| Realtime | `running → completed` sin reload | PASS |
| Executions | scope, events, usage, modelo y coste visibles | PASS |
| Deep links | CRM lead y calendario visita correctos | PASS |
| Responsive | Chat/Executions 390×844, sin overflow | PASS |
| Consola/red | 0 exceptions/failures; Convex WebSocket creado | PASS |

### Evidencia persistente

- `docs/evidence/agent-platform-browser-smoke/01-search-lead-desktop.jpg`
- `docs/evidence/agent-platform-browser-smoke/02-four-capability-flow-desktop.jpg`
- `docs/evidence/agent-platform-browser-smoke/03-agent-scope-no-leak.jpg`
- `docs/evidence/agent-platform-browser-smoke/04-execution-trace-desktop.jpg`
- `docs/evidence/agent-platform-browser-smoke/05-chat-mobile.jpg`
- `docs/evidence/agent-platform-browser-smoke/06-executions-mobile.png`
- `docs/evidence/agent-platform-browser-smoke/07-lead-deeplink-crm.jpg`
- `docs/evidence/agent-platform-browser-smoke/08-visit-deeplink-calendar.jpg`
- `docs/evidence/agent-platform-browser-smoke/browser-smoke-evidence.json`

Conclusión: **GO para uso interno en staging**. La causa primaria del freeze era una violación del contrato de cleanup de React activada por la instrumentación del controlador; no era saturación de runtime ni del bundle. Las dos incidencias SPA adicionales detectadas —consulta pre-conversación y deep link del comercial— quedaron corregidas y cubiertas por regresión.
