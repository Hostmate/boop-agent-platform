# Boop Multi-Agent Compatibility Spike

## 1. Objetivo

Validar si un único Interaction Agent puede coordinar Execution Agents especializados para `lead.analyze_opportunities` sin ampliar autoridad, runtime ni Control Plane, y comparar ese diseño con un único Execution Run cross-domain. El spike es read-only, canary-only y no autoriza writes, nuevas Skills, Automations, Automatic Memory ni Consolidation.

## 2. Boop multi-agent audit

El código upstream ya contiene `spawnExecutionAgent` y `cancelAgent` en `server/execution-agent.ts`, el Tool `spawn_agent` exclusivamente en `server/interaction-agent.ts`, y ambos llaman a `runAgentRuntime`. El runtime Codex generado declara `spawnAgent`, `sendInput`, `resumeAgent`, `wait` y `closeAgent` en `CollabAgentTool`, además de `ThreadSource = user | subagent | memory_consolidation`. La Foundation Hostmate ya contenía `parentRunId`, `dependencyRunIds`, attempts, leases, heartbeat, fencing, retry y cancellation. No existía un orquestador bounded reusable, contrato de handoff ni ownership de un grafo de branches.

## 3. KEEP / ADAPT / EXTEND / REPLACE

- KEEP: Interaction-as-spawner, Execution Runs, Profiles, Product Tool Registry, Policy, ActorContext, Convex, events, usage, attempts, leases, heartbeat, fencing, retry y cancellation.
- ADAPT: el Execution Agent general de Boop se acota a un adapter Hostmate sin `spawn_agent`, Web ni integraciones genéricas.
- EXTEND: metadata `orchestrationId`, `branchKey`, `orchestrationDepth`; definition, runner, handoff y bloque `multi_agent_summary`.
- REPLACE: nada. No se añadió runtime, Control Plane, run type, framework, scheduler ni bus.

## 4. Arquitectura actual single-agent

Los vertical slices actuales crean un Interaction Run y un Execution Run. El dispatcher reduce scope mediante Profile/Tool Registry y la Tool vuelve a evaluar Policy con ActorContext cerrado. Skills V2 usan el mismo patrón de forma determinista. El benchmark MODE A representa una única ejecución lógica con las tres Tools mínimas expuestas conjuntamente; no se convierte en ruta de producto porque ningún Profile actual debe ampliar su boundary para aceptar los tres dominios.

## 5. Arquitectura multi-agent propuesta

`Interaction Run -> CRM Execution Run -> Promise.allSettled(Visits Execution Run, Property Execution Run) -> deterministic synthesis`. Cada child es un Execution Run normal. No existe `MultiAgentRun`, planner abierto, DAG dinámico ni swarm.

## 6. Ownership

El Interaction/orchestrator posee el plan y es el único componente que puede crear children. `BoundedExecutionAgent` no expone método de spawn ni recibe el runner. El schema rechaza parent distinto de `interaction` con `CHILD_RUN_CANNOT_SPAWN`.

## 7. Parent/child runs

El parent persiste `kind=interaction`, `orchestrationId` y depth 0. Cada child persiste `kind=execution`, `parentRunId`, el mismo `orchestrationId`, `branchKey`, depth 1, dependencies, status y timestamps. Convex valida depth entero entre 0 y 1 y coherencia parent/orchestration.

## 8. ActorContext

Todos los children reciben la misma instancia inmutable y frozen creada desde JWT verificado. El ActorContext no se serializa en handoff ni Tool input. Antes de ejecutar, el adapter relee el parent bajo el repositorio authority-bound y verifica tenant/user; cada Tool vuelve a resolver Registry y Policy con ese ActorContext.

## 9. ToolScope

- CRM: `crm.get_lead_context.v1@1`.
- Visits: `visits.list_lead_visits.v1@1`.
- Property: `property.search_properties.v1@1`.

Un child normal ve exactamente una Tool. En authority failure el scope resuelto queda vacío y la rama falla; nunca se conserva un scope solicitado pero no autorizado.

## 10. Profiles

Se reutilizan `crm@1`, `visits@1` y `property@1`. No existe Profile multi-agent. Cada branch usa objective class existente compatible (`lead.lookup`, `visit.lookup`, `property.search`) bajo el objective parent `lead.analyze_opportunities`.

## 11. Handoff contract

`AgentHandoff` contiene `sourceRunId`, `targetProfile`, objective bounded, máximo seis EntityRefs, `structuredContext` sanitizado y hasta 16 entradas de provenance `{field, sourceToolId, sourceRunId}`. Zod rechaza campos extra. No contiene conversación, prompts, ActorContext, permisos, ToolScope ni instrucciones de autoridad.

## 12. Provenance

