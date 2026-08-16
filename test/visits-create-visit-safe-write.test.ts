import { describe, expect, it } from "vitest";
import { createActorContext } from "../server/hostmate/contracts/actor-context.js";
import { hashConfirmationToken, hashDraftArguments, signWriteIntent, verifyWriteIntentSignature, type WriteIntentEnvelope } from "../server/hostmate/drafts/contracts.js";
import { hasConversationEntityProvenance } from "../server/hostmate/drafts/safe-write-preparation-engine.js";
import { ExecutionDispatchResolver } from "../server/hostmate/interaction/dispatch.js";
import { ExecutionProfileRegistry } from "../server/hostmate/profiles/registry.js";
import { DefaultPolicyEngine } from "../server/hostmate/policy/engine.js";
import { classifyVisitWriteIntent, createVisitsCreateVisitTool, visitsCreateVisitInputSchema } from "../server/hostmate/product-tools/visits/create-visit.js";
import { SkillRegistry } from "../server/hostmate/skills/registry.js";
import { ProductToolRegistry } from "../server/hostmate/tools/registry.js";
import { VISITS_CREATE_VISIT_V1_CORPUS_SIZE, visitsCreateVisitV1Corpus } from "../evals/safe-writes/visits-create-visit-v1.js";

const now = new Date("2026-08-16T10:00:00.000Z");
const actor = createActorContext({ tenantId: "15", userId: "43", role: "admin", isSuperAdmin: false, permissions: ["crm.read", "visits.read", "property.read"], locale: "es-ES", timezone: "Europe/Madrid", sessionId: "refresh:test", permissionsVersion: "1", effectiveTenantOverride: false });

