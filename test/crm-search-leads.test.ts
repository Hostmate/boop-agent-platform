import { describe, expect, it, vi } from "vitest";
import { createActorContext } from "../server/hostmate/contracts/actor-context.js";
import type { ControlPlaneRepository } from "../server/hostmate/control-plane/repository.js";
import { DefaultPolicyEngine } from "../server/hostmate/policy/engine.js";
import {
  LeadContextPortError,
  createCrmGetLeadContextTool,
  crmGetLeadContextInputSchema,
  type LeadContextPort,
} from "../server/hostmate/product-tools/crm/get-lead-context.js";
import {
  CRM_SEARCH_LEADS_TOOL_ID,
  createCrmSearchLeadsTool,
  crmSearchLeadsInputSchema,
  toCrmSearchExecutionResult,
  type LeadSearchPort,
} from "../server/hostmate/product-tools/crm/search-leads.js";
import {
  LeadVisitsPortError,
  VISITS_LIST_LEAD_VISITS_TOOL_ID,
  createListLeadVisitsTool,
  listLeadVisitsInputSchema,
  type LeadVisitsPort,
} from "../server/hostmate/product-tools/visits/list-lead-visits.js";
import {
  createGetVisitTool,
  getVisitInputSchema,
  VisitDetailPortError,
  type VisitDetailPort,
} from "../server/hostmate/product-tools/visits/get-visit.js";
import { OpenRouterAdapter } from "../server/hostmate/runtime/openrouter-adapter.js";
import { ProductToolRegistry } from "../server/hostmate/tools/registry.js";
import { CrmSearchLeadsVerticalSlice, normalizeStoredContext } from "../server/hostmate/vertical-slices/crm-search-leads.js";

function actor(tenantId = "7", permissions: string[] = ["crm.read", "visits.read"]) {
  return createActorContext({ tenantId, userId: "10", role: "agent", isSuperAdmin: false, permissions, locale: "es-ES", timezone: "Europe/Madrid", sessionId: "s-10", permissionsVersion: "v1" });
}

function visitDetailPort(overrides?: Partial<VisitDetailPort>): VisitDetailPort {
  return {
    getVisit: async (_actor, input) => ({
      kind: input.visit.type === "visits.group_visit" ? "group" : "individual",
      id: input.visit.id,
      at: "2099-08-20T10:00:00.000Z",
      status: input.visit.type === "visits.group_visit" ? "active" : "confirmed",
      visitType: "presencial",
      durationMinutes: 45,
      property: { id: "55", title: "Ático Centro", reference: "REF-55", address: "Calle Mayor 1" },
      lead: { id: "123", name: "Juan García" },
      assignedAgent: { id: "10", name: "Ana" },
      ...(input.visit.type === "visits.group_visit"
        ? { registration: { status: "confirmed", capacity: 10, registeredCount: 4, availableCapacity: 6 } }
        : { clientConfirmation: "confirmed", state: { isGroupSlot: false }, lastReschedule: null }),
      telemetry: { services: ["visit.service.getById"], latencyMs: 14 },
    }),
    ...overrides,
  } as VisitDetailPort;
}

function output(count: number) {
  return {
    total: count, page: 1, limit: 5,
    matches: Array.from({ length: count }, (_, index) => ({
      id: String(index + 1), name: index ? "Juan García López" : "Juan García",
      status: "new", ref: { type: "crm.lead", id: String(index + 1), label: index ? "Juan García López" : "Juan García", deepLink: `/conversations?leadId=${index + 1}` },
    })),
  };
}

function contextPort(overrides?: Partial<LeadContextPort>): LeadContextPort {
  return {
    getContext: async (_actor, input) => ({
      lead: { id: input.lead.id, name: input.lead.label ?? "Juan García", phone: "+34600123456", email: "juan@example.com", status: "qualified" },
      assignedAgent: { id: "10", name: "Ana" },
      property: { id: "55", title: "Ático Centro", reference: "REF-55", price: 350000 },
      opportunity: { id: "3", status: "qualified" }, activeDemand: { id: "4", city: "Madrid", priceMax: 400000 },
      nextVisit: { id: "91", at: "2099-08-20T10:00:00.000Z", status: "confirmed" },
      pendingTasks: [{ id: "5", title: "Llamar", priority: "high" }],
      telemetry: { services: ["lead.service.getById"], latencyMs: 11 },
    }),
    ...overrides,
  };
}

function visitsPort(overrides?: Partial<LeadVisitsPort>): LeadVisitsPort {
  return {
    listLeadVisits: async (_actor, input) => ({
      lead: { id: input.lead.id, name: input.lead.label ?? "Juan García" },
      visits: [{
        id: "91", kind: "individual", at: "2099-08-20T10:00:00.000Z", status: "confirmed",
        property: { id: "55", title: "Ático Centro", reference: "REF-55", address: "Calle Mayor 1" },
        assignedAgent: { name: "Ana" }, visitType: "presencial", durationMinutes: 45,
        clientConfirmation: "confirmed", isGroup: false,
      }],
      metadata: { scope: input.scope, status: input.status, total: 1, returned: 1, hasMore: false, limit: 10 },
      telemetry: { services: ["lead.service.getById", "visit.service.listByLead"], latencyMs: 12 },
    }),
    ...overrides,
  };
}

