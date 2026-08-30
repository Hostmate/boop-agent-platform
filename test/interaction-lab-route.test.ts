import { describe, expect, it } from "vitest";
import { interactionLabReply, isInteractionActionAllowed } from "../server/hostmate/shadow/interaction-lab-route.js";
import type { ConversationProposal } from "../server/hostmate/shadow/boop-interaction-shadow.js";

function proposal(overrides: Partial<ConversationProposal> = {}): ConversationProposal {
  return {
    intent: "consultar un inmueble",
    domain: "property",
    action: "property.get_property.v1",
    candidateRefs: [],
    needsClarification: false,
    clarificationQuestion: "",
    delegationProposal: { kind: "none", target: "" },
    freshRead: "required",
    ...overrides,
  };
}

describe("Interaction Lab", () => {
  it("presents a captured proposal without claiming execution", () => {
    expect(interactionLabReply(proposal())).toBe(
      "He entendido que quieres consultar un inmueble. En este laboratorio no ejecutaré la acción.",
    );
  });

  it("uses the model's discriminating clarification", () => {
    expect(interactionLabReply(proposal({
      action: "needs_clarification",
      needsClarification: true,
      clarificationQuestion: "¿Te refieres al piso de tres o al de cuatro habitaciones?",
    }))).toBe("¿Te refieres al piso de tres o al de cuatro habitaciones?");
  });

  it("does not expose internal errors when no proposal is captured", () => {
    expect(interactionLabReply(null)).toBe(
      "No he podido interpretar este mensaje. Puedes probar a expresarlo de otra forma.",
    );
  });

  it("fails closed outside the production read-only action set", () => {
    const allowed = new Set(["crm.search_leads.v1"]);
    expect(isInteractionActionAllowed("crm.search_leads.v1", allowed)).toBe(true);
    expect(isInteractionActionAllowed("skill.prepare-lead-brief.v1", allowed)).toBe(false);
    expect(isInteractionActionAllowed("multi-agent.lead-opportunity-analysis.v1", allowed)).toBe(false);
    expect(isInteractionActionAllowed("visits.create_visit.v1", allowed)).toBe(false);
    expect(isInteractionActionAllowed("needs_clarification", allowed)).toBe(true);
  });
});
