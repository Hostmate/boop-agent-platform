import { describe, expect, it, vi } from "vitest";
import { createActorContext } from "../server/hostmate/contracts/actor-context.js";
import type { ControlPlaneRepository } from "../server/hostmate/control-plane/repository.js";
import { classifyInteractionTurn } from "../server/hostmate/interaction/turn-classifier.js";
import {
  PROPERTY_SEARCH_PROPERTIES_TOOL_ID,
  createPropertySearchPropertiesTool,
  propertySearchPropertiesInputSchema,
  toPropertySearchExecutionResult,
  type PropertySearchPort,
  type PropertySearchPropertiesOutput,
} from "../server/hostmate/product-tools/property/search-properties.js";
import { OpenRouterAdapter } from "../server/hostmate/runtime/openrouter-adapter.js";
import { ProductToolRegistry } from "../server/hostmate/tools/registry.js";
import { bindPropertyFiltersToObjective, PropertySearchPropertiesVerticalSlice } from "../server/hostmate/vertical-slices/property-search-properties.js";

function actor(tenantId = "15", permissions: string[] = ["property.read"]) {
  return createActorContext({ tenantId, userId: "43", role: "agent", isSuperAdmin: false, permissions, locale: "es-ES", timezone: "Europe/Madrid", sessionId: "s-43", permissionsVersion: "v1" });
}

function serviceResult(count = 2) {
  return {
    items: Array.from({ length: count }, (_, index) => ({
      id: String(101 + index), reference: `STG-${101 + index}`, title: index ? "Piso Centre" : "Piso Estació",
      operation: "alquilar", propertyType: "piso", price: 1200 + index * 100, currency: "EUR" as const,
      city: "Manresa", neighborhood: index ? "Centre" : "Estació", rooms: 3, bathrooms: 2,
      areaBuilt: 90, status: "activo", imageUrl: "https://images.example.test/piso.jpg",
      features: ["terraza"], associatedAgent: "Agent A",
    })),
    total: count, returned: count, hasMore: false,
    telemetry: { service: "property.service.list" as const, latencyMs: 7 },
  };
}

function output(count: number): PropertySearchPropertiesOutput {
  const tool = createPropertySearchPropertiesTool({ port: { search: async () => serviceResult(count) } });
  return tool.handler({ city: "Manresa" }, actor()) as unknown as PropertySearchPropertiesOutput;
}

