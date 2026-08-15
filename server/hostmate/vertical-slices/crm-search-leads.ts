import { createHash, randomUUID } from "node:crypto";
import type { ActorContext } from "../contracts/actor-context.js";
import type { EntityRef } from "../contracts/domain.js";
import type { AgentContentBlock, ExecutionResult } from "../contracts/execution-result.js";
import type { AgentMessageRecord, ControlPlaneRepository } from "../control-plane/repository.js";
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
import { OpenRouterAdapter, OpenRouterRuntimeError, type OpenRouterRuntimeResult } from "../runtime/openrouter-adapter.js";
import { SkillRegistry } from "../skills/registry.js";
import { ProductToolRegistry } from "../tools/registry.js";

export type CrmSearchLeadsSliceConfig = Readonly<{
  model: string;
  fallbackModels?: readonly string[];
  timeoutMs?: number;
  maxCostUsd?: number;
}>;

export type CrmLeadReadData = Readonly<{
  search?: CrmSearchLeadsOutput;
  context?: CrmGetLeadContextOutput;
}>;

export type CrmSearchLeadsTurnResult = Readonly<{
  conversationId: string;
  interactionRunId: string;
  executionRunId?: string;
  result: ExecutionResult<CrmLeadReadData>;
  runtime?: OpenRouterRuntimeResult;
}>;

type CapabilityPlan = "search" | "search+context" | "context";

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
    new: ["new", "nuevo", "nueva"], pending: ["pending", "pendiente"], contacted: ["contacted", "contactado", "contactada"],
    qualified: ["qualified", "cualificado", "cualificada"], visit_scheduled: ["visit scheduled", "visita agendada", "visita programada"],
  };
  const status = input.status && statusEvidence[input.status].some((word) => ` ${evidence} `.includes(` ${word} `)) ? input.status : undefined;
  return { ...input, city, status, page: 1, limit: 5 };
}

function wantsLeadContext(message: string): boolean {
  const value = normalizeEvidence(message);
  return /\b(que sabemos|dime que sabemos|contexto|informacion|detalle|visita|visitas|tarea|tareas)\b/.test(value);
}

function asksToSearch(message: string): boolean {
  return /\b(busca|buscar|encuentra|encontrar|localiza|localizar)\b/.test(normalizeEvidence(message));
}

function isAnaphoric(message: string): boolean {
  return /\b(el|ella|este|esta|esa|ese|lead seleccionado|seleccionado|seleccionada)\b/.test(normalizeEvidence(message));
}

function isContextFollowUp(message: string): boolean {
  return /\b(que visitas tiene|que tareas tiene|proxima visita|tareas pendientes)\b/.test(normalizeEvidence(message));
}

function latestEntityList(messages: readonly AgentMessageRecord[]): AgentContentBlock | undefined {
  for (const message of [...messages].reverse()) {
    const block = [...(message.blocks ?? [])].reverse().find((candidate) => candidate.type === "entity_list");
    if (block) return block;
  }
  return undefined;
}

function ordinalIndex(message: string): number | undefined {
  const value = normalizeEvidence(message);
  const ordinals: ReadonlyArray<readonly [RegExp, number]> = [
    [/\b(el )?(primero|primera|1)\b/, 0], [/\b(el )?(segundo|segunda|2)\b/, 1],
    [/\b(el )?(tercero|tercera|3)\b/, 2], [/\b(el )?(cuarto|cuarta|4)\b/, 3], [/\b(el )?(quinto|quinta|5)\b/, 4],
  ];
  return ordinals.find(([pattern]) => pattern.test(value))?.[1];
}

function resolveConversationRef(messages: readonly AgentMessageRecord[], message: string): EntityRef | undefined {
  const ordinal = ordinalIndex(message);
  if (ordinal !== undefined) return latestEntityList(messages)?.items[ordinal]?.ref;
  if (!isAnaphoric(message) && !isContextFollowUp(message)) return undefined;
  for (const prior of [...messages].reverse()) {
    if (prior.contextRefs?.length === 1) return prior.contextRefs[0];
    const refs = (prior.blocks ?? []).flatMap((block) => block.items.map((item) => item.ref));
    if (refs.length === 1) return refs[0];
  }
  return undefined;
}

function ambiguityResult(messages: readonly AgentMessageRecord[]): ExecutionResult<CrmLeadReadData> {
  const block = latestEntityList(messages);
  return {
    status: "needs_input",
    summary: "Necesito que selecciones uno de los candidatos antes de consultar su contexto.",
    entities: block?.items.map((item) => item.ref) ?? [], blocks: block ? [block] : undefined, errors: [],
    suggestedNext: ["Selecciona un lead de la lista."],
  };
}

