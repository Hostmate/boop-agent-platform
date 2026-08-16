import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ActorContext } from "../contracts/actor-context.js";
import type { EntityRef, ExecutionProfileId, RiskLevel } from "../contracts/domain.js";
import type { ActionConfirmationBlock, ExecutionResult } from "../contracts/execution-result.js";
import type { AgentMessageRecord, ControlPlaneRepository, ConversationContextRefs } from "../control-plane/repository.js";
import { redactEventPayload } from "../events/contracts.js";
import { ExecutionDispatchResolver } from "../interaction/dispatch.js";
import { DefaultPolicyEngine } from "../policy/engine.js";
import { ExecutionProfileRegistry } from "../profiles/registry.js";
import { SkillRegistry } from "../skills/registry.js";
import { ProductToolRegistry } from "../tools/registry.js";
import { hashConfirmationToken, hashDraftArguments, signWriteIntent, type SignedWriteIntent, type WriteIntentEnvelope } from "./contracts.js";

export type SafeWriteConfig = Readonly<{
  enabled: boolean;
  allowedTenantIds: readonly string[];
  allowedUserIds: readonly string[];
  signingSecret: string;
  ttlMs?: number;
}>;

export type SafeWriteTurnInput<TInput> = Readonly<{
  conversationId: string;
  message: string;
  selectedEntityRef?: EntityRef;
  value?: TInput;
  inputError?: string;
}>;

export type SafeWriteTurnResult = Readonly<{
  conversationId: string;
  interactionRunId: string;
  executionRunId?: string;
  draftId?: string;
  result: ExecutionResult;
}>;

export type PreparedWriteProjection = Readonly<{
  target: EntityRef;
  relatedEntities?: readonly EntityRef[];
  operationType: "update" | "create";
  operation: string;
  requestedValue: string;
  structuredPayload?: Readonly<Record<string, string | number | boolean | null>>;
  preconditions: readonly Readonly<{ kind: string; expected: string }>[];
  args: unknown;
  block: Omit<ActionConfirmationBlock, "type" | "draftId" | "confirmationToken" | "risk" | "expiresAt" | "target">;
}>;

export type SafeWritePreparationDefinition<TInput, TPrepared> = Readonly<{
  profileId: ExecutionProfileId;
  toolId: string;
  toolVersion: number;
  capability: string;
  objectiveClass: string;
  requiredPermission: string;
  selectedContextKey: string;
  selectedEntityType: string;
  requiredContextRefs?: readonly Readonly<{ contextKey: string; entityType: string; missingMessage: string }>[];
  requireConversationProvenance?: boolean;
  risk?: Exclude<RiskLevel, "R0">;
  // Heterogeneous concrete tool definitions are erased at the registry edge;
  // each tool still parses its own strict schema before its handler runs.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tool: any;
  missingInputMessage(input: SafeWriteTurnInput<TInput>, selected?: EntityRef, context?: ConversationContextRefs): string | undefined;
  toolInput(value: TInput, selected: EntityRef, context: ConversationContextRefs): Record<string, unknown>;
  parsePrepared(value: unknown): TPrepared;
  project(value: TInput, selected: EntityRef, prepared: TPrepared, context: ConversationContextRefs): PreparedWriteProjection;
  toolStartedPayload(value: TInput, selected: EntityRef, context: ConversationContextRefs): Record<string, unknown>;
  toolCompletedPayload(prepared: TPrepared): Record<string, unknown>;
  actorAllowed?(actor: ActorContext): boolean;
  noOp?(value: TInput, prepared: TPrepared): string | undefined;
  preparedSummary: string;
}>;

function sha(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function redact(value: string): string {
  return value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/(?:\+?\d[\d\s().-]{6,}\d)/g, "[phone]").slice(0, 240);
}

function latestContext(messages: readonly AgentMessageRecord[]): ConversationContextRefs {
  for (const message of [...messages].reverse()) if (message.contextRefs) return message.contextRefs;
  return { selected: {}, referenced: [] };
}

function sameRef(left: EntityRef | undefined, right: EntityRef): boolean {
  return left?.type === right.type && left.id === right.id;
}

