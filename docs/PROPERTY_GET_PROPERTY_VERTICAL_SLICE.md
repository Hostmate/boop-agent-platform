# Property Get Property Vertical Slice

Estado: `GO` para uso interno en staging. Capability read-only: `property.get_property.v1`.
Las inferencias usan OpenRouter `deepseek/deepseek-v4-flash-0731` con
`reasoning.effort=max`; los recorridos deterministas siguen enviando cero
peticiones al proveedor.

## 1. Auditoría de detalle Property

La ficha actual entra por `GET /api/v2/properties/:id` y llama a `property.service.getById(tenantId, id, isSuperAdmin)`. El servicio consulta la property tenant-scoped, resuelve nombre del agente, agente IA, price drop, URLs de media y transparencia legal. Su respuesta completa mezcla catálogo público, operación interna, campos privados, legales, AI y relaciones; por ello no es un DTO seguro para el agente. El schema Prisma se usó para clasificar datos, no para inventar otra lectura.

También se revisaron media/gallery, agentes asociados, campos dinámicos, dossier, datos comerciales y legales, relaciones de visitas/demandas, Property Intelligence y permisos de la ficha. Ninguna de esas superficies sustituye al detalle canónico ni justifica cargar relaciones completas en V1.

## 2. Servicio canónico

La fuente de verdad es `property.service.getById(actor.tenantId, propertyId, false)`. La facade read-only `agent-platform-property-detail.service.ts` transforma su resultado y, solo para Admin/Superadmin, consulta `property-agents.service.getPropertyAgentsConfig`. El runtime no importa Prisma, no ejecuta SQL, no replica joins y no usa `property.search_properties.v1` como detalle.

## 3. Permisos

La tool exige `property.read`, perfil `property`, feature gate activo, modo `read` y riesgo `R0`. El callback verifica de nuevo JWT RS256, sesión activa, usuario, tenant efectivo y `permissionsVersion`; después fija el tenant desde ActorContext. Agent y Admin pueden leer el catálogo completo de ese tenant. Superadmin queda igualmente anclado al tenant firmado porque la facade fuerza `isSuperAdmin=false`. Un inmueble de otro tenant responde como inexistente.

## 4. Campos públicos, internos y privados

- Incluidos: referencia, título, operación, subtipo, estado, precio/EUR, ciudad/zona/provincia, dimensiones, amenities allowlisted, descripción pública, notas públicas, hasta ocho imágenes seguras y agente asociado permitido.
- Internos permitidos de forma acotada: estado comercial, referencia y nombre del comercial canónico; Agent solo ve el agente principal ya expuesto por la ficha y Admin/Superadmin puede ver asociados activos.
- Omitidos: `tenant_id`, dirección exacta/privada, coordenadas, observaciones internas, datos de contacto, prompts/perfiles AI, embeddings, provider/portal payloads, credenciales/tokens, campos legales y catastrales, transparencia detallada, histories, logs, dossiers, campos dinámicos raw y relaciones completas.

`property.read` no se interpreta como permiso universal sobre la fila Prisma. Ante la inconsistencia de que la ficha estándar del producto permite a un Agent abrir un modal con controles de edición, la capability aplica la proyección más restrictiva y no cambia silenciosamente la política global del producto.

## 5. Contract

`property.get_property.v1` tiene owner domain `property`, profile compatible `property`, versión 1, `read`, `R0`, permiso `property.read`, availability `active` bajo feature gate e idempotency `none`. El único input es `{ property: EntityRef<"property.property"> }`; schema `strict`, ID decimal positivo. Rechaza `propertyId`, ID libre, referencia comercial como lookup, tenant/user/role/agent, query, include y fields arbitrarios.

## 6. Provenance

La EntityRef identifica, nunca autoriza. Una selección solo es válida si procede de un bloque de resultado autorizado conservado en la conversación o de `contextRefs.selected.property` previamente persistido. Una ref manual sin esa provenance devuelve `permission_denied`/`STALE_REFERENCE` antes de crear Execution Run, llamar al dominio o llamar al modelo. Incluso con provenance, la lectura vuelve a autorizarse en Hostmate.

## 7. DTO