function normalizedFailure(error: unknown): ExecutionResult<CrmLeadReadData> {
  const contextError = error instanceof LeadContextPortError ? error : null;
  const runtime = error instanceof OpenRouterRuntimeError ? error : null;
  const code = contextError?.code ?? runtime?.code ?? "INTERNAL";
  const denied = code === "PERMISSION_DENIED" || code === "POLICY_DENIED" || code === "STALE_REFERENCE";
  const missing = code === "NOT_FOUND";
  return {
    status: denied ? "permission_denied" : "failed",
    summary: denied
      ? "Ese lead ya no está disponible dentro de tu scope asignado."
      : missing ? "El lead ya no existe o no pertenece al tenant efectivo." : "No se pudo completar la consulta CRM.",
    entities: [], errors: [{ code, message: contextError?.message ?? runtime?.message ?? "Internal execution error", retryable: runtime?.retryable ?? false, details: runtime?.details }],
    suggestedNext: runtime?.retryable ? ["Vuelve a intentarlo en unos instantes."] : undefined,
  };
}

export class CrmSearchLeadsVerticalSlice {
  constructor(
    private readonly repository: ControlPlaneRepository,
    private readonly leadSearch: LeadSearchPort,
    private readonly leadContext: LeadContextPort,
    private readonly runtime: OpenRouterAdapter,
    private readonly config: CrmSearchLeadsSliceConfig,
  ) {
    if (!config.model.trim()) throw new Error("CRM read model must come from runtime configuration");
  }

