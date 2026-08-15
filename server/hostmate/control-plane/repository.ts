import type { ActorContext } from "../contracts/actor-context.js";
import type { ExecutionProfileId } from "../contracts/domain.js";
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

export type AgentMessageRecord = Readonly<{
  messageId: string;
  conversationId: string;
  tenantId: string;
  actorUserId: string;
  role: "user" | "assistant" | "system";
  contentRedacted: string;
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
  parentRunId?: string;
  dependencyRunIds: readonly string[];
  registryHash: string;
  skillVersions: Readonly<Record<string, number>>;
  toolScope: readonly string[];
  requestedModel?: string;
  visibility: "user" | "tenant_admin" | "platform_admin";
}>;

export type RunPatch = Readonly<{
  status?: RunStatus;
  resolvedModel?: string;
  provider?: string;
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
  createRun(actor: ActorContext, input: CreateRunInput): Promise<ExecutionRunRecord>;
  getRun(actor: ActorContext, runId: string): Promise<ExecutionRunRecord | null>;
  listRuns(actor: ActorContext, input: { limit: number; status?: RunStatus; ownOnly?: boolean }): Promise<readonly ExecutionRunRecord[]>;
  updateRun(actor: ActorContext, runId: string, patch: RunPatch, expectedStatus?: RunStatus): Promise<ExecutionRunRecord>;
  appendEvent(actor: ActorContext, input: AgentEventInput): Promise<AgentEvent>;
  createAttempt(actor: ActorContext, input: AttemptRecord): Promise<AttemptRecord>;
  acquireLease(actor: ActorContext, input: LeaseClaim): Promise<AttemptRecord | null>;
  heartbeat(actor: ActorContext, input: { runId: string; attemptId: string; leaseOwner: string; fencingToken: number; leaseExpiresAt: number }): Promise<boolean>;
  requestCancellation(actor: ActorContext, runId: string, requestedAt: number): Promise<ExecutionRunRecord>;
  recordUsage(actor: ActorContext, usage: UsageRecord): Promise<void>;
}
