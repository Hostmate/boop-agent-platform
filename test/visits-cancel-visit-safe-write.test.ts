import { describe, expect, it, vi } from "vitest";
import { createActorContext } from "../server/hostmate/contracts/actor-context.js";
import { ExecutionDispatchResolver } from "../server/hostmate/interaction/dispatch.js";
import { ExecutionProfileRegistry } from "../server/hostmate/profiles/registry.js";
import { DefaultPolicyEngine } from "../server/hostmate/policy/engine.js";
import { classifyVisitCancelIntent, createVisitsCancelVisitTool, visitsCancelVisitInputSchema } from "../server/hostmate/product-tools/visits/cancel-visit.js";
import { SkillRegistry } from "../server/hostmate/skills/registry.js";
import { ProductToolRegistry } from "../server/hostmate/tools/registry.js";
import { VisitsCancelVisitVerticalSlice } from "../server/hostmate/vertical-slices/visits-cancel-visit.js";
import { VISITS_CANCEL_VISIT_V1_CORPUS_SIZE, visitsCancelVisitV1Corpus } from "../evals/safe-writes/visits-cancel-visit-v1.js";

const actor = createActorContext({ tenantId: "15", userId: "43", role: "admin", isSuperAdmin: false, permissions: ["visits.read"], locale: "es-ES", timezone: "Europe/Madrid", sessionId: "refresh:test", permissionsVersion: "1", effectiveTenantOverride: false });

describe("visits.cancel_visit.v1 safe write contract", () => {
  it("executes a 160-scenario corpus with complete expected outcomes", () => {
    expect(visitsCancelVisitV1Corpus).toHaveLength(VISITS_CANCEL_VISIT_V1_CORPUS_SIZE);
    expect(new Set(visitsCancelVisitV1Corpus.map((scenario) => scenario.id)).size).toBe(VISITS_CANCEL_VISIT_V1_CORPUS_SIZE);
    for (const scenario of visitsCancelVisitV1Corpus) {
      expect(scenario).toEqual(expect.objectContaining({ expectedRisk: "R2", targetStatus: "cancelled_by_agent", effectiveCancellations: expect.any(Number), events: expect.any(Number), notifications: expect.any(Number) }));
      if (scenario.category === "parsing") expect(classifyVisitCancelIntent(scenario.message).kind, scenario.id).toBe(scenario.expectedIntent);
    }
  });

  it("accepts only a provenanced individual Visit EntityRef", () => {
    expect(visitsCancelVisitInputSchema.safeParse({ visit: { type: "visits.visit", id: "91" } }).success).toBe(true);
    for (const value of [
      { visit: { type: "visits.group_visit", id: "91" } }, { visit: { type: "visits.visit", id: "0" } },
      { visit: { type: "visits.visit", id: "91", tenantId: "15" } }, { visit: { type: "visits.visit", id: "91" }, reason: "free text" },
    ]) expect(visitsCancelVisitInputSchema.safeParse(value).success).toBe(false);
  });

  it("registers exactly one visits-owned R2 Draft Tool", async () => {
    const tool = createVisitsCancelVisitTool({ port: {
      prepare: async () => ({ visit: { id: 91, status: "confirmed", datetime: "2026-08-20T10:00:00.000Z", durationMinutes: 60, generation: "0" }, lead: { id: 501, name: "Lead" }, property: { id: 801, reference: "REF", title: "Piso" }, opportunity: { id: 901 }, agent: { id: 43 }, targetStatus: "cancelled_by_agent", reasonCode: null, noOp: false, materialFingerprint: "a".repeat(64), sideEffectPlan: { requiredAtomic: ["visit.status"], postCommitInternal: ["reminder.disable"], external: ["google_calendar_cancel"] } }),
      commit: async () => ({ outcome: "committed", idempotent: false }),
    } });
    const dispatch = new ExecutionDispatchResolver(new ExecutionProfileRegistry(), new ProductToolRegistry([tool]), new SkillRegistry()).resolve({
      actor, allowedToolIds: ["visits.cancel_visit.v1"], featureEnabled: () => true,
      request: { profileId: "visits", objective: "Cancelar visita", objectiveClasses: ["visit.update"], objectiveCapabilities: ["visits.visit.cancel.prepare"], inputRefs: [{ type: "visits.visit", id: "91" }], dependencyRunIds: [], constraints: { readOnly: false } },
    });
    expect(dispatch.toolResolution.tools).toHaveLength(1);
    expect(dispatch.toolResolution.tools[0]).toMatchObject({ toolId: "visits.cancel_visit.v1", ownerDomain: "visits", mode: "draft", risk: "R2" });
    expect(new DefaultPolicyEngine().evaluate({ decisionId: "d", actor, profileId: "visits", toolId: "visits.cancel_visit.v1", mode: "draft", risk: "R2", requiredPermission: "visits.read", featureEnabled: true, writeEnabled: true, hasRequiredPreconditions: true }).effect).toBe("allow");
  });

  it("denies Agent at the actual Safe Write slice boundary before Prepare", async () => {
    const agent = createActorContext({ ...actor, role: "agent", isSuperAdmin: false });
    const visit = { type: "visits.visit" as const, id: "91", label: "Visita fixture" };
    const repository = {
      listMessages: async () => [{ messageId: "m1", conversationId: "123e4567-e89b-42d3-a456-426614174399", tenantId: "15", actorUserId: "43", role: "assistant", contentRedacted: "fixture", contextRefs: { selected: { visit }, referenced: [visit] }, sequence: 1, createdAt: Date.now() }],
      appendMessage: async (_actor: unknown, input: unknown) => input,
      createRun: async (_actor: unknown, input: unknown) => ({ ...(input as object), status: "queued" }),
      updateRun: async (_actor: unknown, _id: string, patch: unknown) => patch,
    } as any;
    const prepare = vi.fn();
    const slice = new VisitsCancelVisitVerticalSlice(repository, { prepare, commit: vi.fn() }, {
      enabled: true, allowedTenantIds: ["15"], allowedUserIds: ["43"], signingSecret: "cancel-test-signing-secret-at-least-32-bytes",
    });
    const turn = await slice.execute(agent, { conversationId: "123e4567-e89b-42d3-a456-426614174399", message: "Cancela esta visita", selectedEntityRef: visit });
    expect(turn.result.status).toBe("permission_denied");
    expect(prepare).not.toHaveBeenCalled();
  });
});
