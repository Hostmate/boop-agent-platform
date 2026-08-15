import type { ActorContext } from "../contracts/actor-context.js";
import type { ExecutionProfileId } from "../contracts/domain.js";
import type { EntityRef } from "../contracts/domain.js";
import type { AgentContentBlock } from "../contracts/execution-result.js";
import type { AgentEvent, AgentEventInput } from "../events/contracts.js";
import type {
  AttemptRecord,
  ExecutionRunRecord,
  LeaseClaim,
  RunStatus,
  UsageRecord,
} from "../lifecycle/contracts.js";

export type ConversationRecord = Readonly<{
  conversationId: string;
  tenantId: string;
  ownerUserId: string;
  title?: string;
  createdAt: number;
  updatedAt: number;
}>;

export type ConversationContextRefs = Readonly<{
  /**
   * Semantic selection roles owned by each product extension. The shared
   * control plane deliberately does not enumerate CRM, visits or future
   * domains; extensions currently use `lead` and `visit`.
   */
  selected: Readonly<Record<string, EntityRef | undefined>>;
  referenced: readonly EntityRef[];
}>;

export type AgentMessageRecord = Readonly<{
  messageId: string;
  conversationId: string;
  tenantId: string;
  actorUserId: string;
  role: "user" | "assistant" | "system";
  contentRedacted: string;
  blocks?: readonly AgentContentBlock[];
  contextRefs?: ConversationContextRefs;
  runId?: string;
  sequence: number;
  createdAt: number;
}>;

export type CreateRunInput = Readonly<{
  runId: string;
  conversationId?: string;
  kind: "interaction" | "execution";
  profileId?: ExecutionProfileId;
  profileVersion?: number;
  objectiveHash: string;
  objectiveRedacted?: string;
  parentRunId?: string;
  dependencyRunIds: readonly string[];
  registryHash: string;
  skillVersions: Readonly<Record<string, number>>;
  skillRefs?: readonly Readonly<{ id: string; version: number; hash: string; sourcePath: string }> [];
  toolScope: readonly string[];
  requestedModel?: string;
  visibility: "user" | "tenant_admin" | "platform_admin";
}>;

export type RunPatch = Readonly<{
  status?: RunStatus;
  resolvedModel?: string;
  provider?: string;
  finishReason?: string;
  resultSummary?: string;
  errorCode?: string;
  cancelRequestedAt?: number;
  completedAt?: number;
}>;

/**
 * Port owned by the Boop-derived core. Implementations may use Convex today or
 * a different control-plane datastore later without changing runtime logic.
 */
export interface ControlPlaneRepository {
  createConversation(actor: ActorContext, input: { conversationId: string; title?: string }): Promise<ConversationRecord>;
  appendMessage(actor: ActorContext, input: Omit<AgentMessageRecord, "tenantId" | "actorUserId">): Promise<AgentMessageRecord>;
  listMessages(actor: ActorContext, input: { conversationId: string; limit: number }): Promise<readonly AgentMessageRecord[]>;
  createRun(actor: ActorContext, input: CreateRunInput): Promise<ExecutionRunRecord>;
  getRun(actor: ActorContext, runId: string): Promise<ExecutionRunRecord | null>;
  listRuns(actor: ActorContext, input: { limit: number; status?: RunStatus; ownOnly?: boolean }): Promise<readonly ExecutionRunRecord[]>;
  updateRun(actor: ActorContext, runId: string, patch: RunPatch, expectedStatus?: RunStatus): Promise<ExecutionRunRecord>;
  appendEvent(actor: ActorContext, input: AgentEventInput): Promise<AgentEvent>;
  listEvents(actor: ActorContext, input: { executionRunId: string; limit: number }): Promise<readonly AgentEvent[]>;
  listUsage(actor: ActorContext, input: { runId: string; limit: number }): Promise<readonly UsageRecord[]>;
  createAttempt(actor: ActorContext, input: AttemptRecord): Promise<AttemptRecord>;
  updateAttempt(actor: ActorContext, input: { attemptId: string; expectedStatus?: AttemptRecord["status"]; patch: Partial<Pick<AttemptRecord, "status" | "startedAt" | "completedAt" | "errorCode">> }): Promise<AttemptRecord>;
  acquireLease(actor: ActorContext, input: LeaseClaim): Promise<AttemptRecord | null>;
  heartbeat(actor: ActorContext, input: { runId: string; attemptId: string; leaseOwner: string; fencingToken: number; leaseExpiresAt: number }): Promise<boolean>;
  requestCancellation(actor: ActorContext, runId: string, requestedAt: number): Promise<ExecutionRunRecord>;
  recordUsage(actor: ActorContext, usage: UsageRecord): Promise<void>;
}
