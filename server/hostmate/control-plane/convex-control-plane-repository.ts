import type { ActorContext } from "../contracts/actor-context.js";
import type { AgentEvent } from "../events/contracts.js";
import type { AttemptRecord, ExecutionRunRecord } from "../lifecycle/contracts.js";
import type {
  AgentMessageRecord,
  ControlPlaneRepository,
  ConversationRecord,
  CreateRunInput,
  RunPatch,
} from "./repository.js";

export interface ConvexControlPlaneClient {
  mutation<T>(name: string, args: Record<string, unknown>): Promise<T>;
  query<T>(name: string, args: Record<string, unknown>): Promise<T>;
  action<T>(name: string, args: Record<string, unknown>): Promise<T>;
}

/**
 * Convex adapter with no authorization inputs in its public methods. The
 * service client is expected to derive tenant/user claims from its credential;
 * actor refs are sent only for audit and must be checked by Convex functions.
 */
export class ConvexControlPlaneRepository implements ControlPlaneRepository {
  constructor(private readonly client: ConvexControlPlaneClient) {}

  private audit(actor: ActorContext): Record<string, unknown> {
    return { expectedTenantId: actor.tenantId, expectedUserId: actor.userId };
  }

  createConversation(actor: ActorContext, input: { conversationId: string; title?: string }) {
    return this.client.mutation<ConversationRecord>("agentPlatform:createConversation", {
      ...input,
      ...this.audit(actor),
    });
  }

  appendMessage(actor: ActorContext, input: Omit<AgentMessageRecord, "tenantId" | "actorUserId">) {
    return this.client.mutation<AgentMessageRecord>("agentPlatform:appendMessage", {
      ...input,
      ...this.audit(actor),
    });
  }

  listMessages(actor: ActorContext, input: { conversationId: string; limit: number }) {
    return this.client.query<readonly AgentMessageRecord[]>("agentPlatform:listMessages", { ...input, ...this.audit(actor) });
  }

  createRun(actor: ActorContext, input: CreateRunInput) {
    return this.client.mutation<ExecutionRunRecord>("agentPlatform:createRun", {
      ...input,
      dependencyRunIds: [...input.dependencyRunIds],
      skillVersions: { ...input.skillVersions },
      skillRefs: input.skillRefs ? input.skillRefs.map((skill) => ({ ...skill })) : undefined,
      toolScope: [...input.toolScope],
      ...this.audit(actor),
    });
  }

  getRun(actor: ActorContext, runId: string) {
    return this.client.query<ExecutionRunRecord | null>("agentPlatform:getRun", {
      runId,
      ...this.audit(actor),
    });
  }

  listRuns(actor: ActorContext, input: Parameters<ControlPlaneRepository["listRuns"]>[1]) {
    return this.client.query<readonly ExecutionRunRecord[]>("agentPlatform:listRuns", {
      ...input,
      ...this.audit(actor),
    });
  }

  updateRun(actor: ActorContext, runId: string, patch: RunPatch, expectedStatus?: ExecutionRunRecord["status"]) {
    return this.client.mutation<ExecutionRunRecord>("agentPlatform:updateRun", {
      runId,
      patch,
      expectedStatus,
      ...this.audit(actor),
    });
  }

  appendEvent(actor: ActorContext, input: Parameters<ControlPlaneRepository["appendEvent"]>[1]) {
    return this.client.mutation<AgentEvent>("agentPlatform:appendEvent", {
      ...input,
      ...this.audit(actor),
    });
  }

  listEvents(actor: ActorContext, input: { executionRunId: string; limit: number }) {
    return this.client.query<readonly AgentEvent[]>("agentPlatform:listEvents", { ...input, ...this.audit(actor) });
  }

  listUsage(actor: ActorContext, input: { runId: string; limit: number }) {
    return this.client.query<readonly Parameters<ControlPlaneRepository["recordUsage"]>[1][]>("agentPlatform:listUsage", { ...input, ...this.audit(actor) });
  }

  createAttempt(actor: ActorContext, input: AttemptRecord) {
    return this.client.mutation<AttemptRecord>("agentPlatform:createAttempt", {
      ...input,
      ...this.audit(actor),
    });
  }

  updateAttempt(actor: ActorContext, input: Parameters<ControlPlaneRepository["updateAttempt"]>[1]) {
    return this.client.mutation<AttemptRecord>("agentPlatform:updateAttempt", { ...input, ...this.audit(actor) });
  }

  acquireLease(actor: ActorContext, input: Parameters<ControlPlaneRepository["acquireLease"]>[1]) {
    return this.client.mutation<AttemptRecord | null>("agentPlatform:acquireLease", {
      ...input,
      ...this.audit(actor),
    });
  }

  heartbeat(actor: ActorContext, input: Parameters<ControlPlaneRepository["heartbeat"]>[1]) {
    return this.client.mutation<boolean>("agentPlatform:heartbeat", {
      ...input,
      ...this.audit(actor),
    });
  }

  requestCancellation(actor: ActorContext, runId: string, requestedAt: number) {
    return this.client.mutation<ExecutionRunRecord>("agentPlatform:requestCancellation", {
      runId,
      requestedAt,
      ...this.audit(actor),
    });
  }

  async recordUsage(actor: ActorContext, usage: Parameters<ControlPlaneRepository["recordUsage"]>[1]) {
    await this.client.mutation("agentPlatform:recordUsage", {
      ...usage,
      ...this.audit(actor),
    });
  }
}
