import { describe, expect, it, vi } from "vitest";
import {
  resolveTenantPropertyCandidate,
  tenantPropertyCandidateRef,
  tenantPropertyCandidatesBlock,
  type TenantPropertyCandidate,
} from "../server/hostmate/interaction/property-candidate-grounding.js";

const candidates: readonly TenantPropertyCandidate[] = [
  {
    id: "865", reference: "BONA-3", title: "Bonavista 3 habitaciones",
    address: "Carrer Bonavista 1", neighborhood: "Gràcia", city: "Barcelona",
    price: 450_000, rooms: 3, bathrooms: 2, areaBuilt: 90,
    propertySubtype: "piso", character: { has_terrace: true }, descriptionExcerpt: "Reformado",
  },
  {
    id: "866", reference: "BONA-4", title: "Bonavista 4 habitaciones",
    address: "Carrer Bonavista 8", neighborhood: "Gràcia", city: "Barcelona",
    price: 520_000, rooms: 4, bathrooms: 2, areaBuilt: 115,
    propertySubtype: "piso", character: null, descriptionExcerpt: "Amplio",
  },
];

const evidence = {
  currentSelection: {},
  referencedEntities: [],
  recentResultEvidence: [],
  conversationHistory: [{ role: "user", content: "Hablábamos de Bonavista" }],
  candidateRefs: [],
  orderedContext: { recentResultSets: [], recentFocusedEntities: [] },
};

function runtimeSelecting(toolName: "select_property_candidate" | "ask_property_clarification", args: Record<string, unknown>) {
  return {
    run: vi.fn(async (request: { prompt: string; tools: Array<{ name: string; handle: (input: Record<string, unknown>) => Promise<{ text: string; success?: boolean }> }> }) => {
      const tool = request.tools.find((candidate) => candidate.name === toolName)!;
      const output = await tool.handle(args);
      return {
        resolvedModel: "test/model", latencyMs: 8,
        detailedUsage: { inputTokens: 120, outputTokens: 9, costUsd: 0.001 },
        toolResults: [{ toolName: tool.name, text: output.text, success: output.success !== false }],
      };
    }),
  };
}

describe("shared Property candidate grounding", () => {
  it("lets the LLM select one opaque candidate without exposing database IDs", async () => {
    const runtime = runtimeSelecting("select_property_candidate", { candidateKey: "p2" });
    const result = await resolveTenantPropertyCandidate({
      query: "Bonavista de cuatro habitaciones",
      currentMessage: "¿Cuánto cuesta el de Bonavista de cuatro habitaciones?",
      evidence,
      search: { query: "Bonavista", total: 2, items: candidates, latencyMs: 2 },
      runtime: runtime as never,
      model: "test/model",
      reasoningEffort: "none",
    });

    expect(result).toMatchObject({ outcome: "selected", candidate: { id: "866" } });
    const request = runtime.run.mock.calls[0]![0];
    expect(request.prompt).toContain("Bonavista 4 habitaciones");
    expect(request.prompt).not.toContain('"id":"865"');
    expect(request.prompt).not.toContain('"id":"866"');
  });

  it("fails closed when the model returns a key outside the supplied set", async () => {
    const runtime = runtimeSelecting("select_property_candidate", { candidateKey: "p9" });
    const result = await resolveTenantPropertyCandidate({
      query: "Bonavista",
      currentMessage: "Enséñame el de Bonavista",
      evidence,
      search: { query: "Bonavista", total: 2, items: candidates, latencyMs: 2 },
      runtime: runtime as never,
      model: "test/model",
      reasoningEffort: "none",
    });

    expect(result).toMatchObject({ outcome: "needs_input" });
  });

  it("preserves a discriminating clarification produced by the LLM", async () => {
    const runtime = runtimeSelecting("ask_property_clarification", {
      question: "¿Te refieres al de 3 habitaciones o al de 4?",
    });
    const result = await resolveTenantPropertyCandidate({
      query: "Bonavista",
      currentMessage: "¿Cuánto cuesta el piso de Bonavista?",
      evidence,
      search: { query: "Bonavista", total: 2, items: candidates, latencyMs: 2 },
      runtime: runtime as never,
      model: "test/model",
      reasoningEffort: "none",
    });

    expect(result).toEqual(expect.objectContaining({
      outcome: "needs_input",
      question: "¿Te refieres al de 3 habitaciones o al de 4?",
    }));
  });

  it("renders factual ordered candidates without choosing one", () => {
    expect(candidates.map(tenantPropertyCandidateRef)).toMatchObject([
      { type: "property.property", id: "865" },
      { type: "property.property", id: "866" },
    ]);
    expect(tenantPropertyCandidatesBlock(candidates)).toMatchObject({
      type: "entity_list",
      items: [
        { ref: { id: "865" }, fields: expect.arrayContaining([{ label: "Habitaciones", value: "3" }]) },
        { ref: { id: "866" }, fields: expect.arrayContaining([{ label: "Habitaciones", value: "4" }]) },
      ],
    });
  });
});
