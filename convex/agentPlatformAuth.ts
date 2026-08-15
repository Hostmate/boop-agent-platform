import { ConvexError } from "convex/values";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server";

export type ConvexActor = {
  tenantId: string;
  userId: string;
  role: "agent" | "admin" | "superadmin";
  permissions: string[];
  locale: string;
  timezone: string;
  sessionId: string;
  permissionsVersion: string;
  effectiveTenantOverride: boolean;
};

export async function requireAgentPlatformActor(
  ctx: QueryCtx | MutationCtx | ActionCtx,
  expected?: { expectedTenantId?: string; expectedUserId?: string },
): Promise<ConvexActor> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError("UNAUTHENTICATED");
  const tenantId = identity.tenant_id;
  const claimedUserId = identity.user_id;
  const userId = typeof claimedUserId === "string" ? claimedUserId : identity.subject;
  const role = identity.role;
  const permissions = Array.isArray(identity.permissions) ? identity.permissions.filter((value): value is string => typeof value === "string") : [];
  if (typeof tenantId !== "string" || !tenantId) throw new ConvexError("MISSING_TENANT_CLAIM");
  if (typeof userId !== "string" || !userId) throw new ConvexError("MISSING_USER_CLAIM");
  if (role !== "agent" && role !== "admin" && role !== "superadmin") throw new ConvexError("INVALID_ROLE_CLAIM");
  if (expected?.expectedTenantId && expected.expectedTenantId !== tenantId) throw new ConvexError("ACTOR_TENANT_MISMATCH");
  if (expected?.expectedUserId && expected.expectedUserId !== userId) throw new ConvexError("ACTOR_USER_MISMATCH");
  return {
    tenantId, userId, role, permissions,
    locale: typeof identity.locale === "string" ? identity.locale : "es-ES",
    timezone: typeof identity.timezone === "string" ? identity.timezone : "Europe/Madrid",
    sessionId: typeof identity.session_id === "string" ? identity.session_id : `user-${userId}`,
    permissionsVersion: typeof identity.permissions_version === "string" ? identity.permissions_version : "session-v1",
    effectiveTenantOverride: identity.effective_tenant_override === true,
  };
}

export function canReadTenantRun(actor: ConvexActor, run: { actorUserId: string; visibility: string }): boolean {
  return run.actorUserId === actor.userId || (run.visibility !== "user" && (actor.role === "admin" || actor.role === "superadmin"));
}

export function assertConversationOwner(
  actor: Pick<ConvexActor, "userId">,
  conversation: { ownerUserId: string } | null,
): conversation is { ownerUserId: string } {
  if (!conversation) return false;
  if (conversation.ownerUserId !== actor.userId) throw new ConvexError("CONVERSATION_FORBIDDEN");
  return true;
}
