import { describe, expect, it } from "vitest";
import {
  interactionLabProposalFailure,
  interactionLabReply,
  isInteractionActionAllowed,
} from "../server/hostmate/shadow/interaction-lab-route.js";
import { InteractionLabHostmateConnection } from "../server/hostmate/shadow/interaction-lab-hostmate.js";
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

  it("surfaces an invalid model proposal as safe JSON instead of a proxy 502", () => {
    expect(interactionLabProposalFailure("INVALID_TOOL_CALL")).toEqual({
      status: 422,
      error: "LAB_PROPOSAL_INVALID",
      message: "No he podido interpretar esta petición con suficiente seguridad. Prueba a expresarla de otra forma.",
    });
    expect(interactionLabProposalFailure("PROVIDER_UNAVAILABLE").status).toBe(502);
  });

  it("fails closed outside the production read-only action set", () => {
    const allowed = new Set(["crm.search_leads.v1"]);
    expect(isInteractionActionAllowed("crm.search_leads.v1", allowed)).toBe(true);
    expect(isInteractionActionAllowed("skill.prepare-lead-brief.v1", allowed)).toBe(false);
    expect(isInteractionActionAllowed("multi-agent.lead-opportunity-analysis.v1", allowed)).toBe(false);
    expect(isInteractionActionAllowed("visits.create_visit.v1", allowed)).toBe(false);
    expect(isInteractionActionAllowed("needs_clarification", allowed)).toBe(true);
  });

  it("binds each runtime connection to the authenticated request actor", () => {
    const connection = new InteractionLabHostmateConnection({
      accessToken: "opaque-session-token",
      tenantId: "12",
      userId: "48",
      role: "agent",
      sessionId: "session-fingerprint",
    });

    expect(connection.status()).toEqual({
      connected: true,
      tenantId: "12",
      tenantName: undefined,
      userId: "48",
      role: "agent",
      mode: "read_only",
    });
  });
});
