import { describe, expect, it, vi } from "vitest";
import { createActorContext } from "../server/hostmate/contracts/actor-context.js";
import { ExecutionDispatchResolver } from "../server/hostmate/interaction/dispatch.js";
import { ExecutionProfileRegistry } from "../server/hostmate/profiles/registry.js";
import { DefaultPolicyEngine } from "../server/hostmate/policy/engine.js";
import { classifyVisitRescheduleIntent, createVisitsRescheduleVisitTool, visitsRescheduleVisitInputSchema } from "../server/hostmate/product-tools/visits/reschedule-visit.js";
import { SkillRegistry } from "../server/hostmate/skills/registry.js";
import { ProductToolRegistry } from "../server/hostmate/tools/registry.js";
import { VisitsRescheduleVisitVerticalSlice } from "../server/hostmate/vertical-slices/visits-reschedule-visit.js";
import { VISITS_RESCHEDULE_VISIT_V1_CORPUS_SIZE, visitsRescheduleVisitV1Corpus } from "../evals/safe-writes/visits-reschedule-visit-v1.js";

const now = new Date("2026-08-16T10:00:00.000Z");
const actor = createActorContext({ tenantId: "15", userId: "43", role: "admin", isSuperAdmin: false, permissions: ["visits.read"], locale: "es-ES", timezone: "Europe/Madrid", sessionId: "refresh:test", permissionsVersion: "1", effectiveTenantOverride: false });

describe("visits.reschedule_visit.v1 safe write contract", () => {
  it("executes the 200-case deterministic corpus with 0 inference", () => {
    expect(visitsRescheduleVisitV1Corpus).toHaveLength(VISITS_RESCHEDULE_VISIT_V1_CORPUS_SIZE);
    expect(new Set(visitsRescheduleVisitV1Corpus.map((item) => item.id)).size).toBe(VISITS_RESCHEDULE_VISIT_V1_CORPUS_SIZE);
    for (const item of visitsRescheduleVisitV1Corpus) {
      const classified = classifyVisitRescheduleIntent({ message: item.message, now, timezone: "Europe/Madrid" });
      expect(classified.kind, item.id).toBe(item.expectedIntent);
      if (classified.kind === "needs_input" && item.expectedReason) expect(classified.reason, item.id).toBe(item.expectedReason);
      if (classified.kind === "reschedule") expect(classified.candidate.inference, item.id).toBe(0);
    }
  });

  it("accepts only an individual Visit ref plus temporal-only candidate", () => {
    const candidate = { startDate: "2026-08-17", startTime: "19:00", startAtUtc: "2026-08-17T17:00:00.000Z", timezone: "Europe/Madrid", temporalPhrase: "mañana a las 19:00", referenceTime: now.toISOString(), inference: 0 };
    expect(visitsRescheduleVisitInputSchema.safeParse({ visit: { type: "visits.visit", id: "91" }, candidate }).success).toBe(true);
    expect(visitsRescheduleVisitInputSchema.safeParse({ visit: { type: "visits.group_visit", id: "91" }, candidate }).success).toBe(false);
    expect(visitsRescheduleVisitInputSchema.safeParse({ visit: { type: "visits.visit", id: "91" }, candidate: { ...candidate, agentId: "43" } }).success).toBe(false);
  });

  it("registers one visits-owned R2 Draft Tool and allows Admin policy", () => {
    const candidate = { startDate: "2026-08-17", startTime: "19:00", startAtUtc: "2026-08-17T17:00:00.000Z", timezone: "Europe/Madrid" as const, temporalPhrase: "mañana a las 19:00", referenceTime: now.toISOString(), inference: 0 as const };
    const tool = createVisitsRescheduleVisitTool({ port: { prepare: async () => ({
      visit: { id: 91, status: "confirmed", generation: "2", oldDatetime: "2026-08-17T15:00:00.000Z", newDatetime: "2026-08-17T19:00:00.000Z", oldDurationMinutes: 60 },
      lead: { id: 501, name: "Lead", phone: "+34000000000" }, property: { id: 801, reference: "REF", title: "Piso" }, opportunity: { id: 901 }, agent: { id: 43, name: "Admin" }, candidate,
      duration: { durationMinutes: 60, source: "tenant_uniform", durationClass: "piso" }, slots: { oldSlotId: 11, newSlotId: 12 }, scheduleLocks: ["15:43:2026-08-17"],
      constraints: { allowed: true, hardConflicts: [], warnings: [] }, reminder: { present: true, generation: "2", scheduledAt: "2026-08-16T17:00:00.000Z", tokenPresent: true }, calendar: { eventId: "g1", connected: true },
      sideEffectPlan: { requiredAtomic: ["visit.update"], external: ["google_calendar_reschedule"] }, nextGeneration: "3", materialFingerprint: "a".repeat(64),
    }), commit: async () => ({ outcome: "committed", idempotent: false }) } });
    const dispatch = new ExecutionDispatchResolver(new ExecutionProfileRegistry(), new ProductToolRegistry([tool]), new SkillRegistry()).resolve({
      actor, allowedToolIds: ["visits.reschedule_visit.v1"], featureEnabled: () => true,
      request: { profileId: "visits", objective: "Reprogramar visita", objectiveClasses: ["visit.update"], objectiveCapabilities: ["visits.visit.reschedule.prepare"], inputRefs: [{ type: "visits.visit", id: "91" }], dependencyRunIds: [], constraints: { readOnly: false } },
    });
    expect(dispatch.toolResolution.tools[0]).toMatchObject({ toolId: "visits.reschedule_visit.v1", ownerDomain: "visits", mode: "draft", risk: "R2" });
    expect(new DefaultPolicyEngine().evaluate({ decisionId: "d", actor, profileId: "visits", toolId: "visits.reschedule_visit.v1", mode: "draft", risk: "R2", requiredPermission: "visits.read", featureEnabled: true, writeEnabled: true, hasRequiredPreconditions: true }).effect).toBe("allow");
  });

  it("denies Agent before Prepare", async () => {
    const agent = createActorContext({ ...actor, role: "agent", isSuperAdmin: false });
    const visit = { type: "visits.visit" as const, id: "91", label: "Visita fixture" };
    const repository = {
      listMessages: async () => [{ messageId: "m1", conversationId: "123e4567-e89b-42d3-a456-426614174399", tenantId: "15", actorUserId: "43", role: "assistant", contentRedacted: "fixture", contextRefs: { selected: { visit }, referenced: [visit] }, sequence: 1, createdAt: Date.now() }],
      appendMessage: async (_actor: unknown, input: unknown) => input, createRun: async (_actor: unknown, input: unknown) => ({ ...(input as object), status: "queued" }), updateRun: async (_actor: unknown, _id: string, patch: unknown) => patch,
    } as any;
    const prepare = vi.fn();
    const slice = new VisitsRescheduleVisitVerticalSlice(repository, { prepare, commit: vi.fn() }, { enabled: true, allowedTenantIds: ["15"], allowedUserIds: ["43"], signingSecret: "reschedule-test-signing-secret-32-bytes" });
    const result = await slice.execute(agent, { conversationId: "123e4567-e89b-42d3-a456-426614174399", message: "Mueve esta visita a mañana a las 19:00", selectedEntityRef: visit, candidate: { startDate: "2026-08-17", startTime: "19:00", startAtUtc: "2026-08-17T17:00:00.000Z", timezone: "Europe/Madrid", temporalPhrase: "mañana a las 19:00", referenceTime: now.toISOString(), inference: 0 } });
    expect(result.result.status).toBe("permission_denied"); expect(prepare).not.toHaveBeenCalled();
  });
});
