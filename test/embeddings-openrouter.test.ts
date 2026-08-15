import { afterEach, describe, expect, it, vi } from "vitest";
import { embedWithMetadata } from "../server/embeddings.js";

afterEach(() => {
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.AGENT_PLATFORM_MEMORY_EMBEDDING_MODEL;
  vi.unstubAllGlobals();
});

describe("Boop embeddings OpenRouter adapter", () => {
  it("preserves the 1024-dimensional Boop vector contract and exposes usage", async () => {
    process.env.OPENROUTER_API_KEY = "test";
    process.env.AGENT_PLATFORM_MEMORY_EMBEDDING_MODEL = "baai/bge-large-en-v1.5";
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify({
      data: [{ embedding: Array.from({ length: 1024 }, () => 0.01) }], usage: { prompt_tokens: 12, cost: 0.00000012 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(embedWithMetadata("preferencia")).resolves.toMatchObject({
      provider: "openrouter", model: "baai/bge-large-en-v1.5", inputTokens: 12, costUsd: 0.00000012,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ model: "baai/bge-large-en-v1.5", input: "preferencia" });
  });
});
