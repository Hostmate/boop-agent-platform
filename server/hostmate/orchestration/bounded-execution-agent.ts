import { randomUUID } from "node:crypto";
import type { ActorContext } from "../contracts/actor-context.js";
import type { ExecutionProfileId, NormalizedAgentErrorCode } from "../contracts/domain.js";
import type { ExecutionResult } from "../contracts/execution-result.js";
import type { ControlPlaneRepository } from "../control-plane/repository.js";
import { ExecutionDispatchResolver } from "../interaction/dispatch.js";
import { shouldRetryAttempt } from "../lifecycle/contracts.js";
import { DefaultPolicyEngine } from "../policy/engine.js";
import { ExecutionProfileRegistry } from "../profiles/registry.js";
import { SkillRegistry } from "../skills/registry.js";
import { ProductToolRegistry } from "../tools/registry.js";
import type { AgentHandoff, ChildExecutionResult, ImmutableOrchestrationContext } from "./contracts.js";
import { agentHandoffSchema, MAX_ORCHESTRATION_DEPTH } from "./contracts.js";

type ChildSpec<T> = Readonly<{
  branchKey: string;
  profileId: ExecutionProfileId;
  objective: string;
  objectiveClasses: readonly string[];
  objectiveCapabilities: readonly string[];
  dependencyRunIds: readonly string[];
  handoff: AgentHandoff;
  tool: ConstructorParameters<typeof ProductToolRegistry>[0][number];
  toolInput?: unknown;
  noToolResult?: ExecutionResult<T>;
  toResult: (output: unknown) => ExecutionResult<T>;
  maxAttempts?: number;
}>;

function errorCode(error: unknown): NormalizedAgentErrorCode {
  const value = String(error);
  if (/PERMISSION|FORBIDDEN|STALE_REFERENCE|REFERENCE_MISMATCH/.test(value)) return "PERMISSION_DENIED";
  if (/RATE_LIMIT/.test(value)) return "RATE_LIMITED";
  if (/TIMEOUT|AbortError/.test(value)) return "TIMEOUT";
  if (/NETWORK|fetch failed|ECONN/.test(value)) return "NETWORK";
  if (/PROVIDER_UNAVAILABLE/.test(value)) return "PROVIDER_UNAVAILABLE";
  return "INTERNAL";
}

function terminalResult<T>(code: NormalizedAgentErrorCode): ExecutionResult<T> {
  const authority = code === "PERMISSION_DENIED" || code === "POLICY_DENIED";
  return {
    status: authority ? "permission_denied" : "failed",
    summary: authority ? "La rama no está autorizada dentro del scope actual." : "No se pudo completar esta parte del análisis.",
    entities: [], errors: [{ code, message: code, retryable: ["RATE_LIMITED", "PROVIDER_UNAVAILABLE", "TIMEOUT", "NETWORK"].includes(code) }],
  };
}

/**
 * Thin Hostmate adapter over the existing Execution Run/lifecycle/runtime-tool
 * primitives. It has no spawn API, so an Execution Agent cannot create a child.
 */
export class BoundedExecutionAgent {
  constructor(private readonly repository: ControlPlaneRepository) {}

