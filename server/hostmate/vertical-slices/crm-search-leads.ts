import { createHash, randomUUID } from "node:crypto";
import type { ActorContext } from "../contracts/actor-context.js";
import type { EntityRef } from "../contracts/domain.js";
import type { EntityListBlock, ExecutionResult } from "../contracts/execution-result.js";
import type { AgentMessageRecord, ControlPlaneRepository, ConversationContextRefs } from "../control-plane/repository.js";
import { redactEventPayload } from "../events/contracts.js";
import { ExecutionDispatchResolver } from "../interaction/dispatch.js";
import { DefaultPolicyEngine } from "../policy/engine.js";
import { ExecutionProfileRegistry } from "../profiles/registry.js";
import {
  CRM_GET_LEAD_CONTEXT_TOOL_ID,
  LeadContextPortError,
  createCrmGetLeadContextTool,
  toCrmLeadContextExecutionResult,
  type CrmGetLeadContextOutput,
  type LeadContextPort,
} from "../product-tools/crm/get-lead-context.js";
import {
  CRM_SEARCH_LEADS_TOOL_ID,
  createCrmSearchLeadsTool,
  toCrmSearchExecutionResult,
  type CrmSearchLeadsOutput,
  type CrmSearchLeadsInput,
  type LeadSearchPort,
} from "../product-tools/crm/search-leads.js";
import {
  VISITS_LIST_LEAD_VISITS_TOOL_ID,
  LeadVisitsPortError,
  createListLeadVisitsTool,
  toLeadVisitsExecutionResult,
  type LeadVisitsPort,
  type ListLeadVisitsInput,
  type ListLeadVisitsOutput,
} from "../product-tools/visits/list-lead-visits.js";
import {
  VISITS_GET_VISIT_TOOL_ID,
  VisitDetailPortError,
  createGetVisitTool,
  toVisitDetailExecutionResult,
  type GetVisitOutput,
  type VisitDetailPort,
} from "../product-tools/visits/get-visit.js";
import { OpenRouterAdapter, OpenRouterRuntimeError, type OpenRouterReasoningEffort, type OpenRouterRuntimeResult } from "../runtime/openrouter-adapter.js";
import { SkillRegistry } from "../skills/registry.js";
import { ProductToolRegistry } from "../tools/registry.js";

export type CrmSearchLeadsSliceConfig = Readonly<{
  model: string;
  fallbackModels?: readonly string[];
  reasoningEffort?: OpenRouterReasoningEffort;
  timeoutMs?: number;
  maxCostUsd?: number;
}>;

export type CrmLeadReadData = Readonly<{
  search?: CrmSearchLeadsOutput;
  context?: CrmGetLeadContextOutput;
  visits?: ListLeadVisitsOutput;
  visitDetail?: GetVisitOutput;
}>;

export type CrmSearchLeadsTurnResult = Readonly<{
  conversationId: string;
  interactionRunId: string;
  executionRunId?: string;
  result: ExecutionResult<CrmLeadReadData>;
  runtime?: OpenRouterRuntimeResult;
}>;

type CapabilityPlan = "search" | "search+context" | "context" | "search+visits" | "visits" | "detail" | "visits+detail" | "search+visits+detail";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function redactObjective(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/(?:\+?\d[\d\s().-]{6,}\d)/g, "[phone]")
    .slice(0, 240);
}

function normalizeEvidence(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9@+]+/g, " ").trim();
}

function bindFiltersToObjective(input: CrmSearchLeadsInput, objective: string): CrmSearchLeadsInput {
  const evidence = normalizeEvidence(objective);
  const normalizedQuery = input.query ? normalizeEvidence(input.query) : undefined;
  if (normalizedQuery && !evidence.includes(normalizedQuery)) throw new Error("QUERY_NOT_GROUNDED_IN_OBJECTIVE");
  const normalizedCity = input.city ? normalizeEvidence(input.city) : undefined;
  const city = normalizedCity && evidence.includes(normalizedCity) ? input.city : undefined;
  const statusEvidence: Record<NonNullable<CrmSearchLeadsInput["status"]>, readonly string[]> = {
    new: ["new", "nuevo", "nueva"], contacted: ["contacted", "contactado", "contactada"],
    qualified: ["qualified", "cualificado", "cualificada"], visit_scheduled: ["visit scheduled", "visita agendada", "visita programada"],
  };
  const status = input.status && statusEvidence[input.status].some((word) => ` ${evidence} `.includes(` ${word} `)) ? input.status : undefined;
  return { ...input, city, status, page: 1, limit: 5 };
}

