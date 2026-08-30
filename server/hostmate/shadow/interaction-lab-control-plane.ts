import type { ActorContext } from "../contracts/actor-context.js";
import type { AgentEvent, AgentEventInput } from "../events/contracts.js";
import type { AttemptRecord, ExecutionRunRecord, LeaseClaim, RunStatus, UsageRecord } from "../lifecycle/contracts.js";
import type {
  AgentMessageRecord,
  ControlPlaneRepository,
  ConversationRecord,
  CreateRunInput,
  RunPatch,
  WriteIntentRecord,
} from "../control-plane/repository.js";

/**
 * Request-local control plane for the read-only Interaction Lab. It lets the
 * real Boop Skill and bounded-workflow executors keep their lifecycle and
 * fencing contracts without writing to Convex or Product Data.
 */
export class InteractionLabControlPlaneRepository implements ControlPlaneRepository {
  private readonly conversations = new Map<string, ConversationRecord>();
  private readonly messages: AgentMessageRecord[];
  private readonly runs = new Map<string, ExecutionRunRecord>();
  private readonly attempts = new Map<string, AttemptRecord>();
  private readonly events: AgentEvent[] = [];
  private readonly usage: UsageRecord[] = [];

  constructor(seedMessages: readonly AgentMessageRecord[] = []) {
    this.messages = [...seedMessages];
    for (const message of seedMessages) {
      if (!this.conversations.has(message.conversationId)) {
        this.conversations.set(message.conversationId, {
          conversationId: message.conversationId,
          tenantId: message.tenantId,
          ownerUserId: message.actorUserId,
          createdAt: message.createdAt,
          updatedAt: message.createdAt,
        });
      }
    }
  }

  async createConversation(actor: ActorContext, input: { conversationId: string; title?: string }): Promise<ConversationRecord> {
    const existing = this.conversations.get(input.conversationId);
    if (existing) return this.assertConversation(actor, existing);
    const now = Date.now();
    const record: ConversationRecord = {
      conversationId: input.conversationId,
      tenantId: actor.tenantId,
      ownerUserId: actor.userId,
      title: input.title,
      createdAt: now,
      updatedAt: now,
    };
    this.conversations.set(input.conversationId, record);
    return record;
  }

  async appendMessage(actor: ActorContext, input: Omit<AgentMessageRecord, "tenantId" | "actorUserId">): Promise<AgentMessageRecord> {
    const conversation = this.conversations.get(input.conversationId);
    if (conversation) this.assertConversation(actor, conversation);
    else await this.createConversation(actor, { conversationId: input.conversationId });
    const record: AgentMessageRecord = { ...input, tenantId: actor.tenantId, actorUserId: actor.userId };
    this.messages.push(record);
    return record;
  }

  async listMessages(actor: ActorContext, input: { conversationId: string; limit: number }): Promise<readonly AgentMessageRecord[]> {
    const conversation = this.conversations.get(input.conversationId);
    if (!conversation) throw new Error("CONVERSATION_NOT_FOUND");
    this.assertConversation(actor, conversation);
    return this.messages.filter((message) => message.conversationId === input.conversationId).slice(-input.limit);
  }

  async createRun(actor: ActorContext, input: CreateRunInput): Promise<ExecutionRunRecord> {
    if ((input.orchestrationDepth ?? 0) > 1) throw new Error("ORCHESTRATION_DEPTH_EXCEEDED");
    if (input.parentRunId) {
      const parent = this.runs.get(input.parentRunId);
      if (!parent || parent.kind !== "interaction") throw new Error("CHILD_RUN_CANNOT_SPAWN");
      this.assertRun(actor, parent);
    }
    const now = Date.now();
    const record: ExecutionRunRecord = { ...input, tenantId: actor.tenantId, actorUserId: actor.userId, status: "queued", createdAt: now, updatedAt: now };
    this.runs.set(input.runId, record);
    return record;
  }

  async getRun(actor: ActorContext, runId: string): Promise<ExecutionRunRecord | null> {
    const run = this.runs.get(runId);
    return run && run.tenantId === actor.tenantId && run.actorUserId === actor.userId ? run : null;
  }

  async listRuns(actor: ActorContext, input: { limit: number; status?: RunStatus; ownOnly?: boolean }): Promise<readonly ExecutionRunRecord[]> {
    return [...this.runs.values()]
      .filter((run) => run.tenantId === actor.tenantId && run.actorUserId === actor.userId)
      .filter((run) => !input.status || run.status === input.status)
      .slice(-input.limit);
  }

  async updateRun(actor: ActorContext, runId: string, patch: RunPatch, expectedStatus?: RunStatus): Promise<ExecutionRunRecord> {
    const current = this.runs.get(runId);
    if (!current) throw new Error("RUN_NOT_FOUND");
    this.assertRun(actor, current);
    if (expectedStatus && current.status !== expectedStatus) throw new Error("RUN_STATUS_CONFLICT");
    const updated: ExecutionRunRecord = { ...current, ...patch, updatedAt: Date.now() };
    this.runs.set(runId, updated);
    return updated;
  }