El DTO final contiene `id`, `reference`, `title`, `operation`, `propertyType`, `status`, `price`, `currency`, `location`, `specifications`, `features`, `description`, `publicNotes`, `images`, `associatedAgents` y telemetry acotada (`services`, `latencyMs`). Los textos y arrays están limitados, las imágenes aceptan solo HTTPS o uploads V2 seguros y la salida se valida con Zod. No contiene ActorContext ni datos raw.

## 8. EntityRefs

La salida emite únicamente la ref canónica del inmueble consultado: `property.property:<staging PK>`, label derivada de referencia+título y deep link `/properties?highlight=<staging PK>`. V1 no emite refs de leads o visitas porque el detalle no obtiene una relación inequívoca y autorizada que lo justifique. Nunca se emiten source IDs de Paz Malet.

## 9. ContextRefs

El resultado persiste `contextRefs.selected.property` y conserva las selecciones existentes de `lead` y `visit`. La ref explícita autorizada tiene prioridad; el lenguaje explícito de dominio decide entre visita e inmueble. Los resets CRM eliminan solo roles CRM cuando corresponde, no roles de Property.

## 10. Detalle determinista

Search → selección → “Cuéntame más” y “Cuéntame más sobre este inmueble” con `selected.property` ejecutan solo `property.get_property.v1`. No vuelven a buscar, no reinterpretan filtros y no llaman OpenRouter. El run `c6c8f671-87bd-4491-97c1-ad62a72bb92a` confirmó inference count 0, tokens 0 y coste 0.

## 11. Search + detail compuesto

“Busca pisos con piscina y cuéntame los detalles del más barato” crea un único Property Execution Run. OpenRouter estructura una búsqueda con `order=price_asc`; el runtime toma determinísticamente el primer resultado y llama a detail sin segunda inferencia. El run staging `92ca87af-8b54-46c7-82ad-43864ac216c6` seleccionó el fixture 865 y usó una inferencia total.

## 12. Tool scoping

Detail seleccionado: `[property.get_property.v1@1]`. Search normal: `[property.search_properties.v1@1]`. Search+detail compuesto: `[property.search_properties.v1@1, property.get_property.v1@1]`. El perfil continúa siendo `property@1`; nunca se entrega el catálogo completo de Property.

## 13. AI Chat

Se añadió el bloque genérico `entity_detail`, no una rama de payload exclusiva para Property. Renderiza imagen/gallery segura, título, referencia/localización, badges de operación/tipo/estado, precio, habitaciones, baños, superficies, features, descripción permitida, comercial y acción “Abrir inmueble”. Mantiene touch targets de 44 px y layout sin overflow a 390×844.

## 14. AI Platform

Executions muestra Property Execution Run, perfil, scope, EntityRef de entrada, provenance, requested/sanitized payloads, servicios, latencias, eventos y usage. El detail seleccionado registrado mostró `property.get_property.v1@1`, `property.service.getById`, latencia de servicio 14,13 ms, inference count 0, tokens 0 y coste `$0.000000`.

## 15. Realtime

Después de abrir Executions, una nueva lectura determinista apareció por Convex realtime sin recargar: run `46ffaf2c-f2f9-4d46-a113-3e3e3e2ae638`, scope get-only, 644 ms. Refresh del chat conservó la conversación y `selected.property`; el follow-up reautorizó y devolvió detalle con cero inferencias.

## 16. Contexto multidominio

La regresión completa conserva simultáneamente `selected.lead`, `selected.visit` y `selected.property`. “Cuéntame más sobre esta visita” selecciona Visits; después “Cuéntame más sobre este inmueble” vuelve a Property. Ambos paths son deterministas cuando la ref es inequívoca. También se corrigió el orden de creación Attempt/Event para que ninguna traza apunte a documentos todavía inexistentes.

## 17. Aislamiento Paz Malet

Tenant 15 puede leer fixtures `STAGING-PM-*`. Refs manuales 579 (Paz Malet), 852 (tenant B) e incluso 853 sin provenance devolvieron `STALE_REFERENCE`, cero entities, cero Execution Run y cero domain/model calls. Con un ActorContext real firmado, la fachada devolvió 200 para staging ID 853 y 404 para 579 y 852. El source sigue con 123 properties, 13 seleccionadas y hash `6af2f9585ff0585de0af372360f56c9d517398d3b112c03ce7c120d85c406df8`; producción contiene cero `STAGING-PM-*`.

## 18. Performance