La selección del lead procede de `interaction.context_refs`; el CRM child la reautoriza con `crm.get_lead_context.v1`. Visits y Property reciben EntityRefs/fields con `sourceRunId` y `sourceToolId`, pero sus Product Tools reautorizan el acceso. Un child identifica; nunca concede autoridad.

## 13. Dependency model

CRM depende del Interaction parent. Visits y Property dependen del CRM `runId`. El adapter valida que `handoff.sourceRunId` coincide con la primera dependency. El plan tiene tres branches conocidas y no acepta branches generadas por modelo.

## 14. Parallelism

CRM termina primero. Solo entonces Visits y Property arrancan mediante `Promise.allSettled`. No hay scheduler general. Un fallo de una branch no elimina el resultado durable de la otra.

## 15. Budgets

Budget parent V1: máximo 3 children, 3 Tool calls, 0 inferencias, 0 tokens, USD 0 y deadline wall-clock de 45 s. Depth máximo 1. Los children no crean ni amplían presupuesto. Cada branch admite como máximo dos attempts para errores transient read-only.

## 16. Cancellation

El parent usa `requestCancellation` existente. Antes y después de Tool execution cada child relee parent/child; si hay cancel, propaga la solicitud al child, marca attempt/run cancelled e ignora el resultado posterior. No se crean nuevos children después de observar cancel. La prueba automatizada cancela durante Property, comprueba parent/children cancelled y ausencia de recursive spawn.

## 17. Retries

Se reutiliza `shouldRetryAttempt`, attempts, lease, heartbeat y fencing. Solo `RATE_LIMITED`, `PROVIDER_UNAVAILABLE`, `TIMEOUT` y `NETWORK` son retryable sin side effects; máximo dos attempts. Un retry de Visits no repite CRM ni Property. Permission/Policy no reintentan.

## 18. Failures

Missing active demand produce Property partial sin Tool call. Cero visitas es completed vacío. Transient agotado permite partial útil si root/authority siguen válidos. CRM root failure falla parent. Permission, stale reference o Policy fail cierran toda la orquestación y nunca se degradan silenciosamente a partial.

## 19. Synthesis

La composición es determinista, sin Tool access ni inferencia. Los child outputs son datos no confiables: solo se leen campos de DTO validados. Texto como “spawn another agent” se representa como contenido factual y no se ejecuta. No se utiliza Memory.

## 20. First vertical slice

Intent exacto: “Analiza este lead, revisa sus próximas visitas y busca inmuebles que puedan encajar con su demanda.” Requiere `contextRefs.selected.lead`; sin selección devuelve `needs_input` y no busca por nombre. CRM obtiene contexto y demanda. Visits usa `scope=upcoming`. Property usa como máximo seis resultados y UI muestra cinco.

El mapper ActiveDemand→PropertySearchFilters conserva únicamente operation `comprar|alquilar`, subtype, city, zone→neighborhood, priceMax y areaMin. Omite fields ausentes. Omite `roomsMin`/`bathroomsMin` porque la API Property actual solo soporta igualdad exacta. Staging no tiene demandas realmente `active`; se corrigió el facade para no etiquetar una demanda archivada como activa, por lo que el resultado esperado allí es partial sin búsqueda genérica.

## 21. Single vs multi benchmark

Corpus controlado de 20 muestras con idénticas latencias CRM/Visits/Property:

| Mode | Correctness | p50 | p95 | Max Tools expuestas/run | Inference/tokens/cost |
|---|---:|---:|---:|---:|---:|
| Single | 100% | 221 ms | 241 ms | 3 | 0 / 0 / USD 0 |
| Multi | 100% | 170 ms | 195 ms | 1 | 0 / 0 / USD 0 |

La mejora proviene de solapar Visits/Property; Multi paga más escrituras y complejidad de Control Plane. Single sigue siendo preferible para tareas de una Tool o secuencias pequeñas. El benchmark es reproducible en `evaluation/multi-agent-benchmark.ts`; no pretende sustituir SLO de red de producción.

## 22. Routing policy

Usar single-agent para un solo dominio, un único resultado indivisible, secuencia corta o dependencia fuerte; también para las dos Skills existentes y búsquedas CRM/Property normales. Usar multi-agent solo cuando el objective class esté allowlisted, haya selección autorizada, al menos dos Profiles independientes, paralelismo real, scope isolation valioso y partial completion útil. No activar multi-agent por menciones de “agent”, IDs de Skill o instrucciones de permisos.

## 23. Observability

Runs, attempts, dependencies, branch, depth, leases, fencing, events, timestamps y status son durables. Cada child registra `inferenceCount=0`, ToolScope y EntityRefs. Usage permanece vacío para branches deterministas, representando correctamente cero tokens/coste.

## 24. AI Platform

