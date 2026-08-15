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

Infraestructura validada: `it_re-v2-dev` (image `property-search-20260815-r2`) e `it_re-agent-platform-runtime-staging` (image `property-search-20260815-r4`), Convex `different-mockingbird-928`, MySQL `realestate_staging`. Solo tenant 15/users 42 y 43 permanecen allowlisted. Tenant 16 queda fuera. `it_re-v2-prod` no se desplegó ni modificó y producción contiene cero referencias `STAGING-PM-%`.

## Paz Malet staging fixture certification

### Autoridad y snapshots

- SOURCE read-only: `realestate`, tenant `Paz Malet`, `tenant_id=11`.
- TARGET: `realestate_staging`, tenant `Hostmate Mobile Staging`, `tenant_id=15`.
- Guardrail: `11 !== 15`; la escritura aborta si base, ID/nombre del tenant o referencias existentes no coinciden.
- Catálogo fuente auditado: 123 properties; muestra seleccionada: 13.
- Snapshot pre: 123 total, 13 seleccionadas, SHA-256 `6af2f9585ff0585de0af372360f56c9d517398d3b112c03ce7c120d85c406df8`.
- Snapshot post: 123 total, las mismas 13 PK/tenant/reference/status/`updated_at` y el mismo SHA-256.
- Resultado: `Paz Malet source unchanged: PASS`.

El hash compone PK, tenant, reference, title, operación, subtype, status, precio, ciudad/provincia/barrio, rooms, baths, superficie, doce amenities y `updated_at`. La fuente solo se consultó mediante `SELECT`; no participa en la transacción de destino.

### Selección y mapping test-only

La muestra maximiza cobertura de compra/alquiler, precios 2.570–990.000, 1–5 habitaciones, 1–3 baños, 40–210 m², pisos/ático/estudio, activo/alquilado y todas las amenities soportadas.

| Source ID | Source ref | Staging ID | Staging ref | Cobertura principal |
| ---: | --- | ---: | --- | --- |
| 579 | `born` | 853 | `STAGING-PM-579` | compra, 199k, 1 habitación, balcón, AC |
| 627 | `sants` | 854 | `STAGING-PM-627` | compra, terraza, ascensor, jardín |
| 633 | `turo park` | 855 | `STAGING-PM-633` | alquiler, 4 habitaciones, garaje |
| 642 | `paqui` | 856 | `STAGING-PM-642` | piscina, jardín, terraza, ascensor |
| 658 | `bea` | 857 | `STAGING-PM-658` | compra, 650k, terraza |
| 663 | `alfonso XII` | 858 | `STAGING-PM-663` | piscina, garaje, trastero, balcón |
| 674 | `Joan` | 859 | `STAGING-PM-674` | boundary 450k, terraza |
| 704 | `regomir` | 860 | `STAGING-PM-704` | compra, 240k |
| 739 | `Gloria` | 861 | `STAGING-PM-739` | estudio, 159k |
| 749 | `Muntaner` | 862 | `STAGING-PM-749` | 5 habitaciones, a reformar, garaje |
| 754 | `Bea pobel sec` | 863 | `STAGING-PM-754` | ático, 520k, terraza |
| 797 | `ferr pon` | 864 | `STAGING-PM-797` | 160k, terraza, a reformar |
| 822 | `Aribau alquiler` | 865 | `STAGING-PM-822` | alquiler, piscina, garaje, ascensor |

### Campos y mecanismo

