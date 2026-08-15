import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { OpenRouterAdapter, OpenRouterRuntimeError, type OpenRouterObservation } from "../server/hostmate/runtime/openrouter-adapter.js";
import { defineRuntimeTool } from "../server/runtimes/tool.js";

function sse(events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const budget = { timeoutMs: 2_000, maxToolRounds: 2, maxCostUsd: 1 };

describe("production-oriented OpenRouterAdapter", () => {
  it("streams deltas, assembles tool calls, validates with Zod and records resolved routing usage", async () => {
    const requests: Record<string, unknown>[] = [];
    const fetchMock = vi.fn()
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        requests.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return sse([
          { model: "provider/resolved-model", provider: "Provider A", choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "math__sum_0", arguments: '{"a":2,' } }] } }] },
          { choices: [{ finish_reason: "tool_calls", delta: { tool_calls: [{ index: 0, function: { arguments: '"b":3}' } }] } }], usage: { prompt_tokens: 10, completion_tokens: 4, cost: 0.01 } },
        ]);
      })
      .mockImplementationOnce(async () => sse([
        { model: "provider/resolved-model", provider: "Provider A", choices: [{ delta: { content: "Resultado " } }] },
        { choices: [{ delta: { content: "5" }, finish_reason: "stop" }], usage: { prompt_tokens: 15, completion_tokens: 6, cost: 0.02, prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 1 } } },
      ]));
    const adapter = new OpenRouterAdapter({ apiKey: "test", fetch: fetchMock, maxTransportRetries: 0 });
    const text: string[] = [];
    const tools: string[] = [];
    const result = await adapter.run({
      prompt: "sum", systemPrompt: "test", model: "requested/model", mode: "execution",
      tools: [defineRuntimeTool("math", "sum", "sum", { a: z.number(), b: z.number() }, async ({ a, b }) => ({ text: String(a + b) }))],
      onText: (delta) => text.push(delta),
      onToolUse: (name) => tools.push(`use:${name}`),
      onToolResult: (name, value) => tools.push(`result:${name}:${value}`),
    }, {
      budget,
      fallbackModels: ["fallback/model"],
      provider: { allowFallbacks: true, requireParameters: true },
      metadata: { run_kind: "execution" },
    });
    expect(text).toEqual(["Resultado ", "5"]);
    expect(tools).toEqual(["use:sum", "result:sum:5"]);
    expect(result.text).toBe("Resultado 5");
    expect(result.detailedUsage).toMatchObject({
      requestedModel: "requested/model", resolvedModel: "provider/resolved-model", provider: "Provider A",
      inputTokens: 25, outputTokens: 10, reasoningTokens: 1, cachedTokens: 3, costUsd: 0.03, fallbackUsed: true,
    });
    expect(requests[0]).toMatchObject({
      models: ["requested/model", "fallback/model"], parallel_tool_calls: false,
      provider: { allow_fallbacks: true, require_parameters: true },
    });
    expect((requests[0].tools as any[])[0].function).not.toHaveProperty("strict");
    expect(requests[0]).not.toHaveProperty("model");
  });

  it("sends OpenRouter max reasoning without widening the Codex runtime effort contract", async () => {
    let body: Record<string, unknown> | undefined;
    const adapter = new OpenRouterAdapter({
      apiKey: "test", maxTransportRetries: 0,
      fetch: vi.fn(async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return sse([{ model: "deepseek/deepseek-v4-flash-0731", choices: [{ delta: { content: "ok" }, finish_reason: "stop" }], usage: {} }]);
      }),
    });
    await adapter.run({ prompt: "x", systemPrompt: "x", model: "deepseek/deepseek-v4-flash-0731", mode: "execution", tools: [] }, {
      budget, reasoningEffort: "max",
    });
    expect(body).toMatchObject({
      model: "deepseek/deepseek-v4-flash-0731",
      reasoning: { effort: "max" },
    });
  });

  it("normalizes provider errors", async () => {
    const adapter = new OpenRouterAdapter({
      apiKey: "test", maxTransportRetries: 0,
      fetch: vi.fn(async () => new Response('{"error":"busy"}', { status: 503 })),
    });
    const error = await adapter.run({ prompt: "x", systemPrompt: "x", model: "configured/model", mode: "execution", tools: [] }, { budget }).catch((value) => value);
    expect(error).toBeInstanceOf(OpenRouterRuntimeError);
    expect(error).toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true, status: 503 });
  });

  it("classifies connect, provider and cancellation observations without changing retry policy", async () => {
    const connect: OpenRouterObservation[] = [];
    const connectAdapter = new OpenRouterAdapter({
      apiKey: "test", maxTransportRetries: 0, onObservation: (row) => connect.push(row),
      fetch: vi.fn(async (_url, init) => await new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      })),
    });
    await expect(connectAdapter.run({ prompt: "x", systemPrompt: "x", model: "configured/model", mode: "execution", tools: [] }, { budget: { timeoutMs: 5, maxToolRounds: 0 } })).rejects.toMatchObject({ code: "TIMEOUT", details: { phase: "connect", timeoutKind: "connect" } });
    expect(connect[0]).toMatchObject({ operation: "chat.completions", outcome: "timeout", phase: "connect", timeoutKind: "connect", attempts: 1 });

    const provider: OpenRouterObservation[] = [];
    const providerAdapter = new OpenRouterAdapter({ apiKey: "test", maxTransportRetries: 0, onObservation: (row) => provider.push(row), fetch: vi.fn(async () => new Response("timeout", { status: 504 })) });
    await expect(providerAdapter.run({ prompt: "x", systemPrompt: "x", model: "configured/model", mode: "execution", tools: [] }, { budget })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", status: 504, details: { phase: "provider", timeoutKind: "provider" } });
    expect(provider[0]).toMatchObject({ outcome: "error", phase: "provider", timeoutKind: "provider", status: 504 });
  });

  it("rejects invalid tool arguments before the handler", async () => {
    const handler = vi.fn(async () => ({ text: "never" }));
    const adapter = new OpenRouterAdapter({ apiKey: "test", maxTransportRetries: 0, fetch: vi.fn(async () => sse([
      { model: "configured/model", choices: [{ delta: { tool_calls: [{ index: 0, id: "call", function: { name: "math__sum_0", arguments: '{"a":"wrong"}' } }] }, finish_reason: "tool_calls" }], usage: {} },
    ])) });
    const error = await adapter.run({
      prompt: "x", systemPrompt: "x", model: "configured/model", mode: "execution",
      tools: [defineRuntimeTool("math", "sum", "sum", { a: z.number() }, handler)],
    }, { budget }).catch((value) => value);
    expect(error).toMatchObject({ code: "INVALID_TOOL_CALL", retryable: false });
    expect(handler).not.toHaveBeenCalled();
  });

  it("propagates durable cancellation as a normalized error", async () => {
    const controller = new AbortController();
    const adapter = new OpenRouterAdapter({
      apiKey: "test",
      fetch: vi.fn(async (_url, init) => await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      })),
    });
    const pending = adapter.run({ prompt: "x", systemPrompt: "x", model: "configured/model", mode: "execution", tools: [], abortController: controller }, { budget });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED", retryable: false });
  });

  it("can stop after a real tool call without paying for a cosmetic second model round", async () => {
    const handler = vi.fn(async ({ query }: { query: string }) => ({ text: JSON.stringify({ query, matches: [] }) }));
    const fetchMock = vi.fn(async () => sse([
      { model: "provider/model", provider: "Provider", choices: [{ delta: { tool_calls: [{ index: 0, id: "call", type: "function", function: { name: "crm__search_leads_0", arguments: '{"query":"Juan"}' } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 8, completion_tokens: 3, cost: 0.001 } },
    ]));
    const adapter = new OpenRouterAdapter({ apiKey: "test", maxTransportRetries: 0, fetch: fetchMock });
    const result = await adapter.run({
      prompt: "Busca a Juan", systemPrompt: "Use the tool", model: "requested/model", mode: "execution",
      tools: [defineRuntimeTool("crm", "search_leads", "search", { query: z.string() }, handler)],
    }, { budget: { timeoutMs: 2_000, maxToolRounds: 0 }, toolChoice: "required", stopAfterToolResult: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ query: "Juan" });
    expect(result.toolResults).toEqual([{ toolName: "search_leads", text: '{"query":"Juan","matches":[]}', success: true }]);
    expect(result.finishReason).toBe("tool_calls");
  });
});