export function hasConversationEntityProvenance(messages: readonly AgentMessageRecord[], ref: EntityRef): boolean {
  return messages.some((message) => {
    if (message.role !== "assistant") return false;
    if (message.contextRefs?.referenced.some((candidate) => sameRef(candidate, ref))) return true;
    if (Object.values(message.contextRefs?.selected ?? {}).some((candidate) => sameRef(candidate, ref))) return true;
    return message.blocks?.some((block) => {
      if (block.type === "entity_list") return block.items.some((item) => sameRef(item.ref, ref));
      if (block.type === "entity_detail") return sameRef(block.ref, ref);
      if (block.type === "multi_agent_summary") return block.sections.some((section) => section.items?.some((item) => item.ref && sameRef(item.ref, ref)));
      return false;
    }) ?? false;
  });
}

export function compactEntityRefForWriteIntent(ref: EntityRef): EntityRef {
  return {
    type: ref.type,
    id: ref.id,
    ...(ref.label !== undefined ? { label: ref.label } : {}),
    ...(ref.deepLink !== undefined ? { deepLink: ref.deepLink } : {}),
  };
}

export class SafeWritePreparationEngine<TInput, TPrepared> {
  constructor(
    private readonly repository: ControlPlaneRepository,
    private readonly config: SafeWriteConfig,
    private readonly definition: SafeWritePreparationDefinition<TInput, TPrepared>,
  ) {}