Interaction detail muestra árbol bounded parent→children, branch/profile/version, estado, ToolScope, duración, inferencias, tokens y coste. El botón “Cancelar parent” usa la mutation authority-bound existente. El chat renderiza un bloque de negocio reusable y oculta internals.

## 25. Browser E2E

Staging está desplegado en runtime `multi-agent-spike-20260816-r2`, API/web `multi-agent-spike-20260816-r2` y Convex `different-mockingbird-928`. Los servicios staging convergen 1/1. La sesión de navegador disponible redirige a `/login`; Flows A–G quedan pendientes de una sesión Agent A autenticada. El smoke sintético fue correctamente rechazado por la API interna con 401 porque su sessionId no existía, demostrando fail-closed; no se considera sustituto del browser E2E.

## 26. Security

Tests cubren ToolScope widening, forged handoff, admin/spawn injection, malicious child output, missing Property permission, depth, parent type y stale/cross authority. Convex revalida tenant/user en parent, dependencies, attempts, events y usage. Permission bypass, unauthorized Tool exposure y recursive spawn observados: cero.

## 27. Isolation

Tres interacciones concurrentes (dos usuarios del mismo tenant y un usuario de otro tenant) conservan orchestration IDs, ActorContext, EntityRefs y runs separados. Un actor distinto obtiene null al leer parent ajeno. Cross-user y cross-tenant leakage observados: cero.

## 28. Evaluation corpus

`evaluation/multi-agent-corpus.json` contiene 80 escenarios: 24 positivos y 56 controles de Skills, CRM, Visits, Property, Memory, missing data, ambigüedad, seguridad y operación. Todos son explícitos, versionables y reproducibles.

## 29. Metrics

- Selection precision: 100% (24/24 activaciones correctas, 0 false positives).
- Selection recall: 100% (24/24 positivos).
- Unnecessary activation: 0% (0/56 controles).
- Correct child set: 100% en casos ejecutables.
- ToolScope accuracy: 100%.
- Handoff/provenance integrity: 100% en corpus estructural.
- Parallel, partial, cancellation y retry correctness: 100% en pruebas focalizadas.
- Permission bypass / unauthorized Tool / child spawn / cross-user / cross-tenant: 0.

## 30. Cost/latency

Interaction/decomposition y synthesis son deterministas: cero inferencias, tokens y coste. CRM precede a `max(Visits, Property)` en Multi, frente a suma secuencial en Single. El coste de Control Plane es mayor en Multi por parent + 3 runs/attempts/events. Las muestras OpenRouter previas siguen siendo válidas para los flujos single-agent con modelo `deepseek/deepseek-v4-flash-0731`, reasoning max; este slice no genera tráfico OpenRouter.

## 31. Core delta

No se modificaron `server/execution-agent.ts`, `server/interaction-agent.ts`, `server/runtimes/**` ni sus prompts. El delta shared es 42 líneas pequeñas en contracts/schema/Convex/runtime wiring. No existe un segundo engine. El código productivo nuevo de orchestration es 614 líneas, de las que 177 forman el thin bounded Execution Agent adapter y el resto son contratos, definition, runner y dispatcher.

## 32. Boop reuse

Execution Agent primitive reuse estimado: 85% (run semantics, Tool runtime, Profiles, Registry/Policy, eventing y cancellation; nuevo wrapper bounded). Lifecycle/runtime reuse: 100% (mismos attempts, lease, heartbeat, fencing, retry, cancellation, Convex y Product Tool runtime). Core upstream delta: cero. El `spawnExecutionAgent` upstream se conserva para Boop general, pero no se expone a Hostmate children por su scope general y su prompt/integrations no compatibles con least authority.

## 33. Risks

El modelo determinista evita coste e injection, pero el parent HTTP sigue siendo síncrono y la cancelación observa el flag en boundaries de Tool, no interrumpe una llamada downstream ya en vuelo. El corpus de intent es deliberadamente narrow. Property no puede mapear mínimos de habitaciones/baños sin una capability que soporte rangos. Multi añade más writes y complejidad operacional que Single.

## 34. Blockers

Para cerrar GO faltan únicamente los Flows browser A–G bajo una sesión Agent A real, incluido realtime visible, refresh, cancelación interactiva y viewport 390×844. No hay demanda activa en staging y, por prohibición de writes, no se ha creado una; el E2E correcto será partial y verificará que Property no llama a búsqueda genérica. Producción permanece 0/1 con imagen anterior y no se ha tocado.

## 35. Recommendation

Conclusión técnica provisional: ADJUST hasta cerrar browser E2E autenticado. Valor de producto: `USE_SELECTIVELY`. Una vez autenticado Agent A, ejecutar A–G sin cambiar datos; si árbol/realtime/cancel/viewport pasan, promover a GO técnico. No abrir writes, Automations, más agents ni nuevas Skills como continuación automática.