function wantsLeadContext(message: string): boolean {
  const value = normalizeEvidence(message);
  return /\b(que sabemos|dime que sabemos|contexto|informacion|detalle|tarea|tareas)\b/.test(value);
}

function wantsLeadVisits(message: string): boolean {
  return /\b(visita|visitas|cita|citas)\b/.test(normalizeEvidence(message));
}

function wantsVisitDetail(message: string): boolean {
  const value = normalizeEvidence(message);
  return /\b(cuentame mas|mas detalle|mas detalles|detalle de (la|esta|esa) visita|detalle completo|amplia|ampliar)\b/.test(value);
}

function asksToSearch(message: string): boolean {
  return /\b(busca|buscar|encuentra|encontrar|localiza|localizar)\b/.test(normalizeEvidence(message));
}

function isAnaphoric(message: string): boolean {
  return /\b(el|ella|este|esta|esa|ese|lead seleccionado|seleccionado|seleccionada)\b/.test(normalizeEvidence(message));
}

function isEntityFollowUp(message: string): boolean {
  return /\b(que visitas tiene|que tareas tiene|proxima visita|ultima visita|visita programada|visitas programadas|tiene alguna visita|tareas pendientes)\b/.test(normalizeEvidence(message));
}

function hasExplicitLeadTarget(message: string): boolean {
  const value = normalizeEvidence(message);
  if (asksToSearch(value)) return true;
  const anaphors = "(?:el|ella|este|esta|ese|esa|este lead|lead seleccionado|seleccionado|seleccionada)";
  return new RegExp(`\\bque visitas tiene\\s+(?!${anaphors}\\b)[a-z0-9]`).test(value)
    || new RegExp(`\\bque sabemos de\\s+(?!${anaphors}\\b)[a-z0-9]`).test(value)
    || new RegExp(`\\b(?:visita|visitas|contexto|informacion|detalle)\\s+de\\s+(?!${anaphors}\\b)[a-z0-9]`).test(value);
}

function visitsFilters(message: string, lead: EntityRef): ListLeadVisitsInput {
  const value = normalizeEvidence(message);
  const scope: ListLeadVisitsInput["scope"] = /\b(proxima|proximas|futura|futuras|programada|programadas)\b/.test(value)
    ? "upcoming"
    : /\b(ultima|ultimas|pasada|pasadas|anterior|anteriores|historico|historial)\b/.test(value)
      ? "past"
      : "all";
  const statusEvidence: ReadonlyArray<readonly [RegExp, NonNullable<ListLeadVisitsInput["status"]>]> = [
    [/\b(cancelada por cliente|canceladas por cliente)\b/, "cancelled_by_client"],
    [/\b(cancelada por agente|canceladas por agente)\b/, "cancelled_by_agent"],
    [/\b(sin agentes disponibles|no hay agentes disponibles)\b/, "no_agents_available"],
    [/\b(no se presento|no presentadas|no show)\b/, "no_show"],
    [/\b(confirmada|confirmadas|confirmado|confirmados)\b/, "confirmed"],
    [/\b(completada|completadas|completado|completados)\b/, "completed"],
    [/\b(cancelada|canceladas|cancelado|cancelados)\b/, "cancelled"],
    [/\b(rechazada|rechazadas|rechazado|rechazados)\b/, "rejected"],
    [/\b(flotante|flotantes)\b/, "floating"],
  ];
  return { lead: { type: "crm.lead", id: lead.id, label: lead.label, deepLink: lead.deepLink }, scope, status: statusEvidence.find(([pattern]) => pattern.test(value))?.[1] };
}

function latestEntityList(messages: readonly AgentMessageRecord[], typePrefix?: string): EntityListBlock | undefined {
  for (const message of [...messages].reverse()) {
    const block = [...(message.blocks ?? [])].reverse().find((candidate) => candidate.type === "entity_list"
      && candidate.items.some((item) => !typePrefix || item.ref.type.startsWith(typePrefix)));
    if (block?.type === "entity_list") return block;
  }
  return undefined;
}

function ordinalIndex(message: string): number | undefined {
  const value = normalizeEvidence(message);
  const ordinals: ReadonlyArray<readonly [RegExp, number]> = [
    [/\b((el|la) )?(primero|primera|1)\b/, 0], [/\b((el|la) )?(segundo|segunda|2)\b/, 1],
    [/\b((el|la) )?(tercero|tercera|3)\b/, 2], [/\b((el|la) )?(cuarto|cuarta|4)\b/, 3], [/\b((el|la) )?(quinto|quinta|5)\b/, 4],
  ];
  return ordinals.find(([pattern]) => pattern.test(value))?.[1];
}

