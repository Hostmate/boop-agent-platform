import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ActorContext } from "../contracts/actor-context.js";
import type { EntityRef } from "../contracts/domain.js";
import type { ActionConfirmationBlock, ExecutionResult } from "../contracts/execution-result.js";
import type { AgentMessageRecord, ControlPlaneRepository, ConversationContextRefs } from "../control-plane/repository.js";
import { hashConfirmationToken, hashDraftArguments, signWriteIntent, type SignedWriteIntent, type WriteIntentEnvelope } from "../drafts/contracts.js";
import { redactEventPayload } from "../events/contracts.js";
import { ExecutionDispatchResolver } from "../interaction/dispatch.js";
import { DefaultPolicyEngine } from "../policy/engine.js";
import { ExecutionProfileRegistry } from "../profiles/registry.js";
import {
  CRM_UPDATE_LEAD_STATUS_TOOL_ID,
  CRM_UPDATE_LEAD_STATUS_TOOL_VERSION,
  createCrmUpdateLeadStatusTool,
  type CanonicalLeadStatus,
  type LeadStatusWritePort,
} from "../product-tools/crm/update-lead-status.js";
import { SkillRegistry } from "../skills/registry.js";
import { ProductToolRegistry } from "../tools/registry.js";

const STATUS_LABEL: Record<CanonicalLeadStatus, string> = {
  new: "Nuevo", contacted: "Contactado", qualified: "Cualificado", visit_scheduled: "Visita programada",
};

