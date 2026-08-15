import { createHash, randomUUID } from "node:crypto";
import type { ActorContext } from "../contracts/actor-context.js";
import type { ExecutionResult } from "../contracts/execution-result.js";
import type { ControlPlaneRepository } from "../control-plane/repository.js";
import { redactEventPayload } from "../events/contracts.js";
import { ExecutionDispatchResolver } from "../interaction/dispatch.js";
import { DefaultPolicyEngine } from "../policy/engine.js";
import { ExecutionProfileRegistry } from "../profiles/registry.js";
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

export type CrmSearchLeadsTurnResult = Readonly<{
  conversationId: string;
  interactionRunId: string;
  executionRunId: string;
  result: ExecutionResult<CrmSearchLeadsOutput>;
  runtime?: OpenRouterRuntimeResult;
}>;

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
    new: [" new", "nuevo", "nueva"], pending: ["pending", "pendiente"], contacted: ["contacted", "contactado", "contactada"],
    qualified: ["qualified", "cualificado", "cualificada"], visit_scheduled: ["visit scheduled", "visita agendada", "visita programada"],
  };
  const status = input.status && statusEvidence[input.status].some((word) => ` ${evidence} `.includes(` ${word.trim()} `)) ? input.status : undefined;
  return { ...input, city, status, page: 1, limit: 5 };
}

function normalizedFailure(error: unknown): ExecutionResult<CrmSearchLeadsOutput> {
  const runtime = error instanceof OpenRouterRuntimeError ? error : null;
  const code = runtime?.code ?? "INTERNAL";
  return {
    status: code === "PERMISSION_DENIED" || code === "POLICY_DENIED" ? "permission_denied" : "failed",
    summary: code === "PERMISSION_DENIED" || code === "POLICY_DENIED"
      ? "No tienes permiso para buscar leads en este contexto."
      : "No se pudo completar la búsqueda de leads.",
    entities: [], errors: [{ code, message: runtime?.message ?? "Internal execution error", retryable: runtime?.retryable ?? false, details: runtime?.details }],
    suggestedNext: runtime?.retryable ? ["Vuelve a intentarlo en unos instantes."] : undefined,
  };
}

export class CrmSearchLeadsVerticalSlice {
  constructor(
    private readonly repository: ControlPlaneRepository,
    private readonly leadSearch: LeadSearchPort,
    private readonly runtime: OpenRouterAdapter,
    private readonly config: CrmSearchLeadsSliceConfig,
  ) {
    if (!config.model.trim()) throw new Error("CRM search model must come from runtime configuration");
  }