describe("crm.search_leads.v1 contract", () => {
  it("accepts only real bounded filters and rejects authority or entity injection", () => {
    expect(crmSearchLeadsInputSchema.parse({ query: "Juan", city: "Madrid", status: "new" })).toMatchObject({ query: "Juan", city: "Madrid" });
    for (const malicious of [
      { query: "Juan", tenantId: "9" }, { query: "Juan", tenant_id: 9 }, { query: "Juan", leadId: 44 },
      { query: "Juan", entityRef: { type: "crm.lead", id: "44" } }, { query: "Juan", assignedAgentId: 12 },
    ]) expect(crmSearchLeadsInputSchema.safeParse(malicious).success).toBe(false);
    expect(crmSearchLeadsInputSchema.safeParse({}).success).toBe(false);
    expect(crmSearchLeadsInputSchema.safeParse({ query: "x" }).success).toBe(false);
    expect(crmSearchLeadsInputSchema.safeParse({ query: "Juan", limit: 11 }).success).toBe(false);
  });

  it("keeps ActorContext in the handler closure and sanitizes raw service entities", async () => {
    const port: LeadSearchPort = { search: vi.fn(async (seenActor, input) => ({
      items: [{ id: 17, client_name: `Juan T${seenActor.tenantId}`, client_phone: "+34 600 123 456", client_email: "juan@example.com", status: "new", property_title: "Ático", property_ref: "REF-1", agent_name: "Ana", created_at: "2026-08-15T08:00:00Z", tenant_id: 999, raw_email_html: "secret" } as any],
      total: 1, page: input.page, limit: input.limit, telemetry: { service: "lead.service.list", latencyMs: 12 },
    })) };
    const tool = createCrmSearchLeadsTool({ port });
    const result = await tool.handler({ query: "Juan" }, actor("7")) as any;
    expect(port.search).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "7" }), expect.not.objectContaining({ tenantId: expect.anything() }));
    expect(result.matches[0]).toMatchObject({
      id: "17", name: "Juan T7", phone: "••• •• 3456", email: "j•••@example.com",
      ref: { type: "crm.lead", id: "17", deepLink: "/conversations?leadId=17" },
    });
    expect(JSON.stringify(result)).not.toMatch(/tenant_id|raw_email_html|600 123 456|secret/);
  });

  it("blocks direct malicious handler calls before touching the domain port", async () => {
    const port: LeadSearchPort = { search: vi.fn() };
    const tool = createCrmSearchLeadsTool({ port });
    await expect(tool.handler({ query: "Juan", tenantId: "9" } as any, actor("7"))).rejects.toThrow();
    expect(port.search).not.toHaveBeenCalled();
  });

  it("preserves tenant A/B isolation and normal-agent permission scope", async () => {
    const seen: string[] = [];
    const port: LeadSearchPort = { search: async (seenActor, input) => {
      seen.push(seenActor.tenantId);
      return { items: [{ id: seenActor.tenantId, client_name: `Lead ${seenActor.tenantId}` }], total: 1, page: input.page, limit: input.limit };
    } };
    const tool = createCrmSearchLeadsTool({ port });
    expect((await tool.handler({ query: "Lead" }, actor("7")) as any).matches[0].id).toBe("7");
    expect((await tool.handler({ query: "Lead" }, actor("9")) as any).matches[0].id).toBe("9");
    expect(seen).toEqual(["7", "9"]);

    const registry = new ProductToolRegistry([tool]);
    const denied = registry.resolve({ profileId: "crm", objectiveCapabilities: ["crm.lead.search"], actor: actor("7", []), featureEnabled: () => true, readOnly: true });
    expect(denied.tools).toHaveLength(0);
    expect(denied.rejected).toEqual([{ toolId: CRM_SEARCH_LEADS_TOOL_ID, reason: "missing_permission" }]);
  });

  it("uses deterministic unique, multiple and zero-result semantics", () => {
    expect(toCrmSearchExecutionResult(output(0))).toMatchObject({ status: "completed", entities: [] });
    expect(toCrmSearchExecutionResult(output(1))).toMatchObject({ status: "completed", entities: [{ id: "1" }] });
    expect(toCrmSearchExecutionResult(output(2))).toMatchObject({ status: "needs_input", blocks: [{ type: "entity_list" }] });
  });

  it("passes name, phone, email, city and supported combinations through the same service port", async () => {
    const calls: any[] = [];
    const tool = createCrmSearchLeadsTool({ port: { search: async (_actor, input) => { calls.push(input); return { items: [], total: 0, page: input.page, limit: input.limit }; } } });
    for (const input of [{ query: "Juan García" }, { query: "+34600123456" }, { query: "juan@example.com" }, { city: "Madrid" }, { query: "Juan", city: "Madrid", status: "qualified" as const }]) {
      await tool.handler(input, actor());
    }
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ query: "Juan García" }), expect.objectContaining({ query: "+34600123456" }),
      expect.objectContaining({ query: "juan@example.com" }), expect.objectContaining({ city: "Madrid" }),
      expect.objectContaining({ query: "Juan", city: "Madrid", status: "qualified" }),
    ]));
  });
});