function sha(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function redact(value: string): string { return value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]").replace(/(?:\+?\d[\d\s().-]{6,}\d)/g, "[phone]").slice(0, 240); }

function latestContext(messages: readonly AgentMessageRecord[]): ConversationContextRefs {
  for (const message of [...messages].reverse()) {
    if (message.contextRefs) return message.contextRefs;
  }
  return { selected: {}, referenced: [] };
}

export type CrmUpdateLeadStatusTurnResult = Readonly<{
  conversationId: string;
  interactionRunId: string;
  executionRunId?: string;
  draftId?: string;
  result: ExecutionResult;
}>;

export class CrmUpdateLeadStatusVerticalSlice {
  constructor(
    private readonly repository: ControlPlaneRepository,
    private readonly port: LeadStatusWritePort,
    private readonly config: Readonly<{ enabled: boolean; allowedTenantIds: readonly string[]; allowedUserIds: readonly string[]; signingSecret: string; ttlMs?: number }>,
  ) {}

  async execute(actor: ActorContext, input: { conversationId: string; message: string; selectedEntityRef?: EntityRef; requestedStatus?: CanonicalLeadStatus }): Promise<CrmUpdateLeadStatusTurnResult> {
    const interactionRunId = randomUUID();
    let prior: readonly AgentMessageRecord[];
    try { prior = await this.repository.listMessages(actor, { conversationId: input.conversationId, limit: 200 }); }
    catch { await this.repository.createConversation(actor, { conversationId: input.conversationId, title: "AI Chat" }); prior = []; }
    const previousContext = latestContext(prior);
    const selected = input.selectedEntityRef?.type === "crm.lead" ? input.selectedEntityRef : previousContext.selected.lead;
    const context: ConversationContextRefs = selected?.type === "crm.lead"
      ? { selected: { ...previousContext.selected, lead: selected }, referenced: previousContext.referenced }
      : previousContext;
    let messageSequence = (prior.at(-1)?.sequence ?? 0) + 1;
    await this.repository.appendMessage(actor, {
      messageId: randomUUID(), conversationId: input.conversationId, role: "user", contentRedacted: redact(input.message),
      contextRefs: context, sequence: messageSequence++, createdAt: Date.now(),
    });
    await this.repository.createRun(actor, {
      runId: interactionRunId, conversationId: input.conversationId, kind: "interaction", objectiveHash: sha(input.message),
      objectiveRedacted: redact(input.message), dependencyRunIds: [], registryHash: "interaction-safe-write-v1",
      skillVersions: {}, toolScope: [], visibility: "user",
    });
    await this.repository.updateRun(actor, interactionRunId, { status: "running" }, "queued");

    if (!input.requestedStatus || !selected || selected.type !== "crm.lead") {
      const summary = !selected
        ? "Selecciona primero un lead autorizado; no puedo cambiar estados usando un ID escrito manualmente."
        : "Indica uno de estos estados: Nuevo, Contactado, Cualificado o Visita programada.";
      const result: ExecutionResult = { status: "needs_input", summary, entities: selected ? [selected] : [], errors: [], suggestedNext: [summary] };
      await this.repository.updateRun(actor, interactionRunId, { status: "completed", resultSummary: summary, completedAt: Date.now() }, "running");
      await this.repository.appendMessage(actor, { messageId: randomUUID(), conversationId: input.conversationId, role: "assistant", contentRedacted: summary, contextRefs: context, sequence: messageSequence, createdAt: Date.now() });
      return { conversationId: input.conversationId, interactionRunId, result };
    }

    if (!this.config.enabled || !this.config.allowedTenantIds.includes(actor.tenantId) || !this.config.allowedUserIds.includes(actor.userId) || !actor.permissions.includes("crm.write")) {
      const summary = "La preparación de cambios CRM no está habilitada para este actor.";
      const result: ExecutionResult = { status: "permission_denied", summary, entities: [selected], errors: [{ code: "PERMISSION_DENIED", message: "safe_write_canary_denied", retryable: false }] };
      await this.repository.updateRun(actor, interactionRunId, { status: "failed", errorCode: "PERMISSION_DENIED", resultSummary: summary, completedAt: Date.now() }, "running");
      await this.repository.appendMessage(actor, { messageId: randomUUID(), conversationId: input.conversationId, role: "assistant", contentRedacted: summary, contextRefs: context, sequence: messageSequence, createdAt: Date.now() });
      return { conversationId: input.conversationId, interactionRunId, result };
    }

    const toolRegistry = new ProductToolRegistry([createCrmUpdateLeadStatusTool({ port: this.port })]);
    const dispatch = new ExecutionDispatchResolver(new ExecutionProfileRegistry(), toolRegistry, new SkillRegistry()).resolve({
      actor, allowedToolIds: [CRM_UPDATE_LEAD_STATUS_TOOL_ID], featureEnabled: () => true,
      request: {
        profileId: "crm", objective: input.message, objectiveClasses: ["lead.update"], objectiveCapabilities: ["crm.lead.status.prepare"],
        inputRefs: [selected], dependencyRunIds: [], internalSkillHints: [], constraints: { readOnly: false },
      },
    });
    const resolvedTool = dispatch.toolResolution.tools[0];
    if (!resolvedTool) throw new Error(`SAFE_WRITE_TOOL_UNAVAILABLE:${dispatch.toolResolution.rejected[0]?.reason ?? "unknown"}`);
    await this.repository.updateRun(actor, interactionRunId, { status: "completed", resultSummary: "Dispatched crm status draft", completedAt: Date.now() }, "running");

    const executionRunId = randomUUID();
    const attemptId = randomUUID();
    await this.repository.createRun(actor, {
      runId: executionRunId, conversationId: input.conversationId, kind: "execution", profileId: "crm", profileVersion: dispatch.profile.version,
      objectiveHash: dispatch.objectiveHash, objectiveRedacted: redact(input.message), parentRunId: interactionRunId, dependencyRunIds: [],
      registryHash: dispatch.toolResolution.registryHash, skillVersions: {}, toolScope: [`${CRM_UPDATE_LEAD_STATUS_TOOL_ID}@${CRM_UPDATE_LEAD_STATUS_TOOL_VERSION}`], visibility: "user",
    });
    await this.repository.createAttempt(actor, { attemptId, runId: executionRunId, attemptNumber: 1, status: "queued", fencingToken: 0 });
    await this.repository.updateAttempt(actor, { attemptId, expectedStatus: "queued", patch: { status: "running", startedAt: Date.now() } });
    await this.repository.updateRun(actor, executionRunId, { status: "running" }, "queued");
    let eventSequence = 0;
    const event = async (type: string, payload: unknown) => this.repository.appendEvent(actor, {
      eventId: randomUUID(), conversationId: input.conversationId, interactionRunId, executionRunId, attemptId,
      sequence: ++eventSequence, type, visibility: "user", payload: redactEventPayload(payload), occurredAt: Date.now(),
    });
    await event("execution.started", { profile: "crm", profileVersion: 1, toolScope: [`${CRM_UPDATE_LEAD_STATUS_TOOL_ID}@1`], inference: 0 });
    await event("tool.started", { toolId: CRM_UPDATE_LEAD_STATUS_TOOL_ID, target: selected, requestedStatus: input.requestedStatus });
    const tools = toolRegistry.compileRuntimeTools({
      resolved: dispatch.toolResolution, actor, policy: new DefaultPolicyEngine(), profileId: "crm",
      decisionId: () => randomUUID(), hasRequiredPreconditions: () => true,
    });
    const response = await tools[0]!.handle({ lead: selected, requestedStatus: input.requestedStatus });
    if (!response.success) throw new Error("SAFE_WRITE_PREPARATION_FAILED");
    const prepared = JSON.parse(response.text) as { ok: true; data: { lead: { id: string; name: string; status: CanonicalLeadStatus; assignedAgentId?: string }; requestedStatus: CanonicalLeadStatus; noOp: boolean; telemetry?: unknown } };
    await event("tool.completed", { toolId: CRM_UPDATE_LEAD_STATUS_TOOL_ID, service: "lead.service.prepareStatusUpdate", telemetry: prepared.data.telemetry });

    if (prepared.data.noOp) {
      const summary = `${prepared.data.lead.name} ya está en estado ${STATUS_LABEL[input.requestedStatus]}; no se ha creado ningún borrador.`;
      const result: ExecutionResult = { status: "completed", summary, entities: [selected], errors: [] };
      await this.repository.updateAttempt(actor, { attemptId, expectedStatus: "running", patch: { status: "succeeded", completedAt: Date.now() } });
      await this.repository.updateRun(actor, executionRunId, { status: "completed", resultSummary: summary, completedAt: Date.now() }, "running");
      await event("draft.not_created", { reason: "no_op", currentStatus: prepared.data.lead.status });
      await this.repository.appendMessage(actor, { messageId: randomUUID(), conversationId: input.conversationId, role: "assistant", contentRedacted: summary, contextRefs: context, runId: executionRunId, sequence: messageSequence, createdAt: Date.now() });
      return { conversationId: input.conversationId, interactionRunId, executionRunId, result };
    }

    const now = Date.now();
    const draftId = randomUUID();
    const confirmationToken = randomBytes(32).toString("base64url");
    const args = { lead: { type: "crm.lead", id: selected.id }, requestedStatus: input.requestedStatus };
    const envelope: WriteIntentEnvelope = {
      draftId, tenantId: actor.tenantId, actorUserId: actor.userId, sessionId: actor.sessionId,
      permissionsVersion: actor.permissionsVersion, effectiveTenantOverride: actor.effectiveTenantOverride,
      conversationId: input.conversationId, sourceRunId: executionRunId, profileId: "crm",
      toolId: CRM_UPDATE_LEAD_STATUS_TOOL_ID, toolVersion: CRM_UPDATE_LEAD_STATUS_TOOL_VERSION,
      toolScope: [`${CRM_UPDATE_LEAD_STATUS_TOOL_ID}@${CRM_UPDATE_LEAD_STATUS_TOOL_VERSION}`],
      target: { type: "crm.lead", id: selected.id, label: prepared.data.lead.name, deepLink: selected.deepLink },
      operation: "lead.status.set", requestedValue: input.requestedStatus,
      preconditions: [
        { kind: "lead.status", expected: prepared.data.lead.status },
        { kind: "lead.assigned_agent_id", expected: prepared.data.lead.assignedAgentId ?? "unassigned" },
      ],
      argsHash: hashDraftArguments(args), idempotencyKey: `agent-write:${draftId}`, risk: "R1",
      policyDecisionId: randomUUID(), expiresAt: now + (this.config.ttlMs ?? 10 * 60_000),
      confirmationTokenHash: hashConfirmationToken(confirmationToken),
    };
    const signedIntent: SignedWriteIntent = { envelope, signature: signWriteIntent(envelope, this.config.signingSecret) };
    await this.repository.updateAttempt(actor, { attemptId, expectedStatus: "running", patch: { status: "succeeded", completedAt: now } });
    await this.repository.updateRun(actor, executionRunId, { status: "awaiting_confirmation", resultSummary: "Draft awaiting explicit confirmation" }, "running");
    await this.repository.createWriteIntent(actor, { intent: signedIntent, status: "proposed", createdAt: now });
    await event("draft.created", { draftId, toolId: envelope.toolId, risk: envelope.risk, target: envelope.target, operation: envelope.operation, argsHash: envelope.argsHash, expiresAt: envelope.expiresAt });
    const block: ActionConfirmationBlock = {
      type: "action_confirmation", draftId, confirmationToken,
      title: "Confirmar cambio de estado", description: `Se cambiará el estado de ${prepared.data.lead.name}.`,
      target: envelope.target,
      changes: [{ field: "Estado", from: STATUS_LABEL[prepared.data.lead.status], to: STATUS_LABEL[input.requestedStatus] }],
      risk: "R1", expiresAt: envelope.expiresAt,
    };
    const summary = "He preparado el cambio. Revisa el borrador y confírmalo para aplicarlo.";
    const result: ExecutionResult = { status: "needs_input", summary, entities: [envelope.target], blocks: [block], errors: [], suggestedNext: ["Confirmar o cancelar el borrador."] };
    await this.repository.appendMessage(actor, { messageId: randomUUID(), conversationId: input.conversationId, role: "assistant", contentRedacted: summary, blocks: [block], contextRefs: context, runId: executionRunId, sequence: messageSequence, createdAt: now });
    return { conversationId: input.conversationId, interactionRunId, executionRunId, draftId, result };
  }
}
