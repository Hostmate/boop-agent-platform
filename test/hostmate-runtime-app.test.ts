import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createAgentPlatformRuntimeApp, type AgentPlatformRuntimeConfig } from "../server/hostmate/http/runtime-app.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function serve(overrides: Partial<AgentPlatformRuntimeConfig> = {}) {
  const app = createAgentPlatformRuntimeApp({
    convexUrl: "https://example.convex.cloud",
    hostmateApiBaseUrl: "http://127.0.0.1:3000",
    openRouterApiKey: "test-only",
    model: "test/model",
    executeTurn: async () => ({ ok: true }),
    ...overrides,
  });
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

const turnBody = {
  conversationId: "00000000-0000-4000-8000-000000000001",
  message: "Busca a Roger",
};

describe("Hostmate managed runtime HTTP boundary", () => {
  it("exposes separate liveness and readiness probes", async () => {
    let ready = true;
    const baseUrl = await serve({ isReady: () => ready });
    await expect(fetch(`${baseUrl}/health/live`).then((response) => response.json())).resolves.toEqual({ ok: true });
    expect((await fetch(`${baseUrl}/health/ready`)).status).toBe(200);
    ready = false;
    expect((await fetch(`${baseUrl}/health/ready`)).status).toBe(503);
  });

  it("does not leak internal exception messages to clients", async () => {
    const baseUrl = await serve({ executeTurn: async () => { throw new Error("OPENROUTER_API_KEY=secret"); } });
    const response = await fetch(`${baseUrl}/v1/turn`, {
      method: "POST", headers: { authorization: "Bearer valid-test-token", "content-type": "application/json" }, body: JSON.stringify(turnBody),
    });
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ success: false, error: "INTERNAL_ERROR" });
  });

  it("bounds concurrent turns and advertises retry", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const baseUrl = await serve({ maxConcurrentTurns: 1, executeTurn: async () => { await gate; return { ok: true }; } });
    const first = fetch(`${baseUrl}/v1/turn`, {
      method: "POST", headers: { authorization: "Bearer first", "content-type": "application/json" }, body: JSON.stringify(turnBody),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await fetch(`${baseUrl}/v1/turn`, {
      method: "POST", headers: { authorization: "Bearer second", "content-type": "application/json" }, body: JSON.stringify(turnBody),
    });
    expect(second.status).toBe(503);
    expect(second.headers.get("retry-after")).toBe("1");
    await expect(second.json()).resolves.toEqual({ success: false, error: "RUNTIME_BUSY" });
    release();
    expect((await first).status).toBe(200);
  });
});
