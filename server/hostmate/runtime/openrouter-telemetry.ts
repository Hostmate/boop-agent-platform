import type { OpenRouterObservation } from "./openrouter-adapter.js";

type Percentiles = Readonly<{ p50: number; p95: number; p99: number }>;

function percentile(values: readonly number[], value: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * value) - 1))]!;
}

function percentiles(values: readonly number[]): Percentiles {
  return { p50: percentile(values, 0.5), p95: percentile(values, 0.95), p99: percentile(values, 0.99) };
}

/**
 * Process-local staging monitor. It deliberately stores only operational
 * dimensions: no prompts, actor IDs, tenant IDs or tool arguments.
 */
export class OpenRouterTelemetryMonitor {
  private readonly observations: OpenRouterObservation[] = [];

  constructor(
    private readonly windowMs = 15 * 60_000,
    private readonly maxObservations = 2_000,
  ) {}

  record = (observation: OpenRouterObservation): void => {
    this.observations.push(Object.freeze({ ...observation }));
    const cutoff = Date.now() - this.windowMs;
    while (this.observations.length && (this.observations[0]!.occurredAt < cutoff || this.observations.length > this.maxObservations)) {
      this.observations.shift();
    }
  };

  snapshot(now = Date.now()) {
    const rows = this.observations.filter((row) => row.occurredAt >= now - this.windowMs);
    const timeouts = rows.filter((row) => row.outcome === "timeout" || row.timeoutKind !== undefined);
    const groups = new Map<string, OpenRouterObservation[]>();
    for (const row of rows) {
      const key = `${row.operation}|${row.provider ?? "unresolved"}|${row.resolvedModel ?? row.requestedModel}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    const timeoutRate = rows.length ? timeouts.length / rows.length : 0;
    const latency = percentiles(rows.map((row) => row.latencyMs));
    return {
      windowMinutes: this.windowMs / 60_000,
      samples: rows.length,
      timeouts: timeouts.length,
      timeoutRate,
      latencyMs: latency,
      timeoutKinds: Object.fromEntries(["connect", "provider", "generation", "runtime"].map((kind) => [kind, timeouts.filter((row) => row.timeoutKind === kind).length])),
      byOperationProviderModel: [...groups.entries()].map(([key, values]) => {
        const [operation, provider, model] = key.split("|");
        const groupTimeouts = values.filter((row) => row.outcome === "timeout" || row.timeoutKind !== undefined).length;
        return { operation, provider, model, samples: values.length, timeouts: groupTimeouts, timeoutRate: groupTimeouts / values.length, latencyMs: percentiles(values.map((row) => row.latencyMs)) };
      }),
      initialStagingSlo: {
        minimumSamples: 50,
        timeoutRateTarget: 0.02,
        p95LatencyMsTarget: 30_000,
        status: rows.length < 50 ? "insufficient_data" : timeoutRate <= 0.02 && latency.p95 <= 30_000 ? "meeting" : "breached",
      },
    };
  }
}
