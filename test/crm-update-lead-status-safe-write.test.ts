import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createActorContext } from "../server/hostmate/contracts/actor-context.js";
import {
  hashConfirmationToken, hashDraftArguments, signWriteIntent, verifyWriteIntentConfirmationToken,
  verifyWriteIntentSignature, type SignedWriteIntent, type WriteIntentEnvelope,
} from "../server/hostmate/drafts/contracts.js";
import { DefaultPolicyEngine } from "../server/hostmate/policy/engine.js";
import {
  classifyLeadStatusWriteIntent, crmUpdateLeadStatusInputSchema,
} from "../server/hostmate/product-tools/crm/update-lead-status.js";

const actor = createActorContext({
  tenantId: "15", userId: "43", role: "agent", isSuperAdmin: false,
  permissions: ["crm.read", "crm.write"], locale: "es-ES", timezone: "Europe/Madrid",
  sessionId: "refresh:test", permissionsVersion: "1", effectiveTenantOverride: false,
});

function signed(): { intent: SignedWriteIntent; token: string } {
  const token = "confirmation-token-with-enough-entropy";
  const envelope: WriteIntentEnvelope = {
    draftId: "123e4567-e89b-42d3-a456-426614174300", tenantId: "15", actorUserId: "43",
    sessionId: actor.sessionId, permissionsVersion: actor.permissionsVersion, effectiveTenantOverride: false,
    conversationId: "123e4567-e89b-42d3-a456-426614174301", sourceRunId: "123e4567-e89b-42d3-a456-426614174302",
    profileId: "crm", toolId: "crm.update_lead_status.v1", toolVersion: 1, toolScope: ["crm.update_lead_status.v1@1"],
    target: { type: "crm.lead", id: "123", label: "Fixture" }, operation: "lead.status.set", requestedValue: "qualified",
    preconditions: [{ kind: "lead.status", expected: "contacted" }, { kind: "lead.assigned_agent_id", expected: "43" }],
    argsHash: hashDraftArguments({ lead: { type: "crm.lead", id: "123" }, requestedStatus: "qualified" }),
    idempotencyKey: "agent-write:123e4567-e89b-42d3-a456-426614174300", risk: "R1",
    policyDecisionId: "123e4567-e89b-42d3-a456-426614174303", expiresAt: Date.now() + 600_000,
    confirmationTokenHash: hashConfirmationToken(token),
  };
  const secret = "safe-write-test-secret-at-least-thirty-two-bytes";
  return { intent: { envelope, signature: signWriteIntent(envelope, secret) }, token };
}

describe("crm.update_lead_status.v1 safe write contract", () => {
  it("passes the versioned 80-scenario intent and draft-precision corpus", () => {
    const corpus = JSON.parse(readFileSync(new URL("../evals/safe-writes/crm-update-lead-status-v1.json", import.meta.url), "utf8")) as {
      count: number; scenarios: Array<{ message: string; selectedLead: boolean; expectedKind: string; expectedStatus?: string; draftExpected: boolean }>;
    };
    expect(corpus.count).toBe(80);
    let predictedDrafts = 0;
    let correctDrafts = 0;
    for (const scenario of corpus.scenarios) {
      const classification = classifyLeadStatusWriteIntent(scenario.message);
      expect(classification.kind, scenario.message).toBe(scenario.expectedKind);
      if (classification.kind === "status" && scenario.expectedStatus) expect(classification.status, scenario.message).toBe(scenario.expectedStatus);
      const predictsDraft = classification.kind === "status" && scenario.selectedLead;
      if (predictsDraft) predictedDrafts += 1;
      if (predictsDraft && scenario.draftExpected) correctDrafts += 1;
      expect(predictsDraft, scenario.message).toBe(scenario.draftExpected);
    }
    expect(correctDrafts / predictedDrafts).toBe(1);
  });

  it("accepts only a selected EntityRef and canonical status", () => {
    expect(crmUpdateLeadStatusInputSchema.parse({ lead: { type: "crm.lead", id: "123" }, requestedStatus: "qualified" })).toEqual({ lead: { type: "crm.lead", id: "123" }, requestedStatus: "qualified" });
    for (const invalid of [
      { lead: "123", requestedStatus: "qualified" },
      { lead: { type: "crm.lead", id: "123" }, requestedStatus: "won" },
      { lead: { type: "crm.lead", id: "123" }, requestedStatus: "qualified", tenantId: "1" },
      { lead: { type: "crm.lead", id: "123", userId: "9" }, requestedStatus: "qualified" },
      { lead: { type: "crm.lead", id: "123" }, requestedStatus: "qualified", force: true },
    ]) expect(crmUpdateLeadStatusInputSchema.safeParse(invalid).success).toBe(false);
  });

  it("binds signature and confirmation token to every immutable authority field", () => {
    const { intent, token } = signed();
    const secret = "safe-write-test-secret-at-least-thirty-two-bytes";
    expect(verifyWriteIntentSignature(intent, secret)).toBe(true);
    expect(verifyWriteIntentConfirmationToken(intent, token)).toBe(true);
    expect(verifyWriteIntentConfirmationToken(intent, `${token}-tampered`)).toBe(false);
    expect(verifyWriteIntentSignature({ ...intent, envelope: { ...intent.envelope, actorUserId: "44" } }, secret)).toBe(false);
    expect(verifyWriteIntentSignature({ ...intent, envelope: { ...intent.envelope, requestedValue: "new" } }, secret)).toBe(false);
    expect(verifyWriteIntentSignature({ ...intent, envelope: { ...intent.envelope, expiresAt: intent.envelope.expiresAt + 1 } }, secret)).toBe(false);
  });

  it("allows non-mutating draft preparation but gates every write behind confirmation", () => {
    const policy = new DefaultPolicyEngine();
    const base = { decisionId: "decision", actor, profileId: "crm" as const, toolId: "crm.update_lead_status.v1", risk: "R1" as const, requiredPermission: "crm.write", featureEnabled: true, writeEnabled: true, hasRequiredPreconditions: true };
    expect(policy.evaluate({ ...base, mode: "draft" }).effect).toBe("allow");
    expect(policy.evaluate({ ...base, mode: "write" }).effect).toBe("require_confirmation");
    expect(policy.evaluate({ ...base, mode: "write", confirmedDraftId: "draft" }).effect).toBe("allow");
  });
});
