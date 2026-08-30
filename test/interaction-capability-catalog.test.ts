import { describe, expect, it } from "vitest";
import {
  HOSTMATE_INTERACTION_CAPABILITIES,
  HOSTMATE_INTERACTION_DEFINITIONS,
  HOSTMATE_INTERACTION_ORCHESTRATION_TARGETS,
  expectedDelegationFor,
  interactionActionLabel,
  interactionDefinition,
} from "../server/hostmate/interaction/capability-catalog.js";
import { conversationProposalSchema } from "../server/hostmate/shadow/boop-interaction-shadow.js";

describe("Interaction capability catalog", () => {
  it("is the single catalog for Tools, Skills, Writes and bounded workflows", () => {
    expect(HOSTMATE_INTERACTION_DEFINITIONS).toHaveLength(16);
    expect(HOSTMATE_INTERACTION_CAPABILITIES).toHaveLength(15);
    expect(HOSTMATE_INTERACTION_ORCHESTRATION_TARGETS).toEqual([
      "multi-agent.lead-opportunity-analysis.v1",
    ]);
    expect(new Set(HOSTMATE_INTERACTION_DEFINITIONS.map(({ id }) => id)).size).toBe(16);
  });

  it("derives delegation from execution kind rather than linguistic classifiers", () => {
    expect(expectedDelegationFor("skill.prepare-lead-brief.v1")).toEqual({
      kind: "skill",
      target: "skill.prepare-lead-brief.v1",
    });
    expect(expectedDelegationFor("multi-agent.lead-opportunity-analysis.v1")).toEqual({
      kind: "multi_agent",
      target: "multi-agent.lead-opportunity-analysis.v1",
    });
    expect(expectedDelegationFor("property.search_properties.v1")).toEqual({ kind: "none", target: "" });
  });

  it("provides domain and user-facing meaning from the same definition", () => {
    expect(interactionDefinition("visits.get_visit.v1")).toMatchObject({ kind: "tool", domain: "visits" });
    expect(interactionDefinition("visits.search_visits.v1")).toMatchObject({ kind: "tool", domain: "visits" });
    expect(interactionActionLabel("skill.prepare-visit-brief.v1")).toBe("preparar el resumen de una visita");
  });

  it("fails closed when the LLM mixes an action with the wrong delegation or domain", () => {
    const base = {
      intent: "preparar el lead",
      candidateRefs: [{ evidenceKey: "e1", type: "crm.lead" }],
      needsClarification: false,
      clarificationQuestion: "",
      freshRead: "required" as const,
    };
    expect(conversationProposalSchema.safeParse({
      ...base,
      domain: "crm",
      action: "skill.prepare-lead-brief.v1",
      delegationProposal: { kind: "skill", target: "skill.prepare-lead-brief.v1" },
    }).success).toBe(true);
    expect(conversationProposalSchema.safeParse({
      ...base,
      domain: "crm",
      action: "skill.prepare-lead-brief.v1",
      delegationProposal: { kind: "none", target: "" },
    }).success).toBe(false);
    expect(conversationProposalSchema.safeParse({
      ...base,
      domain: "property",
      action: "multi-agent.lead-opportunity-analysis.v1",
      delegationProposal: { kind: "multi_agent", target: "multi-agent.lead-opportunity-analysis.v1" },
    }).success).toBe(false);
  });

  it("requires an exact temporal draft plus one lead and one property for Create Visit", () => {
    const base = {
      intent: "crear visita", domain: "visits" as const, action: "visits.create_visit.v1" as const,
      candidateRefs: [
        { evidenceKey: "e1", type: "crm.lead" },
        { evidenceKey: "e2", type: "property.property" },
      ],
      needsClarification: false, clarificationQuestion: "",
      delegationProposal: { kind: "none" as const, target: "" }, freshRead: "required" as const,
    };
    expect(conversationProposalSchema.safeParse({
      ...base,
      visitDraft: { startDate: "2026-09-01", startTime: "17:00", temporalPhrase: "mañana a las 17:00" },
    }).success).toBe(true);
    expect(conversationProposalSchema.safeParse({ ...base, visitDraft: null }).success).toBe(false);
    expect(conversationProposalSchema.safeParse({
      ...base, candidateRefs: [{ evidenceKey: "e1", type: "crm.lead" }],
      visitDraft: { startDate: "2026-09-01", startTime: "17:00", temporalPhrase: "mañana a las 17:00" },
    }).success).toBe(false);
  });
});