- Selected detail: Interaction 248 ms, Execution 510 ms, domain 14,13 ms, 0 inferencias, 0 tokens, `$0`; aproximadamente 19 escrituras documentales Convex por el lifecycle/event log.
- Search+detail: Interaction 196 ms, Execution 2,69 s, search 38,09 ms, detail 25,32 ms, 1 inferencia, 349 input tokens, 67 output tokens, `$0.000247`; aproximadamente 24 escrituras Convex. La experiencia browser inicial completó en 5,31 s incluyendo red/UI.

Los counts Convex son estimaciones instrumentadas a partir de las mutations/eventos del recorrido, no métricas de negocio MySQL. No se hizo optimización prematura.

## 19. Staging y browser E2E

Validado con Agent A real, tenant 15 y usuarios internos allowlisted. Flow A buscó tres pisos con piscina y seleccionó 865; Flow B hizo refresh y get-only; Flow C compuso search+detail del más barato; Flow D cambió explícitamente Visit→Property; Flow E pasó 390×844 sin overflow; Flow F mostró el run nuevo en realtime. El deep link `/properties?highlight=865` abrió la ficha correcta `STAGING-PM-822`. El cierre visual confirmó `6 capabilities · read-only`. API staging: `hostmate/re-v2-agent-platform-staging:property-detail-20260815-r2`; runtime: `hostmate/agent-platform-runtime-staging:property-detail-20260815-r3`. Producción no se desplegó.

## 20. Regression

Pasó CRM search → CRM context → lead visits → visit detail → property search → property detail. La selección de Property no destruye Lead/Visit; el target explícito de Visit no colisiona con Property y el regreso explícito a inmueble recupera ID 865. Los cinco tools anteriores permanecen funcionales.

## 21. Tests

Cobertura nueva: contract estricto, rechazo de authority injection, metadata R0/read/profile/permission, DTO y redacción, URL/media segura, Agent/Admin/Superadmin, 404 tenant-scoped, provenance stale/cross-tenant, selected+refresh get-only, composed one-inference, ambigüedad needs-input, scope mínimo, events sin refs colgantes, contexto multidominio, renderer genérico y selección UI. Resultado final: API 146 files/1.254 tests pasados (44 integration opt-in skipped), Web 33/162, Boop 21/136; lint/typechecks y builds API, Web y runtime pasaron.

## 22. Bugs encontrados

1. El direct detail intentó inicialmente enlazar eventos a Execution/Attempt antes de crear esos documentos y Convex devolvió `RUN_FORBIDDEN`; se introdujo linkage explícito interaction/execution/current.
2. El recorrido Visit eliminaba la selección Property; se corrigió la composición de roles de contexto y se añadió regression.
3. `activeAttemptId` en CRM se activaba antes de persistir Attempt, riesgo latente de eventos colgantes; ahora se activa después.
4. El shell decía cinco capabilities aunque health ya exponía seis; se corrigió a seis.
5. El arranque del API staging encontró deadlocks transitorios del geo-catalog sobre fixtures, reintentó y terminó 13/0. Es un comportamiento de startup preexistente, no una escritura de la capability.
6. El deep link estándar muestra a Agent controles de edición/notas privadas en el modal de producto. La capability no los usa ni amplía; requiere revisión separada de política UI.

## 23. Riesgos

La ficha canónica seguirá creciendo y podría incorporar campos nuevos sensibles; la allowlist de la facade debe mantenerse cerrada. Las URLs externas seguras por esquema HTTPS no garantizan disponibilidad. El coste de eventos Convex es aceptable para staging pero debe medirse con volumen. Los deadlocks del job geo y la política del modal estándar son riesgos externos a esta vertical slice.

## 24. Deuda técnica

Centralizar una taxonomía reusable public/internal/private para Property; añadir contadores de writes Convex de primera clase; revisar autorización de controles de edición del modal estándar; separar el geo-catalog de startup; y considerar relations EntityRefs solo cuando existan servicios canónicos de relación y reglas inequívocas. No se añade Memory, semantic search, writes ni nueva Skill.

## 25. Recomendación de siguiente fase

Mantener esta capability en uso interno staging y hacer una revisión independiente de la política de ficha Property para Agent antes de cualquier write. La siguiente fase estratégica puede ser Memory con privacy review explícita, pero no debe iniciarse automáticamente ni mezclarse con esta entrega.
