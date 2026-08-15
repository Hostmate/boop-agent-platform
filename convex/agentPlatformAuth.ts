import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "./_generated/server";

export type ConvexActor = {
  tenantId: string;
  userId: string;
  role: "agent" | "admin" | "superadmin";
};

export async function requireAgentPlatformActor(
  ctx: QueryCtx | MutationCtx,
  expected?: { expectedTenantId?: string; expectedUserId?: string },
): Promise<ConvexActor> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError("UNAUTHENTICATED");
  const tenantId = identity.tenant_id;
  const claimedUserId = identity.user_id;
  const userId = typeof claimedUserId === "string" ? claimedUserId : identity.subject;
  const role = identity.role;
  if (typeof tenantId !== "string" || !tenantId) throw new ConvexError("MISSING_TENANT_CLAIM");
  if (typeof userId !== "string" || !userId) throw new ConvexError("MISSING_USER_CLAIM");
  if (role !== "agent" && role !== "admin" && role !== "superadmin") throw new ConvexError("INVALID_ROLE_CLAIM");
  if (expected?.expectedTenantId && expected.expectedTenantId !== tenantId) throw new ConvexError("ACTOR_TENANT_MISMATCH");
  if (expected?.expectedUserId && expected.expectedUserId !== userId) throw new ConvexError("ACTOR_USER_MISMATCH");
  return { tenantId, userId, role };
}

export function canReadTenantRun(actor: ConvexActor, run: { actorUserId: string; visibility: string }): boolean {
  return run.actorUserId === actor.userId || (run.visibility !== "user" && (actor.role === "admin" || actor.role === "superadmin"));
}