describe("crm.get_lead_context.v1 contract", () => {
  it("accepts only a real crm.lead EntityRef and rejects search/authority injection", () => {
    expect(crmGetLeadContextInputSchema.parse({ lead: { type: "crm.lead", id: "123" } })).toMatchObject({ lead: { id: "123" } });
    for (const malicious of [
      { query: "Juan" }, { lead: { type: "crm.property", id: "123" } },
      { lead: { type: "crm.lead", id: "not-a-real-id" } },
      { lead: { type: "crm.lead", id: "123", tenantId: "9" } },
      { lead: { type: "crm.lead", id: "123" }, userId: "11" },
    ]) expect(crmGetLeadContextInputSchema.safeParse(malicious).success).toBe(false);
  });

  it("revalidates through ActorContext and returns a sanitized bounded DTO", async () => {
    const port = contextPort({ getContext: vi.fn(contextPort().getContext) });
    const tool = createCrmGetLeadContextTool({ port });
    const result = await tool.handler({ lead: { type: "crm.lead", id: "123", label: "Juan García" } }, actor()) as any;
    expect(port.getContext).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "7", userId: "10" }), expect.objectContaining({ lead: { type: "crm.lead", id: "123", label: "Juan García" } }));
    expect(result).toMatchObject({
      lead: {
        name: "Juan García", phone: "••• •• 3456", email: "j•••@example.com",
        ref: { type: "crm.lead", id: "123", deepLink: "/conversations?leadId=123" },
      },
      property: { title: "Ático Centro" }, pendingTasks: [{ title: "Llamar" }],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("tenantId");
    expect(serialized).not.toContain("tenant_id");
    expect(serialized).not.toContain("+34600123456");
    expect(serialized).not.toContain("juan@example.com");
    expect(result.assignedAgent).toEqual({ name: "Ana" });
  });

  it("preserves typed authorization failures from the domain adapter", async () => {
    const tool = createCrmGetLeadContextTool({ port: contextPort({ getContext: async () => { throw new LeadContextPortError("PERMISSION_DENIED", "reassigned"); } }) });
    await expect(tool.handler({ lead: { type: "crm.lead", id: "123" } }, actor())).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });
});

describe("visits.list_lead_visits.v1 contract", () => {
  it("accepts only a resolved crm.lead EntityRef and backend-owned real filters", () => {
    expect(listLeadVisitsInputSchema.parse({ lead: { type: "crm.lead", id: "123" }, scope: "upcoming", status: "confirmed" })).toMatchObject({ scope: "upcoming" });
    for (const malicious of [
      { query: "Juan" }, { leadId: 123 }, { lead: { type: "visits.visit", id: "123" } },
      { lead: { type: "crm.lead", id: "123", tenantId: "9" } },
      { lead: { type: "crm.lead", id: "123" }, tenant_id: 9 },
      { lead: { type: "crm.lead", id: "123" }, status: "rescheduled" },
      { lead: { type: "crm.lead", id: "123" }, limit: 10000 },
    ]) expect(listLeadVisitsInputSchema.safeParse(malicious).success).toBe(false);
  });

  it("keeps authority in ActorContext, emits durable visit refs and strips domain internals", async () => {
    const port = visitsPort({ listLeadVisits: vi.fn(async (_actor, input) => ({
      ...(await visitsPort().listLeadVisits(_actor, input)),
      visits: [{ ...(await visitsPort().listLeadVisits(_actor, input)).visits[0], tenant_id: 9, relation_source: "opportunity", notes: "secret" } as any],
    })) });
    const result = await createListLeadVisitsTool({ port }).handler({ lead: { type: "crm.lead", id: "123", label: "Juan" }, scope: "upcoming" }, actor()) as any;
    expect(port.listLeadVisits).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "7", userId: "10" }), expect.not.objectContaining({ tenantId: expect.anything() }));
    expect(result).toMatchObject({
      timezone: "Europe/Madrid",
      lead: { ref: { type: "crm.lead", id: "123", deepLink: "/conversations?leadId=123" } },
      visits: [{ ref: { type: "visits.visit", id: "91", deepLink: "/visits?visitId=91" }, status: "confirmed" }],
    });
    expect(JSON.stringify(result)).not.toMatch(/tenant_id|relation_source|notes|secret/);
  });

  it("preserves typed authorization failures", async () => {
    const tool = createListLeadVisitsTool({ port: visitsPort({ listLeadVisits: async () => { throw new LeadVisitsPortError("STALE_REFERENCE", "merged"); } }) });
    await expect(tool.handler({ lead: { type: "crm.lead", id: "123" } }, actor())).rejects.toMatchObject({ code: "STALE_REFERENCE" });
  });
});

