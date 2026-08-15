import { ConvexError, v } from "convex/values";
import { mutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { requireAgentPlatformActor, type ConvexActor } from "./agentPlatformAuth";

const lifecycleV = v.union(v.literal("active"), v.literal("archived"), v.literal("pruned"));
const scopeV = v.literal("user");
const MAX_BATCH = 100;
const MIN_AGE_MS = 24 * 60 * 60 * 1_000;
const PLAN_TTL_MS = 15 * 60 * 1_000;
const commonArgs = {
  tenantId: v.string(), ownerUserId: v.string(), scope: scopeV,
  before: v.number(), limit: v.optional(v.number()),
};

function authorize(actor: ConvexActor, args: { tenantId: string; ownerUserId: string; before: number }) {
  if (actor.role !== "superadmin" || !actor.permissions.includes("memory.purge")) throw new ConvexError("MEMORY_PURGE_FORBIDDEN");
  if (actor.tenantId !== args.tenantId) throw new ConvexError("MEMORY_PURGE_TENANT_MISMATCH");
  if (!/^[1-9]\d*$/.test(args.tenantId) || !/^[1-9]\d*$/.test(args.ownerUserId)) throw new ConvexError("MEMORY_PURGE_SCOPE_INVALID");
  if (!Number.isFinite(args.before) || args.before > Date.now() - MIN_AGE_MS) throw new ConvexError("MEMORY_PURGE_AGE_INVALID");
}

function batchSize(limit?: number) {
  return Math.max(1, Math.min(MAX_BATCH, Math.floor(limit ?? MAX_BATCH)));
}

function recordConfirmation(args: { tenantId: string; ownerUserId: string; lifecycle: string; before: number }) {
  return `PURGE_MEMORY_RECORDS:${args.tenantId}:${args.ownerUserId}:user:${args.lifecycle}:${args.before}`;
}

function eventConfirmation(args: { tenantId: string; ownerUserId: string; eventType: string; before: number }) {
  return `PURGE_MEMORY_EVENTS:${args.tenantId}:${args.ownerUserId}:user:${args.eventType}:${args.before}`;
}

async function scopedRecords(ctx: QueryCtx | MutationCtx, args: { tenantId: string; ownerUserId: string; lifecycle: "active" | "archived" | "pruned"; before: number; limit?: number }) {
  const limit = batchSize(args.limit);
  return await ctx.db.query("memoryRecords")
    .withIndex("by_scope_lifecycle_created", (q) => q.eq("tenantId", args.tenantId).eq("ownerUserId", args.ownerUserId).eq("scope", "user").eq("lifecycle", args.lifecycle).lt("createdAt", args.before))
    .order("asc").take(limit + 1);
}

async function scopedEvents(ctx: QueryCtx | MutationCtx, args: { tenantId: string; ownerUserId: string; eventType: string; before: number; limit?: number }) {
  const limit = batchSize(args.limit);
  return await ctx.db.query("memoryEvents")
    .withIndex("by_scope_type_created", (q) => q.eq("tenantId", args.tenantId).eq("ownerUserId", args.ownerUserId).eq("scope", "user").eq("eventType", args.eventType).lt("createdAt", args.before))
    .order("asc").take(limit + 1);
}

export const previewRecords = mutation({
  args: { ...commonArgs, lifecycle: lifecycleV },
  handler: async (ctx, args) => {
    const actor = await requireAgentPlatformActor(ctx);
    authorize(actor, args);
    const limit = batchSize(args.limit);
    const rows = await scopedRecords(ctx, args);
    const createdAt = Date.now();
    const planId = await ctx.db.insert("memoryPurgePlans", {
      target: "memoryRecords", tenantId: args.tenantId, ownerUserId: args.ownerUserId, scope: "user", lifecycle: args.lifecycle,
      before: args.before, limit, matched: Math.min(rows.length, limit), withEmbedding: rows.slice(0, limit).filter((row) => row.embedding?.length).length,
      createdBy: actor.userId, createdAt, expiresAt: createdAt + PLAN_TTL_MS,
    });
    return {
      dryRun: true, target: "memoryRecords", scope: { tenantId: args.tenantId, ownerUserId: args.ownerUserId, scope: args.scope, lifecycle: args.lifecycle, before: args.before },
      matched: Math.min(rows.length, limit), hasMore: rows.length > limit,
      withEmbedding: rows.slice(0, limit).filter((row) => row.embedding?.length).length,
      planId, confirmation: recordConfirmation(args), expiresAt: createdAt + PLAN_TTL_MS,
    };
  },
});

export const purgeRecords = mutation({
  args: { ...commonArgs, lifecycle: lifecycleV, dryRun: v.boolean(), confirmation: v.string(), planId: v.id("memoryPurgePlans") },
  handler: async (ctx, args) => {
    const actor = await requireAgentPlatformActor(ctx);
    authorize(actor, args);
    if (args.dryRun) throw new ConvexError("MEMORY_PURGE_EXECUTION_MUST_NOT_BE_DRY_RUN");
    if (args.confirmation !== recordConfirmation(args)) throw new ConvexError("MEMORY_PURGE_CONFIRMATION_INVALID");
    const plan = await ctx.db.get(args.planId);
    if (!plan || plan.target !== "memoryRecords" || plan.consumedAt || plan.expiresAt < Date.now()
      || plan.createdBy !== actor.userId || plan.tenantId !== args.tenantId || plan.ownerUserId !== args.ownerUserId
      || plan.lifecycle !== args.lifecycle || plan.before !== args.before || plan.limit !== batchSize(args.limit)) {
      throw new ConvexError("MEMORY_PURGE_PLAN_INVALID");
    }
    const limit = batchSize(args.limit);
    const rows = (await scopedRecords(ctx, args)).slice(0, limit);
    if (rows.length > plan.matched) throw new ConvexError("MEMORY_PURGE_SCOPE_CHANGED");
    for (const row of rows) await ctx.db.delete(row._id);
    await ctx.db.patch(args.planId, { consumedAt: Date.now() });
    return { dryRun: false, target: "memoryRecords", deleted: rows.length, matched: rows.length, embeddingsDeleted: rows.filter((row) => row.embedding?.length).length };
  },
});

export const previewEvents = mutation({
  args: { ...commonArgs, eventType: v.string() },
  handler: async (ctx, args) => {
    const actor = await requireAgentPlatformActor(ctx);
    authorize(actor, args);
    if (!/^[a-z][a-z0-9._-]{2,80}$/.test(args.eventType)) throw new ConvexError("MEMORY_EVENT_TYPE_INVALID");
    const limit = batchSize(args.limit);
    const rows = await scopedEvents(ctx, args);
    const createdAt = Date.now();
    const planId = await ctx.db.insert("memoryPurgePlans", {
      target: "memoryEvents", tenantId: args.tenantId, ownerUserId: args.ownerUserId, scope: "user", eventType: args.eventType,
      before: args.before, limit, matched: Math.min(rows.length, limit), createdBy: actor.userId, createdAt, expiresAt: createdAt + PLAN_TTL_MS,
    });
    return { dryRun: true, target: "memoryEvents", scope: { tenantId: args.tenantId, ownerUserId: args.ownerUserId, scope: args.scope, eventType: args.eventType, before: args.before }, matched: Math.min(rows.length, limit), hasMore: rows.length > limit, planId, confirmation: eventConfirmation(args), expiresAt: createdAt + PLAN_TTL_MS };
  },
});

export const purgeEvents = mutation({
  args: { ...commonArgs, eventType: v.string(), dryRun: v.boolean(), confirmation: v.string(), planId: v.id("memoryPurgePlans") },
  handler: async (ctx, args) => {
    const actor = await requireAgentPlatformActor(ctx);
    authorize(actor, args);
    if (args.dryRun) throw new ConvexError("MEMORY_PURGE_EXECUTION_MUST_NOT_BE_DRY_RUN");
    if (!/^[a-z][a-z0-9._-]{2,80}$/.test(args.eventType)) throw new ConvexError("MEMORY_EVENT_TYPE_INVALID");
    if (args.confirmation !== eventConfirmation(args)) throw new ConvexError("MEMORY_PURGE_CONFIRMATION_INVALID");
    const plan = await ctx.db.get(args.planId);
    if (!plan || plan.target !== "memoryEvents" || plan.consumedAt || plan.expiresAt < Date.now()
      || plan.createdBy !== actor.userId || plan.tenantId !== args.tenantId || plan.ownerUserId !== args.ownerUserId
      || plan.eventType !== args.eventType || plan.before !== args.before || plan.limit !== batchSize(args.limit)) {
      throw new ConvexError("MEMORY_PURGE_PLAN_INVALID");
    }
    const rows = (await scopedEvents(ctx, args)).slice(0, batchSize(args.limit));
    if (rows.length > plan.matched) throw new ConvexError("MEMORY_PURGE_SCOPE_CHANGED");
    for (const row of rows) await ctx.db.delete(row._id);
    await ctx.db.patch(args.planId, { consumedAt: Date.now() });
    return { dryRun: false, target: "memoryEvents", deleted: rows.length, matched: rows.length };
  },
});
