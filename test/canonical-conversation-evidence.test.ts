import { describe, expect, it } from "vitest";
import type { EntityRef } from "../server/hostmate/contracts/domain.js";
import type { AgentContentBlock } from "../server/hostmate/contracts/execution-result.js";
import type { AgentMessageRecord, ConversationContextRefs } from "../server/hostmate/control-plane/repository.js";
import {
  auditCanonicalConversationEvidence,
  buildCanonicalConversationEvidence,
} from "../server/hostmate/shadow/canonical-conversation-evidence.js";

const actor = { tenantId: "tenant-a", userId: "user-a" };
const conversationId = "conversation-a";
const lead: EntityRef = { type: "crm.lead", id: "lead-17", label: "Lead Ada" };
const property: EntityRef = { type: "property.property", id: "property-29", label: "Bonavista" };
const visit: EntityRef = { type: "visits.visit", id: "visit-41", label: "Visita Bonavista" };

function message(input: Readonly<{
  id: string;
  sequence: number;
  role?: AgentMessageRecord["role"];
  content?: string;
  contextRefs?: ConversationContextRefs;
  blocks?: readonly AgentContentBlock[];
  tenantId?: string;
  actorUserId?: string;
  conversation?: string;
}>): AgentMessageRecord {
  return {
    messageId: input.id,
    conversationId: input.conversation ?? conversationId,
    tenantId: input.tenantId ?? actor.tenantId,
    actorUserId: input.actorUserId ?? actor.userId,
    role: input.role ?? "assistant",
    contentRedacted: input.content ?? "Resultado",
    contextRefs: input.contextRefs,
    blocks: input.blocks,
    sequence: input.sequence,
    createdAt: input.sequence * 1_000,
  };
}

function fixture(): readonly AgentMessageRecord[] {
  return [
    message({
      id: "m1", sequence: 1, role: "user", content: "Busca el piso de Bonavista",
      contextRefs: { selected: { lead }, referenced: [lead] },
    }),
    message({
      id: "m2", sequence: 2, content: "He encontrado el inmueble.",
      contextRefs: { selected: { lead, property }, referenced: [lead, property] },
      blocks: [{
        type: "entity_list", title: "Inmuebles", items: [{
          ref: property, title: "Piso Bonavista", subtitle: "Barcelona · 3 habitaciones",
          fields: [
            { label: "Precio", value: "450.000 €" },
            { label: "Contacto", value: "ada@example.test · +34 600 123 456" },
          ],
        }],
      }],
    }),
    message({
      id: "m3", sequence: 3, content: "Esta es la visita vinculada.",
      contextRefs: { selected: { lead, property, visit }, referenced: [lead, property, visit] },
      blocks: [{
        type: "entity_list", title: "Visitas", items: [{
          ref: visit, title: "Visita Bonavista", subtitle: "30 ago 2026 · 19:00", fields: [{ label: "Estado", value: "confirmed" }],
        }],
      }],
    }),
  ];
}

