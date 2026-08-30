import { beforeEach, describe, expect, it, vi } from "vitest";
import { createActorContext } from "../server/hostmate/contracts/actor-context.js";
import type { EntityRef } from "../server/hostmate/contracts/domain.js";
import type { AgentMessageRecord } from "../server/hostmate/control-plane/repository.js";
import { InteractionLabControlPlaneRepository } from "../server/hostmate/shadow/interaction-lab-control-plane.js";
import { InteractionLabHostmateConnection } from "../server/hostmate/shadow/interaction-lab-hostmate.js";
import type { ConversationProposal, ShadowEvidence } from "../server/hostmate/shadow/boop-interaction-shadow.js";

const actor = createActorContext({
  tenantId: "9", userId: "39", role: "admin", isSuperAdmin: false,
  permissions: ["crm.read", "property.read", "visits.read"],
  locale: "es-ES", timezone: "Europe/Madrid", sessionId: "lab-session", permissionsVersion: "lab-v1",
});

function message(conversationId: string, ref: EntityRef): AgentMessageRecord {
  const role = ref.type === "crm.lead" ? "lead" : ref.type.startsWith("visits.") ? "visit" : "property";
  return {
    messageId: `${conversationId}:1`, conversationId, tenantId: actor.tenantId, actorUserId: actor.userId,
    role: "assistant", contentRedacted: "Entidad seleccionada", contextRefs: { selected: { [role]: ref }, referenced: [ref] },
    sequence: 1, createdAt: Date.now(),
  };
}

function evidence(ref: EntityRef): ShadowEvidence {
  return {
    currentSelection: {}, referencedEntities: [], recentResultEvidence: [], conversationHistory: [], emittedEntityRefs: [],
    candidateRefs: [{ evidenceKey: "e1", type: ref.type, label: ref.label, source: "selected" }],
    captureStatus: { referenced: "captured", blocks: "captured", prompt: "captured" },
    entityIndex: { e1: { evidenceKey: "e1", ref, sources: ["selected"], messageIds: ["m1"] } },
  };
}

function proposal(action: ConversationProposal["action"], domain: ConversationProposal["domain"], type: string): ConversationProposal {
  const kind = action.startsWith("skill.") ? "skill" : "multi_agent";
  return {
    intent: "preparar contexto", domain, action,
    candidateRefs: [{ evidenceKey: "e1", type }], needsClarification: false, clarificationQuestion: "",
    delegationProposal: { kind, target: action }, freshRead: "required",
  } as ConversationProposal;
}

function connection(): InteractionLabHostmateConnection & Record<string, unknown> {
  const value = new InteractionLabHostmateConnection() as InteractionLabHostmateConnection & Record<string, unknown>;
  value.actor = actor;
  value.accessToken = "test-token";
  value.composeReadReply = vi.fn(async (input: { execution: { summary: string } }) => ({
    text: input.execution.summary, model: "test", latencyMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0,
  }));
  return value;
}

