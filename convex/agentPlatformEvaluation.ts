import { ConvexError, v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { requireAgentPlatformActor, type ConvexActor } from "./agentPlatformAuth";

const expectedActorArgs = { expectedTenantId: v.optional(v.string()), expectedUserId: v.optional(v.string()) };
const MAX_EVAL_CONVERSATIONS_PER_ACTOR = 64;

function requireEvaluationActor(actor: ConvexActor, runId: string) {
  if (!/^memory-eval-[a-z0-9-]{8,80}$/.test(runId)) throw new ConvexError("MEMORY_EVAL_RUN_ID_INVALID");
  if (!actor.permissions.includes("memory.eval")) throw new ConvexError("MEMORY_EVAL_PERMISSION_REQUIRED");
  if (actor.permissionsVersion !== `memory-eval:${runId}` || !actor.sessionId.startsWith("refresh:")) {
    throw new ConvexError("MEMORY_EVAL_SESSION_REQUIRED");
  }
}

async function collectRows(ctx: QueryCtx | MutationCtx, actor: ConvexActor, conversationIds: string[]) {
  const requested = new Set(conversationIds);
  const conversations = (await ctx.db.query("agentPlatformConversations")
    .withIndex("by_tenant_conversation", (q) => q.eq("tenantId", actor.tenantId)).collect())
    .filter((row) => requested.has(row.conversationId) && row.ownerUserId === actor.userId);
  if (conversations.length !== requested.size) throw new ConvexError("MEMORY_EVAL_CONVERSATION_OWNERSHIP_MISMATCH");

  const runs = (await ctx.db.query("agentPlatformRuns")
    .withIndex("by_tenant_actor_created", (q) => q.eq("tenantId", actor.tenantId).eq("actorUserId", actor.userId)).collect())
    .filter((row) => row.conversationId && requested.has(row.conversationId));
  const runIds = new Set(runs.map((row) => row.runId));
  const attempts = [];
  for (const run of runs) attempts.push(...await ctx.db.query("agentPlatformAttempts")
    .withIndex("by_tenant_run_attempt", (q) => q.eq("tenantId", actor.tenantId).eq("runId", run.runId)).collect());
  const messages = (await ctx.db.query("agentPlatformMessages")
    .withIndex("by_tenant_conversation_sequence", (q) => q.eq("tenantId", actor.tenantId)).collect())
    .filter((row) => row.actorUserId === actor.userId && requested.has(row.conversationId));
  const events = (await ctx.db.query("agentPlatformEvents")
    .withIndex("by_tenant_occurred", (q) => q.eq("tenantId", actor.tenantId)).collect())
    .filter((row) => row.actorUserId === actor.userId && (
      (row.conversationId && requested.has(row.conversationId))
      || (row.interactionRunId && runIds.has(row.interactionRunId))
      || (row.executionRunId && runIds.has(row.executionRunId))
    ));
  const usage = (await ctx.db.query("agentPlatformUsage")
    .withIndex("by_tenant_created", (q) => q.eq("tenantId", actor.tenantId)).collect())
    .filter((row) => row.actorUserId === actor.userId && runIds.has(row.runId));
  const writeIntents = (await ctx.db.query("agentPlatformWriteIntents")
    .withIndex("by_tenant_actor_created", (q) => q.eq("tenantId", actor.tenantId).eq("actorUserId", actor.userId)).collect())
    .filter((row) => {
      const envelope = row.intent?.envelope as { conversationId?: unknown; sourceRunId?: unknown } | undefined;
      return (typeof envelope?.conversationId === "string" && requested.has(envelope.conversationId))
        || (typeof envelope?.sourceRunId === "string" && runIds.has(envelope.sourceRunId));
    });
  const memoryRecords = [];
  for (const lifecycle of ["active", "archived", "pruned"] as const) {
    memoryRecords.push(...(await ctx.db.query("memoryRecords")
      .withIndex("by_scope_lifecycle_created", (q) => q.eq("tenantId", actor.tenantId).eq("ownerUserId", actor.userId).eq("scope", "user").eq("lifecycle", lifecycle)).collect())
      .filter((row) => row.sourceRunId && runIds.has(row.sourceRunId)));
  }
  const memoryIds = new Set(memoryRecords.map((row) => row.memoryId));
  const memoryEvents = (await ctx.db.query("memoryEvents")
    .withIndex("by_scope_created", (q) => q.eq("tenantId", actor.tenantId).eq("ownerUserId", actor.userId).eq("scope", "user")).collect())
    .filter((row) => (row.conversationId && requested.has(row.conversationId)) || (row.memoryId && memoryIds.has(row.memoryId)));
  return { conversations, messages, runs, attempts, events, usage, writeIntents, memoryRecords, memoryEvents };
}

function counts(rows: Awaited<ReturnType<typeof collectRows>>) {
  return Object.fromEntries(Object.entries(rows).map(([name, values]) => [name, values.length]));
}

export const listOwnedConversationIds = query({
  args: { runId: v.string(), limit: v.optional(v.number()), ...expectedActorArgs },
  handler: async (ctx, args) => {
    const actor = await requireAgentPlatformActor(ctx, args);
    requireEvaluationActor(actor, args.runId);
    const limit = Math.max(1, Math.min(args.limit ?? MAX_EVAL_CONVERSATIONS_PER_ACTOR, MAX_EVAL_CONVERSATIONS_PER_ACTOR));
    return (await ctx.db.query("agentPlatformConversations")
      .withIndex("by_tenant_conversation", (q) => q.eq("tenantId", actor.tenantId)).collect())
      .filter((row) => row.ownerUserId === actor.userId)
      .slice(0, limit)
      .map((row) => row.conversationId);
  },
});

/**
 * Bounded discovery for browser-created evaluation conversations. The caller
 * is still an authenticated evaluation actor, and the result never crosses
 * actor ownership. This lets soak cleanup identify a precise time window
 * before using the existing preview + explicit-confirmation deletion path.
 */
export const listOwnedConversationsSince = query({
  args: {
    runId: v.string(),
    createdAtOrAfter: v.number(),
    createdBefore: v.optional(v.number()),
    limit: v.optional(v.number()),
    ...expectedActorArgs,
  },
  handler: async (ctx, args) => {
    const actor = await requireAgentPlatformActor(ctx, args);
    requireEvaluationActor(actor, args.runId);
    const limit = Math.max(1, Math.min(args.limit ?? MAX_EVAL_CONVERSATIONS_PER_ACTOR, MAX_EVAL_CONVERSATIONS_PER_ACTOR));
    const conversations = (await ctx.db.query("agentPlatformConversations")
      .withIndex("by_tenant_conversation", (q) => q.eq("tenantId", actor.tenantId)).collect())
      .filter((row) => row.ownerUserId === actor.userId
        && row.createdAt >= args.createdAtOrAfter
        && (args.createdBefore == null || row.createdAt < args.createdBefore))
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit);
    const rows = [];
    for (const conversation of conversations) {
      const firstUserMessage = (await ctx.db.query("agentPlatformMessages")
        .withIndex("by_tenant_conversation_sequence", (q) => q.eq("tenantId", actor.tenantId).eq("conversationId", conversation.conversationId)).collect())
        .find((message) => message.actorUserId === actor.userId && message.role === "user");
      rows.push({
        conversationId: conversation.conversationId,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        firstUserMessage: firstUserMessage?.contentRedacted.slice(0, 240) ?? null,
      });
    }
    return rows;
  },
});