  async execute<T>(actor: ActorContext, context: ImmutableOrchestrationContext, spec: ChildSpec<T>): Promise<ChildExecutionResult<T>> {
    const startedAt = performance.now();
    const parent = await this.repository.getRun(actor, context.interactionRunId);
    if (!parent || parent.kind !== "interaction" || parent.orchestrationId !== context.orchestrationId) throw new Error("INVALID_ORCHESTRATION_PARENT");
    if (parent.actorUserId !== actor.userId || parent.tenantId !== actor.tenantId) throw new Error("ACTOR_CONTEXT_MISMATCH");
    if (parent.cancelRequestedAt) return this.cancelledBeforeSpawn(spec, startedAt);
    agentHandoffSchema.parse(spec.handoff);
    if (spec.handoff.targetProfile !== spec.profileId) throw new Error("HANDOFF_PROFILE_MISMATCH");
    if (spec.handoff.sourceRunId !== spec.dependencyRunIds[0] && spec.dependencyRunIds.length > 0) throw new Error("HANDOFF_SOURCE_MISMATCH");

    const registry = new ProductToolRegistry([spec.tool]);
    const dispatch = new ExecutionDispatchResolver(new ExecutionProfileRegistry(), registry, new SkillRegistry()).resolve({
      actor,
      allowedToolIds: [spec.tool.toolId],
      featureEnabled: (toolId) => toolId === spec.tool.toolId,
      request: {
        profileId: spec.profileId, objective: spec.objective, objectiveClasses: spec.objectiveClasses,
        objectiveCapabilities: spec.objectiveCapabilities, inputRefs: spec.handoff.entityRefs,
        dependencyRunIds: spec.dependencyRunIds, constraints: { readOnly: true, maxResults: 6 },
      },
    });
    const runId = randomUUID();
    const toolScope = dispatch.toolResolution.tools.map((tool) => `${tool.toolId}@${tool.version}`);
    await this.repository.createRun(actor, {
      runId, conversationId: context.conversationId, kind: "execution", profileId: spec.profileId,
      profileVersion: dispatch.profile.version, objectiveHash: dispatch.objectiveHash,
      objectiveRedacted: spec.objective.slice(0, 240), parentRunId: context.interactionRunId,
      orchestrationId: context.orchestrationId, branchKey: spec.branchKey,
      orchestrationDepth: MAX_ORCHESTRATION_DEPTH, dependencyRunIds: spec.dependencyRunIds,
      registryHash: dispatch.toolResolution.registryHash, skillVersions: {}, toolScope, visibility: "user",
    });
    let sequence = 0;
    const event = (type: string, payload: unknown, attemptId?: string) => this.repository.appendEvent(actor, {
      eventId: randomUUID(), conversationId: context.conversationId,
      interactionRunId: context.interactionRunId, executionRunId: runId, attemptId,
      sequence: ++sequence, type, visibility: "tenant_admin", payload, occurredAt: Date.now(),
    });
    await event("orchestration.child.created", {
      orchestrationId: context.orchestrationId, branchKey: spec.branchKey,
      depth: MAX_ORCHESTRATION_DEPTH, dependencies: spec.dependencyRunIds,
      handoffProvenance: spec.handoff.provenance, actorSessionId: actor.sessionId,
    });

    if (dispatch.toolResolution.tools.length !== 1) {
      const result = terminalResult<T>("PERMISSION_DENIED");
      await this.repository.updateRun(actor, runId, { status: "failed", errorCode: "PERMISSION_DENIED", resultSummary: result.summary, completedAt: Date.now() }, "queued");
      await event("execution.permission_denied", { rejected: dispatch.toolResolution.rejected, inferenceCount: 0 });
      return { runId, branchKey: spec.branchKey, profileId: spec.profileId, status: "failed", toolScope, result, errorCode: "PERMISSION_DENIED", attempts: 0, latencyMs: performance.now() - startedAt };
    }

    const maxAttempts = Math.min(2, Math.max(1, spec.maxAttempts ?? 2));
    let lastCode: NormalizedAgentErrorCode = "INTERNAL";
    let previousAttemptId: string | undefined;
    for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
      const attemptId = randomUUID();
      const leaseOwner = `orchestration:${context.orchestrationId}:${spec.branchKey}`;
      await this.repository.createAttempt(actor, {
        attemptId, runId, attemptNumber, status: "queued", fencingToken: 0,
        retryOfAttemptId: previousAttemptId,
      });
      previousAttemptId = attemptId;
      const lease = await this.repository.acquireLease(actor, { runId, attemptId, leaseOwner, now: Date.now(), leaseDurationMs: 30_000 });
      if (!lease) throw new Error("EXECUTION_LEASE_UNAVAILABLE");
      if (attemptNumber === 1) await this.repository.updateRun(actor, runId, { status: "running" }, "queued");
      const heartbeatAccepted = await this.repository.heartbeat(actor, {
        runId, attemptId, leaseOwner, fencingToken: lease.fencingToken, leaseExpiresAt: Date.now() + 30_000,
      });
      if (!heartbeatAccepted) throw new Error("STALE_FENCING_TOKEN");
      await event("execution.started", { profile: spec.profileId, toolScope, attemptNumber, fencingToken: lease.fencingToken, inferenceCount: 0 }, attemptId);
      try {
        const cancellation = await this.cancellationRequested(actor, context, runId);
        if (cancellation) throw new Error("CANCELLED");
        if (Date.now() > context.budget.deadlineAt) throw new Error("TIMEOUT");
        if (spec.noToolResult) {
          await this.repository.updateAttempt(actor, { attemptId, expectedStatus: "running", patch: { status: "succeeded", completedAt: Date.now() } });
          await this.repository.updateRun(actor, runId, { status: "partial", resultSummary: spec.noToolResult.summary, completedAt: Date.now() }, "running");
          await event("execution.partial", { reason: spec.noToolResult.errors[0]?.code ?? "MISSING_REQUIRED_FIELD", toolCalls: 0, inferenceCount: 0 }, attemptId);
          return { runId, branchKey: spec.branchKey, profileId: spec.profileId, status: "partial", toolScope, result: spec.noToolResult, attempts: attemptNumber, latencyMs: performance.now() - startedAt };
        }
        const runtimeTool = registry.compileRuntimeTools({
          resolved: dispatch.toolResolution, actor, policy: new DefaultPolicyEngine(), profileId: spec.profileId,
          decisionId: () => randomUUID(), hasRequiredPreconditions: () => true,
        })[0]!;
        await event("tool.started", { toolId: spec.tool.toolId, inputSanitized: spec.toolInput, handoffSourceRunId: spec.handoff.sourceRunId }, attemptId);
        const toolResponse = await runtimeTool.handle((spec.toolInput ?? {}) as Record<string, unknown>);
        if (!toolResponse.success) throw new Error(`POLICY_DENIED:${toolResponse.text}`);
        const parsed = JSON.parse(toolResponse.text) as { ok: boolean; data?: unknown };
        if (!parsed.ok || parsed.data === undefined) throw new Error("INVALID_TOOL_RESULT");
        const result = spec.toResult(parsed.data);
        if (await this.cancellationRequested(actor, context, runId)) throw new Error("CANCELLED");
        await this.repository.updateAttempt(actor, { attemptId, expectedStatus: "running", patch: { status: "succeeded", completedAt: Date.now() } });
        await this.repository.updateRun(actor, runId, { status: result.status === "partial" ? "partial" : "completed", resultSummary: result.summary, completedAt: Date.now() }, "running");
        await event("tool.completed", { toolId: spec.tool.toolId, entityRefs: result.entities, status: result.status }, attemptId);
        await event("execution.completed", { status: result.status, toolCalls: 1, inferenceCount: 0 }, attemptId);
        return { runId, branchKey: spec.branchKey, profileId: spec.profileId, status: result.status === "partial" ? "partial" : "completed", toolScope, result, attempts: attemptNumber, latencyMs: performance.now() - startedAt };
      } catch (error) {
        const cancelled = /CANCELLED/.test(String(error));
        lastCode = cancelled ? "CANCELLED" : errorCode(error);
        await this.repository.updateAttempt(actor, { attemptId, expectedStatus: "running", patch: { status: cancelled ? "cancelled" : lastCode === "TIMEOUT" ? "timeout" : "failed", errorCode: lastCode, completedAt: Date.now() } });
        const retry = shouldRetryAttempt({ status: lastCode === "TIMEOUT" ? "timeout" : "failed", errorCode: lastCode, attemptNumber, maxAttempts, sideEffectOutcome: "none" });
        await event(retry ? "execution.retry_scheduled" : "execution.attempt_failed", { errorCode: lastCode, retry, attemptNumber }, attemptId);
        if (retry) continue;
        const result = terminalResult<T>(lastCode);
        await this.repository.updateRun(actor, runId, { status: cancelled ? "cancelled" : lastCode === "TIMEOUT" ? "timeout" : "failed", errorCode: lastCode, resultSummary: result.summary, completedAt: Date.now() }, "running");
        return { runId, branchKey: spec.branchKey, profileId: spec.profileId, status: cancelled ? "cancelled" : "failed", toolScope, result, errorCode: lastCode, attempts: attemptNumber, latencyMs: performance.now() - startedAt };
      }
    }
    throw new Error(`UNREACHABLE:${lastCode}`);
  }

  private async cancellationRequested(actor: ActorContext, context: ImmutableOrchestrationContext, childRunId: string): Promise<boolean> {
    const parent = await this.repository.getRun(actor, context.interactionRunId);
    const child = await this.repository.getRun(actor, childRunId);
    if (!parent?.cancelRequestedAt && !child?.cancelRequestedAt) return false;
    if (!child?.cancelRequestedAt) await this.repository.requestCancellation(actor, childRunId, parent?.cancelRequestedAt ?? Date.now());
    return true;
  }

  private cancelledBeforeSpawn<T>(spec: ChildSpec<T>, startedAt: number): ChildExecutionResult<T> {
    return { runId: "not-spawned", branchKey: spec.branchKey, profileId: spec.profileId, status: "cancelled", toolScope: [], errorCode: "CANCELLED", attempts: 0, latencyMs: performance.now() - startedAt };
  }
}
