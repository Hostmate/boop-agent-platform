# Property Search Properties — Vertical Slice

Fecha: 2026-08-15. Scope: exclusivamente `property.search_properties.v1`, read-only, staging interno. Producción y `main` quedan fuera de alcance.

## 1. Auditoría del dominio

El catálogo canónico vive en `RE_Properties`, con PK numérica y unicidad `(tenant_id, reference)`. `property.service.list` es la operación que sirve `/api/v2/properties` y la UI de inventario. Filtra soft-delete (`deleted_at IS NULL`), aplica filtros deterministas con Prisma, pagina y enriquece imágenes, precio, agente y señales de visitas. `property-search.service.ts` es un motor diferente, orientado a chatbot/demand matching: fuerza `status='activo'`, soporta rangos de habitaciones/baños y una relajación acumulativa de seis niveles. La búsqueda semántica puntúa `ai_profile` y está integrada en flows públicos/chatbot, no en la pantalla de inventario.

Campos reales relevantes: referencia, título/description searchable, `type` de operación, `property_subtype`, estado, precio, ciudad, provincia, neighborhood, superficies, rooms, bathrooms, booleanos de amenities, `agent_id`, `ai_agent_id`, media y campos dinámicos/legal/AI no necesarios para esta capability. `agents_mode` y `RE_Property_Agents` gobiernan routing de comerciales, no visibilidad del catálogo.

## 2. Permission model

- Agent: `/properties` es una ruta para todo usuario autenticado y `GET /api/v2/properties` no restringe por `agent_id`; ve el catálogo completo del tenant efectivo. La ficha existente también muestra controles de edición al Agent, fuera del Agent Platform.
- Admin: el mismo scope tenant-wide y los mismos controles del producto; esta tool no expone ninguna acción de escritura.
- Superadmin: la API histórica puede abrir catálogo cross-tenant con `isSuperAdmin=true`, pero Agent Platform pasa siempre `false` y usa exclusivamente `tenant_id` firmado. El effective tenant no es input del modelo ni del cliente.
- Permission del Product Tool: `property.read`, emitido server-side a actores Hostmate habilitados. Cada callback revalida firma, sesión, permissionsVersion, allowlists y kill switches antes de invocar el dominio.

## 3. Servicio canónico

`property.service.list` es la operación canónica. La fachada interna solo traduce un contrato reducido a sus filtros y convierte la respuesta en DTO; no contiene Prisma/SQL ni duplica la búsqueda. Se descarta `property-search.service` para V1 porque cambiaría la semántica visible de inventario al forzar activos y porque su relajación elimina restricciones. También se descarta la búsqueda semántica para este contrato determinista.

## 4. Deterministic vs semantic

Decisión A: filtros deterministas únicamente. No hay semantic fallback ni relajación. Los criterios cualitativos basados en `ai_profile` merecen, si producto lo aprueba, una capability separada posterior como `property.semantic_search.v1`. V1 usa una sola inferencia únicamente para estructurar lenguaje natural en filtros allowlisted.

## 5. Defaults

Defaults de producto aplicados por `property.service.list`: `deleted_at IS NULL`; si no se pide estado, excluir `desactivado`; página 1; límite interno 6; orden heredado seguro `created_at DESC`; moneda de presentación EUR. No hay default de operation, city, subtype, rooms, baths, price, area, features ni status=`activo`.

La UI histórica pasa `include_deactivated=true` cuando no hay filtro de estado, mientras el servicio por defecto excluye desactivados. Agent Platform conserva el default más restrictivo del servicio. El fixture staging usa `type='venta'`, aunque validators, UI, scraper y motores de búsqueda declaran el vocabulario canónico `comprar|alquilar`; no se normaliza silenciosamente en esta fase.

## 6. Tool contract

- ID/version: `property.search_properties.v1` / 1.
- Owner/profile: `property` / `property`.
- Capability: `property.property.search`.
- Mode/risk: read / R0.
- Permission: `property.read`.
- Availability: active detrás de los feature gates existentes.
- Input estricto; unknown keys rechazadas. Tenant, actor, role, permission, IDs de autoridad, page, limit, SQL sort, relations y raw flags no aparecen en el schema LLM-visible.

## 7. Filters

Soportados porque existen en `PropertyFiltersSchema` + `property.service.list`:

- `query`: contains sobre title/reference/description; se usa también para referencia comercial.
- `city`, `neighborhood`.
- `operation`: `comprar|alquilar` → `type`.
- `propertyType` → `property_subtype` dinámico del catálogo.
- `status`: `activo|reservado|vendido|alquilado|desactivado`.
- `minPrice`, `maxPrice`.
- `rooms` y `bathrooms` exactos. No se publican mínimos/máximos porque el servicio de inventario no los soporta.
- `minArea`, `maxArea` sobre `area_built`.
- features: exterior, ascensor, garaje, piscina, jardín, terraza, aire acondicionado, trastero, a reformar, reformado, amueblado y balcón.
- `order`: `price_asc`, `price_desc`, `newest`, solo con petición explícita.