  async execute(actor: ActorContext, input: SafeWriteTurnInput<TInput>): Promise<SafeWriteTurnResult> {
    const interactionRunId = randomUUID();
    let prior: readonly AgentMessageRecord[];
    try { prior = await this.repository.listMessages(actor, { conversationId: input.conversationId, limit: 200 }); }
    catch { await this.repository.createConversation(actor, { conversationId: input.conversationId, title: "AI Chat" }); prior = []; }
    const previousContext = latestContext(prior);
    const inputRole = input.selectedEntityRef?.type === this.definition.selectedEntityType
      ? this.definition.selectedContextKey
      : this.definition.requiredContextRefs?.find((required) => required.entityType === input.selectedEntityRef?.type)?.contextKey;
    const context: ConversationContextRefs = input.selectedEntityRef && inputRole
      ? { selected: { ...previousContext.selected, [inputRole]: input.selectedEntityRef }, referenced: previousContext.referenced }
      : previousContext;
    const selected = context.selected[this.definition.selectedContextKey];
    let messageSequence = (prior.at(-1)?.sequence ?? 0) + 1;
    await this.repository.appendMessage(actor, {
      messageId: randomUUID(), conversationId: input.conversationId, role: "user", contentRedacted: redact(input.message),
      contextRefs: context, sequence: messageSequence++, createdAt: Date.now(),
    });
    await this.repository.createRun(actor, {
      runId: interactionRunId, conversationId: input.conversationId, kind: "interaction", objectiveHash: sha(input.message),
      objectiveRedacted: redact(input.message), dependencyRunIds: [], registryHash: "interaction-safe-write-v2",
      skillVersions: {}, toolScope: [], visibility: "user",
    });
    await this.repository.updateRun(actor, interactionRunId, { status: "running" }, "queued");

    const requiredMissing = this.definition.requiredContextRefs?.find((required) => context.selected[required.contextKey]?.type !== required.entityType);
    const provenanceRefs = [selected, ...(this.definition.requiredContextRefs ?? []).map((required) => context.selected[required.contextKey])]
      .filter((ref): ref is EntityRef => Boolean(ref));
    const provenanceMissing = this.definition.requireConversationProvenance
      ? provenanceRefs.find((ref) => !hasConversationEntityProvenance(prior, ref))
      : undefined;
    const missing = requiredMissing?.missingMessage
      ?? (provenanceMissing ? "La selección no tiene provenance autorizada en esta conversación. Vuelve a seleccionar el resultado desde una card." : undefined)
      ?? this.definition.missingInputMessage(input, selected, context);
    if (missing || input.value === undefined || !selected || selected.type !== this.definition.selectedEntityType) {
      const summary = missing ?? "Selecciona primero una entidad autorizada; no puedo escribir usando un ID manual.";
      const result: ExecutionResult = { status: "needs_input", summary, entities: selected ? [selected] : [], errors: [], suggestedNext: [summary] };
      await this.repository.updateRun(actor, interactionRunId, { status: "completed", resultSummary: summary, completedAt: Date.now() }, "running");
      await this.repository.appendMessage(actor, { messageId: randomUUID(), conversationId: input.conversationId, role: "assistant", contentRedacted: summary, contextRefs: context, sequence: messageSequence, createdAt: Date.now() });
      return { conversationId: input.conversationId, interactionRunId, result };
    }

    if (!this.config.enabled || !this.config.allowedTenantIds.includes(actor.tenantId)
      || !this.config.allowedUserIds.includes(actor.userId)
      || (this.definition.actorAllowed && !this.definition.actorAllowed(actor))
      || (!actor.isSuperAdmin && !actor.permissions.includes(this.definition.requiredPermission))) {
      const summary = "La preparación de esta acción no está habilitada para este actor.";
      const result: ExecutionResult = { status: "permission_denied", summary, entities: [selected], errors: [{ code: "PERMISSION_DENIED", message: "safe_write_canary_denied", retryable: false }] };
      await this.repository.updateRun(actor, interactionRunId, { status: "failed", errorCode: "PERMISSION_DENIED", resultSummary: summary, completedAt: Date.now() }, "running");
      await this.repository.appendMessage(actor, { messageId: randomUUID(), conversationId: input.conversationId, role: "assistant", contentRedacted: summary, contextRefs: context, sequence: messageSequence, createdAt: Date.now() });
      return { conversationId: input.conversationId, interactionRunId, result };
    }

    const toolRegistry = new ProductToolRegistry([this.definition.tool]);
    const dispatch = new ExecutionDispatchResolver(new ExecutionProfileRegistry(), toolRegistry, new SkillRegistry()).resolve({
      actor, allowedToolIds: [this.definition.toolId], featureEnabled: () => true,
      request: {
        profileId: this.definition.profileId, objective: input.message,
        objectiveClasses: [this.definition.objectiveClass], objectiveCapabilities: [this.definition.capability],
        inputRefs: provenanceRefs, dependencyRunIds: [], internalSkillHints: [], constraints: { readOnly: false },
      },
    });
    if (!dispatch.toolResolution.tools[0]) throw new Error(`SAFE_WRITE_TOOL_UNAVAILABLE:${dispatch.toolResolution.rejected[0]?.reason ?? "unknown"}`);
    await this.repository.updateRun(actor, interactionRunId, { status: "completed", resultSummary: `Dispatched ${this.definition.toolId} draft`, completedAt: Date.now() }, "running");

    const executionRunId = randomUUID();
    const attemptId = randomUUID();
    const toolScope = [`${this.definition.toolId}@${this.definition.toolVersion}`];
    await this.repository.createRun(actor, {
      runId: executionRunId, conversationId: input.conversationId, kind: "execution", profileId: this.definition.profileId, profileVersion: dispatch.profile.version,
      objectiveHash: dispatch.objectiveHash, objectiveRedacted: redact(input.message), parentRunId: interactionRunId, dependencyRunIds: [],
      registryHash: dispatch.toolResolution.registryHash, skillVersions: {}, toolScope, visibility: "user",
    });
    await this.repository.createAttempt(actor, { attemptId, runId: executionRunId, attemptNumber: 1, status: "queued", fencingToken: 0 });
    await this.repository.updateAttempt(actor, { attemptId, expectedStatus: "queued", patch: { status: "running", startedAt: Date.now() } });
    await this.repository.updateRun(actor, executionRunId, { status: "running" }, "queued");
    let eventSequence = 0;
    const event = async (type: string, payload: unknown) => this.repository.appendEvent(actor, {
      eventId: randomUUID(), conversationId: input.conversationId, interactionRunId, executionRunId, attemptId,
      sequence: ++eventSequence, type, visibility: "user", payload: redactEventPayload(payload), occurredAt: Date.now(),
    });
    await event("execution.started", { profile: this.definition.profileId, profileVersion: 1, toolScope, inference: 0 });
    await event("tool.started", { toolId: this.definition.toolId, ...this.definition.toolStartedPayload(input.value, selected, context) });
    const tools = toolRegistry.compileRuntimeTools({
      resolved: dispatch.toolResolution, actor, policy: new DefaultPolicyEngine(), profileId: this.definition.profileId,
      decisionId: () => randomUUID(), hasRequiredPreconditions: () => true,
    });
    const response = await tools[0]!.handle(this.definition.toolInput(input.value, selected, context));
    if (!response.success) throw new Error("SAFE_WRITE_PREPARATION_FAILED");
    const parsed = JSON.parse(response.text) as { ok: true; data: unknown };
    const prepared = this.definition.parsePrepared(parsed.data);
    await event("tool.completed", { toolId: this.definition.toolId, ...this.definition.toolCompletedPayload(prepared) });

    const noOp = this.definition.noOp?.(input.value, prepared);
    if (noOp) {
      const result: ExecutionResult = { status: "completed", summary: noOp, entities: [selected], errors: [] };
      await this.repository.updateAttempt(actor, { attemptId, expectedStatus: "running", patch: { status: "succeeded", completedAt: Date.now() } });
      await this.repository.updateRun(actor, executionRunId, { status: "completed", resultSummary: noOp, completedAt: Date.now() }, "running");
      await event("draft.not_created", { reason: "no_op" });
      await this.repository.appendMessage(actor, { messageId: randomUUID(), conversationId: input.conversationId, role: "assistant", contentRedacted: noOp, contextRefs: context, runId: executionRunId, sequence: messageSequence, createdAt: Date.now() });
      return { conversationId: input.conversationId, interactionRunId, executionRunId, result };
    }

    const projection = this.definition.project(input.value, selected, prepared, context);
    // Signed intents must survive a JSON/Convex round-trip byte-for-byte at
    // the canonical-data level. Optional EntityRef fields with `undefined`
    // are omitted explicitly before signing because JSON drops them.
    const signedTarget = compactEntityRefForWriteIntent(projection.target);
    const now = Date.now();
    const draftId = randomUUID();
    const confirmationToken = randomBytes(32).toString("base64url");
    const envelope: WriteIntentEnvelope = {
      draftId, tenantId: actor.tenantId, actorUserId: actor.userId, sessionId: actor.sessionId,
      permissionsVersion: actor.permissionsVersion, effectiveTenantOverride: actor.effectiveTenantOverride,
      conversationId: input.conversationId, sourceRunId: executionRunId, profileId: this.definition.profileId,
      toolId: this.definition.toolId, toolVersion: this.definition.toolVersion, toolScope,
      target: signedTarget,
      ...(projection.relatedEntities?.length ? { relatedEntities: projection.relatedEntities.map(compactEntityRefForWriteIntent) } : {}),
      operationType: projection.operationType, operation: projection.operation,
      requestedValue: projection.requestedValue,
      ...(projection.structuredPayload ? { structuredPayload: projection.structuredPayload } : {}),
      preconditions: projection.preconditions,
      argsHash: hashDraftArguments(projection.args), idempotencyKey: `agent-write:${draftId}`, risk: this.definition.risk ?? "R1",
      policyDecisionId: randomUUID(), expiresAt: now + (this.config.ttlMs ?? 10 * 60_000),
      confirmationTokenHash: hashConfirmationToken(confirmationToken),
    };
    const signedIntent: SignedWriteIntent = { envelope, signature: signWriteIntent(envelope, this.config.signingSecret) };
    await this.repository.updateAttempt(actor, { attemptId, expectedStatus: "running", patch: { status: "succeeded", completedAt: now } });
    await this.repository.updateRun(actor, executionRunId, { status: "awaiting_confirmation", resultSummary: "Draft awaiting explicit confirmation" }, "running");
    await this.repository.createWriteIntent(actor, { intent: signedIntent, status: "proposed", createdAt: now });
    await event("draft.created", {
      draftId, toolId: envelope.toolId, risk: envelope.risk, target: envelope.target,
      operationType: envelope.operationType, operation: envelope.operation, argsHash: envelope.argsHash,
      requestedValueHash: sha(envelope.requestedValue), requestedValueLength: envelope.requestedValue.length, expiresAt: envelope.expiresAt,
    });
    const block: ActionConfirmationBlock = {
      type: "action_confirmation", draftId, confirmationToken, target: signedTarget,
      ...projection.block, risk: envelope.risk, expiresAt: envelope.expiresAt,
    };
    const result: ExecutionResult = { status: "needs_input", summary: this.definition.preparedSummary, entities: [signedTarget], blocks: [block], errors: [], suggestedNext: ["Confirmar o cancelar el borrador."] };
    await this.repository.appendMessage(actor, { messageId: randomUUID(), conversationId: input.conversationId, role: "assistant", contentRedacted: this.definition.preparedSummary, blocks: [block], contextRefs: context, runId: executionRunId, sequence: messageSequence, createdAt: now });
    return { conversationId: input.conversationId, interactionRunId, executionRunId, draftId, result };
  }
}
