export type BenchmarkSample = Readonly<{
  crmMs: number;
  visitsMs: number;
  propertyMs: number;
  singleControlPlaneMs: number;
  multiControlPlaneMs: number;
}>;

export type BenchmarkSummary = Readonly<{
  samples: number;
  single: Readonly<{ p50Ms: number; p95Ms: number; inferenceCalls: 0; tokens: 0; costUsd: 0; maxToolsExposedPerRun: 3 }>;
  multi: Readonly<{ p50Ms: number; p95Ms: number; inferenceCalls: 0; tokens: 0; costUsd: 0; maxToolsExposedPerRun: 1 }>;
}>;

function percentile(values: readonly number[], value: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * value) - 1)] ?? 0;
}

/** Same tool work in both modes; Multi overlaps Visits and Property. */
export function summarizeBenchmark(samples: readonly BenchmarkSample[]): BenchmarkSummary {
  const single = samples.map((sample) => sample.singleControlPlaneMs + sample.crmMs + sample.visitsMs + sample.propertyMs);
  const multi = samples.map((sample) => sample.multiControlPlaneMs + sample.crmMs + Math.max(sample.visitsMs, sample.propertyMs));
  return {
    samples: samples.length,
    single: { p50Ms: percentile(single, 0.5), p95Ms: percentile(single, 0.95), inferenceCalls: 0, tokens: 0, costUsd: 0, maxToolsExposedPerRun: 3 },
    multi: { p50Ms: percentile(multi, 0.5), p95Ms: percentile(multi, 0.95), inferenceCalls: 0, tokens: 0, costUsd: 0, maxToolsExposedPerRun: 1 },
  };
}