No se exponen province, useful/plot area, year, agent/AI-agent, portal ni campos comerciales/industriales avanzados en este primer contrato, aunque algunos existen en el backend.

## 8. Scope

El runtime cierra `ActorContext` sobre el handler. La fachada Hostmate recibe un Actor JWT RS256, reautoriza y llama `property.service.list(actor.tenantId, ..., false)`. Agent y Admin obtienen tenant-wide según la política actual. El modelo nunca puede ampliar scope. `page=1`, `limit=6` y sort allowlisted se fijan server-side.

## 9. DTO

Cada card incluye: id string, reference, title, operation, propertyType, price, currency EUR, city, neighborhood, rooms, bathrooms, areaBuilt, status, HTTPS/relative product image segura, features esenciales, associatedAgent y EntityRef. No contiene tenant, row Prisma, legal data, private address, observations, portals, embeddings, `ai_profile`, provider/tokens ni metadata interna.

## 10. EntityRefs

La referencia canónica es `{ type:'property.property', id:<tenant-scoped PK>, label, deepLink:'/properties?highlight=<id>' }`. La referencia comercial es atributo/label, nunca autoridad. La página de properties valida el ID positivo y abre el modal; la API vuelve a aplicar tenant scope.

## 11. Selected property context

El botón Seleccionar envía la EntityRef previamente emitida en un bloque durable. El runtime exige provenance en mensajes anteriores, escribe `contextRefs.selected.property` y conserva cualquier `selected.lead` o `selected.visit`. No requiere cambios al modelo genérico `selected: Record<string, EntityRef>`. No usa Memory. “Cuéntame más” con property seleccionado se resuelve sin inferencia y declara que `property.get_property.v1` todavía no está habilitada.

## 12. Interaction flow

El clasificador solo reconoce intención de búsqueda + sustantivo inmobiliario, o un follow-up genérico sobre property seleccionado. Una `selectedEntityRef` explícita tiene precedencia: property entra en Property y lead/visit entra en CRM aunque exista un property previo; menciones explícitas de visita/lead/cliente también vencen al contexto property. No extrae filtros ni contiene lógica de catálogo. La salida es profile `property`, objective class `property.search` y capability `property.property.search`; el resto sigue en el flujo CRM aprobado.

## 13. Property Execution Run

La búsqueda crea Interaction Run y un Execution Run `profile=property@1`. El modelo actual de OpenRouter recibe instrucciones property-only, hace exactamente una tool call y se detiene tras el tool result. Lifecycle: queued → running → completed/failed; attempt y usage se persisten igual que en CRM.

## 14. Tool scoping

Scope durable y efectivo: `[property.search_properties.v1@1]`. Skills: `{}`. Runtime tools visibles: únicamente `property.search_properties`; no aparecen CRM, Visits, semantic, get_property ni writes. El backend registra input solicitado y input sanitizado. El binder elimina cada opcional sin evidencia textual, incluso status/operation inventados y counts comparativos que el backend solo soporta como exactos.

## 15. AI Chat

`entity_list` admite `imageUrl` opcional y renderiza property cards estructuradas. Cada card muestra título/referencia, precio, ubicación, operación/tipo, rooms/baths/area, features, estado y comercial cuando existen. “Abrir” y “Seleccionar inmueble” son controles distintos, ambos con target mínimo de 44 px. Multiple sigue `completed`, no `needs_input`.

## 16. AI Platform

La vista genérica de Executions muestra profile/property version, tool version, objective, requested/resolved model, provider, tokens, cost, latency, events y result summary. `tool.started` conserva argumentos solicitados; `tool.completed` contiene argumentos sanitizados, servicio, latencia, counts y EntityRefs. No hay rama UI especial para Property.

## 17. Staging validation

Infraestructura validada: `it_re-v2-dev` (image `property-search-20260815-r2`) e `it_re-agent-platform-runtime-staging` (image `property-search-20260815-r3`), Convex `different-mockingbird-928`, MySQL `realestate_staging`. Solo tenant 15/users 42 y 43 permanecen allowlisted. Tenant 16 queda fuera. `it_re-v2-prod` permaneció 1/1 y sin cambios.

Inventario staging auditado read-only: tenant 15 tiene únicamente property 851 (`STAGING-MOBILE-001`, Barcelona), activa, sin precio/rooms/baths/area/features; tenant 16 tiene property 852 (`STAGING-MOBILE-FOREIGN`), también incompleta. Por la prohibición explícita de create/update property no se fabrican fixtures. Esto impide certificar en staging los positivos multiple, price y feature; se mantiene como gap de aceptación, no se oculta con datos productivos.

## 18. Browser E2E

Completado con sesión real de Agent A en `v2-dev`: Barcelona devuelve la card 851; precio hasta 1.500 EUR y casa+terraza devuelven zero coherente con el fixture incompleto; referencia exacta devuelve 851; Reykjavik y la referencia de tenant B devuelven zero. Selección y “Cuéntame más” son deterministas y declaran la ausencia de `get_property`; el deep link `/properties?highlight=851` abre la ficha tenant-scoped. Convex añadió los runs a Executions sin reload. En viewport emulado 390×844 no hay overflow horizontal; botones Abrir y Seleccionar miden 44 px de alto. No puede existir un positivo multiple/price/feature sin autorización separada para fixtures.