describe("visits.get_visit.v1 contract", () => {
  it("accepts exactly one visit EntityRef and rejects search, authority and lead injection", () => {
    expect(getVisitInputSchema.parse({ visit: { type: "visits.visit", id: "91" } })).toEqual({ visit: { type: "visits.visit", id: "91" } });
    expect(getVisitInputSchema.parse({ visit: { type: "visits.group_visit", id: "7" } })).toEqual({ visit: { type: "visits.group_visit", id: "7" } });
    for (const malicious of [
      { query: "visita de Juan" }, { visitId: 91 }, { lead: { type: "crm.lead", id: "123" } },
      { visit: { type: "crm.lead", id: "91" } }, { visit: { type: "visits.visit", id: "0" } },
      { visit: { type: "visits.visit", id: "91", tenantId: "9" } },
      { visit: { type: "visits.visit", id: "91" }, tenant_id: 9 },
    ]) expect(getVisitInputSchema.safeParse(malicious).success).toBe(false);
  });

  it("sanitizes an individual detail into bounded visit, lead and canonical property refs", async () => {
    const port = visitDetailPort({ getVisit: vi.fn(async (_actor, input) => ({
      ...(await visitDetailPort().getVisit(_actor, input) as any),
      token: "never", google_event_id: "never", notes: "secret", tenant_id: 9, dynamic_answers: { secret: true },
    })) });
    const result = await createGetVisitTool({ port }).handler({ visit: { type: "visits.visit", id: "91", label: "Visita" } }, actor()) as any;
    expect(port.getVisit).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "7", userId: "10" }), { visit: expect.objectContaining({ type: "visits.visit", id: "91" }) });
    expect(result).toMatchObject({
      kind: "individual", status: "confirmed", timezone: "Europe/Madrid",
      ref: { type: "visits.visit", id: "91", deepLink: "/visits?visitId=91" },
      lead: { ref: { type: "crm.lead", id: "123", deepLink: "/conversations?leadId=123" } },
      property: { ref: { type: "property.property", id: "55" } },
    });
    expect(JSON.stringify(result)).not.toMatch(/token|google_event|notes|secret|tenant_id|dynamic_answers/);
  });

  it("returns a discriminated bounded group detail", async () => {
    const result = await createGetVisitTool({ port: visitDetailPort() }).handler({ visit: { type: "visits.group_visit", id: "7" } }, actor()) as any;
    expect(result).toMatchObject({
      kind: "group", status: "active", ref: { type: "visits.group_visit", id: "7", deepLink: "/visits" },
      registration: { status: "confirmed", capacity: 10, registeredCount: 4, availableCapacity: 6 },
    });
    expect(result).not.toHaveProperty("lastReschedule");
  });

  it("requires visits.read and preserves typed current-authorization failures", async () => {
    const tool = createGetVisitTool({ port: visitDetailPort({ getVisit: async () => { throw new VisitDetailPortError("PERMISSION_DENIED", "reassigned"); } }) });
    const registry = new ProductToolRegistry([tool]);
    for (const profileId of ["crm", "visits"] as const) {
      expect(registry.resolve({ profileId, objectiveCapabilities: ["visits.visit.detail"], actor: actor(), featureEnabled: () => true, readOnly: true }).tools)
        .toHaveLength(1);
    }
    expect(registry.resolve({ profileId: "crm", objectiveCapabilities: ["visits.visit.detail"], actor: actor("7", ["crm.read"]), featureEnabled: () => true, readOnly: true }).rejected)
      .toEqual([{ toolId: "visits.get_visit.v1", reason: "missing_permission" }]);
    await expect(tool.handler({ visit: { type: "visits.visit", id: "91" } }, actor())).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });
});