  async execute(actor: ActorContext, input: { conversationId: string; message: string; selectedEntityRef?: EntityRef }): Promise<CrmSearchLeadsTurnResult> {
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
    const contextualRef = input.selectedEntityRef ?? resolveConversationRef(priorMessages, message);
    let messageSequence = (priorMessages.at(-1)?.sequence ?? 0) + 1;
    await this.repository.appendMessage(actor, {
      messageId: randomUUID(), conversationId: input.conversationId, role: "user", contentRedacted: message,
      contextRefs: contextualRef ? [contextualRef] : undefined, sequence: messageSequence++, createdAt: now,
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

    const asksContext = wantsLeadContext(message) || ordinalIndex(message) !== undefined;
    const plan: CapabilityPlan = contextualRef ? "context" : asksContext ? "search+context" : "search";
    if (!contextualRef && asksContext && isAnaphoric(message) && !asksToSearch(message)) {
      const result = ambiguityResult(priorMessages);
      await event("interaction.needs_input", { reason: "ambiguous_conversation_reference", candidateCount: result.entities.length });
      await this.repository.updateRun(actor, interactionRunId, { status: "completed", resultSummary: result.summary, completedAt: Date.now() }, "running");
      await this.persistAssistant(actor, input.conversationId, messageSequence, undefined, result);
      return { conversationId: input.conversationId, interactionRunId, result };
    }

    let searchOutput: CrmSearchLeadsOutput | undefined;
    let contextOutput: CrmGetLeadContextOutput | undefined;
    const objectiveBoundPort: LeadSearchPort = {
      search: (context, toolInput) => this.leadSearch.search(context, bindFiltersToObjective(toolInput, message)),
    };
    const toolRegistry = new ProductToolRegistry([
      createCrmSearchLeadsTool({ port: objectiveBoundPort, onResult: (output) => { searchOutput = output; } }),
      createCrmGetLeadContextTool({ port: this.leadContext, onResult: (output) => { contextOutput = output; } }),
    ]);
    const allowedToolIds = plan === "search" ? [CRM_SEARCH_LEADS_TOOL_ID]
      : plan === "context" ? [CRM_GET_LEAD_CONTEXT_TOOL_ID]
      : [CRM_SEARCH_LEADS_TOOL_ID, CRM_GET_LEAD_CONTEXT_TOOL_ID];
    const capabilities = plan === "search" ? ["crm.lead.search"]
      : plan === "context" ? ["crm.lead.context"]
      : ["crm.lead.search", "crm.lead.context"];
    const dispatch = new ExecutionDispatchResolver(new ExecutionProfileRegistry(), toolRegistry, new SkillRegistry()).resolve({
      actor, allowedToolIds, featureEnabled: (toolId) => allowedToolIds.includes(toolId),
      request: {
        profileId: "crm", objective: message, objectiveClasses: ["lead.lookup"], objectiveCapabilities: capabilities,
        inputRefs: contextualRef ? [contextualRef] : [], dependencyRunIds: [], skillHints: plan === "context" ? [] : ["resolve-ambiguous-lead"],
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
    activeAttemptId = attemptId;
    await this.repository.createRun(actor, {
      runId: executionRunId, conversationId: input.conversationId, kind: "execution", profileId: "crm",
      profileVersion: dispatch.profile.version, objectiveHash: dispatch.objectiveHash, objectiveRedacted: redactObjective(message),
      parentRunId: interactionRunId, dependencyRunIds: [], registryHash: dispatch.toolResolution.registryHash,
      skillVersions, toolScope, requestedModel: plan === "context" ? undefined : this.config.model, visibility: "user",
    });

    if (dispatch.toolResolution.tools.length !== allowedToolIds.length) {
      const result: ExecutionResult<CrmLeadReadData> = {
        status: "permission_denied", summary: "No tienes permiso para consultar leads en este contexto.", entities: [],
        errors: [{ code: "PERMISSION_DENIED", message: dispatch.toolResolution.rejected[0]?.reason ?? "Tool unavailable", retryable: false }],
      };
      await this.repository.updateRun(actor, executionRunId, { status: "failed", errorCode: "PERMISSION_DENIED", resultSummary: result.summary, completedAt: Date.now() }, "queued");
      await event("execution.permission_denied", { rejected: dispatch.toolResolution.rejected });
      await this.persistAssistant(actor, input.conversationId, messageSequence, executionRunId, result);
      return { conversationId: input.conversationId, interactionRunId, executionRunId, result };
    }

    await this.repository.createAttempt(actor, { attemptId, runId: executionRunId, attemptNumber: 1, status: "queued", fencingToken: 0 });
    await this.repository.updateAttempt(actor, { attemptId, expectedStatus: "queued", patch: { status: "running", startedAt: Date.now() } });
    await this.repository.updateRun(actor, executionRunId, { status: "running" }, "queued");
    await event("execution.started", { plan, profile: "crm", profileVersion: dispatch.profile.version, requestedModel: plan === "context" ? undefined : this.config.model });

    const runtimeTools = toolRegistry.compileRuntimeTools({
      resolved: dispatch.toolResolution, actor, policy: new DefaultPolicyEngine(), profileId: "crm",
      decisionId: () => randomUUID(), hasRequiredPreconditions: () => true,
    });

    let runtime: OpenRouterRuntimeResult | undefined;
    try {
      if (plan !== "context") {
        await event("tool.requested", { toolId: CRM_SEARCH_LEADS_TOOL_ID, version: 1 });
        await event("model.started", { requestedModel: this.config.model, provider: "openrouter", inference: 1 });
        runtime = await this.runtime.run({
          prompt: message,
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
          budget: { timeoutMs: this.config.timeoutMs ?? 30_000, maxToolRounds: 0, maxCostUsd: this.config.maxCostUsd ?? 0.05 },
          parallelToolCalls: false, toolChoice: "required", stopAfterToolResult: true,
          metadata: { interaction_run_id: interactionRunId, execution_run_id: executionRunId, profile: "crm", plan },
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

      const contextRef = contextualRef ?? (searchOutput?.total === 1 && searchOutput.matches.length === 1 ? searchOutput.matches[0]?.ref : undefined);
      if ((plan === "context" || plan === "search+context") && contextRef) {
        const contextTool = runtimeTools.find((tool) => tool.name === "get_lead_context");
        if (!contextTool) throw new OpenRouterRuntimeError("Context tool is outside the effective scope", "POLICY_DENIED", false);
        await event("tool.requested", { toolId: CRM_GET_LEAD_CONTEXT_TOOL_ID, version: 1, inputRef: contextRef });
        await event("tool.started", { toolName: "get_lead_context", inputRef: contextRef });
        const toolResult = await contextTool.handle({ lead: contextRef });
        if (toolResult.success === false || !contextOutput) throw new OpenRouterRuntimeError("Context tool failed", "INVALID_TOOL_CALL", false);
        await event("tool.completed", { toolName: "get_lead_context", services: contextOutput.telemetry?.services, latencyMs: contextOutput.telemetry?.latencyMs });
      }

      const result: ExecutionResult<CrmLeadReadData> = contextOutput
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
      });
      await this.persistAssistant(actor, input.conversationId, messageSequence, executionRunId, result);
      return { conversationId: input.conversationId, interactionRunId, executionRunId, result, runtime };
    } catch (error) {
      const result = normalizedFailure(error);
      const errorCode = result.errors[0]?.code ?? "INTERNAL";
      await this.repository.updateAttempt(actor, { attemptId, expectedStatus: "running", patch: { status: errorCode === "TIMEOUT" ? "timeout" : "failed", completedAt: Date.now(), errorCode } });
      await this.repository.updateRun(actor, executionRunId, { status: errorCode === "TIMEOUT" ? "timeout" : "failed", errorCode, resultSummary: result.summary, completedAt: Date.now() }, "running");
      await event("execution.failed", { errorCode, retryable: result.errors[0]?.retryable ?? false });
      await this.persistAssistant(actor, input.conversationId, messageSequence, executionRunId, result);
      return { conversationId: input.conversationId, interactionRunId, executionRunId, result };
    }
  }

  private async persistAssistant(
    actor: ActorContext,
    conversationId: string,
    sequence: number,
    runId: string | undefined,
    result: ExecutionResult<CrmLeadReadData>,
  ) {
    await this.repository.appendMessage(actor, {
      messageId: randomUUID(), conversationId, role: "assistant", contentRedacted: result.summary,
      blocks: result.blocks, contextRefs: result.entities.length === 1 ? result.entities : undefined,
      runId, sequence, createdAt: Date.now(),
    });
  }
}

function throwNoResult(): never {
  throw new OpenRouterRuntimeError("Execution produced no result", "INTERNAL", false);
}