describe("CanonicalConversationEvidence shadow adapter", () => {
  it("captures selected, referenced, blocks and emitted refs with stable opaque keys", () => {
    const messages = fixture();
    const evidence = buildCanonicalConversationEvidence({ actor, conversationId, messages });
    const reversed = buildCanonicalConversationEvidence({ actor, conversationId, messages: [...messages].reverse() });

    expect(evidence.currentSelection).toMatchObject({
      lead: { evidenceKey: "e1", type: "crm.lead", source: "selected" },
      property: { evidenceKey: "e2", type: "property.property", source: "selected" },
      visit: { evidenceKey: "e3", type: "visits.visit", source: "selected" },
    });
    expect(evidence.referencedEntities.map((item) => item.evidenceKey)).toEqual(["e1", "e2", "e3"]);
    expect(evidence.emittedEntityRefs.map((item) => item.evidenceKey)).toEqual(["e2", "e3"]);
    expect(evidence.candidateRefs.map((item) => item.evidenceKey)).toEqual(["e1", "e2", "e3"]);
    expect(reversed).toEqual(evidence);
    expect(auditCanonicalConversationEvidence(evidence)).toMatchObject({
      completeness: 1,
      invalidOpaqueKeys: [],
      missingCandidateIndexKeys: [],
      relationContradictions: [],
      crossScopeMessages: 0,
      pass: true,
    });
  });

  it("keeps real refs in the internal index while exposing only opaque candidate keys", () => {
    const evidence = buildCanonicalConversationEvidence({ actor, conversationId, messages: fixture() });
    expect(evidence.entityIndex.e2?.ref).toEqual(property);
    expect(evidence.candidateRefs[1]).not.toHaveProperty("ref");
    expect(evidence.candidateRefs[1]).not.toHaveProperty("id");
    expect(JSON.stringify(evidence.recentResultEvidence)).not.toContain("property-29");
  });

  it("exposes factual visual order and recency without interpreting the user's language", () => {
    const first: EntityRef = { type: "property.property", id: "property-1", label: "Bonavista 3 hab" };
    const second: EntityRef = { type: "property.property", id: "property-2", label: "Bonavista 4 hab" };
    const evidence = buildCanonicalConversationEvidence({
      actor,
      conversationId,
      messages: [
        message({
          id: "list", sequence: 1, blocks: [{
            type: "entity_list", title: "Inmuebles", items: [
              { ref: first, title: "Bonavista 3 hab", fields: [] },
              { ref: second, title: "Bonavista 4 hab", fields: [] },
            ],
          }],
        }),
        message({
          id: "detail", sequence: 2, blocks: [{
            type: "entity_detail", ref: second, title: "Bonavista 4 hab", sections: [],
          }],
        }),
      ],
    });

    expect(evidence.orderedContext).toEqual({
      recentResultSets: [{
        recency: 1,
        type: "entity_list",
        sequence: 1,
        items: [
          { position: 1, evidenceKey: "e1", type: "property.property", label: "Bonavista 3 hab" },
          { position: 2, evidenceKey: "e2", type: "property.property", label: "Bonavista 4 hab" },
        ],
      }],
      recentFocusedEntities: [{ recency: 1, evidenceKey: "e2", type: "property.property", label: "Bonavista 4 hab" }],
    });
    expect(evidence).not.toHaveProperty("ordinalResolution");
    expect(evidence).not.toHaveProperty("anaphoraResolution");
  });

  it("collapses repeated renders of the same focused card", () => {
    const detail = (): AgentContentBlock => ({ type: "entity_detail", ref: property, title: "Bonavista", sections: [] });
    const evidence = buildCanonicalConversationEvidence({
      actor,
      conversationId,
      messages: [
        message({ id: "detail-1", sequence: 1, blocks: [detail()] }),
        message({ id: "detail-2", sequence: 2, blocks: [detail()] }),
      ],
    });
    expect(evidence.orderedContext.recentFocusedEntities).toEqual([
      { recency: 1, evidenceKey: "e1", type: "property.property", label: "Bonavista" },
    ]);
  });

  it("sanitizes PII and never captures confirmation credentials", () => {
    const original = fixture();
    const before = structuredClone(original);
    const confirmation: AgentContentBlock = {
      type: "action_confirmation",
      draftId: "draft-secret-id",
      confirmationToken: "confirmation-secret-token",
      title: "Actualizar lead",
      description: "Enviar a ada@example.test o +34 600 123 456",
      target: lead,
      changes: [{ field: "Email", from: "ada@example.test", to: "new@example.test" }],
      risk: "R1",
      expiresAt: 123_456,
    };
    const evidence = buildCanonicalConversationEvidence({
      actor,
      conversationId,
      messages: [...original, message({ id: "m4", sequence: 4, blocks: [confirmation] })],
    });
    const serializedBlocks = JSON.stringify(evidence.recentResultEvidence);
    expect(serializedBlocks).toContain("[email]");
    expect(serializedBlocks).toContain("[phone]");
    expect(serializedBlocks).not.toContain("confirmation-secret-token");
    expect(serializedBlocks).not.toContain("draft-secret-id");
    expect(original).toEqual(before);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.candidateRefs)).toBe(true);
  });

  it.each([
    ["foreign tenant", { tenantId: "tenant-b" }],
    ["foreign user", { actorUserId: "user-b" }],
    ["foreign conversation", { conversation: "conversation-b" }],
  ])("fails closed for a %s message", (_label, override) => {
    const contaminated = [...fixture(), message({ id: "foreign", sequence: 4, ...override })];
    expect(() => buildCanonicalConversationEvidence({ actor, conversationId, messages: contaminated }))
      .toThrow("CANONICAL_EVIDENCE_SCOPE_MISMATCH");
  });

  it("captures only structured Multi-Agent relations and reports no contradiction", () => {
    const multi: AgentContentBlock = {
      type: "multi_agent_summary",
      title: "Análisis",
      status: "complete",
      sections: [
        { key: "lead", title: "Lead", availability: "available", summary: "Lead", items: [{ ref: lead, title: "Ada" }] },
        { key: "visits", title: "Visitas", availability: "available", summary: "Una", items: [{ ref: visit, title: "Visita" }] },
        { key: "properties", title: "Inmuebles", availability: "available", summary: "Uno", items: [{ ref: property, title: "Bonavista" }] },
      ],
    };
    const evidence = buildCanonicalConversationEvidence({
      actor,
      conversationId,
      messages: [message({
        id: "multi", sequence: 1, blocks: [multi],
        contextRefs: { selected: { lead }, referenced: [lead, visit, property] },
      })],
    });
    expect(evidence.knownRelations).toEqual([
      expect.objectContaining({ fromKey: "e1", toKey: "e2", relation: "lead_visit", source: "multi_agent_summary" }),
      expect.objectContaining({ fromKey: "e1", toKey: "e3", relation: "lead_property", source: "multi_agent_summary" }),
    ]);
    expect(auditCanonicalConversationEvidence(evidence).relationContradictions).toEqual([]);
  });

  it("limits history and result evidence without silently truncating the selected context", () => {
    const messages = Array.from({ length: 15 }, (_, index) => message({
      id: `m${index + 1}`, sequence: index + 1, role: index % 2 ? "assistant" : "user",
      content: `Turno ${index + 1}`,
      contextRefs: index === 14 ? { selected: { property }, referenced: [property] } : undefined,
      blocks: index >= 10 ? [{ type: "entity_list", title: "Resultado", items: [{ ref: property, title: "Bonavista", fields: [] }] }] : undefined,
    }));
    const evidence = buildCanonicalConversationEvidence({ actor, conversationId, messages, historyWindow: 10, resultWindow: 3 });
    expect(evidence.conversationHistory).toHaveLength(10);
    expect(evidence.conversationHistory[0]?.content).toBe("Turno 6");
    expect(evidence.recentResultEvidence).toHaveLength(3);
    expect(evidence.currentSelection.property?.evidenceKey).toBe("e1");
    expect(evidence.captureMetrics).toMatchObject({ inputMessages: 15, historyMessages: 10, resultBlocks: 3, orderedResultSets: 3 });
  });
});