- Copiados: title de catálogo, operación/type, `property_subtype`, status, price, city, province, neighborhood, rooms, bathrooms, `area_built` y amenities booleanas allowlisted.
- Transformados: PK autogenerada, `tenant_id=15`, reference `STAGING-PM-<sourceId>`, prefijo de title `[STAGING PM]` y timestamps nuevos de staging.
- Omitidos/neutralizados: description y notas, direcciones/coordenadas, media/galerías/video/URLs/slugs, usuarios/agentes/AI agents, leads/visits/template values, portales, campañas, Instagram, flows, scraping/sync/publication, legal/AI/custom payloads y toda relación externa. Contacto, visitas, reserva y transparencia pública quedan desactivados.
- Media: omitida completamente.
- Mecanismo: `v2/scripts/seed-agent-platform-property-fixtures.mjs`, dry-run por defecto y `--apply` explícito; Prisma transaction target-only, sin endpoint público ni lectura/escritura de source durante el apply.
- Verificación target: 13 filas/13 references únicas, IDs 853–865, tenant 15; cero ubicación sensible, contenido externo, relaciones o flags de side effects. `property.service.list` devuelve las copias.

Los fixtures permanecen para regresión. Limpieza futura segura: ejecutar primero un dry-run que exija base `realestate_staging`, tenant 15, exactamente las 13 referencias allowlisted y cero filas en `RE_Leads`, `RE_Property_Agents`, `RE_Property_Portals` y `RE_Property_Template_Values`; después borrar esas 13 filas en una única transacción target-only y verificar que ninguna otra property cambió. Nunca usar source IDs ni operar en `realestate`.

### Certificación funcional

- Multiple: “Busca pisos en Barcelona para comprar” → total 9, returned 6, `hasMore=true`, seis EntityRefs staging distintas; todas `propertyType=piso` tras el fix mínimo de grounding.
- Precio: pisos de compra hasta 450.000 EUR → 4 resultados, todos dentro del límite e incluye exactamente 450.000.
- Feature: pisos de compra con piscina → IDs staging 856 y 858, ambos con piscina.
- Combinación: compra en Barcelona hasta 700.000 EUR con terraza → 5 resultados, todos cumplen los tres filtros.
- Orden: compra en Barcelona de menor a mayor → primeras cards 159k, 160k, 199k, 240k, 450k y 520k.

## 18. Browser E2E

Completado con sesión real de Agent A en `v2-dev`: los cinco casos positivos, selección del staging ID 861, deep link `/properties?highlight=861`, cards con `STAGING-PM-*`, y vuelta posterior a CRM/Visits. Executions recibió todos los Interaction/Execution runs por Convex realtime sin reload; scope efectivo `property@1`, una tool `property.search_properties.v1@1`, una inferencia y EntityRefs únicamente con PK staging. En viewport real emulado 390×844 no hay overflow horizontal (`390/390`); Abrir y Seleccionar miden 44 px de alto.

## 19. Multi-tenant y provenance

Agent A real (`user_id=43`, tenant 15) obtiene las copias y, para compra ordenada, únicamente IDs staging `861,864,853,860,859,863` en la primera página. La referencia de tenant B `STAGING-MOBILE-FOREIGN` devuelve 0; inyección `tenantId=16` recibe 400 y un token sin `property.read` recibe 403. Una EntityRef manual con source ID 579 y conversación nueva devuelve `permission_denied` + `STALE_REFERENCE`, cero entities y cero domain/model calls; no entra en `contextRefs.selected.property`. Producción tiene cero referencias `STAGING-PM-%` y el snapshot fuente permanece idéntico.

## 20. Performance

Run property final: Interaction 220 ms; Execution 2,40 s; OpenRouter/OpenAI `openai/gpt-4.1-mini` 1.769 ms, 341 input + 61 output tokens y USD 0,000234; `property.service.list` 36,68 ms. Convex: 23 document writes estimados (2 mensajes, 2 runs, 4 run updates, 9 events, 1 attempt, 2 attempt updates y 1 usage). Selección/follow-up limitado: 0 inferencias. Comparativa CRM search: Interaction 185 ms; Execution 1,72 s; modelo 1.148 ms, 183+15 tokens, USD 0,0000972; `lead.service.list` 111,09 ms; 25 writes. Property cuesta aproximadamente 2,41× CRM en esta muestra única, dominado por prompt/tokens, no por dominio.

