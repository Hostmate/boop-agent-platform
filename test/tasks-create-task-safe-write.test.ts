import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createActorContext } from "../server/hostmate/contracts/actor-context.js";
import { hashConfirmationToken, hashDraftArguments, signWriteIntent, verifyWriteIntentSignature, type WriteIntentEnvelope } from "../server/hostmate/drafts/contracts.js";
import { ExecutionDispatchResolver } from "../server/hostmate/interaction/dispatch.js";
import { ExecutionProfileRegistry } from "../server/hostmate/profiles/registry.js";
import { classifyTaskWriteIntent, createTasksCreateTaskTool, tasksCreateTaskInputSchema, zonedDateTimeToUtc } from "../server/hostmate/product-tools/tasks/create-task.js";
import { SkillRegistry } from "../server/hostmate/skills/registry.js";
import { ProductToolRegistry } from "../server/hostmate/tools/registry.js";

const corpus = JSON.parse(readFileSync(new URL("../evals/safe-writes/tasks-create-task-v1.json", import.meta.url), "utf8")) as {
  count: number; referenceTime: string; timezone: string; inferencePaths: number; actions: string[];
  temporalCases: Array<{ phrase: string; dueDate: string; dueTime?: string; dueAtUtc?: string }>;
  negativeScenarios: Array<{ message: string; reason: string }>;
};
const now = new Date(corpus.referenceTime);
const actor = createActorContext({ tenantId: "15", userId: "42", role: "admin", isSuperAdmin: false, permissions: ["crm.read", "crm.write"], locale: "es-ES", timezone: "Europe/Madrid", sessionId: "refresh:test", permissionsVersion: "1", effectiveTenantOverride: false });

