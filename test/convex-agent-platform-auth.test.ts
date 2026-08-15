import { describe, expect, it } from "vitest";
import { canReadTenantRun, requireAgentPlatformActor } from "../convex/agentPlatformAuth.js";

describe("Convex Agent Platform auth characterization", () => {
  it("derives actor and tenant only from authenticated claims", async () => {
    const ctx = {
      auth: { getUserIdentity: async () => ({ tenant_id: "tenant-a", user_id: "user-1", subject: "user-1", role: "admin" }) },
    };
    await expect(requireAgentPlatformActor(ctx as never, { expectedTenantId: "tenant-a", expectedUserId: "user-1" })).resolves.toEqual({ tenantId: "tenant-a", userId: "user-1", role: "admin" });
    await expect(requireAgentPlatformActor(ctx as never, { expectedTenantId: "tenant-b" })).rejects.toThrow();
  });

  it("keeps user-visible runs private and tenant-visible runs admin-scoped", () => {
    expect(canReadTenantRun({ tenantId: "a", userId: "owner", role: "agent" }, { actorUserId: "owner", visibility: "user" })).toBe(true);
    expect(canReadTenantRun({ tenantId: "a", userId: "other", role: "agent" }, { actorUserId: "owner", visibility: "tenant_admin" })).toBe(false);
    expect(canReadTenantRun({ tenantId: "a", userId: "admin", role: "admin" }, { actorUserId: "owner", visibility: "tenant_admin" })).toBe(true);
  });
});
