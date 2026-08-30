import { describe, expect, it, vi } from "vitest";
import {
  buildInteractionPrompt,
  INTERACTION_SYSTEM,
} from "../server/interaction-agent.js";
import {
  BOOP_INTERACTION_SHADOW_CONTRACT,
  BOOP_INTERACTION_SHADOW_CONTRACT_VERSION,
  conversationDecisionSchema,
  conversationProposalSchema,
  enrichConversationProposal,
  runBoopInteractionShadow,
  runBoopInteractionShadowFromMessages,
  type ShadowEvidence,
} from "../server/hostmate/shadow/boop-interaction-shadow.js";
import { OpenRouterAdapter } from "../server/hostmate/runtime/openrouter-adapter.js";

function sse(events: unknown[]): Response {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function readyWire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    intent: "consultar contexto",
    outcome: "ready",
    action: "crm.get_lead_context.v1",
    candidateRefs: [],
    missingInputs: [],
    clarificationQuestion: "",
    targetSearch: null,
    visitDraft: null,
    ...overrides,
  };
}

const evidence: ShadowEvidence = {
  currentSelection: {
    lead: { evidenceKey: "e1", type: "crm.lead", label: "Lead A", source: "selected" },
  },
  referencedEntities: [],
  recentResultEvidence: [],
  conversationHistory: [{ role: "user", content: "Lead A" }],
  emittedEntityRefs: [],
  candidateRefs: [
    { evidenceKey: "e1", type: "crm.lead", label: "Lead A", source: "selected" },
  ],
  orderedContext: {
    recentResultSets: [{ recency: 1, type: "entity_list", sequence: 1, items: [{ position: 1, evidenceKey: "e1", type: "crm.lead", label: "Lead A" }] }],
    recentFocusedEntities: [],
  },
  captureStatus: { referenced: "captured", blocks: "captured", prompt: "captured" },
};