function sse(event: unknown): Response {
  return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function memoryRepository() {
  const state = { conversations: new Set<string>(), messages: [] as any[], runs: new Map<string, any>(), events: [] as any[], attempts: new Map<string, any>(), usage: [] as any[] };
  const repository = {
    async createConversation(_a: any, input: any) { state.conversations.add(input.conversationId); return { ...input, tenantId: "15", ownerUserId: "43", createdAt: Date.now(), updatedAt: Date.now() }; },
    async appendMessage(_a: any, input: any) { state.messages.push(input); return { ...input, tenantId: "15", actorUserId: "43" }; },
    async listMessages(_a: any, input: any) { if (!state.conversations.has(input.conversationId)) throw new Error("missing"); return state.messages; },
    async createRun(_a: any, input: any) { const value = { ...input, tenantId: "15", actorUserId: "43", status: "queued", createdAt: Date.now(), updatedAt: Date.now() }; state.runs.set(input.runId, value); return value; },
    async getRun(_a: any, id: string) { return state.runs.get(id) ?? null; }, async listRuns() { return [...state.runs.values()]; },
    async updateRun(_a: any, id: string, patch: any) { const value = { ...state.runs.get(id), ...patch, updatedAt: Date.now() }; state.runs.set(id, value); return value; },
    async appendEvent(_a: any, input: any) { state.events.push(input); return { ...input, tenantId: "15", actorUserId: "43", payloadRedacted: input.payload }; },
    async listEvents() { return state.events; }, async listUsage() { return state.usage; },
    async createAttempt(_a: any, input: any) { state.attempts.set(input.attemptId, input); return input; },
    async updateAttempt(_a: any, input: any) { const value = { ...state.attempts.get(input.attemptId), ...input.patch }; state.attempts.set(input.attemptId, value); return value; },
    async acquireLease() { return null; }, async heartbeat() { return true; }, async requestCancellation() { throw new Error("unused"); },
    async recordUsage(_a: any, input: any) { state.usage.push(input); },
  } as ControlPlaneRepository;
  return { repository, state };
}

describe("property.search_properties.v1 contract", () => {
  it("exposes only real bounded filters and rejects authority, mechanics and invented features", () => {
    expect(propertySearchPropertiesInputSchema.parse({ city: "Manresa", operation: "alquilar", maxPrice: 1500, features: ["terraza"] })).toMatchObject({ city: "Manresa", maxPrice: 1500 });
    for (const malicious of [
      { city: "Manresa", tenantId: "16" }, { city: "Manresa", tenant_id: 16 }, { city: "Manresa", actor: { id: 1 } },
      { city: "Manresa", page: 2 }, { city: "Manresa", limit: 500 }, { city: "Manresa", sort_by: "price" },
      { city: "Manresa", agentId: 43 }, { city: "Manresa", features: ["sauna"] },
    ]) expect(propertySearchPropertiesInputSchema.safeParse(malicious).success).toBe(false);
  });

  it("grounds every model-proposed optional and keeps product defaults outside the model", () => {
    expect(bindPropertyFiltersToObjective({ city: "Manresa", propertyType: "piso", status: "activo", operation: "comprar", rooms: 2 }, "Busca pisos en Manresa")).toEqual({ city: "Manresa", propertyType: "piso" });
    expect(bindPropertyFiltersToObjective({ city: "Manresa" }, "Busca pisos en Manresa")).toEqual({ city: "Manresa", propertyType: "piso" });
    expect(bindPropertyFiltersToObjective({ city: "Manresa" }, "Busca pisos o casas en Manresa")).toEqual({ city: "Manresa" });
    expect(bindPropertyFiltersToObjective({ operation: "alquilar", maxPrice: 1500, status: "activo" }, "Enséñame pisos de alquiler hasta 1.500 €")).toEqual({ operation: "alquilar", propertyType: "piso", maxPrice: 1500 });
    expect(bindPropertyFiltersToObjective({ propertyType: "casa", rooms: 3, features: ["terraza", "piscina"] }, "Busca casas con al menos 3 habitaciones y terraza")).toEqual({ propertyType: "casa", features: ["terraza"] });
    expect(bindPropertyFiltersToObjective({ query: "ABC123", order: "price_asc", city: "Madrid" }, "Encuentra el inmueble con referencia ABC123")).toEqual({ query: "ABC123" });
    expect(bindPropertyFiltersToObjective({ query: "ABC123", maxArea: 100_000_000, maxPrice: 100_000_000 }, "Encuentra el inmueble con referencia ABC123")).toEqual({ query: "ABC123" });
    expect(bindPropertyFiltersToObjective({ city: "Manresa", order: "price_asc" }, "Busca los pisos más baratos en Manresa")).toEqual({ city: "Manresa", propertyType: "piso", order: "price_asc" });
  });

  it("keeps ActorContext in closure, sanitizes DTOs and returns canonical refs", async () => {
    const port: PropertySearchPort = { search: vi.fn(async (seenActor) => ({
      ...serviceResult(1),
      items: [{ ...serviceResult(1).items[0]!, tenant_id: 999, observations: "private", embeddings: [1, 2, 3], actor: seenActor } as any],
    })) };
    const result = await createPropertySearchPropertiesTool({ port }).handler({ city: "Manresa" }, actor("15")) as any;
    expect(port.search).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "15" }), { city: "Manresa" });
    expect(result.matches[0]).toMatchObject({
      id: "101", reference: "STG-101", currency: "EUR",
      ref: { type: "property.property", id: "101", deepLink: "/properties?highlight=101" },
    });
    expect(JSON.stringify(result)).not.toMatch(/tenant_id|observations|embeddings|permissionsVersion|sessionId/);
  });

  it("keeps zero, one and multiple searches completed rather than ambiguous", async () => {
    for (const count of [0, 1, 2]) {
      const resolved = await output(count);
      expect(toPropertySearchExecutionResult(resolved).status).toBe("completed");
    }
  });

  it("requires property.read and only resolves in the property profile", () => {
    const tool = createPropertySearchPropertiesTool({ port: { search: async () => serviceResult(0) } });
    const registry = new ProductToolRegistry([tool]);
    expect(registry.resolve({ profileId: "property", objectiveCapabilities: ["property.property.search"], actor: actor(), featureEnabled: () => true, readOnly: true }).tools).toHaveLength(1);
    expect(registry.resolve({ profileId: "property", objectiveCapabilities: ["property.property.search"], actor: actor("15", []), featureEnabled: () => true, readOnly: true }).rejected)
      .toEqual([{ toolId: PROPERTY_SEARCH_PROPERTIES_TOOL_ID, reason: "missing_permission" }]);
    expect(registry.resolve({ profileId: "crm", objectiveCapabilities: ["property.property.search"], actor: actor(), featureEnabled: () => true, readOnly: true }).tools).toHaveLength(0);
  });
});