## 19. Multi-tenant

Tests locales prueban Agent/Admin/Superadmin tenant-wide dentro del tenant firmado, `isSuperAdmin=false` al servicio, tenant A/B disjoint, permission deny y rechazo de `tenantId`, `tenant_id`, user, agent, page, limit y SQL sort. En staging, Agent A no ve `STAGING-MOBILE-FOREIGN`; Admin 42 obtiene únicamente ID 851 para Barcelona y zero para la referencia tenant B; inyección `tenantId=16` recibe 400 y un token real sin `property.read` recibe 403.

## 20. Performance

Run property final: Interaction 220 ms; Execution 2,40 s; OpenRouter/OpenAI `openai/gpt-4.1-mini` 1.769 ms, 341 input + 61 output tokens y USD 0,000234; `property.service.list` 36,68 ms. Convex: 23 document writes estimados (2 mensajes, 2 runs, 4 run updates, 9 events, 1 attempt, 2 attempt updates y 1 usage). Selección/follow-up limitado: 0 inferencias. Comparativa CRM search: Interaction 185 ms; Execution 1,72 s; modelo 1.148 ms, 183+15 tokens, USD 0,0000972; `lead.service.list` 111,09 ms; 25 writes. Property cuesta aproximadamente 2,41× CRM en esta muestra única, dominado por prompt/tokens, no por dominio.

## 21. Regression

Pasó en navegador real tras el deploy final: lead search → selección/context → lead visits → selección/visit detail → property search. La primera pasada descubrió que un property previamente seleccionado podía capturar “Cuéntame más sobre esta visita”; se corrigió haciendo autoritativa la EntityRef explícita y se revalidó `visits.get_visit.v1` correctamente, manteniendo separados los roles de contexto.

## 22. Tests

Cobertura añadida: schema/authority injection, objective grounding —incluidos opcionales sobredimensionados inventados—, DTO, EntityRef, zero/one/multiple, permission/profile scope, precedencia de EntityRefs, one-tool/one-inference run, requested-vs-sanitized telemetry, context role preservation y 0-inference follow-up. Hostmate cubre mapping exacto a `property.service.list`, Agent/Admin/Superadmin, defaults/paginación backend-owned, DTO, permissions, tenant A/B e inyecciones. Web cubre deep-link ID parsing y cards. Resultado final local: Boop 21 files/131 tests, Hostmate internal routes targeted 53 tests, Web 33 files/161 tests; typechecks y builds pasan. El full API tuvo 1 fallo flaky ajeno (`instagram-webhook-durability`) entre 1.239 tests pasados; aislado pasó 2/2.

## 23. Problemas

1. Datos staging insuficientes para los cinco casos positivos pedidos.
2. Vocabulario histórico `venta` en el único fixture frente al canónico `comprar` del producto.
3. Inconsistencia UI/service sobre inclusión de desactivados.
4. El inventario canónico solo soporta counts exactos; el motor chatbot soporta rangos, pero usarlo alteraría status/defaults y relajación.
5. La primera E2E de referencia expuso un `maxArea` inventado fuera del límite del schema antes del binder; el envelope se amplió para permitir sanitizarlo y la referencia quedó revalidada.
6. La primera regresión visit/detail expuso colisión de contexto con property; se corrigió la precedencia y el rerun pasó. Las trazas fallidas históricas permanecen visibles, como corresponde a un control plane durable.
7. El deep link abre la ficha estándar, que actualmente expone controles de edición también al Agent; no es una ampliación causada por la capability, pero conviene revisar esa política de producto por separado.

## 24. Riesgos

- Normalizar silenciosamente operación o relajar filtros produciría falsos positivos; se evita.
- Una EntityRef aportada por cliente sin provenance podría contaminar contexto; selección exige que haya aparecido en un bloque previo.
- Imágenes remotas pueden fallar; solo se entregan relative uploads o HTTPS y la UI usa `no-referrer`.
- La ausencia de fixtures puede dar una falsa sensación de cobertura si se confunden zero tests con positivos; el gate queda explícitamente condicionado.

## 25. Deuda técnica

- Decidir si la UI debe incluir desactivados por defecto o alinearse con el service default.
- Migrar/normalizar fixtures históricos `venta` fuera de esta capability.
- Evaluar, como cambio de producto independiente, rangos de rooms/baths en `property.service.list`.
- Proveer fixtures sintéticos aprobados para multiple/price/features o un tenant interno ya poblado.
- Evaluar semantic search como capability separada, nunca fallback implícito de V1.

## 26. Recomendación de siguiente capability

No abrir `property.get_property.v1` hasta cerrar el gap de datos y aprobar `property.search_properties.v1`. Una vez certificado el search con fixtures positivos reales, la siguiente capability natural es `property.get_property.v1`, usando la PK tenant-scoped y una fachada read-only específica; no debe reutilizar DTOs Prisma completos.
