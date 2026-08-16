import { createHash, randomUUID } from "node:crypto";
import type { RuntimeTool } from "../../runtimes/types.js";
import type { ActorContext } from "../contracts/actor-context.js";
import type { EntityRef, ExecutionProfileId } from "../contracts/domain.js";
import type { ExecutionResult } from "../contracts/execution-result.js";
import type {
  AgentMessageRecord, ControlPlaneRepository, ConversationContextRefs,
} from "../control-plane/repository.js";
import { redactEventPayload } from "../events/contracts.js";
import { ExecutionDispatchResolver } from "../interaction/dispatch.js";
import { DefaultPolicyEngine } from "../policy/engine.js";
import { ExecutionProfileRegistry } from "../profiles/registry.js";
import type { ProductToolRegistry } from "../tools/registry.js";
import { SkillRegistry } from "./registry.js";

export type DeterministicSkillInput = Readonly<{
  conversationId: string;
  message: string;
  selectedEntityRef?: EntityRef;
}>;

export type DeterministicSkillTurn<T> = Readonly<{
  conversationId: string;
  interactionRunId: string;
  executionRunId?: string;
  result: ExecutionResult<T>;
}>;

type ProcedureResult<T> = Readonly<{
  result: ExecutionResult<T>;
  contextRefs?: ConversationContextRefs;
  completionEvent?: Record<string, unknown>;
}>;

export type DeterministicSkillProcedureContext = Readonly<{
  actor: ActorContext;
  selectedRef: EntityRef;
  contextRefs: ConversationContextRefs;
  callTool: <TOutput>(name: string, toolId: string, args: Record<string, unknown>) => Promise<TOutput>;
  event: (type: string, payload: unknown) => Promise<void>;
}>;

export type DeterministicReadSkillSpec<T> = Readonly<{
  id: string;
  profileId: ExecutionProfileId;
  objectiveClass: string;
  objectiveCapabilities: readonly string[];
  exactToolIds: readonly string[];
  contextRole: string;
  acceptsRef: (ref?: EntityRef) => ref is EntityRef;
  skillEnabled: boolean;
  registry: ProductToolRegistry;
  missingInputSummary: string;
  missingInputSuggestion: string;
  deniedSummary: string;
  failedSummary: string;
  procedure: (context: DeterministicSkillProcedureContext) => Promise<ProcedureResult<T>>;
}>;

export function latestContext(messages: readonly AgentMessageRecord[]): ConversationContextRefs {
  return [...messages].reverse().find((message) => message.contextRefs)?.contextRefs ?? { selected: {}, referenced: [] };
}

export function isAuthorityFailure(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  const detail = error instanceof Error ? `${error.name}:${error.message}:${code}` : `${String(error)}:${code}`;
  return /PERMISSION|POLICY|FORBIDDEN|STALE/.test(detail);
}

export function briefFields(input: ReadonlyArray<readonly [string, string | number | null | undefined, string?]>) {
  return input.flatMap(([label, value, suffix]) => value == null || value === "" ? [] : [{ label, value: `${value}${suffix ?? ""}` }]);
}

export function formatDateTime(value: string, timezone: string): string {
  return new Intl.DateTimeFormat("es-ES", { dateStyle: "medium", timeStyle: "short", timeZone: timezone }).format(new Date(value));
}