function isLeadRef(ref: EntityRef | undefined): ref is EntityRef {
  return ref?.type === "crm.lead";
}

function isVisitRef(ref: EntityRef | undefined): ref is EntityRef {
  return ref?.type === "visits.visit" || ref?.type === "visits.group_visit";
}

function emptyContext(): ConversationContextRefs {
  return { selected: {}, referenced: [] };
}

function withoutCrmSelection(context: ConversationContextRefs): ConversationContextRefs {
  const { lead: _lead, visit: _visit, ...otherDomains } = context.selected;
  return { selected: otherDomains, referenced: context.referenced };
}

function isEntityRef(value: unknown): value is EntityRef {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<EntityRef>;
  return typeof candidate.type === "string" && candidate.type.length > 0
    && typeof candidate.id === "string" && candidate.id.length > 0;
}

export function normalizeStoredContext(value: unknown): ConversationContextRefs | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as { selected?: unknown; referenced?: unknown };
  if (!candidate.selected || typeof candidate.selected !== "object" || Array.isArray(candidate.selected)) return undefined;
  const selected = Object.fromEntries(
    Object.entries(candidate.selected).filter((entry): entry is [string, EntityRef] => isEntityRef(entry[1])),
  );
  const referenced = Array.isArray(candidate.referenced) ? candidate.referenced.filter(isEntityRef) : [];
  return { selected, referenced };
}

function latestConversationContext(messages: readonly AgentMessageRecord[]): ConversationContextRefs {
  for (const message of [...messages].reverse()) {
    const context = normalizeStoredContext(message.contextRefs);
    if (context) return context;
  }
  return emptyContext();
}

function withSelectedRef(context: ConversationContextRefs, ref: EntityRef | undefined): ConversationContextRefs {
  if (!ref) return context;
  if (isLeadRef(ref)) return { selected: { ...context.selected, lead: ref }, referenced: context.referenced };
  if (isVisitRef(ref)) return { selected: { ...context.selected, visit: ref }, referenced: context.referenced };
  return context;
}

function resolveConversationRef(messages: readonly AgentMessageRecord[], message: string): EntityRef | undefined {
  if (hasExplicitLeadTarget(message)) return undefined;
  const ordinal = ordinalIndex(message);
  if (ordinal !== undefined) return latestEntityList(messages)?.items[ordinal]?.ref;
  if (!isAnaphoric(message) && !isEntityFollowUp(message) && !wantsVisitDetail(message)) return undefined;
  const context = latestConversationContext(messages);
  if (wantsVisitDetail(message) && context.selected.visit) return context.selected.visit;
  if (context.selected.lead) return context.selected.lead;
  if (context.selected.visit) return context.selected.visit;
  const refs = (latestEntityList(messages)?.items ?? []).map((item) => item.ref);
  if (refs.length === 1) return refs[0];
  return undefined;
}

function ambiguityResult(messages: readonly AgentMessageRecord[]): ExecutionResult<CrmLeadReadData> {
  const block = latestEntityList(messages, "crm.");
  return {
    status: "needs_input",
    summary: "Necesito que selecciones uno de los candidatos antes de continuar.",
    entities: block?.items.map((item) => item.ref) ?? [], blocks: block ? [block] : undefined, errors: [],
    suggestedNext: ["Selecciona un lead de la lista."],
  };
}

function normalizedFailure(error: unknown): ExecutionResult<CrmLeadReadData> {
  const contextError = error instanceof LeadContextPortError ? error : null;
  const visitsError = error instanceof LeadVisitsPortError ? error : null;
  const visitDetailError = error instanceof VisitDetailPortError ? error : null;
  const runtime = error instanceof OpenRouterRuntimeError ? error : null;
  const code = contextError?.code ?? visitsError?.code ?? visitDetailError?.code ?? runtime?.code ?? "INTERNAL";
  const denied = code === "PERMISSION_DENIED" || code === "POLICY_DENIED" || code === "STALE_REFERENCE";
  const missing = code === "NOT_FOUND";
  return {
    status: denied ? "permission_denied" : "failed",
    summary: denied
      ? "Esa referencia ya no está disponible dentro de tu scope actual."
      : missing ? "La entidad ya no existe o no pertenece al tenant efectivo." : "No se pudo completar la consulta CRM.",
    entities: [], errors: [{ code, message: contextError?.message ?? visitsError?.message ?? visitDetailError?.message ?? runtime?.message ?? "Internal execution error", retryable: runtime?.retryable ?? false, details: runtime?.details }],
    suggestedNext: runtime?.retryable ? ["Vuelve a intentarlo en unos instantes."] : undefined,
  };
}

