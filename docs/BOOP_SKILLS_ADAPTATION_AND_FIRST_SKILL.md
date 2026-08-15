# Boop Skills Adaptation and First Skill

Fecha: 2026-08-15  
Estado: candidato a GO para uso interno controlado en staging  
Baseline Boop auditado: `31979130b1371acd9defbea115279a06c63c1fb4`

## 1. Estado previo

La Agent Platform ya disponía de Interaction Runs, Execution Runs, Execution
Profiles, Product Tool Registry, Policy, ActorContext, Convex como control plane,
seis capabilities read-only y Explicit User Memory V1. El Registry de Skills
contenía únicamente metadatos foundation planificados; todavía no cargaba un
`SKILL.md` real ni participaba en una ejecución.

Automatic extraction, Tenant Memory, Consolidation, Automations, writes y
multi-agent orchestration permanecen desactivados.

## 2. Memory operational fixes

### Logout Convex

`HostmateConvexProvider` creaba un cliente por montaje, pero su cleanup cerraba
el cliente antes de que `ConvexProviderWithAuth` pudiera ejecutar `clearAuth()`.
El cierre se difiere al siguiente macrotask: React desmonta primero el provider
de auth, después se cierra el cliente. Un login posterior monta un cliente nuevo;
no se ha introducido singleton global.

### OpenRouter

El adapter conserva timeout, retries, modelo y fallbacks. Ahora produce
observaciones operativas para `connect`, `provider`, `generation`, `runtime` y
`cancellation`, además de intentos, retries, provider/model resuelto, operación,
status y latencia. El monitor process-local de staging expone ventana de 15
minutos, timeout rate y p50/p95/p99 por operación/provider/model, sin prompts,
argumentos, actor ni tenant.

SLO inicial no contractual: mínimo 50 muestras, timeout rate <= 2% y p95 <= 30 s.
Hasta alcanzar 50 muestras el estado es `insufficient_data`.

### Retention/purge

Se añadió una operación Convex scope-first y fail-closed con este índice:

```text
tenant -> owner -> scope=user -> lifecycle/eventType -> createdAt
```

El flujo exige superadmin con `memory.purge`, tenant exacto del actor, owner
explícito, edad mínima de 24 h, lote máximo de 100, preview que crea un plan de
15 minutos y confirmación exacta para consumirlo una sola vez. No existe purge
global ni tenant-wide. El borrado del record elimina su embedding asociado
porque ambos viven en la misma fila. No se ejecutó purge sobre el canary.

Retención propuesta para staging: records `pruned` o superseded durante 30 días;
eventos de Memory durante 90 días; embeddings con el mismo lifecycle del record;
eliminación de usuario dentro de 30 días una vez resuelta su lista canónica de
owners; eliminación de tenant dentro de 30 días mediante enumeración previa de
owners, nunca mediante scan global. La planificación/scheduler de estas tareas
queda fuera de esta fase.

## 3. Mapa Skills de Boop

| Componente | Código Boop | Responsabilidad | Decisión |
| --- | --- | --- | --- |
| Fuente editorial | `.agents/skills/*/SKILL.md` | Procedimiento versionado en Git | KEEP |
| Compatibilidad Claude | `.claude/skills/*` | Descubrimiento project-level | KEEP |
| Formato | frontmatter `name`, `description` + Markdown | Metadata de discovery y playbook | KEEP |
| Claude runtime | `server/runtimes/claude.ts` | `settingSources: ["project"]` y Skill tool | KEEP |
| Execution Agent | `server/execution-agent.ts` | Prompt, runtime y tools de la ejecución | KEEP |
| Codex runtime | `server/runtimes/codex-app-server.ts` | Tools dinámicas del app server | KEEP |
| Dependencias | `skills-lock.json` | Pin de Skills externas | KEEP; no aplica a Skill local |
| Upgrade | `.agents/skills/upgrade/SKILL.md` | Flujo de actualización Boop | KEEP |
| Governance Hostmate | `server/hostmate/skills/registry.ts` | Eligibility, versión, hash y gates | ADAPT |
| Ejecución Hostmate V1 | `server/hostmate/skills/prepare-visit-brief.ts` | Adapter determinista de un playbook | EXTEND |