export function formatMoney(value: number | null | undefined): string | undefined {
  return value == null ? undefined : new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(value);
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function redactedObjective(value: string): string { return value.replace(/\s+/g, " ").trim().slice(0, 160); }

function failure<T>(error: unknown, spec: DeterministicReadSkillSpec<T>): ExecutionResult<T> {
  const message = error instanceof Error ? error.message : String(error);
  const denied = isAuthorityFailure(error);
  return {
    status: denied ? "permission_denied" : "failed",
    summary: denied ? spec.deniedSummary : spec.failedSummary,
    entities: [],
    errors: [{ code: denied ? "PERMISSION_DENIED" : "INTERNAL", message, retryable: false }],
  };
}

function toolTelemetry(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const telemetry = (value as { telemetry?: unknown }).telemetry;
  if (!telemetry || typeof telemetry !== "object") return {};
  const services = (telemetry as { services?: unknown }).services;
  return Array.isArray(services) ? { services } : {};
}

export async function executeDeterministicReadSkill<T>(
  repository: ControlPlaneRepository,
  actor: ActorContext,
  input: DeterministicSkillInput,
  spec: DeterministicReadSkillSpec<T>,
): Promise<DeterministicSkillTurn<T>> {
  const objective = input.message.trim();
  const interactionRunId = randomUUID();
  let prior: readonly AgentMessageRecord[];
  try {
    prior = await repository.listMessages(actor, { conversationId: input.conversationId, limit: 200 });
  } catch {
    await repository.createConversation(actor, { conversationId: input.conversationId, title: "AI Chat" });
    prior = [];
  }
  const previousContext = latestContext(prior);
  const previousSelected = previousContext.selected[spec.contextRole];
  const selectedRef = spec.acceptsRef(input.selectedEntityRef)
    ? input.selectedEntityRef
    : spec.acceptsRef(previousSelected) ? previousSelected : undefined;
  const contextRefs: ConversationContextRefs = {
    selected: { ...previousContext.selected, ...(selectedRef ? { [spec.contextRole]: selectedRef } : {}) },
    referenced: previousContext.referenced,
  };
  let sequence = (prior.at(-1)?.sequence ?? 0) + 1;
  await repository.appendMessage(actor, {
    messageId: randomUUID(), conversationId: input.conversationId, role: "user",
    contentRedacted: objective, contextRefs, sequence: sequence++, createdAt: Date.now(),
  });
  await repository.createRun(actor, {
    runId: interactionRunId, conversationId: input.conversationId, kind: "interaction",
    objectiveHash: hash(objective), objectiveRedacted: redactedObjective(objective), dependencyRunIds: [],
    registryHash: "interaction-dispatch-skills-v2", skillVersions: {}, toolScope: [], visibility: "user",
  });
  await repository.updateRun(actor, interactionRunId, { status: "running" }, "queued");

  let eventSequence = 0;
  let executionRunId: string | undefined;
  let attemptId: string | undefined;
  const event = async (type: string, payload: unknown) => repository.appendEvent(actor, {
    eventId: randomUUID(), conversationId: input.conversationId, interactionRunId, executionRunId, attemptId,
    sequence: ++eventSequence, type, visibility: "user", payload: redactEventPayload(payload), occurredAt: Date.now(),
  }).then(() => undefined);
  await event("interaction.started", { objectiveClass: spec.objectiveClass, selectedRef });

  const persist = async (result: ExecutionResult<T>, refs = contextRefs) => {
    await repository.appendMessage(actor, {
      messageId: randomUUID(), conversationId: input.conversationId, role: "assistant",
      contentRedacted: result.summary, blocks: result.blocks, contextRefs: refs,
      runId: executionRunId, sequence, createdAt: Date.now(),
    });
  };

  if (!selectedRef) {
    const result: ExecutionResult<T> = {
      status: "needs_input", summary: spec.missingInputSummary, entities: [], errors: [],
      suggestedNext: [spec.missingInputSuggestion],
    };
    await event("interaction.needs_input", { reason: `selected.${spec.contextRole}_missing`, arbitrarySearchAllowed: false });
    await repository.updateRun(actor, interactionRunId, { status: "completed", resultSummary: result.summary, completedAt: Date.now() }, "running");
    await persist(result);
    return { conversationId: input.conversationId, interactionRunId, result };
  }

  const dispatch = new ExecutionDispatchResolver(new ExecutionProfileRegistry(), spec.registry, new SkillRegistry()).resolve({
    actor,
    allowedToolIds: spec.exactToolIds,
    featureEnabled: (toolId) => spec.exactToolIds.includes(toolId),
    skillFeatureEnabled: () => spec.skillEnabled,
    request: {
      profileId: spec.profileId, objective, objectiveClasses: [spec.objectiveClass],
      objectiveCapabilities: spec.objectiveCapabilities, inputRefs: [selectedRef], dependencyRunIds: [],
      internalSkillHints: [spec.id], constraints: { readOnly: true, maxResults: 1 },
    },
  });
  const selectedSkill = dispatch.skills.length === 1 && dispatch.skills[0]?.id === spec.id ? dispatch.skills[0] : undefined;
  const toolScope = dispatch.toolResolution.tools.map((tool) => `${tool.toolId}@${tool.version}`);
  const skillRefs = selectedSkill
    ? [{ id: selectedSkill.id, version: selectedSkill.version, hash: selectedSkill.hash, sourcePath: selectedSkill.sourcePath }]
    : [];
  await event("interaction.dispatch.resolved", {
    profile: spec.profileId, profileVersion: dispatch.profile.version, objectiveClass: spec.objectiveClass,
    toolScope, skillRefs, selectedRef,
  });
  await repository.updateRun(actor, interactionRunId, {
    status: "completed", resultSummary: selectedSkill ? `Dispatched ${spec.id}` : "Skill unavailable", completedAt: Date.now(),
  }, "running");

  executionRunId = randomUUID();
  attemptId = randomUUID();
  await repository.createRun(actor, {
    runId: executionRunId, conversationId: input.conversationId, kind: "execution",
    profileId: spec.profileId, profileVersion: dispatch.profile.version, parentRunId: interactionRunId,
    objectiveHash: dispatch.objectiveHash, objectiveRedacted: redactedObjective(objective), dependencyRunIds: [],
    registryHash: dispatch.toolResolution.registryHash,
    skillVersions: selectedSkill ? { [selectedSkill.id]: selectedSkill.version } : {}, skillRefs,
    toolScope, visibility: "user",
  });
  if (!selectedSkill || dispatch.toolResolution.tools.length !== spec.exactToolIds.length) {
    const result: ExecutionResult<T> = {
      status: "permission_denied", summary: spec.deniedSummary, entities: [],
      errors: [{ code: "PERMISSION_DENIED", message: dispatch.toolResolution.rejected[0]?.reason ?? "skill_disabled", retryable: false }],
    };
    await repository.updateRun(actor, executionRunId, {
      status: "failed", errorCode: "PERMISSION_DENIED", resultSummary: result.summary, completedAt: Date.now(),
    }, "queued");
    await event("execution.permission_denied", { rejected: dispatch.toolResolution.rejected, skillResolved: Boolean(selectedSkill) });
    await persist(result);
    return { conversationId: input.conversationId, interactionRunId, executionRunId, result };
  }

  await repository.createAttempt(actor, { attemptId, runId: executionRunId, attemptNumber: 1, status: "queued", fencingToken: 0 });
  await repository.updateAttempt(actor, { attemptId, expectedStatus: "queued", patch: { status: "running", startedAt: Date.now() } });
  await repository.updateRun(actor, executionRunId, { status: "running" }, "queued");
  const runtimeTools = spec.registry.compileRuntimeTools({
    resolved: dispatch.toolResolution, actor, policy: new DefaultPolicyEngine(), profileId: spec.profileId,
    decisionId: () => randomUUID(), hasRequiredPreconditions: () => true,
  });
  const byName = new Map(runtimeTools.map((tool) => [tool.name, tool]));
  const startedAt = performance.now();
  await event("skill.started", { skill: skillRefs[0], profile: spec.profileId, sourceTrusted: true });

  const callTool = async <TOutput>(name: string, toolId: string, args: Record<string, unknown>): Promise<TOutput> => {
    const tool: RuntimeTool | undefined = byName.get(name);
    if (!tool) throw new Error(`POLICY_DENIED: tool ${toolId} is outside the resolved ToolScope`);
    const toolStartedAt = performance.now();
    await event("tool.started", { toolId, inputRef: Object.values(args)[0] });
    const response = await tool.handle(args);
    let payload: { ok?: boolean; data?: unknown; policy?: unknown };
    try { payload = JSON.parse(response.text) as typeof payload; }
    catch { throw new Error(`${toolId}: malformed tool result`); }
    if (response.success === false || payload.ok === false || payload.data === undefined) {
      throw new Error(`POLICY_DENIED: ${toolId} rejected the invocation`);
    }
    await event("tool.completed", {
      toolId, latencyMs: performance.now() - toolStartedAt, ...toolTelemetry(payload.data),
    });
    return payload.data as TOutput;
  };

  try {
    const completed = await spec.procedure({ actor, selectedRef, contextRefs, callTool, event });
    const finalStatus = completed.result.status === "partial" ? "partial" : "completed";
    await repository.updateAttempt(actor, { attemptId, expectedStatus: "running", patch: { status: "succeeded", completedAt: Date.now() } });
    await repository.updateRun(actor, executionRunId, {
      status: finalStatus, resultSummary: completed.result.summary, completedAt: Date.now(),
    }, "running");
    await event("skill.completed", {
      skill: skillRefs[0], status: completed.result.status, totalLatencyMs: performance.now() - startedAt,
      inferenceCount: 0, costUsd: 0, ...completed.completionEvent,
    });
    await persist(completed.result, completed.contextRefs);
    return { conversationId: input.conversationId, interactionRunId, executionRunId, result: completed.result };
  } catch (error) {
    const result = failure(error, spec);
    const code = result.errors[0]?.code ?? "INTERNAL";
    await repository.updateAttempt(actor, { attemptId, expectedStatus: "running", patch: { status: "failed", errorCode: code, completedAt: Date.now() } });
    await repository.updateRun(actor, executionRunId, { status: "failed", errorCode: code, resultSummary: result.summary, completedAt: Date.now() }, "running");
    await event("skill.failed", { skill: skillRefs[0], errorCode: code, totalLatencyMs: performance.now() - startedAt });
    await persist(result);
    return { conversationId: input.conversationId, interactionRunId, executionRunId, result };
  }
}