describe("tasks.create_task.v1 safe write contract", () => {
  it("passes a 130-scenario multilingual temporal corpus with zero inference", () => {
    let valid = 0;
    for (const action of corpus.actions) for (const temporal of corpus.temporalCases) {
      const result = classifyTaskWriteIntent({ message: `Crea una tarea para ${action} ${temporal.phrase}`, now, timezone: corpus.timezone });
      expect(result.kind, `${action} ${temporal.phrase}`).toBe("task");
      if (result.kind === "task") expect(result.candidate).toEqual({
        title: action.charAt(0).toLocaleUpperCase("es-ES") + action.slice(1), dueDate: temporal.dueDate,
        ...(temporal.dueTime ? { dueTime: temporal.dueTime, dueAtUtc: temporal.dueAtUtc } : {}),
        timezone: "Europe/Madrid", temporalPhrase: temporal.phrase, referenceTime: corpus.referenceTime, inference: 0,
      });
      valid += 1;
    }
    for (const scenario of corpus.negativeScenarios) {
      const result = classifyTaskWriteIntent({ message: scenario.message, now, timezone: corpus.timezone });
      expect(result, scenario.message).toEqual({ kind: "needs_input", reason: scenario.reason });
    }
    expect(valid + corpus.negativeScenarios.length).toBe(corpus.count);
    expect(corpus.inferencePaths).toBe(0);
  });

  it("resolves DST deterministically and rejects nonexistent local times", () => {
    expect(zonedDateTimeToUtc("2026-03-28", "10:00")).toBe("2026-03-28T09:00:00.000Z");
    expect(zonedDateTimeToUtc("2026-03-29", "02:30")).toBeUndefined();
    expect(zonedDateTimeToUtc("2026-10-26", "10:00")).toBe("2026-10-26T09:00:00.000Z");
  });

  it("recognizes the exact accented product phrase and preserves selected-target wording", () => {
    const result = classifyTaskWriteIntent({ message: "Créame una tarea para llamar a este lead mañana a las 10.", now, timezone: "Europe/Madrid" });
    expect(result.kind).toBe("task");
    if (result.kind === "task") expect(result.candidate).toMatchObject({ title: "Llamar al lead", dueDate: "2026-08-17", dueTime: "10:00", inference: 0 });
  });

  it("accepts only selected lead plus authority-free TaskCandidate", () => {
    const candidate = { title: "Llamar", dueDate: "2026-08-17", timezone: "Europe/Madrid", temporalPhrase: "mañana", referenceTime: corpus.referenceTime, inference: 0 } as const;
    expect(tasksCreateTaskInputSchema.safeParse({ lead: { type: "crm.lead", id: "123" }, candidate }).success).toBe(true);
    for (const injected of [{ assignedUserId: "99" }, { tenantId: "15" }, { status: "completed" }, { priority: "high" }, { autoConfirm: true }]) {
      expect(tasksCreateTaskInputSchema.safeParse({ lead: { type: "crm.lead", id: "123" }, candidate: { ...candidate, ...injected } }).success).toBe(false);
    }
  });

  it("signs every structured field and detects temporal or assignee tamper", () => {
    const structuredPayload = { title: "Llamar", dueDate: "2026-08-17", dueTime: "10:00", dueAtUtc: "2026-08-17T08:00:00.000Z", timezone: "Europe/Madrid", temporalPhrase: "mañana a las 10", referenceTime: corpus.referenceTime, inference: 0, assigneeUserId: "42", status: "pending", priority: "medium" } as const;
    const candidate = { title: structuredPayload.title, dueDate: structuredPayload.dueDate, dueTime: structuredPayload.dueTime, dueAtUtc: structuredPayload.dueAtUtc, timezone: structuredPayload.timezone, temporalPhrase: structuredPayload.temporalPhrase, referenceTime: structuredPayload.referenceTime, inference: 0 } as const;
    const envelope: WriteIntentEnvelope = {
      draftId: "123e4567-e89b-42d3-a456-426614174320", tenantId: "15", actorUserId: "42", sessionId: actor.sessionId, permissionsVersion: "1", effectiveTenantOverride: false,
      conversationId: "123e4567-e89b-42d3-a456-426614174321", sourceRunId: "123e4567-e89b-42d3-a456-426614174322", profileId: "crm", toolId: "tasks.create_task.v1", toolVersion: 1, toolScope: ["tasks.create_task.v1@1"],
      target: { type: "crm.lead", id: "123" }, operationType: "create", operation: "task.create", requestedValue: "Llamar", structuredPayload,
      preconditions: [{ kind: "lead.assigned_agent_id", expected: "43" }, { kind: "task.assignee_user_id", expected: "42" }, { kind: "task.due_at_utc", expected: structuredPayload.dueAtUtc }],
      argsHash: hashDraftArguments({ lead: { type: "crm.lead", id: "123" }, candidate }), idempotencyKey: "agent-write:123e4567-e89b-42d3-a456-426614174320", risk: "R1",
      policyDecisionId: "123e4567-e89b-42d3-a456-426614174323", expiresAt: Date.now() + 600_000, confirmationTokenHash: hashConfirmationToken("confirmation-token-with-enough-entropy"),
    };
    const secret = "safe-write-test-secret-at-least-thirty-two-bytes"; const intent = { envelope, signature: signWriteIntent(envelope, secret) };
    expect(verifyWriteIntentSignature(intent, secret)).toBe(true);
    expect(verifyWriteIntentSignature({ ...intent, envelope: { ...envelope, structuredPayload: { ...structuredPayload, assigneeUserId: "99" } } }, secret)).toBe(false);
    expect(verifyWriteIntentSignature({ ...intent, envelope: { ...envelope, structuredPayload: { ...structuredPayload, dueAtUtc: "2026-08-17T09:00:00.000Z" } } }, secret)).toBe(false);
  });

  it("dispatches a tasks-owned draft through the CRM task.manage profile", () => {
    const tool = createTasksCreateTaskTool({ port: { prepare: async (_actor, input) => ({ lead: { id: input.lead.id, name: "Fixture", assignedAgentId: "43" }, candidate: input.candidate, assignee: { userId: "42", name: "Admin" }, defaults: { status: "pending", priority: "medium", description: null } }), commit: async () => ({ outcome: "committed", idempotent: false }) } });
    const dispatch = new ExecutionDispatchResolver(new ExecutionProfileRegistry(), new ProductToolRegistry([tool]), new SkillRegistry()).resolve({
      actor, allowedToolIds: ["tasks.create_task.v1"], featureEnabled: () => true,
      request: { profileId: "crm", objective: "Crea una tarea", objectiveClasses: ["task.manage"], objectiveCapabilities: ["tasks.task.prepare"], inputRefs: [{ type: "crm.lead", id: "123" }], dependencyRunIds: [], internalSkillHints: [], constraints: { readOnly: false } },
    });
    expect(dispatch.toolResolution.tools[0]).toMatchObject({ toolId: "tasks.create_task.v1", ownerDomain: "tasks", mode: "draft", risk: "R1" });
  });
});