Los mirrors existentes en `.claude/skills` apuntan o reproducen las fuentes de
`.agents/skills`. `skills-lock.json` se reserva para dependencias externas
pinneadas; una Skill propia del repositorio se reproduce mediante Git,
version/hash y build image, no mediante una entrada local ficticia.

## 4. Flujo original

```text
.agents/.claude SKILL.md
  -> discovery project-level del runtime Claude/Codex
  -> Skill instructions en el contexto del Execution Agent
  -> runtime tools
  -> tool handlers
```

El dispatcher original de Boop no selecciona Skills de producto. La carga ocurre
en el runtime de ejecución, especialmente mediante `settingSources: ["project"]`
en Claude y el árbol `.agents/skills` en Codex.

## 5. Flujo adaptado

```text
objective class + profile + internal hint + feature gate + capabilities
  -> Hostmate Skill Registry
  -> SKILL.md confiable del repositorio
  -> final ToolScope calculado por backend
  -> Policy por cada invocación
  -> un Execution Run
  -> blocks.brief + events + skillRefs
```

El adapter de la primera Skill traduce el procedimiento inequívoco a llamadas
deterministas, mientras el Runtime Core continúa genérico y no contiene un
`if objective === prepare_visit`.

## 6. KEEP / ADAPT / EXTEND / REPLACE

- KEEP: árboles `.agents/.claude`, `SKILL.md`, frontmatter, Markdown procedural,
  runtime Execution Agent, carga project-level, lock de dependencias externas y
  upgrade workflow.
- ADAPT: Registry foundation, resolver de dispatch, Profiles, eventos y
  persistencia de runs para eligibility, gates, versión y hash Hostmate.
- EXTEND: metadata de governance, `skillRefs`, block genérico `brief`, una capa
  de ejecución determinista y exposición mínima en AI Platform.
- REPLACE: los placeholders hardcoded del Registry dejan de ser Skills activas;
  permanecen como `planned`. No se reemplaza el engine de Skills de Boop.

## 7. Core delta

Estimación LOC del runtime Skills materialmente conservado: 962 líneas sin
modificar (`execution-agent`, Claude runtime y Codex app-server) frente a 367
líneas de adapter/registry Hostmate: 72% de código reutilizado. El formato y
workflow editorial se reutiliza en un 88%: se conservan `SKILL.md`, frontmatter,
mirrors, source trust, Git y concepto runtime; se añade governance server-side.
Los conceptos runtime reutilizados se estiman en 90%.

Core Boop modificado: ninguno de `server/execution-agent.ts`,
`server/runtimes/claude.ts` o `server/runtimes/codex-app-server.ts`.

Adapters/extensions principales:

- `server/hostmate/skills/registry.ts`
- `server/hostmate/skills/prepare-visit-brief.ts`
- `server/hostmate/interaction/dispatch.ts`
- `server/hostmate/interaction/turn-classifier.ts`
- `server/hostmate/profiles/registry.ts`
- `server/hostmate/http/runtime-app.ts`
- `server/hostmate/lifecycle/contracts.ts`
- `convex/agentPlatform.ts`

## 8. Tool vs Skill vs Profile vs Run

- Tool: acción atómica, determinista y autorizada individualmente.
- Skill: instrucciones procedurales de ingeniería para resolver una tarea.
- Execution Profile: catálogo máximo de capabilities elegibles para un tipo de
  trabajo; `visits` es el perfil de esta tarea.
- Execution Agent Run: worker efímero con objective, profile, ToolScope final,
  Skill resuelta, ActorContext y límites.
- Interaction Agent: conserva conversación/context refs y coordina el único run.

Una Tool no se convierte en Skill y una Skill no concede autoridad.

## 9. SKILL.md format

