import { z } from "zod";

const actorContextInputSchema = z
  .object({
    tenantId: z.string().min(1),
    userId: z.string().min(1),
    role: z.enum(["agent", "admin", "superadmin"]),
    isSuperAdmin: z.boolean(),
    permissions: z.array(z.string().min(1)),
    locale: z.string().min(2),
    timezone: z.string().min(1),
    sessionId: z.string().min(1),
    permissionsVersion: z.string().min(1),
    effectiveTenantOverride: z.boolean().default(false),
  })
  .strict();

export type ActorContextInput = z.input<typeof actorContextInputSchema>;

/**
 * Server-authoritative identity captured when a command or run is created.
 * It is deliberately not serializable as part of an LLM tool input schema.
 */
export type ActorContext = Readonly<{
  tenantId: string;
  userId: string;
  role: "agent" | "admin" | "superadmin";
  isSuperAdmin: boolean;
  permissions: readonly string[];
  locale: string;
  timezone: string;
  sessionId: string;
  permissionsVersion: string;
  effectiveTenantOverride: boolean;
}>;

export function createActorContext(input: ActorContextInput): ActorContext {
  const parsed = actorContextInputSchema.parse(input);
  if (parsed.isSuperAdmin !== (parsed.role === "superadmin")) {
    throw new Error("ActorContext role and isSuperAdmin are inconsistent");
  }
  return Object.freeze({
    ...parsed,
    permissions: Object.freeze([...new Set(parsed.permissions)].sort()),
  });
}

export function actorHasPermission(actor: ActorContext, permission: string): boolean {
  return actor.isSuperAdmin || actor.permissions.includes(permission);
}

export function actorAuditRef(actor: ActorContext): Record<string, string | boolean> {
  return {
    tenantId: actor.tenantId,
    userId: actor.userId,
    role: actor.role,
    sessionId: actor.sessionId,
    permissionsVersion: actor.permissionsVersion,
    effectiveTenantOverride: actor.effectiveTenantOverride,
  };
}
