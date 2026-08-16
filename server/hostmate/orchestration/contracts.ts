import { z } from "zod";
import type { ActorContext } from "../contracts/actor-context.js";
import type { EntityRef, ExecutionProfileId, NormalizedAgentErrorCode } from "../contracts/domain.js";
import type { ExecutionResult } from "../contracts/execution-result.js";

export const MAX_ORCHESTRATION_DEPTH = 1;
export const MAX_CHILD_RUNS = 3;

export const agentHandoffSchema = z.object({
  sourceRunId: z.string().uuid(),
  targetProfile: z.enum(["crm", "visits", "property"]),
  objective: z.string().min(1).max(240),
  entityRefs: z.array(z.object({
    type: z.string().min(1).max(64), id: z.string().min(1).max(128),
    label: z.string().min(1).max(160).optional(), deepLink: z.string().min(1).max(512).optional(),
  }).strict()).max(6),
  structuredContext: z.record(z.unknown()),
  provenance: z.array(z.object({
    field: z.string().min(1).max(80), sourceToolId: z.string().min(1).max(100), sourceRunId: z.string().uuid(),
  }).strict()).max(16),
}).strict();

export type AgentHandoff = z.infer<typeof agentHandoffSchema>;

export type OrchestrationBudget = Readonly<{
  maxChildRuns: 3;
  maxToolCalls: number;
  maxInferenceCalls: number;
  maxInputTokens: number;
  maxCostUsd: number;
  deadlineAt: number;
}>;

export type OrchestrationDefinition = Readonly<{
  id: string;
  version: number;
  objectiveClass: string;
  rootProfile: ExecutionProfileId;
  branches: readonly Readonly<{
    key: string;
    profile: ExecutionProfileId;
    dependsOn: readonly string[];
    toolIds: readonly string[];
  }>[];
  limits: Readonly<{ maxChildren: 3; maxDepth: 1 }>;
}>;

export type ChildExecutionResult<T = unknown> = Readonly<{
  runId: string;
  branchKey: string;
  profileId: ExecutionProfileId;
  status: "completed" | "partial" | "failed" | "cancelled";
  toolScope: readonly string[];
  result?: ExecutionResult<T>;
  errorCode?: NormalizedAgentErrorCode;
  attempts: number;
  latencyMs: number;
}>;

/** ActorContext is deliberately captured by closure and never serialized into a handoff. */
export type ImmutableOrchestrationContext = Readonly<{
  actor: ActorContext;
  interactionRunId: string;
  orchestrationId: string;
  conversationId: string;
  budget: OrchestrationBudget;
}>;
