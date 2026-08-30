import { describe, expect, it } from "vitest";
import type { AgentContentBlock } from "../server/hostmate/contracts/execution-result.js";
import { buildCanonicalConversationEvidence } from "../server/hostmate/shadow/canonical-conversation-evidence.js";
import {
  buildInteractionExecutionBrief,
  formatInteractionExecutionBrief,
} from "../server/hostmate/shadow/interaction-execution-brief.js";
import { InteractionLabConversationStore } from "../server/hostmate/shadow/interaction-lab-conversation.js";
import {
  resolveAuthorizedEvidenceCandidate,
  sanitizeInteractionLabEffectiveInput,
} from "../server/hostmate/shadow/interaction-lab-hostmate.js";

const scope = { tenantId: "tenant-9", userId: "user-12" };

describe("Interaction → Execution hybrid brief", () => {
  it("carries the previous effective filters and real ordered results without resolving language in backend", () => {
    const store = new InteractionLabConversationStore();
    store.getOrHydrate({
      conversationId: "conversation-1",
      scope,
      history: [],
    });
    store.appendUser("conversation-1", "Busca pisos con terraza en Barcelona");
    const block: AgentContentBlock = {
      type: "entity_list",
      title: "2 inmuebles",
      items: [
        { ref: { type: "property.property", id: "101", label: "Bonavista" }, title: "Bonavista", fields: [{ label: "Características", value: "terraza" }] },
        { ref: { type: "property.property", id: "102", label: "Les Corts" }, title: "Les Corts", fields: [{ label: "Características", value: "terraza" }] },
      ],
    };
    store.appendAssistant({
      conversationId: "conversation-1",
      content: "He encontrado dos inmuebles.",
      blocks: [block],
      entities: block.items.map((item) => item.ref),
    });
    store.rememberRead("conversation-1", {
      action: "property.search_properties.v1",
      effectiveInput: { city: "Barcelona", propertyType: "piso", features: ["terraza"] },
    });

    const evidence = buildCanonicalConversationEvidence({
      actor: scope,
      conversationId: "conversation-1",
      messages: store.messages("conversation-1"),
    });
    const brief = buildInteractionExecutionBrief({
      proposal: {
        intent: "verificar los inmuebles encontrados",
        domain: "property",
        action: "property.search_properties.v1",
        candidateRefs: [],
        needsClarification: false,
        clarificationQuestion: "",
        delegationProposal: { kind: "none", target: "" },
        freshRead: "required",
      },
      currentMessage: "¿Pero estás seguro de que tienen terraza?",
      evidence,
      previousRead: store.previousRead("conversation-1", "property.search_properties.v1"),
    });
    const rendered = formatInteractionExecutionBrief(brief);

    expect(rendered).toContain('"city":"Barcelona"');
    expect(rendered).toContain('"propertyType":"piso"');
    expect(rendered).toContain('"features":["terraza"]');
    expect(rendered).toContain('"position":1');
    expect(rendered).toContain('"position":2');
    expect(rendered).toContain("¿Pero estás seguro de que tienen terraza?");
    expect(brief).not.toHaveProperty("resolvedFilters");
    expect(brief).not.toHaveProperty("resolvedCandidate");
  });

  it("preserves independent previous reads per capability", () => {
    const store = new InteractionLabConversationStore();
    store.getOrHydrate({ conversationId: "conversation-2", scope, history: [] });
    store.rememberRead("conversation-2", {
      action: "property.search_properties.v1",
      effectiveInput: { city: "Barcelona" },
    });
    store.rememberRead("conversation-2", {
      action: "crm.search_leads.v1",
      effectiveInput: { query: "Laura" },
    });

    expect(store.previousRead("conversation-2", "property.search_properties.v1")?.effectiveInput)
      .toEqual({ city: "Barcelona" });
    expect(store.previousRead("conversation-2", "crm.search_leads.v1")?.effectiveInput)
      .toEqual({ query: "Laura" });
  });

  it("presents a newer Lead list as ordinal context without promoting or deleting entities in backend", () => {
    const store = new InteractionLabConversationStore();
    store.getOrHydrate({ conversationId: "conversation-cross-domain", scope, history: [] });
    const property = { type: "property.property", id: "property-1", label: "Piso Centro" } as const;
    store.appendAssistant({
      conversationId: "conversation-cross-domain",
      content: "Este es el inmueble.",
      blocks: [{ type: "entity_detail", ref: property, title: "Piso Centro", sections: [] }],
      entities: [property],
    });
    const leads = [
      { type: "crm.lead", id: "lead-1", label: "Lead Uno" },
      { type: "crm.lead", id: "lead-2", label: "Lead Dos" },
    ] as const;
    store.appendAssistant({
      conversationId: "conversation-cross-domain",
      content: "He encontrado dos leads.",
      blocks: [{
        type: "entity_list",
        title: "2 leads",
        items: leads.map((ref) => ({ ref, title: ref.label, fields: [] })),
      }],
      entities: leads,
    });

    const evidence = buildCanonicalConversationEvidence({
      actor: scope,
      conversationId: "conversation-cross-domain",
      messages: store.messages("conversation-cross-domain"),
    });
    const rendered = formatInteractionExecutionBrief(buildInteractionExecutionBrief({
      proposal: {
        intent: "consultar las visitas del primer lead",
        domain: "visits",
        action: "visits.list_lead_visits.v1",
        candidateRefs: [{ evidenceKey: "e2", type: "crm.lead" }],
        needsClarification: false,
        clarificationQuestion: "",
        delegationProposal: { kind: "none", target: "" },
        freshRead: "required",
      },
      currentMessage: "Consulta las visitas del primero",
      evidence,
    }));

    expect(evidence.currentSelection).toMatchObject({
      property: { type: "property.property", label: "Piso Centro" },
    });
    expect(evidence.currentSelection).not.toHaveProperty("lead");
    expect(evidence.orderedContext.recentResultSets[0]?.items.map((item) => item.type))
      .toEqual(["crm.lead", "crm.lead"]);
    expect(rendered).toContain("Consulta las visitas del primero");
    expect(rendered).toContain('"action":"visits.list_lead_visits.v1"');
    expect(rendered).toContain('"type":"crm.lead"');
  });

  it("selects one unambiguous entity per role from a composed result", () => {
    const store = new InteractionLabConversationStore();
    store.getOrHydrate({ conversationId: "conversation-composed-context", scope, history: [] });
    const lead = { type: "crm.lead", id: "lead-1", label: "Lead Uno" } as const;
    const property = { type: "property.property", id: "property-1", label: "Piso Centro" } as const;

    store.appendAssistant({
      conversationId: "conversation-composed-context",
      content: "Este lead está interesado en este inmueble.",
      entities: [lead, property],
    });

    expect(store.messages("conversation-composed-context").at(-1)?.contextRefs).toMatchObject({
      selected: { lead, property },
      referenced: [lead, property],
    });
  });

  it("keeps the resolved Lead and ordered Property candidates during a Visit clarification", () => {
    const store = new InteractionLabConversationStore();
    const conversationId = "conversation-pending-visit";
    store.getOrHydrate({ conversationId, scope, history: [] });
    const lead = { type: "crm.lead", id: "lead-demo", label: "Cliente Ejemplo" } as const;
    const properties = [
      { type: "property.property", id: "property-a", label: "Bonavista A" },
      { type: "property.property", id: "property-b", label: "Bonavista B" },
    ] as const;
    store.appendUser(conversationId, "Agenda una visita mañana a las 10:00 en Bonavista con Cliente Ejemplo");
    store.appendAssistant({
      conversationId,
      content: "Solicitud pendiente de visita — Cliente: Cliente Ejemplo · Inmueble: Bonavista · Horario: mañana a las 10:00. ¿Cuál de los dos inmuebles?",
      entities: [lead, ...properties],
      blocks: [{
        type: "entity_list",
        title: "2 inmuebles candidatos",
        items: properties.map((ref) => ({ ref, title: ref.label, fields: [] })),
      }],
    });

    const evidence = buildCanonicalConversationEvidence({
      actor: scope,
      conversationId,
      messages: store.messages(conversationId),
    });

    expect(evidence.currentSelection).toMatchObject({ lead: { type: "crm.lead", label: "Cliente Ejemplo" } });
    expect(evidence.currentSelection).not.toHaveProperty("property");
    expect(evidence.orderedContext.recentResultSets[0]?.items.map((item) => item.label))
      .toEqual(["Bonavista A", "Bonavista B"]);
    expect(evidence.conversationHistory.at(-1)?.content).toContain("Horario: mañana a las 10:00");
  });

  it("fails closed if a conversation id is reused across actor scope", () => {
    const store = new InteractionLabConversationStore();
    store.getOrHydrate({ conversationId: "conversation-3", scope, history: [] });

    expect(() => store.getOrHydrate({
      conversationId: "conversation-3",
      scope: { tenantId: "tenant-other", userId: "user-12" },
      history: [],
    })).toThrow("INTERACTION_LAB_CONVERSATION_SCOPE_MISMATCH");
  });

  it("keeps ordinal list positions and opaque evidence keys aligned after an earlier ambiguous list", () => {
    const store = new InteractionLabConversationStore();
    store.getOrHydrate({ conversationId: "conversation-ordinal-alignment", scope, history: [] });
    const leads = [
      { type: "crm.lead", id: "5063", label: "roger" },
      { type: "crm.lead", id: "824", label: "Roger" },
    ] as const;
    store.appendAssistant({
      conversationId: "conversation-ordinal-alignment", content: "Dos leads.", entities: leads,
      blocks: [{ type: "entity_list", title: "2 candidatos", items: leads.map((ref) => ({ ref, title: ref.label, fields: [] })) }],
    });
    store.appendAssistant({
      conversationId: "conversation-ordinal-alignment", content: "Primer lead.", entities: [leads[0]],
      blocks: [{ type: "entity_list", title: "Contexto del lead", items: [{ ref: leads[0], title: leads[0].label, fields: [] }] }],
    });
    const visits = ["484", "477", "475", "476", "478", "479", "482", "481", "443", "442"].map((id) => ({
      type: "visits.visit" as const, id, label: `Visita ${id}`,
    }));
    store.appendAssistant({
      conversationId: "conversation-ordinal-alignment", content: "Diez visitas.", entities: visits,
      blocks: [{ type: "entity_list", title: "Visitas del lead", items: visits.map((ref) => ({ ref, title: ref.label, fields: [] })) }],
    });
    const evidence = buildCanonicalConversationEvidence({
      actor: scope, conversationId: "conversation-ordinal-alignment", messages: store.messages("conversation-ordinal-alignment"),
    });
    const second = evidence.orderedContext.recentResultSets[0]?.items[1];

    expect(second).toMatchObject({ position: 2, type: "visits.visit", label: "Visita 477" });
    expect(evidence.entityIndex[second!.evidenceKey]?.ref).toMatchObject({ type: "visits.visit", id: "477" });
  });

  it("resolves an opaque candidate key only through canonical conversation evidence", () => {
    const store = new InteractionLabConversationStore();
    store.getOrHydrate({ conversationId: "conversation-4", scope, history: [] });
    store.appendAssistant({
      conversationId: "conversation-4",
      content: "Dos inmuebles.",
      blocks: [{
        type: "entity_list",
        title: "2 inmuebles",
        items: [
          { ref: { type: "property.property", id: "101", label: "Primero" }, title: "Primero", fields: [] },
          { ref: { type: "property.property", id: "102", label: "Segundo" }, title: "Segundo", fields: [] },
        ],
      }],
    });
    const evidence = buildCanonicalConversationEvidence({
      actor: scope,
      conversationId: "conversation-4",
      messages: store.messages("conversation-4"),
    });
    const proposal = {
      intent: "consultar el segundo",
      domain: "property" as const,
      action: "property.get_property.v1" as const,
      candidateRefs: [{ evidenceKey: "e2", type: "property.property" as const }],
      needsClarification: false,
      clarificationQuestion: "",
      delegationProposal: { kind: "none" as const, target: "" },
      freshRead: "required" as const,
    };

    expect(resolveAuthorizedEvidenceCandidate(proposal, evidence, ["property.property"]))
      .toMatchObject({ type: "property.property", id: "102" });
    expect(() => resolveAuthorizedEvidenceCandidate(
      { ...proposal, candidateRefs: [{ evidenceKey: "e99", type: "property.property" }] },
      evidence,
      ["property.property"],
    )).toThrow("INTERACTION_LAB_AUTHORIZED_TARGET_REQUIRED");
    expect(() => resolveAuthorizedEvidenceCandidate(
      { ...proposal, candidateRefs: [{ evidenceKey: "e2", type: "crm.lead" }] },
      evidence,
      ["crm.lead"],
    )).toThrow("INTERACTION_LAB_AUTHORIZED_TARGET_REQUIRED");
  });

  it("does not expose resolved entity ids in the lab effective input", () => {
    expect(sanitizeInteractionLabEffectiveInput({
      property: { type: "property.property", id: "102" },
      scope: "upcoming",
    })).toEqual({ scope: "upcoming" });
  });
});
