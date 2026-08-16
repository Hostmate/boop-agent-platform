import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { summarizeBenchmark } from "../evaluation/multi-agent-benchmark.js";
import { isLeadOpportunityAnalysisIntent } from "../server/hostmate/orchestration/lead-opportunity-definition.js";

type Scenario = { id: string; category: string; utterance: string; expectedMode: "single" | "multi"; selectedLead: boolean };

describe("multi-agent evaluation corpus", () => {
  it("measures exact deterministic orchestration selection over 80 reproducible scenarios", async () => {
    const scenarios = JSON.parse(await readFile(new URL("../evaluation/multi-agent-corpus.json", import.meta.url), "utf8")) as Scenario[];
    const rows = scenarios.map((scenario) => ({ expected: scenario.expectedMode, actual: isLeadOpportunityAnalysisIntent(scenario.utterance) ? "multi" : "single" }));
    const tp = rows.filter((row) => row.expected === "multi" && row.actual === "multi").length;
    const fp = rows.filter((row) => row.expected === "single" && row.actual === "multi").length;
    const fn = rows.filter((row) => row.expected === "multi" && row.actual === "single").length;
    expect(scenarios).toHaveLength(80);
    expect({ precision: tp / (tp + fp), recall: tp / (tp + fn), unnecessaryActivation: fp / rows.filter((row) => row.expected === "single").length }).toEqual({ precision: 1, recall: 1, unnecessaryActivation: 0 });
  });

  it("compares the same deterministic tool work in single and multi execution modes", () => {
    const samples = Array.from({ length: 20 }, (_, index) => ({
      crmMs: 42 + (index % 5) * 3,
      visitsMs: 55 + (index % 4) * 7,
      propertyMs: 76 + (index % 6) * 9,
      singleControlPlaneMs: 8 + (index % 3),
      multiControlPlaneMs: 24 + (index % 4) * 2,
    }));
    expect(summarizeBenchmark(samples)).toEqual({
      samples: 20,
      single: { p50Ms: 221, p95Ms: 241, inferenceCalls: 0, tokens: 0, costUsd: 0, maxToolsExposedPerRun: 3 },
      multi: { p50Ms: 170, p95Ms: 195, inferenceCalls: 0, tokens: 0, costUsd: 0, maxToolsExposedPerRun: 1 },
    });
  });
});
