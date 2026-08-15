import { describe, expect, it } from "vitest";
import { OpenRouterTelemetryMonitor } from "../server/hostmate/runtime/openrouter-telemetry.js";

describe("OpenRouter staging telemetry monitor", () => {
  it("reports timeout rate, p50/p95/p99 and provider/model/operation dimensions", () => {
    const monitor = new OpenRouterTelemetryMonitor(15 * 60_000, 100);
    const now = Date.now();
    for (let index = 0; index < 50; index += 1) monitor.record({
      operation: "chat.completions", outcome: index === 49 ? "timeout" : "success", timeoutKind: index === 49 ? "generation" : undefined,
      phase: index === 49 ? "generation" : undefined, requestedModel: "deepseek/deepseek-v4-flash-0731", resolvedModel: "deepseek/deepseek-v4-flash-0731",
      provider: "DeepInfra", latencyMs: (index + 1) * 100, attempts: 1, occurredAt: now,
    });
    expect(monitor.snapshot(now)).toMatchObject({
      samples: 50, timeouts: 1, timeoutRate: 0.02, latencyMs: { p50: 2500, p95: 4800, p99: 5000 },
      timeoutKinds: { generation: 1 }, initialStagingSlo: { status: "meeting" },
      byOperationProviderModel: [{ operation: "chat.completions", provider: "DeepInfra", model: "deepseek/deepseek-v4-flash-0731", samples: 50 }],
    });
  });
});
