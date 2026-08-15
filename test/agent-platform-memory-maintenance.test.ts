import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Agent Platform Memory maintenance contract", () => {
  it("requires tenant, owner, lifecycle/type and age in the indexed query before deletion", async () => {
    const source = await readFile(new URL("../convex/agentPlatformMemoryMaintenance.ts", import.meta.url), "utf8");
    expect(source).toContain('actor.permissions.includes("memory.purge")');
    expect(source).toContain('.eq("tenantId", args.tenantId).eq("ownerUserId", args.ownerUserId).eq("scope", "user").eq("lifecycle", args.lifecycle).lt("createdAt", args.before)');
    expect(source).toContain('.eq("tenantId", args.tenantId).eq("ownerUserId", args.ownerUserId).eq("scope", "user").eq("eventType", args.eventType).lt("createdAt", args.before)');
    expect(source).toContain("MEMORY_PURGE_CONFIRMATION_INVALID");
    expect(source).toContain("MEMORY_PURGE_EXECUTION_MUST_NOT_BE_DRY_RUN");
    expect(source).toContain("MEMORY_PURGE_PLAN_INVALID");
  });

  it("has no tenant-wide or global deletion path", async () => {
    const source = await readFile(new URL("../convex/agentPlatformMemoryMaintenance.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/query\("memoryRecords"\)\s*\.collect/);
    expect(source).not.toMatch(/query\("memoryEvents"\)\s*\.collect/);
    expect(source).not.toContain("ownerUserId: v.optional");
  });
});