  async execute(actor: ActorContext, input: { conversationId: string; message: string }): Promise<CrmSearchLeadsTurnResult> {
    const message = input.message.trim();
    if (!message || message.length > 500) throw new Error("Message must contain between 1 and 500 characters");
    const interactionRunId = randomUUID();
    const executionRunId = randomUUID();
    const attemptId = randomUUID();
    const now = Date.now();
    let priorMessages;
    try {
      priorMessages = await this.repository.listMessages(actor, { conversationId: input.conversationId, limit: 200 });
    } catch {
      await this.repository.createConversation(actor, { conversationId: input.conversationId, title: "AI Chat" });
      priorMessages = [];
    }
    let messageSequence = (priorMessages.at(-1)?.sequence ?? 0) + 1;
    await this.repository.appendMessage(actor, {
      messageId: randomUUID(), conversationId: input.conversationId, role: "user", contentRedacted: message,
      sequence: messageSequence++, createdAt: now,
    });

    let eventSequence = 0;
    const event = async (type: string, payload: unknown) => {
      await this.repository.appendEvent(actor, {
        eventId: randomUUID(), conversationId: input.conversationId, interactionRunId, executionRunId, attemptId,
        sequence: ++eventSequence, type, visibility: "user", payload: redactEventPayload(payload), occurredAt: Date.now(),
      });
    };

    await this.repository.createRun(actor, {
      runId: interactionRunId, conversationId: input.conversationId, kind: "interaction", objectiveHash: hash(message),
      objectiveRedacted: redactObjective(message), dependencyRunIds: [], registryHash: "interaction-dispatch-v1",
      skillVersions: {}, toolScope: [], visibility: "user",
    });
    await this.repository.updateRun(actor, interactionRunId, { status: "running" }, "queued");
    await event("interaction.started", { profile: "crm", objective: redactObjective(message) });

    let toolOutput: CrmSearchLeadsOutput | undefined;
    const objectiveBoundPort: LeadSearchPort = {
      search: (context, toolInput) => this.leadSearch.search(context, bindFiltersToObjective(toolInput, message)),
    };
    const toolRegistry = new ProductToolRegistry([createCrmSearchLeadsTool({
      port: objectiveBoundPort,
      onResult: (output) => { toolOutput = output; },
    })]);
    const dispatch = new ExecutionDispatchResolver(new ExecutionProfileRegistry(), toolRegistry, new SkillRegistry()).resolve({
      actor,
      allowedToolIds: [CRM_SEARCH_LEADS_TOOL_ID],
      featureEnabled: (toolId) => toolId === CRM_SEARCH_LEADS_TOOL_ID,
      request: {
        profileId: "crm", objective: message, objectiveClasses: ["lead.lookup"], objectiveCapabilities: ["crm.lead.search"],
        inputRefs: [], dependencyRunIds: [], skillHints: ["resolve-ambiguous-lead"], constraints: { readOnly: true, maxResults: 10 },
      },
    });
    const skillVersions = Object.fromEntries(dispatch.skills.map((skill) => [skill.id, skill.version]));
    const toolScope = dispatch.toolResolution.tools.map((tool) => `${tool.toolId}@${tool.version}`);
    await event("interaction.dispatch.resolved", { profile: dispatch.profile.id, profileVersion: dispatch.profile.version, toolScope, skillVersions });
    await this.repository.updateRun(actor, interactionRunId, { status: "completed", resultSummary: "Dispatched crm lead lookup", completedAt: Date.now() }, "running");

    await this.repository.createRun(actor, {
      runId: executionRunId, conversationId: input.conversationId, kind: "execution", profileId: "crm",
      profileVersion: dispatch.profile.version, objectiveHash: dispatch.objectiveHash, objectiveRedacted: redactObjective(message),
      parentRunId: interactionRunId, dependencyRunIds: [], registryHash: dispatch.toolResolution.registryHash,
      skillVersions, toolScope, requestedModel: this.config.model, visibility: "user",
    });

    if (dispatch.toolResolution.tools.length !== 1) {
      const result: ExecutionResult<CrmSearchLeadsOutput> = {
        status: "permission_denied", summary: "No tienes permiso para buscar leads en este contexto.", entities: [],
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
    await event("execution.started", { profile: "crm", profileVersion: dispatch.profile.version, requestedModel: this.config.model });
    await event("tool.requested", { toolId: CRM_SEARCH_LEADS_TOOL_ID, version: 1 });
    await event("model.started", { requestedModel: this.config.model, provider: "openrouter" });

    const runtimeTools = toolRegistry.compileRuntimeTools({
      resolved: dispatch.toolResolution, actor, policy: new DefaultPolicyEngine(), profileId: "crm",
      decisionId: () => randomUUID(), hasRequiredPreconditions: () => true,
    });

    try {
      const runtime = await this.runtime.run({
        prompt: message,
        systemPrompt: [
          "You are a scoped CRM lead lookup execution agent.",
          "Call crm.search_leads exactly once. Infer only filters explicitly supported by its schema.",
          "Put a person's name, phone or email in query. Use city only when the user explicitly names a city.",
          "Never invent a tenant, ID, EntityRef, contact detail, status or city. Do not decide among multiple matches.",
        ].join("\n"),
        model: this.config.model, mode: "execution", tools: [...runtimeTools], allowedTools: ["crm.search_leads"],
        onToolUse: async (toolName, toolInput) => await event("tool.started", { toolName, toolInput }),
        onToolResult: async (toolName) => await event("tool.completed", { toolName, service: "lead.service.list" }),
      }, {
        fallbackModels: this.config.fallbackModels,
        budget: { timeoutMs: this.config.timeoutMs ?? 30_000, maxToolRounds: 0, maxCostUsd: this.config.maxCostUsd ?? 0.05 },
        parallelToolCalls: false, toolChoice: "required", stopAfterToolResult: true,
        metadata: { interaction_run_id: interactionRunId, execution_run_id: executionRunId, profile: "crm", tool: CRM_SEARCH_LEADS_TOOL_ID },
        sessionId: actor.sessionId,
        onEvent: async (runtimeEvent) => {
          if (runtimeEvent.type === "usage") return;
          if (runtimeEvent.type === "tool_call" || runtimeEvent.type === "tool_result") return;
          await event(`model.${runtimeEvent.type}`, runtimeEvent);
        },
      });
      if (!toolOutput) throw new OpenRouterRuntimeError("Model did not execute the scoped tool", "INVALID_TOOL_CALL", false);
      const result = toCrmSearchExecutionResult(toolOutput);
      await this.repository.recordUsage(actor, {
        usageId: randomUUID(), runId: executionRunId, attemptId,
        requestedModel: runtime.requestedModel, resolvedModel: runtime.resolvedModel, provider: runtime.provider,
        inputTokens: runtime.detailedUsage.inputTokens, outputTokens: runtime.detailedUsage.outputTokens,
        reasoningTokens: runtime.detailedUsage.reasoningTokens, cachedTokens: runtime.detailedUsage.cachedTokens,
        costUsd: runtime.detailedUsage.costUsd, latencyMs: runtime.latencyMs, fallbackUsed: runtime.detailedUsage.fallbackUsed,
        finishReason: runtime.finishReason, createdAt: Date.now(),
      });
      await event("model.completed", { requestedModel: runtime.requestedModel, resolvedModel: runtime.resolvedModel, provider: runtime.provider, finishReason: runtime.finishReason, usage: runtime.detailedUsage, latencyMs: runtime.latencyMs });
      await this.repository.updateAttempt(actor, { attemptId, expectedStatus: "running", patch: { status: "succeeded", completedAt: Date.now() } });
      await this.repository.updateRun(actor, executionRunId, {
        status: "completed", resolvedModel: runtime.resolvedModel, provider: runtime.provider, finishReason: runtime.finishReason,
        resultSummary: result.summary, completedAt: Date.now(),
      }, "running");
      await event("execution.completed", { status: result.status, entityCount: result.entities.length, serviceLatencyMs: toolOutput.telemetry?.latencyMs });
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

  private async persistAssistant(actor: ActorContext, conversationId: string, sequence: number, runId: string, result: ExecutionResult<CrmSearchLeadsOutput>) {
    await this.repository.appendMessage(actor, {
      messageId: randomUUID(), conversationId, role: "assistant", contentRedacted: result.summary,
      blocks: result.blocks, runId, sequence, createdAt: Date.now(),
    });
  }
}
