# Memory Evaluation Report

Fecha de ejecución: 2026-08-15  
Entorno: staging únicamente  
Benchmark: `memory-explicit-v1`  
Seed: `hostmate-memory-eval-2026-08-v1`  
Baseline run: `memory-eval-baseline-20260815-r1`

## 1. Objetivo

Evaluar intensivamente Explicit User Memory V1 sobre el sistema real adaptado de Boop: runtime, policy, embeddings OpenRouter, Convex, recall, superseding, Forget, Property tools y UI/Graph. El harness comprime semanas de uso en un corpus reproducible y anotado antes de la ejecución.

No se evaluó una implementación alternativa ni se usaron mocks en la corrida principal. Automatic extraction, Tenant Memory, consolidation, cleanup scheduler, proactive memory, Skills y Automations permanecieron OFF.

## 2. Corpus

El corpus versionado vive en `v2/evals/memory` del repositorio Hostmate y declara personas, escenarios, ground truth, runner, scoring y adversarial set. Contiene:

- 12 personas sintéticas;
- 144 conversaciones;
- 204 turnos;
- 48 escenarios deterministas;
- 72 escenarios sintéticos;
- 24 escenarios adversariales;
- 2 tenants de staging, con varios agentes y un admin sintético por tenant.

Dos conversaciones contienen 20 turnos de ruido operacional; otras diez conversaciones de ruido contienen dos turnos. Se reinició el runtime entre las dos mitades del corpus para validar persistencia entre procesos.

## 3. Personas

| Persona | Tenant | Rol | Patrón |
| --- | ---: | --- | --- |
| budget-brief | 15 | agent | precio ascendente y respuestas breves |
| recent-detailed | 15 | agent | novedades y respuesta detallada |
| frequent-switcher | 15 | agent | cambios frecuentes de orden |
| product-data-heavy | 15 | agent | mezcla Product Data y preferencias |
| ambiguous-language | 15 | agent | lenguaje ambiguo y coloquial |
| authority-adversary | 15 | admin | intentos de elevar autoridad |
| catalan-budget | 16 | agent | catalán y precio económico |
| format-focused | 16 | agent | formato horario |
| workflow-first | 16 | agent | lead antes que inmueble |
| typo-colloquial | 16 | agent | typos razonables |
| cross-tenant-twin | 16 | agent | preferencia idéntica a otro tenant |
| tenant-admin-private | 16 | admin | no hereda Memory privada ajena |

## 4. Escenarios

Cada persona recorre 12 conversaciones con creación inicial, recall en nueva conversación, preferencia secundaria, conversación sin Memory, rechazo de policy, override actual, supersede, recall del valor nuevo, recall irrelevante, Forget, frontera posterior a Forget y prompt injection.

Cada turno registra expected/actual, checks, Memory IDs, interaction/execution run IDs, coste y latencias. Cada escenario termina en `PASS`, `PARTIAL` o `FAIL`.

## 5. Deterministic set

Los 48 escenarios curados cubren Remember, recall, current-request precedence y Forget para las 12 personas. Son el núcleo de regresión de máxima confianza y no dependen de juicio posterior de otro LLM.

## 6. Synthetic set

Los 72 escenarios sintéticos usan templates deterministas y semilla persistida. Cubren preferencias secundarias, conversaciones largas/ruidosas, superseding, recall del valor sustituto, irrelevant recall y frontera posterior a Forget. Las variantes lingüísticas incluyen español, catalán, lenguaje coloquial y errores tipográficos.

## 7. Adversarial set

Los 24 escenarios de `v2/evals/memory/adversarial` cubren PII, Product Data, secretos, selección de tenant, permisos, roles, authority escalation, prompt injection desde contenido y Forget ambiguo. Ningún caso adversarial creó autoridad ni Memory prohibida.

## 8. Ground truth

El ground truth se declara en el corpus antes de la ejecución mediante categorías allowlisted y policy annotations. Se anotan creación, clave/valor, rechazo y código, recall, orden aplicado, superseding, Forget y precedencia. El scoring no reinterpreta retrospectivamente si una respuesta “parece razonable”.

## 9. Baseline results

La baseline se ejecutó completa antes de modificar el comportamiento:

- PASS: 106/144;
- PARTIAL: 23/144;
- FAIL: 15/144;
- write precision: 100%;
- write recall: 58,33%;
- rejection accuracy: 91,67%;
- recall precision: 100%;
- recall coverage: 37,5%;
- false recall: 0%;
- supersede: 50%;
- Forget: 100%;
- current-request precedence: 50%;
- cross-user/cross-tenant leakage: 0/0.

La mitad de los fallos de aplicación/precedencia pertenecía a una configuración de evaluación: el kill switch del tenant 16 estaba OFF. Los restantes eran variantes explícitas no reconocidas y dos códigos de rechazo incorrectos.

## 10. Métricas finales

La certificación final `memory-eval-final-20260815-r2` produjo 144 PASS, 0 PARTIAL y 0 FAIL:

| Métrica | Resultado |
| --- | ---: |
| Memory write precision | 100% |
| Memory write recall | 100% |
| Rejection accuracy | 100% |
| Recall precision | 100% |
| Recall coverage | 100% |
| False recall rate | 0% |
| Supersede accuracy | 100% |
| Forget reliability | 100% |
| Current-request precedence | 100% |
| Prompt-injection accuracy | 100% |
| Cross-user leakage | 0 |
| Cross-tenant leakage | 0 |
| Foreign ANN candidates | 0 |

Los denominadores fueron 36 writes esperados, 24 rechazos, 24 recalls, 12 supersedes, 12 Forget y 12 overrides actuales.

## 11. Falsos positivos

No hubo writes indebidos, falsos recalls, candidates ANN extranjeros ni efecto de autoridad. Los casos normales de CRM/visitas/inmuebles funcionaron sin Memory aplicada. Las preferencias de orden de propiedades no contaminaron consultas de leads o visitas.

## 12. Falsos negativos

La baseline perdió 15/36 writes esperados por parser incompleto. Después de los fixes, el corpus final perdió 0/36. El dogfooding descubrió además una coma no cubierta después de `A partir de ahora`; se corrigió y se revalidó tanto en test como en UI.

La limitación deliberada de V1 es atómica: un mensaje que mezcla una preferencia permitida con Product Data se rechaza completo. No se extrae automáticamente la parte segura porque automatic extraction está OFF.

## 13. Calidad de recall

Los 24 recalls necesarios recuperaron la Memory correcta y relevante; 0 memories irrelevantes se aplicaron. La búsqueda vectorial recuperó únicamente candidatos del `vectorScopeKey` del actor. Las formulaciones semánticamente equivalentes convergieron a las mismas claves allowlisted sin cruzar dimensiones como orden, longitud de respuesta, formato horario y workflow.

## 14. Superseding

12/12 sustituciones dejaron un único valor activo en la dimensión afectada. La siguiente conversación recuperó solo el valor nuevo. Las preferencias independientes no se eliminaron ni sobrescribieron entre sí.

## 15. Forget

12/12 secuencias Remember → Recall → Forget → nueva conversación pasaron. Tras Forget no hubo lifecycle activo, candidato vectorial ni aplicación. La UI bajó el contador, añadió `memory.deleted` y Graph dejó de representar el record activo.

## 16. Aislamiento

Cross-user leakage, cross-tenant leakage y foreign ANN candidates fueron 0. Agentes y admins del mismo tenant no heredaron Memory privada de otro usuario. Dos tenants con preferencias textualmente idénticas mantuvieron records y embeddings independientes.

## 17. Prompt injection

24/24 casos adversariales pasaron. Product Data, provider payloads y contenido recuperado no pudieron convertirse en una petición explícita del usuario. Intentos de guardar permisos, roles, secretos, acceso multi-tenant o de saltarse confirmaciones fueron rechazados sin efecto de autoridad.

## 18. Coste

- coste total de 144 conversaciones: `$0.0026755485`;
- coste medio por conversación: `$0.0000185802`;
- proyección lineal por 100 conversaciones: `$0.00185802`;
- coste medio por persona del corpus: `$0.0002229624`;
- embeddings: 60 llamadas, 1.401 tokens;
- coste estimado de embeddings al precio observado de `$0.00000001/token`: `$0.00001401`;
- turno de Property Search con recall: `$0.0000270945` medio;
- turno equivalente posterior a Forget sin recall: `$0.0000264195` medio.

Los costes son una muestra de staging, no una previsión contractual de facturación.

## 19. Latencia

- Memory overhead medio: `471,67 ms` sobre 204 muestras;
- mediana de overhead: `0 ms`; p95: `1.468 ms`;
- classification: `0,059 ms` medio;
- policy: `0,417 ms` medio;
- embedding: `245,68 ms` medio sobre 96 muestras; p95 `597 ms`;
- Convex write: `39,43 ms` medio;
- vector recall: `3,08 ms` medio; p95 `4 ms`;
- document fetch: `8,79 ms` medio;
- application to tool: `0,354 ms` medio;
- Property Search con recall: `9.799,88 ms` medio;
- Property Search posterior a Forget sin recall: `8.662,50 ms` medio.

Un run adicional terminó 143 PASS/1 PARTIAL por un timeout OpenRouter a 31,7 s después de que Memory hubiese hecho recall correctamente. La repetición idéntica cerró 144/144, por lo que se clasifica como variabilidad operacional no reproducible, no como fallo de aislamiento o recall.

## 20. Failure clusters

Baseline:

| Cluster | Checks fallidos |
| --- | ---: |
| Policy mapping | 30 |
| Preference application | 21 |
| Remember parsing/policy | 15 |
| Superseding | 6 |
| Current-request precedence | 6 |
| Policy classification | 2 |

Final: sin clusters funcionales. Observaciones cualitativas restantes: variabilidad de latencia OpenRouter, logout blanco hasta reload y ellipsis de labels Graph en móvil.

## 21. Fixes realizados

Los fixes fueron mínimos y no ampliaron categorías V1:

1. Habilitación temporal, snapshot y restauración fail-closed del kill switch de los dos tenants de evaluación.
2. Parser explícito para `Acuérdate`, `Recorda`, `A partir de ahora`, `Quiero que de ahora en adelante`, `Siempre que`, variante coloquial `Oye` y typo `Recuerd`.
3. Normalización de policy para fechas relativas y prioridad de `PRODUCT_DATA_DENIED` sobre coincidencias genéricas de secreto.
4. Aceptación de puntuación segura tras los prefijos temporales explícitos.
5. Robustez del harness ante expiración del JWT, timeout por turno y reinicio entre fases; no altera Memory de producto.

No se activó automatic extraction, Tenant Memory, consolidation, cleanup scheduler, proactive memory, Skills ni Automations.

## 22. Before / after

| Métrica | Baseline | Final |
| --- | ---: | ---: |
| PASS/PARTIAL/FAIL | 106/23/15 | 144/0/0 |
| Write recall | 58,33% | 100% |
| Rejection accuracy | 91,67% | 100% |
| Recall coverage | 37,5% | 100% |
| Supersede | 50% | 100% |
| Current precedence | 50% | 100% |
| Leakage user/tenant | 0/0 | 0/0 |
| Memory overhead medio | 377,98 ms | 471,67 ms |
| Coste total | $0.00240922 | $0.00267555 |

El aumento de overhead/coste deriva de ejecutar correctamente 36 writes y 24 recalls frente a la cobertura incompleta de la baseline.

## 23. Dogfooding

Se ejecutaron 10 conversaciones naturales mediante la UI real, repartidas entre ambos tenants y distintas cuentas. Pasaron variantes en español/catalán, coloquiales, typo, puntuación, Product Data y authority denial.

Hallazgos:

- la coma tras `A partir de ahora,` falló antes del fix y pasó después;
- el comando mixto preference + Product Data se rechaza completo de forma fail-closed;
- OpenRouter mostró latencia variable en algunas escrituras;
- logout desde una vista Convex puede dejar blanco hasta reload por `ConvexReactClient already closed`.

Resultado: `PASS_WITH_OBSERVATIONS`.

## 24. UI / Graph

PASS en lista, filtros, búsqueda, detail, importance, access count, origen, consentimiento, embedding provider, timestamps, retención, eventos, superseding y delete. Se verificaron cancelación y confirmación inline: cancelar no mutó; confirmar bajó el contador y creó `memory.deleted`.

Graph mostró solo records del usuario autenticado, root privado, topics y Memory activa. Funcionó en desktop y móvil; las etiquetas largas usan ellipsis en viewport estrecho. No se observó mezcla de usuarios ni degradación relevante con el volumen generado.

## 25. Cleanup

El dry-run identificó exactamente 12 usuarios y 154 conversaciones: 144 del corpus y 10 de dogfooding. El apply eliminó, con confirmación ligada al run:

- 188 attempts;
- 154 conversations;
- 1.390 events;
- 80 memory events;
- 43 memory records;
- 428 messages;
- 402 runs;
- 170 usage rows;
- 12 usuarios y sus refresh sessions/settings.

La verificación posterior obtuvo 0 usuarios sintéticos. Tenant 15 quedó `enabled=1` con allowlist `[42,43]`; tenant 16 volvió a `enabled=0` con `[44]`. Los service envs volvieron a tenant 15/user 43; la allowlist general API volvió a 42,43,44. Fixtures Property y canaries existentes no se tocaron.

## 26. Riesgos

- Una corrida adicional registró un timeout OpenRouter no reproducible; conviene medir SLO de proveedor y tasa de timeout en una ventana más larga.
- El split de mensajes mixtos requiere un benchmark separado ligado a automatic extraction; V1 rechaza atómicamente.
- El cierre de sesión desde páginas Convex necesita corregir el lifecycle del cliente para evitar blanco hasta reload.
- Graph móvil trunca labels largas; es cosmético pero reduce legibilidad.
- El corpus es excelente como regresión del contrato allowlisted, pero no sustituye observación humana continuada ni un benchmark de categorías futuras.

No se observó ningún critical failure: leakage, authority effect, deleted recall y pérdida de precedencia fueron todos 0.

## 27. Recomendación

**GO para continuar el uso interno controlado de Explicit User Memory V1 en staging.** Mantener el canary actual y ejecutar el corpus como regression gate en cualquier cambio de parser, policy, embeddings, recall, lifecycle o modelo.

Antes de considerar producción: corregir el logout Convex, definir SLO/monitor de timeout OpenRouter y acumular una ventana interna de uso. Mantener automatic extraction, Tenant Memory y consolidation OFF; sus benchmarks deben ser fases independientes. No continuar con Skills ni Automations desde esta evaluación.

## Artefactos

- `v2/evals/memory/results/memory-eval-baseline-20260815-r1/`
- `v2/evals/memory/results/memory-eval-final-20260815-r1/` — evidencia del timeout no reproducible.
- `v2/evals/memory/results/memory-eval-final-20260815-r2/` — certificación final.
- `v2/evals/memory/results/comparison.json`
- `v2/evals/memory/results/dogfooding-results.json`