export const previewOwnedCleanup = query({
  args: { runId: v.string(), conversationIds: v.array(v.string()), ...expectedActorArgs },
  handler: async (ctx, args) => {
    const actor = await requireAgentPlatformActor(ctx, args);
    requireEvaluationActor(actor, args.runId);
    const conversationIds = [...new Set(args.conversationIds)];
    if (!conversationIds.length || conversationIds.length > MAX_EVAL_CONVERSATIONS_PER_ACTOR) throw new ConvexError("MEMORY_EVAL_CONVERSATION_SET_INVALID");
    return { runId: args.runId, tenantId: actor.tenantId, ownerUserId: actor.userId, dryRun: true, counts: counts(await collectRows(ctx, actor, conversationIds)) };
  },
});

export const cleanupOwned = mutation({
  args: { runId: v.string(), conversationIds: v.array(v.string()), confirmation: v.string(), ...expectedActorArgs },
  handler: async (ctx, args) => {
    const actor = await requireAgentPlatformActor(ctx, args);
    requireEvaluationActor(actor, args.runId);
    if (args.confirmation !== `DELETE_MEMORY_EVAL_DATA:${args.runId}`) throw new ConvexError("MEMORY_EVAL_CONFIRMATION_INVALID");
    const conversationIds = [...new Set(args.conversationIds)];
    if (!conversationIds.length || conversationIds.length > MAX_EVAL_CONVERSATIONS_PER_ACTOR) throw new ConvexError("MEMORY_EVAL_CONVERSATION_SET_INVALID");
    const rows = await collectRows(ctx, actor, conversationIds);
    const before = counts(rows);
    for (const row of rows.memoryEvents) await ctx.db.delete(row._id);
    for (const row of rows.memoryRecords) await ctx.db.delete(row._id);
    for (const row of rows.writeIntents) await ctx.db.delete(row._id);
    for (const row of rows.usage) await ctx.db.delete(row._id);
    for (const row of rows.events) await ctx.db.delete(row._id);
    for (const row of rows.attempts) await ctx.db.delete(row._id);
    for (const row of rows.runs) await ctx.db.delete(row._id);
    for (const row of rows.messages) await ctx.db.delete(row._id);
    for (const row of rows.conversations) await ctx.db.delete(row._id);
    return { runId: args.runId, tenantId: actor.tenantId, ownerUserId: actor.userId, deleted: before };
  },
});