describe("Interaction Lab composite execution", () => {
  beforeEach(() => {
    process.env.INTERACTION_LAB_HOSTMATE_TENANT_ID = "9";
  });

  it("binds the general Visit search to an authorized Lead or Property when the conversation supplies one", () => {
    const property = { type: "property.property", id: "865", label: "Piso Bonavista" } as const;
    const lab = connection() as any;
    const plan = lab.readToolPlan({
      intent: "consultar las visitas de este inmueble",
      domain: "visits",
      action: "visits.search_visits.v1",
      candidateRefs: [{ evidenceKey: "e1", type: "property.property" }],
      needsClarification: false,
      clarificationQuestion: "",
      delegationProposal: { kind: "none", target: "" },
      freshRead: "required",
    }, evidence(property));

    expect(plan.tool).toMatchObject({ toolId: "visits.search_visits.v1", requiredPermission: "visits.read" });
    expect(plan.target).toEqual({ field: "property", ref: property });
    expect(plan.capability).toBe("visits.visit.search");
  });

  it("resolves named Visit targets with existing tenant-scoped searches before preparing the Draft", async () => {
    const lab = connection() as any;
    lab.searchLeads = vi.fn(async () => ({
      items: [{ id: "41", client_name: "Roger Closas" }], total: 1, page: 1, limit: 6,
      telemetry: { service: "lead.service.list", latencyMs: 2 },
    }));
    const loreto = {
      id: "865", reference: "LORETO", title: "Piso en calle de Loreto", address: "Calle de Loreto 10",
      neighborhood: "Les Corts", city: "Barcelona", price: 400000, rooms: 3, bathrooms: 2,
      areaBuilt: 90, propertySubtype: "piso", character: null, descriptionExcerpt: null,
    };
    lab.searchConcretePropertyCandidates = vi.fn(async () => ({
      query: "calle de Loreto", items: [loreto], total: 1, latencyMs: 3,
    }));
    lab.resolveConcretePropertyCandidate = vi.fn(async () => ({
      outcome: "selected", candidate: loreto, model: "test", latencyMs: 4,
      inputTokens: 100, outputTokens: 10, costUsd: 0.001,
    }));
    lab.post = vi.fn(async () => ({
      success: true,
      data: {
        confirmationToken: "opaque-confirmation",
        signedIntent: { envelope: { draftId: "draft-1" } },
        card: { title: "Crear visita", risk: "R2", fields: [], effects: [], expiresAt: "2026-09-01T09:00:00.000Z" },
      },
    }));
    const emptyEvidence: ShadowEvidence = {
      currentSelection: {}, referencedEntities: [], recentResultEvidence: [], conversationHistory: [], emittedEntityRefs: [], candidateRefs: [],
      captureStatus: { referenced: "captured", blocks: "captured", prompt: "captured" }, entityIndex: {},
    };
    const result = await lab.prepareVisitDraft({
      conversationId: "visit-search-targets",
      message: "Agenda una visita mañana a las 10:00 para el piso en calle de Loreto con Roger Closas",
      openRouterApiKey: "test",
      model: "test",
      reasoningEffort: "none",
      evidence: emptyEvidence,
      proposal: {
        intent: "agendar visita", domain: "visits", action: "visits.create_visit.v1", candidateRefs: [],
        needsClarification: false, clarificationQuestion: "", delegationProposal: { kind: "none", target: "" }, freshRead: "required",
        visitDraft: { startDate: "2026-08-31", startTime: "10:00", temporalPhrase: "mañana a las 10:00" },
        visitTargetSearch: { leadQuery: "Roger Closas", propertyQuery: "calle de Loreto" },
      },
    });

    expect(lab.searchLeads).toHaveBeenCalledWith({ query: "Roger Closas", page: 1, limit: 6 });
    expect(lab.searchConcretePropertyCandidates).toHaveBeenCalledWith("calle de Loreto");
    expect(lab.resolveConcretePropertyCandidate).toHaveBeenCalledWith(expect.objectContaining({
      query: "calle de Loreto",
      currentMessage: "Agenda una visita mañana a las 10:00 para el piso en calle de Loreto con Roger Closas",
    }));
    expect(lab.post).toHaveBeenCalledWith("/api/v2/ai-interaction/visit-drafts", expect.objectContaining({
      leadId: "41", propertyId: "865", startDate: "2026-08-31", startTime: "10:00",
      provenance: { leadEvidenceKey: "e1", propertyEvidenceKey: "e2" },
    }));
    expect(result).toMatchObject({
      status: "completed", executionKind: "write", entities: [{ id: "41" }, { id: "865" }],
      toolCalls: 2, runCount: 1, telemetry: { inputTokens: 100, outputTokens: 10, costUsd: 0.001 },
    });
  });

  it("asks instead of guessing when a named Visit target is ambiguous", async () => {
    const lab = connection() as any;
    lab.searchLeads = vi.fn(async () => ({
      items: [{ id: "41", client_name: "Roger Closas" }, { id: "42", client_name: "Roger Closas" }],
      total: 2, page: 1, limit: 6, telemetry: { service: "lead.service.list", latencyMs: 2 },
    }));
    lab.searchConcretePropertyCandidates = vi.fn();
    lab.post = vi.fn();
    const result = await lab.prepareVisitDraft({
      conversationId: "visit-ambiguous-lead", model: "test", reasoningEffort: "none",
      message: "Agenda una visita mañana a las 10:00 para el piso en calle de Loreto con Roger Closas",
      openRouterApiKey: "test",
      evidence: { currentSelection: {}, referencedEntities: [], recentResultEvidence: [], conversationHistory: [], emittedEntityRefs: [], candidateRefs: [], captureStatus: { referenced: "captured", blocks: "captured", prompt: "captured" }, entityIndex: {} },
      proposal: {
        intent: "agendar visita", domain: "visits", action: "visits.create_visit.v1", candidateRefs: [],
        needsClarification: false, clarificationQuestion: "", delegationProposal: { kind: "none", target: "" }, freshRead: "required",
        visitDraft: { startDate: "2026-08-31", startTime: "10:00", temporalPhrase: "mañana a las 10:00" },
        visitTargetSearch: { leadQuery: "Roger Closas", propertyQuery: "calle de Loreto" },
      },
    });

    expect(result).toMatchObject({ status: "needs_input", entities: [{ id: "41" }, { id: "42" }] });
    expect(lab.searchConcretePropertyCandidates).not.toHaveBeenCalled();
    expect(lab.post).not.toHaveBeenCalled();
  });

  it("uses the model's discriminating clarification when concrete Property candidates remain ambiguous", async () => {
    const lab = connection() as any;
    lab.searchLeads = vi.fn(async () => ({
      items: [{ id: "41", client_name: "Roger Closas" }], total: 1, page: 1, limit: 6,
      telemetry: { service: "lead.service.list", latencyMs: 2 },
    }));
    const candidates = [
      { id: "865", reference: "BONA-3", title: "Bonavista 3 habitaciones", address: "Carrer Bonavista 1", neighborhood: "Gràcia", city: "Barcelona", price: 450000, rooms: 3, bathrooms: 2, areaBuilt: 90, propertySubtype: "piso", character: null, descriptionExcerpt: null },
      { id: "866", reference: "BONA-4", title: "Bonavista 4 habitaciones", address: "Carrer Bonavista 8", neighborhood: "Gràcia", city: "Barcelona", price: 520000, rooms: 4, bathrooms: 2, areaBuilt: 115, propertySubtype: "piso", character: null, descriptionExcerpt: null },
    ];
    lab.searchConcretePropertyCandidates = vi.fn(async () => ({ query: "Bonavista", items: candidates, total: 2, latencyMs: 3 }));
    lab.resolveConcretePropertyCandidate = vi.fn(async () => ({
      outcome: "needs_input", question: "¿Te refieres al de 3 habitaciones o al de 4?",
      model: "test", latencyMs: 4, inputTokens: 120, outputTokens: 14, costUsd: 0.001,
    }));
    lab.post = vi.fn();

    const result = await lab.prepareVisitDraft({
      conversationId: "visit-ambiguous-property",
      message: "Agenda una visita mañana a las 10:00 para el piso de Bonavista con Roger Closas",
      openRouterApiKey: "test", model: "test", reasoningEffort: "none",
      evidence: { currentSelection: {}, referencedEntities: [], recentResultEvidence: [], conversationHistory: [], emittedEntityRefs: [], candidateRefs: [], captureStatus: { referenced: "captured", blocks: "captured", prompt: "captured" }, entityIndex: {} },
      proposal: {
        intent: "agendar visita", domain: "visits", action: "visits.create_visit.v1", candidateRefs: [],
        needsClarification: false, clarificationQuestion: "", delegationProposal: { kind: "none", target: "" }, freshRead: "required",
        visitDraft: { startDate: "2026-08-31", startTime: "10:00", temporalPhrase: "mañana a las 10:00" },
        visitTargetSearch: { leadQuery: "Roger Closas", propertyQuery: "Bonavista" },
      },
    });

    expect(result).toMatchObject({
      status: "needs_input",
      summary: "¿Te refieres al de 3 habitaciones o al de 4?",
      entities: [{ id: "865" }, { id: "866" }],
      toolCalls: 2,
      runCount: 1,
    });
    expect(lab.post).not.toHaveBeenCalled();
  });

  it("maps only the candidate explicitly selected by the LLM grounding call", async () => {
    const lab = connection() as any;
    const candidates = [
      { id: "865", reference: "BONA-3", title: "Bonavista 3 habitaciones", address: "Carrer Bonavista 1", neighborhood: "Gràcia", city: "Barcelona", price: 450000, rooms: 3, bathrooms: 2, areaBuilt: 90, propertySubtype: "piso", character: null, descriptionExcerpt: null },
      { id: "866", reference: "BONA-4", title: "Bonavista 4 habitaciones", address: "Carrer Bonavista 8", neighborhood: "Gràcia", city: "Barcelona", price: 520000, rooms: 4, bathrooms: 2, areaBuilt: 115, propertySubtype: "piso", character: null, descriptionExcerpt: null },
    ];
    const run = vi.fn(async (request: { prompt: string; tools: Array<{ name: string; handle: (args: Record<string, unknown>) => Promise<{ text: string; success?: boolean }> }> }) => {
      const tool = request.tools.find((item) => item.name === "select_property_candidate")!;
      const toolResult = await tool.handle({ candidateKey: "p2" });
      expect(request.prompt).toContain("Bonavista 4 habitaciones");
      expect(request.prompt).not.toContain('"id":"866"');
      return {
        resolvedModel: "test", latencyMs: 7,
        detailedUsage: { inputTokens: 140, outputTokens: 12, costUsd: 0.002 },
        toolResults: [{ toolName: tool.name, text: toolResult.text, success: toolResult.success !== false }],
      };
    });

    const result = await lab.resolveConcretePropertyCandidate({
      query: "Bonavista de cuatro habitaciones",
      currentMessage: "Quiero el de Bonavista de cuatro habitaciones",
      evidence: { currentSelection: {}, referencedEntities: [], recentResultEvidence: [], conversationHistory: [], emittedEntityRefs: [], candidateRefs: [], captureStatus: { referenced: "captured", blocks: "captured", prompt: "captured" }, entityIndex: {} },
      search: { query: "Bonavista de cuatro habitaciones", items: candidates, total: 2, latencyMs: 3 },
      runtime: { run }, model: "test", reasoningEffort: "none",
    });

    expect(result).toMatchObject({ outcome: "selected", candidate: { id: "866" }, inputTokens: 140, outputTokens: 12 });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("uses the shared Eva+LLM grounding path for a concrete Property read", async () => {
    const lab = connection() as any;
    const loreto = {
      id: "865", reference: "LORETO", title: "Piso en calle de Loreto", address: "Calle de Loreto 10",
      neighborhood: "Les Corts", city: "Barcelona", price: 400000, rooms: 3, bathrooms: 2,
      areaBuilt: 90, propertySubtype: "piso", character: null, descriptionExcerpt: null,
    };
    lab.searchConcretePropertyCandidates = vi.fn(async () => ({ query: "calle de Loreto", items: [loreto], total: 1, latencyMs: 3 }));
    lab.resolveConcretePropertyCandidate = vi.fn(async () => ({
      outcome: "selected", candidate: loreto, model: "test", latencyMs: 4,
      inputTokens: 100, outputTokens: 10, costUsd: 0.001,
    }));
    lab.getPropertyDetail = vi.fn(async () => ({
      id: "865", reference: "LORETO", title: "Piso en calle de Loreto", operation: "comprar",
      propertyType: "piso", status: "activo", price: 400000, currency: "EUR",
      location: { city: "Barcelona", neighborhood: "Les Corts", province: "Barcelona" },
      specifications: {
        rooms: 3, bathrooms: 2, areaBuilt: 90, areaUseful: 80, plotArea: null, floor: "2",
        yearBuilt: null, ceilingHeight: null, loadingDocks: null, powerSupplyKw: null,
        officeArea: null, storefrontCount: null, grossYieldPct: null,
      },
      features: ["terraza"], description: null, publicNotes: null, images: [], associatedAgents: [],
      telemetry: { services: ["property.service.getById"], latencyMs: 2 },
    }));
    const emptyEvidence: ShadowEvidence = {
      currentSelection: {}, referencedEntities: [], recentResultEvidence: [], conversationHistory: [],
      emittedEntityRefs: [], candidateRefs: [], captureStatus: { referenced: "captured", blocks: "captured", prompt: "captured" }, entityIndex: {},
    };

    const result = await lab.executeRead({
      conversationId: "property-concrete-read",
      message: "¿Cuánto cuesta el piso en calle de Loreto?",
      evidence: emptyEvidence,
      priorMessages: [], openRouterApiKey: "test", model: "test", reasoningEffort: "none",
      proposal: {
        intent: "consultar el piso de Loreto", domain: "property", action: "property.search_properties.v1",
        candidateRefs: [], needsClarification: false, clarificationQuestion: "",
        delegationProposal: { kind: "none", target: "" }, freshRead: "required",
        propertyTargetSearch: { query: "calle de Loreto" },
      },
    });

    expect(result).toMatchObject({
      action: "property.get_property.v1", status: "completed", entities: [{ id: "865" }],
      blocks: [{ type: "entity_detail", ref: { id: "865" } }], toolCalls: 2, runCount: 2,
    });
    expect(lab.searchConcretePropertyCandidates).toHaveBeenCalledWith("calle de Loreto");
    expect(lab.getPropertyDetail).toHaveBeenCalledWith("865");
  });

  it("keeps ambiguous concrete Property reads as ordered conversational evidence", async () => {
    const lab = connection() as any;
    const candidates = [
      { id: "865", reference: "BONA-3", title: "Bonavista 3 habitaciones", address: "Carrer Bonavista 1", neighborhood: "Gràcia", city: "Barcelona", price: 450000, rooms: 3, bathrooms: 2, areaBuilt: 90, propertySubtype: "piso", character: null, descriptionExcerpt: null },
      { id: "866", reference: "BONA-4", title: "Bonavista 4 habitaciones", address: "Carrer Bonavista 8", neighborhood: "Gràcia", city: "Barcelona", price: 520000, rooms: 4, bathrooms: 2, areaBuilt: 115, propertySubtype: "piso", character: null, descriptionExcerpt: null },
    ];
    lab.searchConcretePropertyCandidates = vi.fn(async () => ({ query: "Bonavista", items: candidates, total: 2, latencyMs: 3 }));
    lab.resolveConcretePropertyCandidate = vi.fn(async () => ({
      outcome: "needs_input", question: "¿Te refieres al de 3 habitaciones o al de 4?",
      model: "test", latencyMs: 4, inputTokens: 100, outputTokens: 10, costUsd: 0.001,
    }));
    lab.getPropertyDetail = vi.fn();
    const emptyEvidence: ShadowEvidence = {
      currentSelection: {}, referencedEntities: [], recentResultEvidence: [], conversationHistory: [],
      emittedEntityRefs: [], candidateRefs: [], captureStatus: { referenced: "captured", blocks: "captured", prompt: "captured" }, entityIndex: {},
    };

    const result = await lab.executeRead({
      conversationId: "property-ambiguous-read", message: "¿Cuánto cuesta el piso de Bonavista?",
      evidence: emptyEvidence, priorMessages: [], openRouterApiKey: "test", model: "test", reasoningEffort: "none",
      proposal: {
        intent: "consultar Bonavista", domain: "property", action: "property.search_properties.v1",
        candidateRefs: [], needsClarification: false, clarificationQuestion: "",
        delegationProposal: { kind: "none", target: "" }, freshRead: "required",
        propertyTargetSearch: { query: "Bonavista" },
      },
    });

    expect(result).toMatchObject({
      status: "needs_input", summary: "¿Te refieres al de 3 habitaciones o al de 4?",
      blocks: [{ type: "entity_list", items: [{ ref: { id: "865" } }, { ref: { id: "866" } }] }],
      entities: [{ id: "865" }, { id: "866" }],
    });
    expect(lab.getPropertyDetail).not.toHaveBeenCalled();
  });

  it("executes the selected Lead Skill through the existing Boop Skill lifecycle", async () => {
    const lead = { type: "crm.lead", id: "123", label: "Laura" } as const;
    const lab = connection();
    lab.getLeadContext = vi.fn(async () => ({
      lead: { id: "123", name: "Laura", status: "qualified" }, assignedAgent: { id: "39", name: "Roger" },
      property: null, opportunity: null, activeDemand: null, nextVisit: null, pendingTasks: [],
    }));
    const result = await lab.executeRead({
      conversationId: "conversation-skill", proposal: proposal("skill.prepare-lead-brief.v1", "crm", "crm.lead"),
      message: "Prepárame este lead", evidence: evidence(lead), priorMessages: [message("conversation-skill", lead)],
      openRouterApiKey: "test", model: "test", reasoningEffort: "none",
    });

    expect(result).toMatchObject({ action: "skill.prepare-lead-brief.v1", executionKind: "skill", toolCalls: 1, runCount: 2 });
    expect(result?.blocks?.[0]).toMatchObject({ type: "brief", title: "Preparación de lead" });
  });

  it("executes the bounded Lead workflow with three exact child Tools", async () => {
    const lead = { type: "crm.lead", id: "123", label: "Laura" } as const;
    const lab = connection();
    lab.getLeadContext = vi.fn(async () => ({
      lead: { id: "123", name: "Laura", status: "qualified" }, assignedAgent: { id: "39", name: "Roger" },
      property: null, opportunity: null,
      activeDemand: { id: "d1", operationType: "comprar", propertySubtype: "piso", city: "Barcelona", zone: null, priceMax: 450000, roomsMin: null, bathroomsMin: null, areaMin: null },
      nextVisit: null, pendingTasks: [],
    }));
    lab.listLeadVisits = vi.fn(async () => ({
      lead: { id: "123", name: "Laura" }, visits: [],
      metadata: { scope: "upcoming", total: 0, returned: 0, hasMore: false, limit: 10 },
    }));
    lab.searchProperties = vi.fn(async () => ({
      items: [{ id: "1", reference: "P-1", title: "Piso Barcelona", operation: "comprar", propertyType: "piso", price: 420000, currency: "EUR", city: "Barcelona", neighborhood: null, rooms: 3, bathrooms: 2, areaBuilt: 90, status: "activo", features: [], associatedAgent: null }],
      total: 1, returned: 1, hasMore: false,
    }));
    const result = await lab.executeRead({
      conversationId: "conversation-workflow", proposal: proposal("multi-agent.lead-opportunity-analysis.v1", "crm", "crm.lead"),
      message: "Analiza este lead, sus visitas y los inmuebles que encajan", evidence: evidence(lead),
      priorMessages: [message("conversation-workflow", lead)], openRouterApiKey: "test", model: "test", reasoningEffort: "none",
    });

    expect(result).toMatchObject({ action: "multi-agent.lead-opportunity-analysis.v1", executionKind: "workflow", toolCalls: 3, runCount: 4, status: "completed" });
    expect(result?.blocks?.[0]).toMatchObject({ type: "multi_agent_summary", title: "Análisis del lead" });
  });

  it("executes the selected Visit Skill with its three existing read Tools", async () => {
    const visit = { type: "visits.visit", id: "91", label: "Visita Ático Centro" } as const;
    const lab = connection();
    lab.getVisitDetail = vi.fn(async () => ({
      kind: "individual", id: "91", at: "2026-09-18T09:00:00.000Z", status: "confirmed", visitType: "presencial", durationMinutes: 60,
      clientConfirmation: "confirmed", property: { id: "865", reference: "HM-865", title: "Ático Centro", address: "Carrer Major" },
      lead: { id: "123", name: "Ana Test" }, assignedAgent: { id: "39", name: "Roger" }, state: { isGroupSlot: false },
    }));
    lab.getLeadContext = vi.fn(async () => ({
      lead: { id: "123", name: "Ana Test", status: "qualified" }, assignedAgent: { id: "39", name: "Roger" },
      property: null, opportunity: null, activeDemand: null, nextVisit: null, pendingTasks: [],
    }));
    lab.getPropertyDetail = vi.fn(async () => ({
      id: "865", reference: "HM-865", title: "Ático Centro", operation: "comprar", propertyType: "atico", status: "activo", price: 280000, currency: "EUR",
      location: { city: "Manresa", neighborhood: "Centre", province: "Barcelona" },
      specifications: { rooms: 3, bathrooms: 2, areaBuilt: 110, areaUseful: 95, plotArea: null, floor: "4", yearBuilt: 2008, ceilingHeight: null, loadingDocks: null, powerSupplyKw: null, officeArea: null, storefrontCount: null, grossYieldPct: null },
      features: ["terraza", "ascensor"], description: "Ático luminoso.", publicNotes: null, images: [], associatedAgents: [],
      telemetry: { services: ["property.service"], latencyMs: 1 },
    }));
    const result = await lab.executeRead({
      conversationId: "conversation-visit-skill", proposal: proposal("skill.prepare-visit-brief.v1", "visits", "visits.visit"),
      message: "Prepárame esta visita", evidence: evidence(visit), priorMessages: [message("conversation-visit-skill", visit)],
      openRouterApiKey: "test", model: "test", reasoningEffort: "none",
    });

    expect(result).toMatchObject({ action: "skill.prepare-visit-brief.v1", executionKind: "skill", toolCalls: 3, runCount: 2, status: "completed" });
    expect(result?.blocks?.[0]).toMatchObject({ type: "brief", title: "Preparación de visita" });
  });

  it("hydrates a Visit Property from canonical property_id and keeps the Visit snapshot only as fallback", async () => {
    const lab = connection();
    lab.get = vi.fn(async (path: string) => {
      if (path === "/api/v2/visits/484") {
        return {
          success: true,
          data: {
            id: 484, visit_datetime: "2026-08-27T13:30:00.000Z", status: "completed",
            property_id: 852, property_ref: "00952",
            property_title: "Piso en Calle dels Motors, La Marina, Barcelona",
            property_address: "Calle dels Motors, 100, La Marina, Barcelona",
          },
        };
      }
      if (path === "/api/v2/properties/852") {
        return {
          success: true,
          data: {
            id: 852, reference: "00952",
            title: "Piso en Calle dels Motors, La Marina del Prat Vermell, Barcelona",
            address: "La Marina del Prat Vermell, Barcelona",
          },
        };
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    const detail = await (lab.getVisitDetail as (ref: EntityRef) => Promise<Record<string, unknown>>)({
      type: "visits.visit", id: "484",
    });

    expect(detail.property).toEqual({
      id: "852", reference: "00952",
      title: "Piso en Calle dels Motors, La Marina del Prat Vermell, Barcelona",
      address: "La Marina del Prat Vermell, Barcelona",
    });
    expect(detail.telemetry).toMatchObject({ services: ["visit.service.getById", "property.service.getById"] });
  });

  it("returns needs_input without a Tool when the LLM proposes a read without an authorized target", async () => {
    const lab = connection();
    lab.getPropertyDetail = vi.fn();
    const result = await lab.executeRead({
      conversationId: "conversation-missing-target",
      proposal: {
        intent: "identificar el inmueble de una visita inexistente",
        domain: "property",
        action: "property.get_property.v1",
        candidateRefs: [],
        needsClarification: false,
        clarificationQuestion: "",
        delegationProposal: { kind: "none", target: "" },
        freshRead: "required",
      },
      message: "¿De qué inmueble se trata?",
      evidence: {
        currentSelection: {}, referencedEntities: [], recentResultEvidence: [], conversationHistory: [],
        emittedEntityRefs: [], candidateRefs: [],
        captureStatus: { referenced: "captured", blocks: "captured", prompt: "captured" },
        entityIndex: {},
      },
      priorMessages: [], openRouterApiKey: "test", model: "test", reasoningEffort: "none",
    });

    expect(result).toMatchObject({
      action: "property.get_property.v1",
      executionKind: "tool",
      status: "needs_input",
      entities: [],
      toolCalls: 0,
      runCount: 0,
      summary: "No tengo un inmueble concreto y autorizado al que referirme. ¿Qué inmueble quieres consultar?",
    });
    expect(lab.getPropertyDetail).not.toHaveBeenCalled();
  });

  it("keeps the laboratory control plane read-only and actor-scoped", async () => {
    const lead = { type: "crm.lead", id: "123" } as const;
    const repository = new InteractionLabControlPlaneRepository([message("conversation-scope", lead)]);
    await expect(repository.listMessages(createActorContext({ ...actor, tenantId: "10" }), {
      conversationId: "conversation-scope", limit: 10,
    })).rejects.toThrow("CONVERSATION_SCOPE_MISMATCH");
    await expect(repository.createWriteIntent()).rejects.toThrow("INTERACTION_LAB_READ_ONLY");
  });
});