describe("Boop Interaction Pareto shadow", () => {
  it("keeps unavailable task reads explicit in the proposal contract", () => {
    expect(BOOP_INTERACTION_SHADOW_CONTRACT).toContain("no task-read action exists");
    expect(BOOP_INTERACTION_SHADOW_CONTRACT).toContain('"¿Qué tareas pendientes tengo?" -> outcome=unsupported');
  });

  it("keeps the proposal contract compact, canonical and example-guided", () => {
    expect(BOOP_INTERACTION_SHADOW_CONTRACT_VERSION).toBe(11);
    expect(BOOP_INTERACTION_SHADOW_CONTRACT).toContain("GUIDE EXAMPLES");
    expect(BOOP_INTERACTION_SHADOW_CONTRACT).toContain("never repeat the active property");
    expect(BOOP_INTERACTION_SHADOW_CONTRACT).toContain("If several share it, clarify");
    expect(BOOP_INTERACTION_SHADOW_CONTRACT).toContain("If the message is Spanish, write them in Spanish");
    expect(BOOP_INTERACTION_SHADOW_CONTRACT).toContain("skill.prepare-lead-brief.v1");
    expect(BOOP_INTERACTION_SHADOW_CONTRACT).toContain("multi-agent.lead-opportunity-analysis.v1");
    expect(BOOP_INTERACTION_SHADOW_CONTRACT).toContain("Hostmate derives domain, delegation and fresh-read policy");
    expect(BOOP_INTERACTION_SHADOW_CONTRACT).toContain("exactly one item: the primary entity");
    expect(BOOP_INTERACTION_SHADOW_CONTRACT).toContain("Cliente Ejemplo is the Lead");
    expect(BOOP_INTERACTION_SHADOW_CONTRACT).toContain("outcome is the single readiness switch");
    expect(BOOP_INTERACTION_SHADOW_CONTRACT).toContain("never reuse an older selected Property");
    expect(BOOP_INTERACTION_SHADOW_CONTRACT).toContain('["property"]');
    expect(BOOP_INTERACTION_SHADOW_CONTRACT).toContain("targetSearch");
    expect(BOOP_INTERACTION_SHADOW_CONTRACT).not.toContain("visitTargetSearch");
    expect(BOOP_INTERACTION_SHADOW_CONTRACT).not.toContain("propertyTargetSearch");
    expect(BOOP_INTERACTION_SHADOW_CONTRACT.length).toBeLessThan(6_000);
  });

  it("keeps the LLM decision minimal and derives canonical catalog metadata", () => {
    const decision = conversationDecisionSchema.parse({
      intent: "Get current lead context",
      outcome: "ready",
      action: "crm.get_lead_context.v1",
      candidateRefs: [{ evidenceKey: "e1", type: "crm.lead" }],
      missingInputs: [],
      clarificationQuestion: "",
      targetSearch: null,
      visitDraft: null,
    });
    expect(enrichConversationProposal(decision)).toMatchObject({
      domain: "crm",
      action: "crm.get_lead_context.v1",
      delegationProposal: { kind: "none", target: "" },
      freshRead: "required",
    });
    expect(conversationDecisionSchema.safeParse({
      intent: "Get current lead context",
      outcome: "ready",
      action: "get_lead_context",
      candidateRefs: [{ evidenceKey: "e1", type: "crm.lead" }],
      missingInputs: [],
      clarificationQuestion: "",
      targetSearch: null,
      visitDraft: null,
    }).success).toBe(false);
    expect(conversationDecisionSchema.safeParse({ ...decision, domain: "crm" }).success).toBe(false);
  });

  it("canonicalizes a provider-emitted empty target-search object", () => {
    const decision = conversationDecisionSchema.parse(readyWire({
      action: "property.get_property.v1",
      candidateRefs: [{ evidenceKey: "e1", type: "property.property" }],
      targetSearch: { leadQuery: null, propertyQuery: null },
      visitDraft: { startDate: null, startTime: null, temporalPhrase: "" },
    }));

    expect(enrichConversationProposal(decision)).toMatchObject({
      action: "property.get_property.v1",
      propertyTargetSearch: null,
      visitTargetSearch: null,
    });
    expect(conversationDecisionSchema.safeParse(readyWire({
      action: "property.get_property.v1",
      visitDraft: { startDate: "2026-09-01", startTime: "10:00", temporalPhrase: "mañana a las 10:00" },
    })).success).toBe(false);
  });

  it("maps one target-search block to the existing downstream proposal", () => {
    const createVisit = enrichConversationProposal(conversationDecisionSchema.parse({
      intent: "crear visita",
      outcome: "ready",
      action: "visits.create_visit.v1",
      candidateRefs: [],
      missingInputs: [],
      clarificationQuestion: "",
      targetSearch: { leadQuery: "Cliente Ejemplo", propertyQuery: "calle de Loreto" },
      visitDraft: { startDate: "2026-09-01", startTime: "10:00", temporalPhrase: "mañana a las 10:00" },
    }));
    expect(createVisit).toMatchObject({
      domain: "visits",
      visitTargetSearch: { leadQuery: "Cliente Ejemplo", propertyQuery: "calle de Loreto" },
      propertyTargetSearch: null,
    });

    const propertySearch = enrichConversationProposal(conversationDecisionSchema.parse({
      intent: "consultar Bonavista",
      outcome: "ready",
      action: "property.search_properties.v1",
      candidateRefs: [],
      missingInputs: [],
      clarificationQuestion: "",
      targetSearch: { leadQuery: null, propertyQuery: "Bonavista" },
      visitDraft: null,
    }));
    expect(propertySearch).toMatchObject({
      domain: "property",
      visitTargetSearch: null,
      propertyTargetSearch: { query: "Bonavista" },
    });
  });

  it("uses one explicit needs_input outcome and rejects an incomplete ready Visit", () => {
    const clarification = conversationDecisionSchema.parse({
      intent: "agendar visita",
      outcome: "needs_input",
      action: null,
      candidateRefs: [],
      missingInputs: ["property"],
      clarificationQuestion: "¿En qué inmueble quieres agendar la visita mañana a las 10:00?",
      targetSearch: { leadQuery: "Cliente Ejemplo", propertyQuery: null },
      visitDraft: { startDate: "2026-09-01", startTime: "10:00", temporalPhrase: "mañana a las 10:00" },
    });
    expect(enrichConversationProposal(clarification)).toMatchObject({
      action: "needs_clarification",
      needsClarification: true,
    });
    expect(conversationDecisionSchema.safeParse(readyWire({
      intent: "agendar visita",
      action: "visits.create_visit.v1",
      targetSearch: { leadQuery: "Cliente Ejemplo", propertyQuery: null },
      visitDraft: { startDate: "2026-09-01", startTime: "10:00", temporalPhrase: "mañana a las 10:00" },
    })).success).toBe(false);
    expect(enrichConversationProposal(conversationDecisionSchema.parse(readyWire({
      clarificationQuestion: "null",
    })))).toMatchObject({ clarificationQuestion: "", needsClarification: false });
    expect(enrichConversationProposal(conversationDecisionSchema.parse(readyWire({
      action: "visits.create_visit.v1",
      targetSearch: { leadQuery: "Cliente Ejemplo", propertyQuery: "Piso Demo" },
      visitDraft: { startDate: "2026-09-01", startTime: "10:00:00", temporalPhrase: "mañana a las 10:00" },
    })))).toMatchObject({ visitDraft: { startTime: "10:00" } });
  });

  it("keeps the upstream history prompt shape reusable", () => {
    expect(buildInteractionPrompt({
      history: [{ role: "user", content: "previous" }],
      currentMessage: "current",
    })).toBe("Prior turns:\nUSER: previous\n\nCurrent message:\ncurrent");
    expect(INTERACTION_SYSTEM).toContain("You are a DISPATCHER, not a doer.");
  });

  it("executes only the inert proposal tool and never emits authority", async () => {
    const requests: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return sse([
        {
          model: "deepseek/deepseek-v4-flash-0731",
          choices: [{
            finish_reason: "tool_calls",
            delta: {
              tool_calls: [{
                index: 0,
                id: "call-1",
                type: "function",
                function: {
                  name: "boop-shadow__propose_conversation_0",
                  arguments: JSON.stringify(readyWire({
                    intent: "lead.get_context",
                    candidateRefs: [{ evidenceKey: "e1", type: "crm.lead" }],
                  })),
                },
              }],
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.001 },
        },
      ]);
    });
    const result = await runBoopInteractionShadow({
      conversationId: "shadow-case",
      turn: 2,
      currentMessage: "¿Qué sabemos de este lead?",
      history: [{ role: "user", content: "Lead A" }],
      evidence,
    }, {
      apiKey: "test",
      model: "deepseek/deepseek-v4-flash-0731",
      reasoningEffort: "max",
      adapter: new OpenRouterAdapter({ apiKey: "test", fetch: fetchMock, maxTransportRetries: 0 }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.proposalStatus).toBe("captured");
    expect(result.proposal).toMatchObject({
      domain: "crm",
      action: "crm.get_lead_context.v1",
    });
    expect(result.validation).toMatchObject({
      validatedCandidateKeys: ["e1"],
      unauthorizedCandidateKeys: [],
      authorityRefIssued: false,
    });
    const requestMessages = requests[0]?.messages as Array<{ role: string; content: string }>;
    expect(requestMessages.find((message) => message.role === "user")?.content).toContain("1. e1 | crm.lead | Lead A");
    const requestTools = requests[0]?.tools as Array<{ function: { parameters: { properties: Record<string, unknown> } } }>;
    const wireProperties = requestTools[0]?.function.parameters.properties ?? {};
    expect(Object.keys(wireProperties).sort()).toEqual([
      "action",
      "candidateRefs",
      "clarificationQuestion",
      "intent",
      "missingInputs",
      "outcome",
      "targetSearch",
      "visitDraft",
    ]);
    expect(wireProperties).not.toHaveProperty("domain");
    expect(wireProperties).not.toHaveProperty("delegationProposal");
    expect(wireProperties).not.toHaveProperty("freshRead");
    expect(wireProperties).not.toHaveProperty("visitTargetSearch");
    expect(wireProperties).not.toHaveProperty("propertyTargetSearch");
  });

  it("rejects candidate keys not present in conversational evidence", async () => {
    const fetchMock = vi.fn(async () => sse([
      {
        model: "deepseek/deepseek-v4-flash-0731",
        choices: [{
          finish_reason: "tool_calls",
          delta: {
            tool_calls: [{
              index: 0,
              id: "call-2",
              type: "function",
              function: {
                name: "boop-shadow__propose_conversation_0",
                arguments: JSON.stringify(readyWire({
                  intent: "lead.get_context",
                  candidateRefs: [{ evidenceKey: "ref:invented", type: "crm.lead" }],
                })),
              },
            }],
          },
        }],
        usage: {},
      },
    ]));
    const result = await runBoopInteractionShadow({
      conversationId: "shadow-case",
      turn: 3,
      currentMessage: "¿Qué sabemos?",
      history: [],
      evidence,
    }, {
      apiKey: "test",
      model: "deepseek/deepseek-v4-flash-0731",
      adapter: new OpenRouterAdapter({
        apiKey: "test",
        fetch: fetchMock,
        maxTransportRetries: 0,
      }),
    });
    expect(result.validation.unauthorizedCandidateKeys).toEqual(["ref:invented"]);
    expect(result.validation.invalidCandidateKeys).toEqual(["ref:invented"]);
    expect(result.validation.authorityRefIssued).toBe(false);
  });

  it("rejects reserved evidence labels even when a provider proposes them", async () => {
    const fetchMock = vi.fn(async () => sse([
      {
        model: "deepseek/deepseek-v4-flash-0731",
        choices: [{
          finish_reason: "tool_calls",
          delta: { tool_calls: [{ index: 0, id: "call-3", type: "function", function: {
            name: "boop-shadow__propose_conversation_0",
            arguments: JSON.stringify(readyWire({ intent: "lead.get_context", candidateRefs: [{ evidenceKey: "selected", type: "crm.lead" }] })),
          } }] },
        }],
        usage: {},
      },
    ]));
    const result = await runBoopInteractionShadow({
      conversationId: "shadow-case",
      turn: 4,
      currentMessage: "¿Qué sabemos?",
      history: [],
      evidence,
    }, { apiKey: "test", model: "deepseek/deepseek-v4-flash-0731", adapter: new OpenRouterAdapter({ apiKey: "test", fetch: fetchMock, maxTransportRetries: 0 }) });
    expect(result.validation.invalidCandidateKeys).toEqual(["selected"]);
    expect(result.validation.unauthorizedCandidateKeys).toEqual(["selected"]);
  });

  it("never serializes the internal EntityRef index into the provider prompt", async () => {
    let requestBody = "";
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      requestBody = String(init.body);
      return sse([{
        model: "deepseek/deepseek-v4-flash-0731",
        choices: [{
          finish_reason: "tool_calls",
          delta: { tool_calls: [{ index: 0, id: "call-4", type: "function", function: {
            name: "boop-shadow__propose_conversation_0",
            arguments: JSON.stringify(readyWire({ intent: "lead.get_context", candidateRefs: [{ evidenceKey: "e1", type: "crm.lead" }] })),
          } }] },
        }],
        usage: {},
      }]);
    });
    const indexedEvidence: ShadowEvidence = {
      ...evidence,
      entityIndex: {
        e1: { evidenceKey: "e1", ref: { type: "crm.lead", id: "internal-lead-id" }, sources: ["selected"], messageIds: ["message-id"] },
      },
      knownRelations: [],
      captureMetrics: { inputMessages: 1, historyMessages: 1, selectedRefs: 1, referencedRefs: 0, blockRefs: 0, resultBlocks: 0, orderedResultSets: 0, focusedEntities: 0, candidateRefs: 1 },
    };
    await runBoopInteractionShadow({
      conversationId: "shadow-case", turn: 5, currentMessage: "¿Qué sabemos?", history: [], evidence: indexedEvidence,
    }, {
      apiKey: "test", model: "deepseek/deepseek-v4-flash-0731",
      adapter: new OpenRouterAdapter({ apiKey: "test", fetch: fetchMock, maxTransportRetries: 0 }),
    });
    expect(requestBody).not.toContain("internal-lead-id");
    expect(requestBody).not.toContain("message-id");
    expect(requestBody).not.toContain("entityIndex");
    const parsedRequest = JSON.parse(requestBody) as { messages: Array<{ role: string; content: string }> };
    expect(parsedRequest.messages.find((message) => message.role === "user")?.content).toContain('"evidenceKey":"e1"');
  });

  it("builds canonical evidence from actor-scoped messages at the preferred shadow entry point", async () => {
    let requestBody = "";
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      requestBody = String(init.body);
      return sse([{
        model: "deepseek/deepseek-v4-flash-0731",
        choices: [{ finish_reason: "tool_calls", delta: { tool_calls: [{ index: 0, id: "call-5", type: "function", function: {
          name: "boop-shadow__propose_conversation_0",
          arguments: JSON.stringify(readyWire({ intent: "lead.get_context", candidateRefs: [{ evidenceKey: "e1", type: "crm.lead" }] })),
        } }] } }],
        usage: {},
      }]);
    });
    const result = await runBoopInteractionShadowFromMessages({
      actor: { tenantId: "tenant-a", userId: "user-a" },
      conversationId: "conversation-a",
      turn: 2,
      currentMessage: "¿Qué sabemos de este lead?",
      messages: [{
        messageId: "m1", conversationId: "conversation-a", tenantId: "tenant-a", actorUserId: "user-a",
        role: "assistant", contentRedacted: "Lead seleccionado", contextRefs: {
          selected: { lead: { type: "crm.lead", id: "internal-lead-id", label: "Lead A" } }, referenced: [],
        }, sequence: 1, createdAt: 1,
      }],
    }, {
      apiKey: "test", model: "deepseek/deepseek-v4-flash-0731",
      adapter: new OpenRouterAdapter({ apiKey: "test", fetch: fetchMock, maxTransportRetries: 0 }),
    });
    expect(result.validation.validatedCandidateKeys).toEqual(["e1"]);
    expect(requestBody).not.toContain("internal-lead-id");
    expect(requestBody).toContain("Lead seleccionado");
  });
});
