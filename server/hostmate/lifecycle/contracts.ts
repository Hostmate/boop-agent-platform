import type { ExecutionProfileId } from "../contracts/domain.js";

export type RunStatus =
  | "queued"
  | "waiting_dependency"
  | "resolving_scope"
  | "running"
  | "awaiting_confirmation"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled"
  | "timeout";

export type AttemptStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timeout" | "unknown";

export type ExecutionRunRecord = Readonly<{
  runId: string;
  tenantId: string;
  actorUserId: string;
  conversationId?: string;
  kind: "interaction" | "execution";
  profileId?: ExecutionProfileId;
  profileVersion?: number;
  parentRunId?: string;
  orchestrationId?: string;
  branchKey?: string;
  orchestrationDepth?: number;
  dependencyRunIds: readonly string[];
  status: RunStatus;
  objectiveHash: string;
  objectiveRedacted?: string;
  registryHash: string;
  skillVersions: Readonly<Record<string, number>>;
  skillRefs?: readonly Readonly<{ id: string; version: number; hash: string; sourcePath: string }> [];
  toolScope: readonly string[];
  requestedModel?: string;
  resolvedModel?: string;
  provider?: string;
  finishReason?: string;
  resultSummary?: string;
  errorCode?: string;
  cancelRequestedAt?: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}>;

export type AttemptRecord = Readonly<{
  attemptId: string;
  runId: string;
  attemptNumber: number;
  status: AttemptStatus;
  leaseOwner?: string;
  fencingToken: number;
  leaseExpiresAt?: number;
  heartbeatAt?: number;
  retryOfAttemptId?: string;
  startedAt?: number;
  completedAt?: number;
  errorCode?: string;
}>;

export type LeaseClaim = Readonly<{
  runId: string;
  attemptId: string;
  leaseOwner: string;
  now: number;
  leaseDurationMs: number;
}>;

export type UsageRecord = Readonly<{
  usageId: string;
  runId: string;
  attemptId: string;
  requestedModel: string;
  resolvedModel: string;
  provider?: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  costUsd: number;
  latencyMs: number;
  fallbackUsed: boolean;
  finishReason?: string;
  createdAt: number;
}>;

const TERMINAL = new Set<RunStatus>(["completed", "partial", "failed", "cancelled", "timeout"]);
const TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  queued: ["waiting_dependency", "resolving_scope", "running", "cancelled", "timeout", "failed"],
  waiting_dependency: ["resolving_scope", "cancelled", "timeout", "failed"],
  resolving_scope: ["running", "cancelled", "timeout", "failed"],
  running: ["awaiting_confirmation", "completed", "partial", "failed", "cancelled", "timeout"],
  awaiting_confirmation: ["running", "completed", "failed", "cancelled", "timeout"],
  completed: [],
  partial: [],
  failed: [],
  cancelled: [],
  timeout: [],
};

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminalRun(status: RunStatus): boolean {
  return TERMINAL.has(status);
}

export function assertFencingToken(expected: number, actual: number): void {
  if (expected !== actual) throw new Error(`STALE_FENCING_TOKEN expected=${expected} actual=${actual}`);
}

export function shouldRetryAttempt(input: {
  status: AttemptStatus;
  errorCode?: string;
  attemptNumber: number;
  maxAttempts: number;
  sideEffectOutcome?: "none" | "committed" | "unknown";
}): boolean {
  if (input.attemptNumber >= input.maxAttempts) return false;
  if (input.sideEffectOutcome === "committed" || input.sideEffectOutcome === "unknown") return false;
  if (["succeeded", "cancelled", "unknown"].includes(input.status)) return false;
  return ["RATE_LIMITED", "PROVIDER_UNAVAILABLE", "TIMEOUT", "NETWORK"].includes(input.errorCode ?? "");
}