La fuente canónica es `.agents/skills/prepare-visit-brief/SKILL.md`, con mirror
idéntico en `.claude/skills`. Mantiene el frontmatter Boop mínimo (`name` y
`description`) y Markdown procedural. Version, profiles, objective classes,
capabilities, gates y estado viven como governance en el Registry para evitar un
segundo formato editorial.

## 10. Skill Registry

El Registry lee el `SKILL.md` del árbol confiable, valida el frontmatter y une
el contenido a metadata runtime: id, version, profiles, objective classes,
required/optional capabilities, status, gate y model compatibility opcional.
No acepta contenido de usuario, tenant, Memory ni Product Data.

Los antiguos ejemplos foundation están `planned`; la única Skill activa es
`prepare-visit-brief`.

## 11. Versioning

Cada Execution Run persiste `skillId`, `version`, hash SHA-256 y `sourcePath`.
El hash V1 se calcula sobre el contenido canónico con saltos LF y whitespace
exterior normalizado. Para la versión desplegada:

```text
prepare-visit-brief@1
b7bba7a3504db21688be1edf7d668ec1e52e9a4e9feacec3af2d0d571848cfaa
```

El commit e imagen completan la reproducción; no se copian snapshots Git a
Convex.

## 12. Selection

V1 usa clasificación determinista de intención natural y un resolver
server-side. Una candidata solo es elegible si coinciden objective class,
profile, allowlist del profile, feature gate, hint interno y todas las
capabilities requeridas. El texto del usuario no puede aportar un Skill ID ni
ensanchar el catálogo.

Canary staging: tenant 15, user 43. El resto falla cerrado antes de ejecutar la
Skill.

## 13. Policy boundary

El backend calcula ToolScope antes de cargar el procedimiento. Cada Tool se
compila de nuevo con `DefaultPolicyEngine`, ActorContext, profile y preconditions.
La Skill no puede alterar tenant, owner, role, permissions, risk, confirmations
ni read-only. Los fallos de autoridad son fatales; los datos ausentes producen
un resultado parcial sin buscar sustitutos.

## 14. Prompt hierarchy

La jerarquía vinculante es:

```text
System / Policy
> Skill confiable
> petición explícita actual
> Memory weak_user_preference
> Product Data recuperado
> Tool results no confiables como instrucciones
```

El playbook describe el procedimiento, nunca autoridad. La primera ejecución es
determinista y no necesita una inferencia LLM para secuenciar pasos inequívocos.

## 15. Memory interaction

Memory no interviene en selection, ToolScope ni procedimiento. Una preferencia
solo podría afectar presentación si una versión futura de la Skill lo permite
explícitamente. Automatic extraction, Tenant Memory y Consolidation continúan
OFF. No se tocaron parser, policy, embeddings ni recall.

## 16. First Skill design

`prepare-visit-brief` resuelve “Prepárame esta visita” exclusivamente desde
`contextRefs.selected.visit`. Sin selección responde `needs_input`, no crea
Execution Run y no busca/lista una visita arbitraria.

El playbook se escribió después de auditar los DTO reales de visita, contexto de
lead e inmueble. El brief solo usa campos presentes en esos contratos.

## 17. Tools used

ToolScope exacto, read-only:

```text
visits.get_visit.v1@1
crm.get_lead_context.v1@1
property.get_property.v1@1
```

No incluye search, list, writes, Memory ni otras capabilities.

## 18. Execution profile

`profile=visits`. La visita es el objetivo y raíz autorizada que proporciona las
refs downstream. No se creó un profile artificial `briefing`.

## 19. Execution flow

```text
selected.visit
  -> Policy + visits.get_visit
  -> refs autorizadas
     -> Policy + crm.get_lead_context  --+
     -> Policy + property.get_property --+ en paralelo
  -> brief complete|partial
```

Existe un Interaction Run y exactamente un Execution Run. Lead/property se
ejecutan en paralelo después de obtener la visita. Ref ausente o dato no
disponible degrada solo ese bloque; denegación de Policy detiene la ejecución.