## 21. Regression

Pasó en navegador real tras el deploy final: lead search → selección/context → lead visits → selección/visit detail → property search. La primera pasada descubrió que un property previamente seleccionado podía capturar “Cuéntame más sobre esta visita”; se corrigió haciendo autoritativa la EntityRef explícita y se revalidó `visits.get_visit.v1` correctamente, manteniendo separados los roles de contexto.

## 22. Tests

Cobertura añadida: schema/authority injection, objective grounding —incluida recuperación determinista de un único property type explícito aunque el modelo lo omita—, DTO, EntityRef, zero/one/multiple, permission/profile scope, precedencia de EntityRefs, one-tool/one-inference run, requested-vs-sanitized telemetry, context role preservation y 0-inference follow-up. Hostmate cubre mapping exacto a `property.service.list`, Agent/Admin/Superadmin, defaults/paginación backend-owned, DTO, permissions, tenant A/B e inyecciones. Web cubre deep-link ID parsing y cards. La fixture tiene dry-run local/contenedor, guardrails de base/tenant/references y transacción target-only. Resultado final: Boop 21 files/131 tests; Hostmate internal routes 53 tests; Web 33 files/161 tests; typechecks y builds de runtime/API/Web pasan. Persisten únicamente los warnings conocidos de tamaño de bundle/caniuse-lite.

## 23. Problemas

1. Los fixtures revelaron que OpenRouter podía omitir `propertyType=piso` ante la frase inequívoca “Busca pisos…”. Se corrigió mínimamente en el binder: recupera un solo tipo explícito y no infiere nada si hay varios; test y rerun staging pasan 9 pisos exactos.
2. El primer apply no escribió nada porque MySQL rechazó el alias reservado `database` en el guardrail `SELECT DATABASE()`; se cambió a `current_database`, se confirmó count 0 y el único apply posterior fue atómico.
3. Inconsistencia UI/service sobre inclusión de desactivados, fuera de alcance.
4. El inventario canónico solo soporta counts exactos; el motor chatbot soporta rangos, fuera de alcance.
5. El deep link abre la ficha estándar, que actualmente expone controles de edición también al Agent; no es una ampliación causada por la capability y se mantiene fuera de alcance.
6. La primera prueba manual de provenance omitió claims de locale/timezone y produjo un 500/Zod antes de evaluar la EntityRef; se repitió con el token canónico y dio el `STALE_REFERENCE` esperado. La traza fallida permanece durable.

## 24. Riesgos

- Normalizar silenciosamente operación o relajar filtros produciría falsos positivos; se evita.
- Una EntityRef aportada por cliente sin provenance podría contaminar contexto; selección exige que haya aparecido en un bloque previo.
- Imágenes remotas pueden fallar; solo se entregan relative uploads o HTTPS y la UI usa `no-referrer`.
- Los fixtures son datos persistentes de staging; su script fail-closed y la limpieza documentada deben conservarse para evitar borrados amplios o re-aplicaciones accidentales.

## 25. Deuda técnica

- Decidir si la UI debe incluir desactivados por defecto o alinearse con el service default.
- Migrar/normalizar fixtures históricos `venta` fuera de esta capability.
- Evaluar, como cambio de producto independiente, rangos de rooms/baths en `property.service.list`.
- Mantener los 13 fixtures `STAGING-PM-*` como baseline de regresión y revisar su vigencia si cambia el schema de Properties.
- Evaluar semantic search como capability separada, nunca fallback implícito de V1.

## 26. Recomendación de siguiente capability

El gap de datos queda cerrado y `property.search_properties.v1` puede pasar a GO. La siguiente capability natural es revisar `property.get_property.v1`, usando la PK tenant-scoped y una fachada read-only específica; no debe reutilizar DTOs Prisma completos ni implementarse sin GO explícito.
