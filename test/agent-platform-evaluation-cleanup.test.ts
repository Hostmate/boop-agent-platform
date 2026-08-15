import { describe, expect, it } from "vitest";

describe("Agent Platform Memory evaluation cleanup contract", () => {
  it("keeps the cleanup authority fail-closed in source", async () => {
    const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../convex/agentPlatformEvaluation.ts", import.meta.url), "utf8"));
    expect(source).toContain('actor.permissions.includes("memory.eval")');
    expect(source).toContain('actor.permissionsVersion !== `memory-eval:${runId}`');
    expect(source).toContain('actor.sessionId.startsWith("refresh:")');
    expect(source).toContain('DELETE_MEMORY_EVAL_DATA:${args.runId}');
    expect(source).toContain("MEMORY_EVAL_CONVERSATION_OWNERSHIP_MISMATCH");
  });
});