## 20. Output contract

Se añadió el block reutilizable `brief`, con `title`, `status` y secciones
genéricas de fields/notes/availability. La primera Skill produce Visita, Lead,
Inmueble y Preparación. No muestra JSON ni logs, ni inventa probabilidad de
cierre, recomendaciones sin evidencia o datos fuera de los DTO.

## 21. Observability

El run registra `skillRefs`, profile/version, ToolScope y events de dispatch,
`skill.started`, tools started/completed/partial y `skill.completed|failed`.
Incluye latencia por Tool, total, missing blocks, inference count y coste. Se usa
el Event Contract existente; no se creó un canal paralelo.

## 22. AI Chat

Las cards de visitas ofrecen “Prepárame esta visita”, que envía la ref
seleccionada y el objetivo natural. El renderer genérico muestra el brief por
secciones, con estados parciales visibles y sin markdown gigante.

## 23. AI Platform

Execution detail muestra `prepare-visit-brief@1`, hash abreviado, profile y las
tres Tools exactas. No se construyó Skill Manager ni editor tenant.

## 24. Evaluation corpus

Corpus reproducible de 42 casos deterministas/adversariales:

- activaciones naturales en castellano y catalán;
- negativos próximos y objetivos de CRM/Property;
- Skill ID injection y “usa cualquier skill”;
- gate/profile/capability mismatch;
- selected context ausente;
- lead/property parcial;
- permisos, cross-tenant y widening de Tools.

## 25. Metrics

Resultado local final: selection precision 100%, recall 100%, 0 activaciones
incorrectas, ToolScope accuracy 100%, secuencia 100%, partial correctness 100%,
permission bypass 0, cross-tenant leakage 0 y unauthorized tool exposure 0.

La ejecución determinista hace 0 inferencias, 0 tokens y $0 de coste LLM. La
latencia es la suma de `get_visit` y el máximo de las dos lecturas downstream,
más persistencia/control plane. Las cifras reales de staging se recogen en el
run y en events; no se inventa un promedio a partir de tests.

## 26. Browser E2E

El gate exige con Agent A: seleccionar una visita autorizada, preparar, validar
brief, abrir Execution detail, comprobar Skill/version/hash/Tools, refrescar,
repetir y verificar 390x844. La evidencia de ejecución se registra tras el
despliegue de staging; producción no se toca.

## 27. Regressions

La suite Boop cubre las seis capabilities, Policy, multi-tenancy, lifecycle,
OpenRouter, Memory y Skills. El core determinista/adversarial de Memory sigue
verde. Como los cambios no tocan parsing/policy/recall, se conserva como gate la
última certificación completa: 144/144, false recall 0 y leakage 0.

Hostmate web cubre logout/login con nuevo cliente, CTA/context ref y renderer de
brief. API y web mantienen lint, tests y builds.

## 28. Risks

- El monitor OpenRouter es process-local; producción requerirá exportación a un
  backend de métricas antes de un SLO contractual.
- El purge es una primitive manual segura; faltan jobs de retención y resolución
  canónica de todos los owners para user/tenant deletion.
- La ejecución V1 del playbook es determinista y específica fuera del Core; una
  segunda Skill debe validar que el adapter común sigue siendo delgado.
- El hash depende de la normalización documentada y del commit/image desplegado.

## 29. Blockers

No hay blocker de código conocido para el canary de staging. El GO definitivo
requiere completar el browser E2E y acumular >=50 observaciones OpenRouter para
evaluar el SLO; esto último no bloquea el uso interno, solo la declaración de
cumplimiento del SLO.

## 30. Recommendation

Si el E2E real queda verde, aprobar Skills V1 para el canary tenant 15/user 43.
Mantener writes, automatic Memory, tenant Memory, consolidation, automations y
multi-agent OFF. La siguiente fase recomendada es ampliar el corpus/ventana de
dogfooding y diseñar una segunda Skill read-only antes de plantear
orquestación multi-agent.