function sse(event: unknown): Response {
  return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function memoryRepository() {
  const state = { conversations: new Set<string>(), messages: [] as any[], runs: new Map<string, any>(), events: [] as any[], attempts: new Map<string, any>(), usage: [] as any[] };
  const repository = {
    async createConversation(_a: any, input: any) { state.conversations.add(input.conversationId); return { ...input, tenantId: "7", ownerUserId: "10", createdAt: Date.now(), updatedAt: Date.now() }; },
    async appendMessage(_a: any, input: any) { state.messages.push(input); return { ...input, tenantId: "7", actorUserId: "10" }; },
    async listMessages(_a: any, input: any) { if (!state.conversations.has(input.conversationId)) throw new Error("missing"); return state.messages; },
    async createRun(_a: any, input: any) { const value = { ...input, tenantId: "7", actorUserId: "10", status: "queued", createdAt: Date.now(), updatedAt: Date.now() }; state.runs.set(input.runId, value); return value; },
    async getRun(_a: any, id: string) { return state.runs.get(id) ?? null; }, async listRuns() { return [...state.runs.values()]; },
    async updateRun(_a: any, id: string, patch: any) { const value = { ...state.runs.get(id), ...patch, updatedAt: Date.now() }; state.runs.set(id, value); return value; },
    async appendEvent(_a: any, input: any) { state.events.push(input); return { ...input, tenantId: "7", actorUserId: "10", payloadRedacted: input.payload }; },
    async listEvents() { return state.events; }, async listUsage() { return state.usage; },
    async createAttempt(_a: any, input: any) { state.attempts.set(input.attemptId, input); return input; },
    async updateAttempt(_a: any, input: any) { const value = { ...state.attempts.get(input.attemptId), ...input.patch }; state.attempts.set(input.attemptId, value); return value; },
    async acquireLease() { return null; }, async heartbeat() { return true; }, async requestCancellation() { throw new Error("unused"); },
    async recordUsage(_a: any, input: any) { state.usage.push(input); },
  } as ControlPlaneRepository;
  return { repository, state };
}

describe("crm.search_leads vertical slice", () => {
  it("records Interaction → Execution, exposes only one tool and avoids a second model call", async () => {
    const fetchMock = vi.fn(async () => sse({
      model: "provider/resolved", provider: "Provider A",
      choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "crm__search_leads_0", arguments: '{"query":"Juan García"}' } }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 50, completion_tokens: 9, cost: 0.002 },
    }));
    const { repository, state } = memoryRepository();
    const port: LeadSearchPort = { search: async (_actor, input) => ({ items: [{ id: 1, client_name: "Juan García" }, { id: 2, client_name: "Juan García López" }], total: 2, page: input.page, limit: input.limit, telemetry: { service: "lead.service.list", latencyMs: 8 } }) };
    const slice = new CrmSearchLeadsVerticalSlice(repository, port, contextPort(), visitsPort(), visitDetailPort(), new OpenRouterAdapter({ apiKey: "test", fetch: fetchMock, maxTransportRetries: 0 }), { model: "requested/model" });
    const result = await slice.execute(actor(), { conversationId: "123e4567-e89b-42d3-a456-426614174000", message: "Busca a Juan García" });
    expect(result.result.status).toBe("needs_input");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.tools).toHaveLength(1);
    expect(body.tool_choice).toBe("required");
    expect(body.tools[0].function.parameters.properties).not.toHaveProperty("tenantId");
    expect(body.tools[0].function.parameters.properties).not.toHaveProperty("limit");
    expect([...state.runs.values()].map((run) => [run.kind, run.profileId, run.toolScope])).toEqual([
      ["interaction", undefined, []], ["execution", "crm", ["crm.search_leads.v1@1"]],
    ]);
    expect(state.events.map((event) => event.type)).toEqual(expect.arrayContaining(["interaction.started", "interaction.dispatch.resolved", "execution.started", "tool.started", "tool.completed", "model.completed", "execution.completed"]));
    expect(state.usage[0]).toMatchObject({ requestedModel: "requested/model", resolvedModel: "provider/resolved", provider: "Provider A", finishReason: "tool_calls", inputTokens: 50, outputTokens: 9, costUsd: 0.002 });
    expect(state.messages.at(-1)).toMatchObject({ role: "assistant", blocks: [{ type: "entity_list" }] });
  });

  it("returns permission_denied before OpenRouter or the domain service", async () => {
    const { repository } = memoryRepository();
    const fetchMock = vi.fn();
    const port = { search: vi.fn() } as LeadSearchPort;
    const slice = new CrmSearchLeadsVerticalSlice(repository, port, contextPort(), visitsPort(), visitDetailPort(), new OpenRouterAdapter({ apiKey: "test", fetch: fetchMock }), { model: "requested/model" });
    const result = await slice.execute(actor("7", []), { conversationId: "123e4567-e89b-42d3-a456-426614174001", message: "Busca a Juan" });
    expect(result.result.status).toBe("permission_denied");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(port.search).not.toHaveBeenCalled();
  });

  it("composes unique search → context in one run with exactly two scoped tools and one inference", async () => {
    const fetchMock = vi.fn(async () => sse({
      model: "provider/resolved", provider: "Provider A",
      choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "crm__search_leads_0", arguments: '{"query":"Juan García"}' } }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 51, completion_tokens: 8, cost: 0.001 },
    }));
    const { repository, state } = memoryRepository();
    const search: LeadSearchPort = { search: async (_actor, input) => ({ items: [{ id: 123, client_name: "Juan García" }], total: 1, page: input.page, limit: input.limit, telemetry: { service: "lead.service.list", latencyMs: 9 } }) };
    const context = contextPort({ getContext: vi.fn(contextPort().getContext) });
    const slice = new CrmSearchLeadsVerticalSlice(repository, search, context, visitsPort(), visitDetailPort(), new OpenRouterAdapter({ apiKey: "test", fetch: fetchMock, maxTransportRetries: 0 }), { model: "requested/model" });
    const turn = await slice.execute(actor(), { conversationId: "123e4567-e89b-42d3-a456-426614174010", message: "Busca a Juan García y dime qué sabemos de él" });
    expect(turn.result).toMatchObject({ status: "completed", data: { search: { total: 1 }, context: { lead: { name: "Juan García" } } } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(context.getContext).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ lead: expect.objectContaining({ id: "123" }) }));
    const execution = [...state.runs.values()].find((run) => run.kind === "execution");
    expect(execution.toolScope).toEqual(["crm.search_leads.v1@1", "crm.get_lead_context.v1@1"]);
    expect(state.events.map((event) => event.type).filter((type) => type === "tool.completed")).toHaveLength(2);
    expect(state.usage).toHaveLength(1);
  });

  it("composes unique search → visits in one CRM run with one inference and exact cross-domain scope", async () => {
    const fetchMock = vi.fn(async () => sse({
      model: "provider/resolved", provider: "Provider A",
      choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "crm__search_leads_0", arguments: '{"query":"Juan García"}' } }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 48, completion_tokens: 8, cost: 0.001 },
    }));
    const { repository, state } = memoryRepository();
    const search: LeadSearchPort = { search: async (_actor, input) => ({ items: [{ id: 123, client_name: "Juan García" }], total: 1, page: input.page, limit: input.limit }) };
    const visits = visitsPort({ listLeadVisits: vi.fn(visitsPort().listLeadVisits) });
    const slice = new CrmSearchLeadsVerticalSlice(repository, search, contextPort(), visits, visitDetailPort(), new OpenRouterAdapter({ apiKey: "test", fetch: fetchMock, maxTransportRetries: 0 }), { model: "requested/model" });
    const turn = await slice.execute(actor(), { conversationId: "123e4567-e89b-42d3-a456-426614174020", message: "¿Qué próximas visitas tiene Juan García?" });
    expect(turn.result).toMatchObject({ status: "completed", data: { search: { total: 1 }, visits: { metadata: { scope: "upcoming" } } } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(visits.listLeadVisits).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ lead: expect.objectContaining({ id: "123" }), scope: "upcoming" }));
    const execution = [...state.runs.values()].find((run) => run.kind === "execution");
    expect(execution.toolScope).toEqual(["crm.search_leads.v1@1", "visits.list_lead_visits.v1@1"]);
    expect(state.usage).toHaveLength(1);
    expect(state.events.find((event) => event.type === "tool.completed" && event.payload.entityRefs)?.payload).toMatchObject({ returned: 1, hasMore: false });
  });

  it("uses selected lead → visits deterministically with zero model calls and preserves lead continuity", async () => {
    const { repository, state } = memoryRepository();
    const fetchMock = vi.fn();
    const search = { search: vi.fn() } as LeadSearchPort;
    const visits = visitsPort({ listLeadVisits: vi.fn(visitsPort().listLeadVisits) });
    const slice = new CrmSearchLeadsVerticalSlice(repository, search, contextPort(), visits, visitDetailPort(), new OpenRouterAdapter({ apiKey: "test", fetch: fetchMock }), { model: "requested/model" });
    const lead = { type: "crm.lead", id: "123", label: "Juan García" };
    const turn = await slice.execute(actor(), { conversationId: "123e4567-e89b-42d3-a456-426614174021", message: "¿Cuál es su próxima visita?", selectedEntityRef: lead });
    expect(turn.result).toMatchObject({ status: "completed", data: { visits: { metadata: { scope: "upcoming" } } } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(search.search).not.toHaveBeenCalled();
    expect(state.usage).toHaveLength(0);
    expect(state.messages.at(-1)).toMatchObject({ contextRefs: { selected: { lead: { type: "crm.lead", id: "123" } } } });
    expect([...state.runs.values()].find((run) => run.kind === "execution").requestedModel).toBeUndefined();
  });

  it("uses a selected visit directly with only get_visit, zero search/list and zero model calls", async () => {
    const { repository, state } = memoryRepository();
    const fetchMock = vi.fn();
    const search = { search: vi.fn() } as LeadSearchPort;
    const visits = visitsPort({ listLeadVisits: vi.fn() });
    const detail = visitDetailPort({ getVisit: vi.fn(visitDetailPort().getVisit) });
    const slice = new CrmSearchLeadsVerticalSlice(repository, search, contextPort(), visits, detail, new OpenRouterAdapter({ apiKey: "test", fetch: fetchMock }), { model: "requested/model" });
    const turn = await slice.execute(actor(), {
      conversationId: "123e4567-e89b-42d3-a456-426614174025", message: "Cuéntame más sobre esta visita",
      selectedEntityRef: { type: "visits.visit", id: "91", label: "Ático Centro" },
    });
    expect(turn.result).toMatchObject({ status: "completed", data: { visitDetail: { kind: "individual", ref: { id: "91" } } } });
    expect(detail.getVisit).toHaveBeenCalledWith(expect.anything(), { visit: expect.objectContaining({ id: "91" }) });
    expect(search.search).not.toHaveBeenCalled();
    expect(visits.listLeadVisits).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.usage).toHaveLength(0);
    const execution = [...state.runs.values()].find((run) => run.kind === "execution");
    expect(execution.toolScope).toEqual(["visits.get_visit.v1@1"]);
    expect(state.messages.at(-1)).toMatchObject({ contextRefs: { selected: { lead: { id: "123" }, visit: { id: "91" } } } });
  });

  it("resolves a visit ordinal from the latest list and keeps selected lead + selected visit across reconnect", async () => {
    const { repository, state } = memoryRepository();
    const fetchMock = vi.fn();
    const search = { search: vi.fn() } as LeadSearchPort;
    const visits = visitsPort({ listLeadVisits: vi.fn(async (_actor, input) => ({
      ...(await visitsPort().listLeadVisits(_actor, input)),
      visits: [
        ...(await visitsPort().listLeadVisits(_actor, input)).visits,
        { ...(await visitsPort().listLeadVisits(_actor, input)).visits[0]!, id: "92", at: "2099-08-21T10:00:00.000Z" },
      ],
      metadata: { scope: input.scope, total: 2, returned: 2, hasMore: false, limit: 10 },
    })) });
    const detail = visitDetailPort({ getVisit: vi.fn(visitDetailPort().getVisit) });
    const conversationId = "123e4567-e89b-42d3-a456-426614174026";
    const firstSlice = new CrmSearchLeadsVerticalSlice(repository, search, contextPort(), visits, detail, new OpenRouterAdapter({ apiKey: "test", fetch: fetchMock }), { model: "requested/model" });
    await firstSlice.execute(actor(), { conversationId, message: "¿Qué visitas tiene?", selectedEntityRef: { type: "crm.lead", id: "123", label: "Juan" } });
    const reconnectedSlice = new CrmSearchLeadsVerticalSlice(repository, search, contextPort(), visits, detail, new OpenRouterAdapter({ apiKey: "test", fetch: fetchMock }), { model: "requested/model" });
    const selected = await reconnectedSlice.execute(actor(), { conversationId, message: "La segunda" });
    const followUp = await reconnectedSlice.execute(actor(), { conversationId, message: "Cuéntame más" });
    expect(selected.result).toMatchObject({ data: { visitDetail: { ref: { id: "92" } } } });
    expect(followUp.result).toMatchObject({ data: { visitDetail: { ref: { id: "92" } } } });
    expect(detail.getVisit).toHaveBeenNthCalledWith(1, expect.anything(), { visit: expect.objectContaining({ id: "92" }) });
    expect(detail.getVisit).toHaveBeenNthCalledWith(2, expect.anything(), { visit: expect.objectContaining({ id: "92" }) });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.messages.at(-1)).toMatchObject({ contextRefs: { selected: { lead: { id: "123" }, visit: { id: "92" } } } });
  });

  it("composes search → upcoming visits → first visit detail in one CRM run and one inference", async () => {
    const fetchMock = vi.fn(async () => sse({
      model: "provider/resolved", provider: "Provider A",
      choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "crm__search_leads_0", arguments: '{"query":"Juan García"}' } }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 44, completion_tokens: 7, cost: 0.001 },
    }));
    const { repository, state } = memoryRepository();
    const search: LeadSearchPort = { search: async (_actor, input) => ({ items: [{ id: 123, client_name: "Juan García" }], total: 1, page: input.page, limit: input.limit }) };
    const visits = visitsPort({ listLeadVisits: vi.fn(visitsPort().listLeadVisits) });
    const detail = visitDetailPort({ getVisit: vi.fn(visitDetailPort().getVisit) });
    const slice = new CrmSearchLeadsVerticalSlice(repository, search, contextPort(), visits, detail, new OpenRouterAdapter({ apiKey: "test", fetch: fetchMock, maxTransportRetries: 0 }), { model: "requested/model" });
    const turn = await slice.execute(actor(), { conversationId: "123e4567-e89b-42d3-a456-426614174027", message: "Busca a Juan García, dime su próxima visita y cuéntame más" });
    expect(turn.result).toMatchObject({ data: { search: { total: 1 }, visits: { metadata: { scope: "upcoming" } }, visitDetail: { ref: { id: "91" } } } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(visits.listLeadVisits).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ scope: "upcoming", lead: expect.objectContaining({ id: "123" }) }));
    expect(detail.getVisit).toHaveBeenCalledWith(expect.anything(), { visit: expect.objectContaining({ id: "91" }) });
    const execution = [...state.runs.values()].find((run) => run.kind === "execution");
    expect(execution.toolScope).toEqual(["crm.search_leads.v1@1", "visits.list_lead_visits.v1@1", "visits.get_visit.v1@1"]);
    expect(state.usage).toHaveLength(1);
  });

  it("returns zero visits clearly without adding a model inference", async () => {
    const { repository, state } = memoryRepository();
    const zeroVisits = visitsPort({ listLeadVisits: async (_actor, input) => ({
      lead: { id: input.lead.id, name: "Juan" }, visits: [],
      metadata: { scope: input.scope, status: input.status, total: 0, returned: 0, hasMore: false, limit: 10 },
    }) });
    const fetchMock = vi.fn();
    const slice = new CrmSearchLeadsVerticalSlice(repository, { search: vi.fn() } as LeadSearchPort, contextPort(), zeroVisits, visitDetailPort(), new OpenRouterAdapter({ apiKey: "test", fetch: fetchMock }), { model: "requested/model" });
    const turn = await slice.execute(actor(), { conversationId: "123e4567-e89b-42d3-a456-426614174022", message: "¿Qué visitas tiene?", selectedEntityRef: { type: "crm.lead", id: "123", label: "Juan" } });
    expect(turn.result).toMatchObject({ status: "completed", entities: [], data: { visits: { visits: [] } } });
    expect(turn.result.summary).toContain("no tiene visitas");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.usage).toHaveLength(0);
  });

  it("requests a lead selection for an implicit visit question with no durable context", async () => {
    const { repository } = memoryRepository();
    const fetchMock = vi.fn();
    const search = { search: vi.fn() } as LeadSearchPort;
    const visits = visitsPort({ listLeadVisits: vi.fn() });
    const slice = new CrmSearchLeadsVerticalSlice(repository, search, contextPort(), visits, visitDetailPort(), new OpenRouterAdapter({ apiKey: "test", fetch: fetchMock }), { model: "requested/model" });
    const turn = await slice.execute(actor(), { conversationId: "123e4567-e89b-42d3-a456-426614174024", message: "¿Tiene alguna visita programada?" });
    expect(turn.result).toMatchObject({ status: "needs_input", entities: [] });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(search.search).not.toHaveBeenCalled();
    expect(visits.listLeadVisits).not.toHaveBeenCalled();
  });

  it("does not list visits when the search is ambiguous", async () => {
    const fetchMock = vi.fn(async () => sse({
      model: "provider/resolved", choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "crm__search_leads_0", arguments: '{"query":"Juan"}' } }] }, finish_reason: "tool_calls" }], usage: {},
    }));
    const { repository } = memoryRepository();
    const search: LeadSearchPort = { search: async (_actor, input) => ({ items: [{ id: 1, client_name: "Juan A" }, { id: 2, client_name: "Juan B" }], total: 2, page: input.page, limit: input.limit }) };
    const visits = visitsPort({ listLeadVisits: vi.fn() });
    const slice = new CrmSearchLeadsVerticalSlice(repository, search, contextPort(), visits, visitDetailPort(), new OpenRouterAdapter({ apiKey: "test", fetch: fetchMock, maxTransportRetries: 0 }), { model: "requested/model" });
    const turn = await slice.execute(actor(), { conversationId: "123e4567-e89b-42d3-a456-426614174023", message: "Busca a Juan y dime qué visitas tiene" });
    expect(turn.result.status).toBe("needs_input");
    expect(visits.listLeadVisits).not.toHaveBeenCalled();
  });

  it("does not get context when search is ambiguous", async () => {
    const fetchMock = vi.fn(async () => sse({
      model: "provider/resolved", choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "crm__search_leads_0", arguments: '{"query":"Juan"}' } }] }, finish_reason: "tool_calls" }], usage: {},
    }));
    const { repository } = memoryRepository();
    const search: LeadSearchPort = { search: async (_actor, input) => ({ items: [{ id: 1, client_name: "Juan A" }, { id: 2, client_name: "Juan B" }, { id: 3, client_name: "Juan C" }], total: 3, page: input.page, limit: input.limit }) };
    const context = contextPort({ getContext: vi.fn() });
    const slice = new CrmSearchLeadsVerticalSlice(repository, search, context, visitsPort(), visitDetailPort(), new OpenRouterAdapter({ apiKey: "test", fetch: fetchMock, maxTransportRetries: 0 }), { model: "requested/model" });
    const turn = await slice.execute(actor(), { conversationId: "123e4567-e89b-42d3-a456-426614174011", message: "Busca a Juan y dime qué sabemos de él" });
    expect(turn.result.status).toBe("needs_input");
    expect(turn.result.entities).toHaveLength(3);
    expect(context.getContext).not.toHaveBeenCalled();
  });

  it("returns a deterministic no-result answer without invoking context", async () => {
    const fetchMock = vi.fn(async () => sse({
      model: "provider/resolved", choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "crm__search_leads_0", arguments: '{"query":"Nadie"}' } }] }, finish_reason: "tool_calls" }], usage: {},
    }));
    const { repository } = memoryRepository();
    const search: LeadSearchPort = { search: async (_actor, input) => ({ items: [], total: 0, page: input.page, limit: input.limit }) };
    const context = contextPort({ getContext: vi.fn() });
    const slice = new CrmSearchLeadsVerticalSlice(repository, search, context, visitsPort(), visitDetailPort(), new OpenRouterAdapter({ apiKey: "test", fetch: fetchMock, maxTransportRetries: 0 }), { model: "requested/model" });
    const turn = await slice.execute(actor(), { conversationId: "123e4567-e89b-42d3-a456-426614174014", message: "Busca a Nadie y dime qué sabemos de él" });
    expect(turn.result).toMatchObject({ status: "completed", entities: [], data: { search: { total: 0 } } });
    expect(context.getContext).not.toHaveBeenCalled();
  });

  it("resolves 'el segundo' from conversation EntityRefs and performs no second search or model call", async () => {
    const fetchMock = vi.fn(async () => sse({
      model: "provider/resolved", choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "crm__search_leads_0", arguments: '{"query":"Juan"}' } }] }, finish_reason: "tool_calls" }], usage: {},
    }));
    const { repository, state } = memoryRepository();
    const search = { search: vi.fn(async (_actor, input) => ({ items: [{ id: 1, client_name: "Juan A" }, { id: 2, client_name: "Juan B" }], total: 2, page: input.page, limit: input.limit })) } as LeadSearchPort;
    const context = contextPort({ getContext: vi.fn(contextPort().getContext) });
    const visits = visitsPort({ listLeadVisits: vi.fn(visitsPort().listLeadVisits) });
    const slice = new CrmSearchLeadsVerticalSlice(repository, search, context, visits, visitDetailPort(), new OpenRouterAdapter({ apiKey: "test", fetch: fetchMock, maxTransportRetries: 0 }), { model: "requested/model" });
    const conversationId = "123e4567-e89b-42d3-a456-426614174012";
    await slice.execute(actor(), { conversationId, message: "Busca a Juan" });
    const selected = await slice.execute(actor(), { conversationId, message: "El segundo" });
    const followUp = await slice.execute(actor(), { conversationId, message: "¿Qué sabemos de él?" });
    const visitFollowUp = await slice.execute(actor(), { conversationId, message: "¿Qué visitas tiene?" });
    expect(selected.result).toMatchObject({ status: "completed", entities: [{ id: "2" }] });
    expect(followUp.result).toMatchObject({ status: "completed", entities: [{ id: "2" }] });
    expect(visitFollowUp.result).toMatchObject({ status: "completed", data: { visits: { lead: { ref: { id: "2" } } } } });
    expect(search.search).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(context.getContext).toHaveBeenCalledTimes(2);
    expect(visits.listLeadVisits).toHaveBeenCalledTimes(1);
    expect(visits.listLeadVisits).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ lead: expect.objectContaining({ id: "2" }) }));
    expect(state.messages.find((item) => item.role === "user" && item.contentRedacted === "El segundo")).toMatchObject({ contextRefs: { selected: { lead: { id: "2" } } } });
  });

  it("reuses the selected EntityRef for a pronoun follow-up and revalidates reassignment", async () => {
    const { repository } = memoryRepository();
    const fetchMock = vi.fn();
    const search = { search: vi.fn() } as LeadSearchPort;
    const context = contextPort({ getContext: vi.fn(async () => { throw new LeadContextPortError("PERMISSION_DENIED", "lead reassigned"); }) });
    const slice = new CrmSearchLeadsVerticalSlice(repository, search, context, visitsPort(), visitDetailPort(), new OpenRouterAdapter({ apiKey: "test", fetch: fetchMock }), { model: "requested/model" });
    const conversationId = "123e4567-e89b-42d3-a456-426614174013";
    const first = await slice.execute(actor(), { conversationId, message: "¿Qué sabemos de Juan?", selectedEntityRef: { type: "crm.lead", id: "123", label: "Juan" } });
    expect(first.result).toMatchObject({ status: "permission_denied", errors: [{ code: "PERMISSION_DENIED" }] });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(search.search).not.toHaveBeenCalled();
  });

  it("keeps semantic context roles generic and rejects the pre-foundation array shape", () => {
    expect(normalizeStoredContext({
      selected: { property: { type: "properties.property", id: "55", label: "Ático Centro" } },
      referenced: [{ type: "crm.lead", id: "123" }],
    })).toEqual({
      selected: { property: { type: "properties.property", id: "55", label: "Ático Centro" } },
      referenced: [{ type: "crm.lead", id: "123" }],
    });
    expect(normalizeStoredContext([{ type: "crm.lead", id: "123" }])).toBeUndefined();
  });
});