  async appendEvent(actor: ActorContext, input: AgentEventInput): Promise<AgentEvent> {
    const event: AgentEvent = { ...input, tenantId: actor.tenantId, actorUserId: actor.userId, payloadRedacted: input.payload };
    this.events.push(event);
    return event;
  }

  async listEvents(actor: ActorContext, input: { executionRunId: string; limit: number }): Promise<readonly AgentEvent[]> {
    return this.events
      .filter((event) => event.tenantId === actor.tenantId && event.actorUserId === actor.userId && event.executionRunId === input.executionRunId)
      .slice(-input.limit);
  }

  async listUsage(actor: ActorContext, input: { runId: string; limit: number }): Promise<readonly UsageRecord[]> {
    const run = await this.getRun(actor, input.runId);
    if (!run) return [];
    return this.usage.filter((usage) => usage.runId === input.runId).slice(-input.limit);
  }

  async createAttempt(actor: ActorContext, input: AttemptRecord): Promise<AttemptRecord> {
    if (!await this.getRun(actor, input.runId)) throw new Error("RUN_NOT_FOUND");
    this.attempts.set(input.attemptId, input);
    return input;
  }

  async updateAttempt(actor: ActorContext, input: { attemptId: string; expectedStatus?: AttemptRecord["status"]; patch: Partial<Pick<AttemptRecord, "status" | "startedAt" | "completedAt" | "errorCode">> }): Promise<AttemptRecord> {
    const current = this.attempts.get(input.attemptId);
    if (!current || !await this.getRun(actor, current.runId)) throw new Error("ATTEMPT_NOT_FOUND");
    if (input.expectedStatus && current.status !== input.expectedStatus) throw new Error("ATTEMPT_STATUS_CONFLICT");
    const updated: AttemptRecord = { ...current, ...input.patch };
    this.attempts.set(input.attemptId, updated);
    return updated;
  }

  async acquireLease(actor: ActorContext, input: LeaseClaim): Promise<AttemptRecord | null> {
    const current = this.attempts.get(input.attemptId);
    if (!current || current.runId !== input.runId || !await this.getRun(actor, input.runId)) return null;
    const updated: AttemptRecord = {
      ...current,
      status: "running",
      leaseOwner: input.leaseOwner,
      fencingToken: current.fencingToken + 1,
      leaseExpiresAt: input.now + input.leaseDurationMs,
      heartbeatAt: input.now,
      startedAt: current.startedAt ?? input.now,
    };
    this.attempts.set(input.attemptId, updated);
    return updated;
  }

  async heartbeat(actor: ActorContext, input: { runId: string; attemptId: string; leaseOwner: string; fencingToken: number; leaseExpiresAt: number }): Promise<boolean> {
    const current = this.attempts.get(input.attemptId);
    if (!current || !await this.getRun(actor, input.runId)) return false;
    if (current.leaseOwner !== input.leaseOwner || current.fencingToken !== input.fencingToken) return false;
    this.attempts.set(input.attemptId, { ...current, leaseExpiresAt: input.leaseExpiresAt, heartbeatAt: Date.now() });
    return true;
  }

  async requestCancellation(actor: ActorContext, runId: string, requestedAt: number): Promise<ExecutionRunRecord> {
    return this.updateRun(actor, runId, { cancelRequestedAt: requestedAt });
  }

  async recordUsage(actor: ActorContext, usage: UsageRecord): Promise<void> {
    if (!await this.getRun(actor, usage.runId)) throw new Error("RUN_NOT_FOUND");
    this.usage.push(usage);
  }

  async createWriteIntent(): Promise<WriteIntentRecord> { throw new Error("INTERACTION_LAB_READ_ONLY"); }
  async getWriteIntent(): Promise<WriteIntentRecord | null> { return null; }
  async confirmWriteIntent(): Promise<WriteIntentRecord> { throw new Error("INTERACTION_LAB_READ_ONLY"); }
  async claimWriteIntentCommit(): Promise<WriteIntentRecord> { throw new Error("INTERACTION_LAB_READ_ONLY"); }
  async cancelWriteIntent(): Promise<WriteIntentRecord> { throw new Error("INTERACTION_LAB_READ_ONLY"); }
  async finalizeWriteIntent(): Promise<WriteIntentRecord> { throw new Error("INTERACTION_LAB_READ_ONLY"); }

  snapshot(): Readonly<{ runs: readonly ExecutionRunRecord[]; attempts: readonly AttemptRecord[]; events: readonly AgentEvent[] }> {
    return { runs: [...this.runs.values()], attempts: [...this.attempts.values()], events: [...this.events] };
  }

  private assertConversation(actor: ActorContext, conversation: ConversationRecord): ConversationRecord {
    if (conversation.tenantId !== actor.tenantId || conversation.ownerUserId !== actor.userId) throw new Error("CONVERSATION_SCOPE_MISMATCH");
    return conversation;
  }

  private assertRun(actor: ActorContext, run: ExecutionRunRecord): void {
    if (run.tenantId !== actor.tenantId || run.actorUserId !== actor.userId) throw new Error("RUN_SCOPE_MISMATCH");
  }
}