export class CrmSearchLeadsVerticalSlice {
  constructor(
    private readonly repository: ControlPlaneRepository,
    private readonly leadSearch: LeadSearchPort,
    private readonly leadContext: LeadContextPort,
    private readonly leadVisits: LeadVisitsPort,
    private readonly visitDetail: VisitDetailPort,
    private readonly runtime: OpenRouterAdapter,
    private readonly config: CrmSearchLeadsSliceConfig,
  ) {
    if (!config.model.trim()) throw new Error("CRM read model must come from runtime configuration");
  }

  async execute(actor: ActorContext, input: { conversationId: string; message: string; selectedEntityRef?: EntityRef; requestId?: string; abortController?: AbortController }): Promise<CrmSearchLeadsTurnResult> {
    const message = input.message.trim();
    if (!message || message.length > 500) throw new Error("Message must contain between 1 and 500 characters");
    const interactionRunId = randomUUID();
    const now = Date.now();
    let priorMessages: readonly AgentMessageRecord[];
    try {
      priorMessages = await this.repository.listMessages(actor, { conversationId: input.conversationId, limit: 200 });
    } catch {
      await this.repository.createConversation(actor, { conversationId: input.conversationId, title: "AI Chat" });
      priorMessages = [];
    }
    const priorContext = latestConversationContext(priorMessages);
    const contextualRef = input.selectedEntityRef ?? resolveConversationRef(priorMessages, message);
    let conversationContext = withSelectedRef(
      hasExplicitLeadTarget(message) && !input.selectedEntityRef ? withoutCrmSelection(priorContext) : priorContext,
      contextualRef,
    );
    let messageSequence = (priorMessages.at(-1)?.sequence ?? 0) + 1;
    await this.repository.appendMessage(actor, {
      messageId: randomUUID(), conversationId: input.conversationId, role: "user", contentRedacted: message,
      contextRefs: conversationContext, sequence: messageSequence++, createdAt: now,
    });

    let eventSequence = 0;
    let activeExecutionRunId: string | undefined;
    let activeAttemptId: string | undefined;
    const event = async (type: string, payload: unknown) => {
      await this.repository.appendEvent(actor, {
        eventId: randomUUID(), conversationId: input.conversationId, interactionRunId,
        executionRunId: activeExecutionRunId, attemptId: activeAttemptId,
        sequence: ++eventSequence, type, visibility: "user", payload: redactEventPayload(payload), occurredAt: Date.now(),
      });
    };

    await this.repository.createRun(actor, {
      runId: interactionRunId, conversationId: input.conversationId, kind: "interaction", objectiveHash: hash(message),
      objectiveRedacted: redactObjective(message), dependencyRunIds: [], registryHash: "interaction-dispatch-v2",
      skillVersions: {}, toolScope: [], visibility: "user",
    });
    await this.repository.updateRun(actor, interactionRunId, { status: "running" }, "queued");
    await event("interaction.started", { profile: "crm", objective: redactObjective(message) });

    const asksVisits = wantsLeadVisits(message);
    const directVisitDetail = isVisitRef(contextualRef)
      && (Boolean(input.selectedEntityRef) || ordinalIndex(message) !== undefined || wantsVisitDetail(message));
    const composedVisitDetail = !directVisitDetail && asksVisits && wantsVisitDetail(message);
    const asksContext = wantsLeadContext(message) || ordinalIndex(message) !== undefined;
    const selectedLead = conversationContext.selected.lead;
    const needsEntity = asksContext || asksVisits || wantsVisitDetail(message);
    const plan: CapabilityPlan = directVisitDetail
      ? "detail"
      : asksVisits && selectedLead
        ? composedVisitDetail ? "visits+detail" : "visits"
        : asksVisits
          ? composedVisitDetail ? "search+visits+detail" : "search+visits"
          : selectedLead ? "context" : asksContext ? "search+context" : "search";
    if (!contextualRef && !selectedLead && needsEntity && (isAnaphoric(message) || isEntityFollowUp(message) || wantsVisitDetail(message)) && !hasExplicitLeadTarget(message)) {
      const result = ambiguityResult(priorMessages);
      await event("interaction.needs_input", { reason: "ambiguous_conversation_reference", candidateCount: result.entities.length });
      await this.repository.updateRun(actor, interactionRunId, { status: "completed", resultSummary: result.summary, completedAt: Date.now() }, "running");
      await this.persistAssistant(actor, input.conversationId, messageSequence, undefined, result, conversationContext);
      return { conversationId: input.conversationId, interactionRunId, result };
    }

    let searchOutput: CrmSearchLeadsOutput | undefined;
    let contextOutput: CrmGetLeadContextOutput | undefined;
    let visitsOutput: ListLeadVisitsOutput | undefined;
    let visitDetailOutput: GetVisitOutput | undefined;
    const objectiveBoundPort: LeadSearchPort = {
      search: (context, toolInput) => this.leadSearch.search(context, bindFiltersToObjective(toolInput, message)),
    };
    const toolRegistry = new ProductToolRegistry([
      createCrmSearchLeadsTool({ port: objectiveBoundPort, onResult: (output) => { searchOutput = output; } }),
      createCrmGetLeadContextTool({ port: this.leadContext, onResult: (output) => { contextOutput = output; } }),
      createListLeadVisitsTool({ port: this.leadVisits, onResult: (output) => { visitsOutput = output; } }),
      createGetVisitTool({ port: this.visitDetail, onResult: (output) => { visitDetailOutput = output; } }),
    ]);
    const allowedToolIds = plan === "search" ? [CRM_SEARCH_LEADS_TOOL_ID]
      : plan === "context" ? [CRM_GET_LEAD_CONTEXT_TOOL_ID]
      : plan === "visits" ? [VISITS_LIST_LEAD_VISITS_TOOL_ID]
      : plan === "search+visits" ? [CRM_SEARCH_LEADS_TOOL_ID, VISITS_LIST_LEAD_VISITS_TOOL_ID]
      : plan === "detail" ? [VISITS_GET_VISIT_TOOL_ID]
      : plan === "visits+detail" ? [VISITS_LIST_LEAD_VISITS_TOOL_ID, VISITS_GET_VISIT_TOOL_ID]
      : plan === "search+visits+detail" ? [CRM_SEARCH_LEADS_TOOL_ID, VISITS_LIST_LEAD_VISITS_TOOL_ID, VISITS_GET_VISIT_TOOL_ID]
      : [CRM_SEARCH_LEADS_TOOL_ID, CRM_GET_LEAD_CONTEXT_TOOL_ID];
    const capabilities = plan === "search" ? ["crm.lead.search"]
      : plan === "context" ? ["crm.lead.context"]
      : plan === "visits" ? ["visits.lead.list"]
      : plan === "search+visits" ? ["crm.lead.search", "visits.lead.list"]
      : plan === "detail" ? ["visits.visit.detail"]
      : plan === "visits+detail" ? ["visits.lead.list", "visits.visit.detail"]
      : plan === "search+visits+detail" ? ["crm.lead.search", "visits.lead.list", "visits.visit.detail"]
      : ["crm.lead.search", "crm.lead.context"];
    const dispatch = new ExecutionDispatchResolver(new ExecutionProfileRegistry(), toolRegistry, new SkillRegistry()).resolve({
      actor, allowedToolIds, featureEnabled: (toolId) => allowedToolIds.includes(toolId),
      request: {
        profileId: "crm", objective: message, objectiveClasses: ["lead.lookup"], objectiveCapabilities: capabilities,
        inputRefs: [conversationContext.selected.lead, conversationContext.selected.visit].filter((ref): ref is EntityRef => Boolean(ref)),
        dependencyRunIds: [], internalSkillHints: plan === "context" || plan === "visits" || plan === "detail" || plan === "visits+detail" ? [] : ["resolve-ambiguous-lead"],
        constraints: { readOnly: true, maxResults: 10 },
      },
    });
    const skillVersions = Object.fromEntries(dispatch.skills.map((skill) => [skill.id, skill.version]));
    const toolScope = dispatch.toolResolution.tools.map((tool) => `${tool.toolId}@${tool.version}`);
    await event("interaction.dispatch.resolved", { plan, profile: dispatch.profile.id, profileVersion: dispatch.profile.version, toolScope, skillVersions, inputRefs: dispatch.inputRefs });
    await this.repository.updateRun(actor, interactionRunId, { status: "completed", resultSummary: `Dispatched crm ${plan}`, completedAt: Date.now() }, "running");

    const executionRunId = randomUUID();
    const attemptId = randomUUID();
    activeExecutionRunId = executionRunId;
    await this.repository.createRun(actor, {
      runId: executionRunId, conversationId: input.conversationId, kind: "execution", profileId: "crm",
      profileVersion: dispatch.profile.version, objectiveHash: dispatch.objectiveHash, objectiveRedacted: redactObjective(message),
      parentRunId: interactionRunId, dependencyRunIds: [], registryHash: dispatch.toolResolution.registryHash,
      skillVersions, toolScope, requestedModel: ["context", "visits", "detail", "visits+detail"].includes(plan) ? undefined : this.config.model, visibility: "user",
    });

    if (dispatch.toolResolution.tools.length !== allowedToolIds.length) {
      const result: ExecutionResult<CrmLeadReadData> = {
        status: "permission_denied", summary: "No tienes permiso para consultar leads en este contexto.", entities: [],
        errors: [{ code: "PERMISSION_DENIED", message: dispatch.toolResolution.rejected[0]?.reason ?? "Tool unavailable", retryable: false }],
      };
      await this.repository.updateRun(actor, executionRunId, { status: "failed", errorCode: "PERMISSION_DENIED", resultSummary: result.summary, completedAt: Date.now() }, "queued");
      await event("execution.permission_denied", { rejected: dispatch.toolResolution.rejected });
      await this.persistAssistant(actor, input.conversationId, messageSequence, executionRunId, result, conversationContext);
      return { conversationId: input.conversationId, interactionRunId, executionRunId, result };
    }

    await this.repository.createAttempt(actor, { attemptId, runId: executionRunId, attemptNumber: 1, status: "queued", fencingToken: 0 });
    activeAttemptId = attemptId;
    await this.repository.updateAttempt(actor, { attemptId, expectedStatus: "queued", patch: { status: "running", startedAt: Date.now() } });
    await this.repository.updateRun(actor, executionRunId, { status: "running" }, "queued");
    await event("execution.started", { plan, profile: "crm", profileVersion: dispatch.profile.version, requestedModel: ["context", "visits", "detail", "visits+detail"].includes(plan) ? undefined : this.config.model });

    const runtimeTools = toolRegistry.compileRuntimeTools({
      resolved: dispatch.toolResolution, actor, policy: new DefaultPolicyEngine(), profileId: "crm",
      decisionId: () => randomUUID(), hasRequiredPreconditions: () => true,
    });

    let runtime: OpenRouterRuntimeResult | undefined;
    try {
      if (plan.startsWith("search")) {
        await event("tool.requested", { toolId: CRM_SEARCH_LEADS_TOOL_ID, version: 1 });
        await event("model.started", { requestedModel: this.config.model, provider: "openrouter", reasoningEffort: this.config.reasoningEffort, inference: 1 });
        runtime = await this.runtime.run({
          prompt: message,
          abortController: input.abortController,
          systemPrompt: [
            "You are a scoped CRM lead lookup execution agent.",
            "Call crm.search_leads exactly once. Infer only filters explicitly supported by its schema.",
            "Put a person's name, phone or email in query. Use city only when the user explicitly names a city.",
            "Never invent a tenant, ID, EntityRef, contact detail, status or city. Do not decide among multiple matches.",
          ].join("\n"),
          model: this.config.model, mode: "execution", tools: [...runtimeTools], allowedTools: ["crm.search_leads"],
          onToolUse: async (toolName, toolInput) => await event("tool.started", { toolName, toolInput }),
          onToolResult: async (toolName) => await event("tool.completed", { toolName, service: "lead.service.list", latencyMs: searchOutput?.telemetry?.latencyMs }),
        }, {
          fallbackModels: this.config.fallbackModels,
          reasoningEffort: this.config.reasoningEffort,
          budget: { timeoutMs: this.config.timeoutMs ?? 30_000, maxToolRounds: 0, maxCostUsd: this.config.maxCostUsd ?? 0.05 },
          parallelToolCalls: false, toolChoice: "required", stopAfterToolResult: true,
          metadata: { interaction_run_id: interactionRunId, execution_run_id: executionRunId, request_id: input.requestId ?? 'unknown', profile: "crm", plan },
          sessionId: actor.sessionId,
          onEvent: async (runtimeEvent) => {
            if (runtimeEvent.type === "usage" || runtimeEvent.type === "tool_call" || runtimeEvent.type === "tool_result") return;
            await event(`model.${runtimeEvent.type}`, runtimeEvent);
          },
        });
        if (!searchOutput) throw new OpenRouterRuntimeError("Model did not execute the scoped search tool", "INVALID_TOOL_CALL", false);
        await this.repository.recordUsage(actor, {
          usageId: randomUUID(), runId: executionRunId, attemptId,
          requestedModel: runtime.requestedModel, resolvedModel: runtime.resolvedModel, provider: runtime.provider,
          inputTokens: runtime.detailedUsage.inputTokens, outputTokens: runtime.detailedUsage.outputTokens,
          reasoningTokens: runtime.detailedUsage.reasoningTokens, cachedTokens: runtime.detailedUsage.cachedTokens,
          costUsd: runtime.detailedUsage.costUsd, latencyMs: runtime.latencyMs, fallbackUsed: runtime.detailedUsage.fallbackUsed,
          finishReason: runtime.finishReason, createdAt: Date.now(),
        });
        await event("model.completed", { inference: 1, requestedModel: runtime.requestedModel, resolvedModel: runtime.resolvedModel, provider: runtime.provider, finishReason: runtime.finishReason, usage: runtime.detailedUsage, latencyMs: runtime.latencyMs });
      }

      const leadRef = conversationContext.selected.lead
        ?? (searchOutput?.total === 1 && searchOutput.matches.length === 1 ? searchOutput.matches[0]?.ref : undefined);
      if (leadRef) conversationContext = {
        selected: { ...conversationContext.selected, lead: leadRef },
        referenced: conversationContext.referenced,
      };
      if ((plan === "context" || plan === "search+context") && leadRef) {
        const contextTool = runtimeTools.find((tool) => tool.name === "get_lead_context");
        if (!contextTool) throw new OpenRouterRuntimeError("Context tool is outside the effective scope", "POLICY_DENIED", false);
        await event("tool.requested", { toolId: CRM_GET_LEAD_CONTEXT_TOOL_ID, version: 1, inputRef: leadRef });
        await event("tool.started", { toolName: "get_lead_context", inputRef: leadRef });
        const toolResult = await contextTool.handle({ lead: leadRef });
        if (toolResult.success === false || !contextOutput) throw new OpenRouterRuntimeError("Context tool failed", "INVALID_TOOL_CALL", false);
        await event("tool.completed", { toolName: "get_lead_context", services: contextOutput.telemetry?.services, latencyMs: contextOutput.telemetry?.latencyMs });
      }

      if (["visits", "search+visits", "visits+detail", "search+visits+detail"].includes(plan) && leadRef) {
        const visitsTool = runtimeTools.find((tool) => tool.name === "list_lead_visits");
        if (!visitsTool) throw new OpenRouterRuntimeError("Lead visits tool is outside the effective scope", "POLICY_DENIED", false);
        const filters = visitsFilters(message, leadRef);
        if (plan === "visits+detail" || plan === "search+visits+detail") filters.scope = "upcoming";
        await event("tool.requested", { toolId: VISITS_LIST_LEAD_VISITS_TOOL_ID, version: 1, input: filters });
        await event("tool.started", { toolName: "list_lead_visits", input: filters });
        const toolResult = await visitsTool.handle(filters);
        if (toolResult.success === false || !visitsOutput) throw new OpenRouterRuntimeError("Lead visits tool failed", "INVALID_TOOL_CALL", false);
        await event("tool.completed", {
          toolName: "list_lead_visits", services: visitsOutput.telemetry?.services, latencyMs: visitsOutput.telemetry?.latencyMs,
          visitServiceLatencyMs: visitsOutput.telemetry?.visitServiceLatencyMs,
          returned: visitsOutput.metadata.returned, hasMore: visitsOutput.metadata.hasMore,
          entityRefs: visitsOutput.visits.map((visit) => visit.ref),
        });
      }

      let detailRef = conversationContext.selected.visit;
      if ((plan === "visits+detail" || plan === "search+visits+detail") && visitsOutput) {
        detailRef = visitsOutput.visits[0]?.ref;
        if (!detailRef) throw new OpenRouterRuntimeError("No upcoming visit is available to detail", "NOT_FOUND", false);
        conversationContext = withSelectedRef(conversationContext, detailRef);
      }
      if ((plan === "detail" || plan === "visits+detail" || plan === "search+visits+detail") && detailRef) {
        const detailTool = runtimeTools.find((tool) => tool.name === "get_visit");
        if (!detailTool) throw new OpenRouterRuntimeError("Visit detail tool is outside the effective scope", "POLICY_DENIED", false);
        await event("tool.requested", { toolId: VISITS_GET_VISIT_TOOL_ID, version: 1, input: { visit: detailRef } });
        await event("tool.started", { toolName: "get_visit", input: { visit: detailRef } });
        const toolResult = await detailTool.handle({ visit: detailRef });
        if (toolResult.success === false || !visitDetailOutput) throw new OpenRouterRuntimeError("Visit detail tool failed", "INVALID_TOOL_CALL", false);
        await event("tool.completed", {
          toolName: "get_visit", services: visitDetailOutput.telemetry?.services,
          latencyMs: visitDetailOutput.telemetry?.latencyMs,
          attributionLatencyMs: visitDetailOutput.telemetry?.attributionLatencyMs,
          detailServiceLatencyMs: visitDetailOutput.telemetry?.detailServiceLatencyMs,
          entityRefs: [visitDetailOutput.ref, visitDetailOutput.lead?.ref, visitDetailOutput.property?.ref].filter(Boolean),
          kind: visitDetailOutput.kind,
          result: visitDetailOutput,
        });
        conversationContext = {
          selected: {
            ...conversationContext.selected,
            lead: conversationContext.selected.lead ?? visitDetailOutput.lead?.ref,
            visit: detailRef,
          },
          referenced: conversationContext.referenced,
        };
      }

      const result: ExecutionResult<CrmLeadReadData> = visitDetailOutput
        ? { ...toVisitDetailExecutionResult(visitDetailOutput), data: { search: searchOutput, visits: visitsOutput, visitDetail: visitDetailOutput } }
        : visitsOutput
        ? { ...toLeadVisitsExecutionResult(visitsOutput), data: { search: searchOutput, visits: visitsOutput } }
        : contextOutput
        ? { ...toCrmLeadContextExecutionResult(contextOutput), data: { search: searchOutput, context: contextOutput } }
        : searchOutput
          ? { ...toCrmSearchExecutionResult(searchOutput), data: { search: searchOutput } }
          : throwNoResult();
      await this.repository.updateAttempt(actor, { attemptId, expectedStatus: "running", patch: { status: "succeeded", completedAt: Date.now() } });
      await this.repository.updateRun(actor, executionRunId, {
        status: "completed", resolvedModel: runtime?.resolvedModel, provider: runtime?.provider, finishReason: runtime?.finishReason,
        resultSummary: result.summary, completedAt: Date.now(),
      }, "running");
      await event("execution.completed", {
        status: result.status, entityCount: result.entities.length, inferenceCount: runtime ? 1 : 0,
        searchLatencyMs: searchOutput?.telemetry?.latencyMs, contextLatencyMs: contextOutput?.telemetry?.latencyMs,
        visitsLatencyMs: visitsOutput?.telemetry?.latencyMs,
        visitServiceLatencyMs: visitsOutput?.telemetry?.visitServiceLatencyMs,
        visitDetailLatencyMs: visitDetailOutput?.telemetry?.latencyMs,
        attributionLatencyMs: visitDetailOutput?.telemetry?.attributionLatencyMs,
        detailServiceLatencyMs: visitDetailOutput?.telemetry?.detailServiceLatencyMs,
      });
      await this.persistAssistant(actor, input.conversationId, messageSequence, executionRunId, result, conversationContext);
      return { conversationId: input.conversationId, interactionRunId, executionRunId, result, runtime };
    } catch (error) {
      const result = normalizedFailure(error);
      const errorCode = result.errors[0]?.code ?? "INTERNAL";
      await this.repository.updateAttempt(actor, { attemptId, expectedStatus: "running", patch: { status: errorCode === "TIMEOUT" ? "timeout" : "failed", completedAt: Date.now(), errorCode } });
      await this.repository.updateRun(actor, executionRunId, { status: errorCode === "TIMEOUT" ? "timeout" : "failed", errorCode, resultSummary: result.summary, completedAt: Date.now() }, "running");
      await event("execution.failed", { errorCode, retryable: result.errors[0]?.retryable ?? false });
      await this.persistAssistant(actor, input.conversationId, messageSequence, executionRunId, result, conversationContext);
      return { conversationId: input.conversationId, interactionRunId, executionRunId, result };
    }
  }

  private async persistAssistant(
    actor: ActorContext,
    conversationId: string,
    sequence: number,
    runId: string | undefined,
    result: ExecutionResult<CrmLeadReadData>,
    context: ConversationContextRefs,
  ) {
    const referenced = [...new Map(result.entities.map((ref) => [`${ref.type}:${ref.id}`, ref])).values()];
    await this.repository.appendMessage(actor, {
      messageId: randomUUID(), conversationId, role: "assistant", contentRedacted: result.summary,
      blocks: result.blocks, contextRefs: { selected: context.selected, referenced },
      runId, sequence, createdAt: Date.now(),
    });
  }
}

function throwNoResult(): never {
  throw new OpenRouterRuntimeError("Execution produced no result", "INTERNAL", false);
}