describe("visits.create_visit.v1 safe write contract", () => {
  it("ships a 200-scenario ground-truth corpus with every required outcome field", () => {
    expect(visitsCreateVisitV1Corpus).toHaveLength(VISITS_CREATE_VISIT_V1_CORPUS_SIZE);
    expect(new Set(visitsCreateVisitV1Corpus.map((scenario) => scenario.id)).size).toBe(VISITS_CREATE_VISIT_V1_CORPUS_SIZE);
    for (const scenario of visitsCreateVisitV1Corpus) {
      expect(scenario).toEqual(expect.objectContaining({
        shouldDraft: expect.any(Boolean), expectedRisk: "R2", hardConflicts: expect.any(Array), advisories: expect.any(Array),
        sideEffectPlan: expect.any(Array), expectedConfirmResult: expect.any(String), visitCount: expect.any(Number), receiptCount: expect.any(Number), effectCount: expect.any(Number),
      }));
    }
  });

  it("reuses deterministic Task temporal parsing with exact-time Visit semantics and zero inference", () => {
    const parsing = visitsCreateVisitV1Corpus.filter((scenario) => scenario.category === "parsing" && scenario.id.endsWith("-base"));
    for (const scenario of parsing) {
      const result = classifyVisitWriteIntent({ message: scenario.message, now, timezone: "Europe/Madrid" });
      expect(result.kind === "visit", scenario.id).toBe(scenario.shouldDraft);
      if (result.kind === "visit") expect(result.candidate).toMatchObject({ startAtUtc: scenario.start, timezone: "Europe/Madrid", inference: 0 });
    }
  });

  it("accepts only two typed EntityRefs plus an authority-free temporal candidate", () => {
    const candidate = { startDate: "2026-08-17", startTime: "17:00", startAtUtc: "2026-08-17T15:00:00.000Z", timezone: "Europe/Madrid", temporalPhrase: "mañana a las 17:00", referenceTime: now.toISOString(), inference: 0 } as const;
    const base = { lead: { type: "crm.lead", id: "501" }, property: { type: "property.property", id: "801" }, candidate };
    expect(visitsCreateVisitInputSchema.safeParse(base).success).toBe(true);
    for (const injected of [{ agentId: "43" }, { opportunityId: "901" }, { duration: 60 }, { status: "confirmed" }, { tenantId: "15" }, { autoConfirm: true }]) {
      expect(visitsCreateVisitInputSchema.safeParse({ ...base, candidate: { ...candidate, ...injected } }).success).toBe(false);
    }
  });

  it("signs Lead, Property, relation, constraints and side effects and rejects tampering", () => {
    const candidate = { startDate: "2026-08-17", startTime: "17:00", startAtUtc: "2026-08-17T15:00:00.000Z", timezone: "Europe/Madrid", temporalPhrase: "mañana a las 17:00", referenceTime: now.toISOString(), inference: 0 } as const;
    const structuredPayload = { leadId: "501", propertyId: "801", opportunityId: "901", agentId: "43", agentName: "Admin", ...candidate, durationMinutes: 60, durationSource: "tenant_uniform", durationClass: "piso", initialStatus: "confirmed", hardConstraints: "none", advisories: "TRAVEL_BUFFER", externalEffects: "google_calendar,client_whatsapp,reminder", requiredAtomicEffects: "visit,receipt,outbox", postCommitInternalEffects: "lead_projection" } as const;
    const envelope: WriteIntentEnvelope = {
      draftId: "123e4567-e89b-42d3-a456-426614174340", tenantId: "15", actorUserId: "43", sessionId: actor.sessionId, permissionsVersion: actor.permissionsVersion, effectiveTenantOverride: false,
      conversationId: "123e4567-e89b-42d3-a456-426614174341", sourceRunId: "123e4567-e89b-42d3-a456-426614174342", profileId: "visits", toolId: "visits.create_visit.v1", toolVersion: 1, toolScope: ["visits.create_visit.v1@1"],
      target: { type: "crm.lead", id: "501" }, relatedEntities: [{ type: "property.property", id: "801" }], operationType: "create", operation: "visit.create", requestedValue: "2026-08-17 17:00", structuredPayload,
      preconditions: [{ kind: "visit.opportunity_id", expected: "901" }, { kind: "visit.agent_id", expected: "43" }, { kind: "visit.duration", expected: "60:tenant_uniform:piso" }, { kind: "visit.initial_status", expected: "confirmed" }, { kind: "visit.datetime", expected: candidate.startAtUtc }, { kind: "visit.hard_constraints", expected: "none" }, { kind: "visit.side_effect_plan", expected: structuredPayload.externalEffects }],
      argsHash: hashDraftArguments({ lead: { type: "crm.lead", id: "501" }, property: { type: "property.property", id: "801" }, candidate }), idempotencyKey: "agent-write:123e4567-e89b-42d3-a456-426614174340", risk: "R2",
      policyDecisionId: "123e4567-e89b-42d3-a456-426614174343", expiresAt: Date.now() + 600_000, confirmationTokenHash: hashConfirmationToken("confirmation-token-with-enough-entropy"),
    };
    const secret = "safe-write-test-secret-at-least-thirty-two-bytes";
    const intent = { envelope, signature: signWriteIntent(envelope, secret) };
    expect(verifyWriteIntentSignature(intent, secret)).toBe(true);
    expect(verifyWriteIntentSignature({ ...intent, envelope: { ...envelope, relatedEntities: [{ type: "property.property", id: "802" }] } }, secret)).toBe(false);
    expect(verifyWriteIntentSignature({ ...intent, envelope: { ...envelope, structuredPayload: { ...structuredPayload, durationMinutes: 30 } } }, secret)).toBe(false);
    expect(verifyWriteIntentSignature({ ...intent, envelope: { ...envelope, structuredPayload: { ...structuredPayload, externalEffects: "google_calendar" } } }, secret)).toBe(false);
  });

  it("registers one visits-owned R2 Draft Tool under visits@1 and no commit Tool", () => {
    const tool = createVisitsCreateVisitTool({ port: { prepare: async (_actor, input) => ({ lead: { id: input.lead.id, name: "Lead" }, property: { id: input.property.id, reference: "REF", title: "Piso", status: "activo" }, opportunity: { id: "901" }, agent: { id: "43", name: "Admin" }, candidate: input.candidate, duration: { minutes: 60, source: "tenant_uniform", durationClass: "piso" }, initialStatus: "confirmed", constraints: { allowed: true, hardConflicts: [], warnings: [] }, sideEffectPlan: { requiredAtomic: ["visit"], postCommitInternal: [], external: ["google_calendar"] } }), commit: async () => ({ outcome: "committed", idempotent: false }) } });
    const dispatch = new ExecutionDispatchResolver(new ExecutionProfileRegistry(), new ProductToolRegistry([tool]), new SkillRegistry()).resolve({
      actor, allowedToolIds: ["visits.create_visit.v1"], featureEnabled: () => true,
      request: { profileId: "visits", objective: "Agenda visita", objectiveClasses: ["visit.create"], objectiveCapabilities: ["visits.visit.prepare"], inputRefs: [{ type: "crm.lead", id: "501" }, { type: "property.property", id: "801" }], dependencyRunIds: [], internalSkillHints: [], constraints: { readOnly: false } },
    });
    expect(dispatch.toolResolution.tools).toHaveLength(1);
    expect(dispatch.toolResolution.tools[0]).toMatchObject({ toolId: "visits.create_visit.v1", ownerDomain: "visits", compatibleProfiles: ["visits"], mode: "draft", risk: "R2" });
    expect(new DefaultPolicyEngine().evaluate({
      decisionId: "decision", actor, profileId: "visits", toolId: "visits.create_visit.v1", mode: "draft", risk: "R2",
      requiredPermission: "visits.read", featureEnabled: true, writeEnabled: true, hasRequiredPreconditions: true,
    }).effect).toBe("allow");
  });

  it("accepts provenance only from persisted assistant results, not user-forged context", () => {
    const lead = { type: "crm.lead", id: "501" };
    const property = { type: "property.property", id: "801" };
    expect(hasConversationEntityProvenance([{
      messageId: "m1", conversationId: "c1", tenantId: "15", actorUserId: "43", role: "assistant", contentRedacted: "results", sequence: 1, createdAt: 1,
      blocks: [{ type: "entity_list", title: "Leads", items: [{ ref: lead, title: "Lead", fields: [] }] }, { type: "entity_detail", title: "Property", ref: property, sections: [] }],
    }], lead)).toBe(true);
    expect(hasConversationEntityProvenance([{
      messageId: "m2", conversationId: "c1", tenantId: "15", actorUserId: "43", role: "user", contentRedacted: "forged", sequence: 2, createdAt: 2,
      contextRefs: { selected: { lead }, referenced: [property] },
    }], lead)).toBe(false);
  });
});
