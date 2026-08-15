import { describe, expect, it, vi } from "vitest";
import { createActorContext } from "../server/hostmate/contracts/actor-context.js";
import type { ControlPlaneRepository } from "../server/hostmate/control-plane/repository.js";
import { DefaultPolicyEngine } from "../server/hostmate/policy/engine.js";
import {
  CRM_SEARCH_LEADS_TOOL_ID,
  createCrmSearchLeadsTool,
  crmSearchLeadsInputSchema,
  toCrmSearchExecutionResult,
  type LeadSearchPort,
} from "../server/hostmate/product-tools/crm/search-leads.js";
import { OpenRouterAdapter } from "../server/hostmate/runtime/openrouter-adapter.js";
import { ProductToolRegistry } from "../server/hostmate/tools/registry.js";
import { CrmSearchLeadsVerticalSlice } from "../server/hostmate/vertical-slices/crm-search-leads.js";

function actor(tenantId = "7", permissions: string[] = ["crm.read"]) {
  return createActorContext({ tenantId, userId: "10", role: "agent", isSuperAdmin: false, permissions, locale: "es-ES", timezone: "Europe/Madrid", sessionId: "s-10", permissionsVersion: "v1" });
}

function output(count: number) {
  return {
    total: count, page: 1, limit: 5,
    matches: Array.from({ length: count }, (_, index) => ({
      id: String(index + 1), name: index ? "Juan García López" : "Juan García",
      status: "new", ref: { type: "crm.lead", id: String(index + 1), label: index ? "Juan García López" : "Juan García", deepLink: `/leads?lead=${index + 1}` },
    })),
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
    expect(result.matches[0]).toMatchObject({ id: "17", name: "Juan T7", phone: "••• •• 3456", email: "j•••@example.com" });
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
    const slice = new CrmSearchLeadsVerticalSlice(repository, port, new OpenRouterAdapter({ apiKey: "test", fetch: fetchMock, maxTransportRetries: 0 }), { model: "requested/model" });
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
    const slice = new CrmSearchLeadsVerticalSlice(repository, port, new OpenRouterAdapter({ apiKey: "test", fetch: fetchMock }), { model: "requested/model" });
    const result = await slice.execute(actor("7", []), { conversationId: "123e4567-e89b-42d3-a456-426614174001", message: "Busca a Juan" });
    expect(result.result.status).toBe("permission_denied");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(port.search).not.toHaveBeenCalled();
  });
});