describe("Property Interaction → Execution", () => {
  it("detects only property search/follow-up and leaves ordinary CRM work unchanged", () => {
    expect(classifyInteractionTurn({ message: "Busca pisos en Manresa" })).toBe("property");
    expect(classifyInteractionTurn({ message: "Encuentra el inmueble con referencia ABC123" })).toBe("property");
    expect(classifyInteractionTurn({ message: "Busca a Juan García" })).toBe("crm");
    expect(classifyInteractionTurn({ message: "¿Qué visitas tiene Juan?" })).toBe("crm");
    const priorMessages = [{ contextRefs: { selected: { property: { type: "property.property", id: "101", label: "Piso" } }, referenced: [] } }] as any;
    expect(classifyInteractionTurn({ message: "Cuéntame más sobre esta visita", selectedEntityRef: { type: "visits.visit", id: "458" }, priorMessages })).toBe("crm");
    expect(classifyInteractionTurn({ message: "Cuéntame más sobre esta visita", priorMessages })).toBe("crm");
    expect(classifyInteractionTurn({ message: "Cuéntame más", priorMessages })).toBe("property");
  });

  it("records a property run with exactly one tool, one inference and sanitized telemetry", async () => {
    const fetchMock = vi.fn(async () => sse({
      model: "provider/resolved", provider: "Provider A",
      choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "property__search_properties_0", arguments: '{"city":"Manresa","propertyType":"piso","status":"activo","operation":"comprar"}' } }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 64, completion_tokens: 12, cost: 0.0025 },
    }));
    const { repository, state } = memoryRepository();
    const port: PropertySearchPort = { search: vi.fn(async () => serviceResult(2)) };
    const slice = new PropertySearchPropertiesVerticalSlice(repository, port, new OpenRouterAdapter({ apiKey: "test", fetch: fetchMock, maxTransportRetries: 0 }), { model: "requested/model" });
    const turn = await slice.execute(actor(), { conversationId: "123e4567-e89b-42d3-a456-426614174100", message: "Busca pisos en Manresa" });
    expect(turn.result).toMatchObject({ status: "completed", data: { appliedFilters: { city: "Manresa", propertyType: "piso" }, returned: 2 } });
    expect(port.search).toHaveBeenCalledWith(expect.anything(), { city: "Manresa", propertyType: "piso" });
    const request = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    expect(request.tools).toHaveLength(1);
    expect(request.tools[0].function.parameters.properties).not.toHaveProperty("tenantId");
    expect(request.tools[0].function.parameters.properties).not.toHaveProperty("limit");
    expect([...state.runs.values()].map((run) => [run.kind, run.profileId, run.toolScope])).toEqual([
      ["interaction", undefined, []], ["execution", "property", ["property.search_properties.v1@1"]],
    ]);
    expect(state.usage).toHaveLength(1);
    expect(state.events.find((event) => event.type === "tool.completed")?.payload).toMatchObject({
      inputRequested: { city: "Manresa", propertyType: "piso", status: "activo", operation: "comprar" },
      inputSanitized: { city: "Manresa", propertyType: "piso" }, resultCount: 2,
    });
  });

  it("persists selected.property without deleting lead and refuses invented detail with zero inference", async () => {
    const fetchMock = vi.fn(async () => sse({
      model: "provider/resolved", choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "property__search_properties_0", arguments: '{"city":"Manresa"}' } }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 30, completion_tokens: 6, cost: 0.001 },
    }));
    const { repository, state } = memoryRepository();
    const conversationId = "123e4567-e89b-42d3-a456-426614174101";
    await repository.createConversation(actor(), { conversationId, title: "AI Chat" });
    await repository.appendMessage(actor(), {
      messageId: "seed", conversationId, role: "system", contentRedacted: "lead context",
      contextRefs: { selected: { lead: { type: "crm.lead", id: "4995", label: "Lead fixture" } }, referenced: [] }, sequence: 1, createdAt: Date.now(),
    });
    const slice = new PropertySearchPropertiesVerticalSlice(repository, { search: async () => serviceResult(1) }, new OpenRouterAdapter({ apiKey: "test", fetch: fetchMock }), { model: "requested/model" });
    const search = await slice.execute(actor(), { conversationId, message: "Busca inmuebles en Manresa" });
    const ref = search.result.entities[0]!;
    await slice.execute(actor(), { conversationId, message: "Selecciona Piso Estació", selectedEntityRef: ref });
    const selectedMessage = state.messages.at(-1);
    expect(selectedMessage.contextRefs.selected).toMatchObject({ lead: { id: "4995" }, property: { type: "property.property", id: "101" } });
    const followUp = await slice.execute(actor(), { conversationId, message: "Cuéntame más" });
    expect(followUp.executionRunId).toBeUndefined();
    expect(followUp.result.summary).toMatch(/todavía no está habilitada/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.usage).toHaveLength(1);
  });

  it("blocks a known cross-tenant or fabricated property ID without model or domain calls", async () => {
    const fetchMock = vi.fn();
    const port = { search: vi.fn() } as PropertySearchPort;
    const { repository } = memoryRepository();
    const conversationId = "123e4567-e89b-42d3-a456-426614174102";
    await repository.createConversation(actor(), { conversationId, title: "AI Chat" });
    const slice = new PropertySearchPropertiesVerticalSlice(repository, port, new OpenRouterAdapter({ apiKey: "test", fetch: fetchMock }), { model: "requested/model" });
    const turn = await slice.execute(actor(), {
      conversationId, message: "Selecciona este inmueble",
      selectedEntityRef: { type: "property.property", id: "852", label: "Cross tenant" },
    });
    expect(turn.result).toMatchObject({ status: "permission_denied", errors: [{ code: "STALE_REFERENCE" }] });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(port.search).not.toHaveBeenCalled();
  });
});
