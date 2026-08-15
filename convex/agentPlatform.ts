import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { canReadTenantRun, requireAgentPlatformActor } from "./agentPlatformAuth";

const expectedActorArgs = {
  expectedTenantId: v.optional(v.string()),
  expectedUserId: v.optional(v.string()),
};

const runStatus = v.union(
  v.literal("queued"), v.literal("waiting_dependency"), v.literal("resolving_scope"),
  v.literal("running"), v.literal("awaiting_confirmation"), v.literal("completed"),
  v.literal("partial"), v.literal("failed"), v.literal("cancelled"), v.literal("timeout"),
);

const attemptStatus = v.union(
  v.literal("queued"), v.literal("running"), v.literal("succeeded"), v.literal("failed"),
  v.literal("cancelled"), v.literal("timeout"), v.literal("unknown"),
);

async function tenantRun(ctx: Parameters<typeof requireAgentPlatformActor>[0], tenantId: string, runId: string) {
  return await ctx.db.query("agentPlatformRuns")
    .withIndex("by_tenant_run", (q) => q.eq("tenantId", tenantId).eq("runId", runId))
    .unique();
}

export const currentActor = query({
  args: {},
  handler: async (ctx) => await requireAgentPlatformActor(ctx),
});

export const createConversation = mutation({
  args: { conversationId: v.string(), title: v.optional(v.string()), ...expectedActorArgs },
  handler: async (ctx, args) => {
    const actor = await requireAgentPlatformActor(ctx, args);
    const existing = await ctx.db.query("agentPlatformConversations")
      .withIndex("by_tenant_conversation", (q) => q.eq("tenantId", actor.tenantId).eq("conversationId", args.conversationId))
      .unique();
    if (existing) throw new ConvexError("CONVERSATION_ALREADY_EXISTS");
    const now = Date.now();
    const value = { conversationId: args.conversationId, tenantId: actor.tenantId, ownerUserId: actor.userId, title: args.title, createdAt: now, updatedAt: now };
    await ctx.db.insert("agentPlatformConversations", value);
    return value;
  },
});

export const appendMessage = mutation({
  args: {
    messageId: v.string(), conversationId: v.string(), role: v.union(v.literal("user"), v.literal("assistant"), v.literal("system")),
    contentRedacted: v.string(), blocks: v.optional(v.any()), runId: v.optional(v.string()), sequence: v.number(), createdAt: v.number(), ...expectedActorArgs,
  },
  handler: async (ctx, args) => {
    const actor = await requireAgentPlatformActor(ctx, args);
    const conversation = await ctx.db.query("agentPlatformConversations")
      .withIndex("by_tenant_conversation", (q) => q.eq("tenantId", actor.tenantId).eq("conversationId", args.conversationId)).unique();
    if (!conversation) return [];
    if (conversation.ownerUserId !== actor.userId) throw new ConvexError("CONVERSATION_FORBIDDEN");
    const value = { messageId: args.messageId, conversationId: args.conversationId, tenantId: actor.tenantId, actorUserId: actor.userId, role: args.role, contentRedacted: args.contentRedacted, sequence: args.sequence, createdAt: args.createdAt };
    await ctx.db.insert("agentPlatformMessages", value);
    await ctx.db.patch(conversation._id, { updatedAt: Date.now() });
    return value;
  },
});

export const listMessages = query({
  args: { conversationId: v.string(), limit: v.number(), ...expectedActorArgs },
  handler: async (ctx, args) => {
    const actor = await requireAgentPlatformActor(ctx, args);
    const conversation = await ctx.db.query("agentPlatformConversations")
      .withIndex("by_tenant_conversation", (q) => q.eq("tenantId", actor.tenantId).eq("conversationId", args.conversationId)).unique();
    if (!conversation || conversation.ownerUserId !== actor.userId) throw new ConvexError("CONVERSATION_FORBIDDEN");
    const limit = Math.max(1, Math.min(200, Math.floor(args.limit)));
    return await ctx.db.query("agentPlatformMessages")
      .withIndex("by_tenant_conversation_sequence", (q) => q.eq("tenantId", actor.tenantId).eq("conversationId", args.conversationId))
      .order("asc").take(limit);
  },
});

export const createRun = mutation({
  args: {
    runId: v.string(), conversationId: v.optional(v.string()), kind: v.union(v.literal("interaction"), v.literal("execution")),
    profileId: v.optional(v.string()), profileVersion: v.optional(v.number()), objectiveHash: v.string(), objectiveRedacted: v.optional(v.string()), parentRunId: v.optional(v.string()),
    dependencyRunIds: v.array(v.string()), registryHash: v.string(), skillVersions: v.any(), toolScope: v.array(v.string()),
    requestedModel: v.optional(v.string()), visibility: v.union(v.literal("user"), v.literal("tenant_admin"), v.literal("platform_admin")),
    ...expectedActorArgs,
  },
  handler: async (ctx, args) => {
    const actor = await requireAgentPlatformActor(ctx, args);
    if (await tenantRun(ctx, actor.tenantId, args.runId)) throw new ConvexError("RUN_ALREADY_EXISTS");
    const now = Date.now();
    const { expectedTenantId: _tenant, expectedUserId: _user, ...input } = args;
    const value = { ...input, tenantId: actor.tenantId, actorUserId: actor.userId, status: "queued" as const, createdAt: now, updatedAt: now };
    await ctx.db.insert("agentPlatformRuns", value);
    return value;
  },
});

export const getRun = query({
  args: { runId: v.string(), ...expectedActorArgs },
  handler: async (ctx, args) => {
    const actor = await requireAgentPlatformActor(ctx, args);
    const run = await tenantRun(ctx, actor.tenantId, args.runId);
    return run && canReadTenantRun(actor, run) ? run : null;
  },
});

export const listRuns = query({
  args: { limit: v.number(), status: v.optional(runStatus), ownOnly: v.optional(v.boolean()), ...expectedActorArgs },
  handler: async (ctx, args) => {
    const actor = await requireAgentPlatformActor(ctx, args);
    const limit = Math.max(1, Math.min(100, Math.floor(args.limit)));
    const rows = args.status
      ? await ctx.db.query("agentPlatformRuns").withIndex("by_tenant_status_created", (q) => q.eq("tenantId", actor.tenantId).eq("status", args.status!)).order("desc").take(limit * 2)
      : await ctx.db.query("agentPlatformRuns").withIndex("by_tenant_created", (q) => q.eq("tenantId", actor.tenantId)).order("desc").take(limit * 2);
    return rows.filter((run) => (args.ownOnly ? run.actorUserId === actor.userId : canReadTenantRun(actor, run))).slice(0, limit);
  },
});

export const updateRun = mutation({
  args: {
    runId: v.string(), expectedStatus: v.optional(runStatus),
    patch: v.object({ status: v.optional(runStatus), resolvedModel: v.optional(v.string()), provider: v.optional(v.string()), finishReason: v.optional(v.string()), resultSummary: v.optional(v.string()), errorCode: v.optional(v.string()), cancelRequestedAt: v.optional(v.number()), completedAt: v.optional(v.number()) }),
    ...expectedActorArgs,
  },
  handler: async (ctx, args) => {
    const actor = await requireAgentPlatformActor(ctx, args);
    const run = await tenantRun(ctx, actor.tenantId, args.runId);
    if (!run || run.actorUserId !== actor.userId) throw new ConvexError("RUN_FORBIDDEN");
    if (args.expectedStatus && run.status !== args.expectedStatus) throw new ConvexError("RUN_STATUS_CONFLICT");
    await ctx.db.patch(run._id, { ...args.patch, updatedAt: Date.now() });
    return { ...run, ...args.patch, updatedAt: Date.now() };
  },
});

export const appendEvent = mutation({
  args: {
    eventId: v.string(), conversationId: v.optional(v.string()), interactionRunId: v.optional(v.string()), executionRunId: v.optional(v.string()),
    attemptId: v.optional(v.string()), sequence: v.number(), type: v.string(), visibility: v.union(v.literal("user"), v.literal("tenant_admin"), v.literal("platform_admin")),
    payload: v.any(), occurredAt: v.number(), ...expectedActorArgs,
  },
  handler: async (ctx, args) => {
    const actor = await requireAgentPlatformActor(ctx, args);
    const { expectedTenantId: _tenant, expectedUserId: _user, payload, ...input } = args;
    const value = { ...input, tenantId: actor.tenantId, actorUserId: actor.userId, payloadRedacted: payload };
    await ctx.db.insert("agentPlatformEvents", value);
    return value;
  },
});

export const listEvents = query({
  args: { executionRunId: v.string(), limit: v.number(), ...expectedActorArgs },
  handler: async (ctx, args) => {
    const actor = await requireAgentPlatformActor(ctx, args);
    const run = await tenantRun(ctx, actor.tenantId, args.executionRunId);
    if (!run || !canReadTenantRun(actor, run)) throw new ConvexError("RUN_FORBIDDEN");
    const limit = Math.max(1, Math.min(500, Math.floor(args.limit)));
    return await ctx.db.query("agentPlatformEvents")
      .withIndex("by_tenant_execution_sequence", (q) => q.eq("tenantId", actor.tenantId).eq("executionRunId", args.executionRunId))
      .order("asc").take(limit);
  },
});

export const createAttempt = mutation({
  args: {
    attemptId: v.string(), runId: v.string(), attemptNumber: v.number(), status: attemptStatus,
    leaseOwner: v.optional(v.string()), fencingToken: v.number(), leaseExpiresAt: v.optional(v.number()), heartbeatAt: v.optional(v.number()),
    retryOfAttemptId: v.optional(v.string()), startedAt: v.optional(v.number()), completedAt: v.optional(v.number()), errorCode: v.optional(v.string()), ...expectedActorArgs,
  },
  handler: async (ctx, args) => {
    const actor = await requireAgentPlatformActor(ctx, args);
    const run = await tenantRun(ctx, actor.tenantId, args.runId);
    if (!run) throw new ConvexError("RUN_NOT_FOUND");
    const { expectedTenantId: _tenant, expectedUserId: _user, ...input } = args;
    const value = { ...input, tenantId: actor.tenantId };
    await ctx.db.insert("agentPlatformAttempts", value);
    return value;
  },
});

export const updateAttempt = mutation({
  args: {
    attemptId: v.string(), expectedStatus: v.optional(attemptStatus),
    patch: v.object({ status: v.optional(attemptStatus), startedAt: v.optional(v.number()), completedAt: v.optional(v.number()), errorCode: v.optional(v.string()) }),
    ...expectedActorArgs,
  },
  handler: async (ctx, args) => {
    const actor = await requireAgentPlatformActor(ctx, args);
    const attempt = await ctx.db.query("agentPlatformAttempts")
      .withIndex("by_tenant_attempt", (q) => q.eq("tenantId", actor.tenantId).eq("attemptId", args.attemptId)).unique();
    if (!attempt) throw new ConvexError("ATTEMPT_NOT_FOUND");
    if (args.expectedStatus && attempt.status !== args.expectedStatus) throw new ConvexError("ATTEMPT_STATUS_CONFLICT");
    await ctx.db.patch(attempt._id, args.patch);
    return { ...attempt, ...args.patch };
  },
});

export const acquireLease = mutation({
  args: { runId: v.string(), attemptId: v.string(), leaseOwner: v.string(), now: v.number(), leaseDurationMs: v.number(), ...expectedActorArgs },
  handler: async (ctx, args) => {
    const actor = await requireAgentPlatformActor(ctx, args);
    const attempt = await ctx.db.query("agentPlatformAttempts")
      .withIndex("by_tenant_attempt", (q) => q.eq("tenantId", actor.tenantId).eq("attemptId", args.attemptId)).unique();
    if (!attempt || attempt.runId !== args.runId) return null;
    if (attempt.status === "running" && (attempt.leaseExpiresAt ?? 0) > args.now) return null;
    if (attempt.status !== "queued" && attempt.status !== "running") return null;
    const patch = { status: "running" as const, leaseOwner: args.leaseOwner, fencingToken: attempt.fencingToken + 1, leaseExpiresAt: args.now + args.leaseDurationMs, heartbeatAt: args.now, startedAt: attempt.startedAt ?? args.now };
    await ctx.db.patch(attempt._id, patch);
    return { ...attempt, ...patch };
  },
});

export const heartbeat = mutation({
  args: { runId: v.string(), attemptId: v.string(), leaseOwner: v.string(), fencingToken: v.number(), leaseExpiresAt: v.number(), ...expectedActorArgs },
  handler: async (ctx, args) => {
    const actor = await requireAgentPlatformActor(ctx, args);
    const attempt = await ctx.db.query("agentPlatformAttempts")
      .withIndex("by_tenant_attempt", (q) => q.eq("tenantId", actor.tenantId).eq("attemptId", args.attemptId)).unique();
    if (!attempt || attempt.runId !== args.runId || attempt.status !== "running" || attempt.leaseOwner !== args.leaseOwner || attempt.fencingToken !== args.fencingToken) return false;
    await ctx.db.patch(attempt._id, { heartbeatAt: Date.now(), leaseExpiresAt: args.leaseExpiresAt });
    return true;
  },
});

export const requestCancellation = mutation({
  args: { runId: v.string(), requestedAt: v.number(), ...expectedActorArgs },
  handler: async (ctx, args) => {
    const actor = await requireAgentPlatformActor(ctx, args);
    const run = await tenantRun(ctx, actor.tenantId, args.runId);
    if (!run || !canReadTenantRun(actor, run)) throw new ConvexError("RUN_FORBIDDEN");
    const patch = { cancelRequestedAt: args.requestedAt, updatedAt: Date.now() };
    await ctx.db.patch(run._id, patch);
    return { ...run, ...patch };
  },
});

export const recordUsage = mutation({
  args: {
    usageId: v.string(), runId: v.string(), attemptId: v.string(), requestedModel: v.string(), resolvedModel: v.string(), provider: v.optional(v.string()),
    inputTokens: v.number(), outputTokens: v.number(), reasoningTokens: v.number(), cachedTokens: v.number(), costUsd: v.number(), latencyMs: v.number(), fallbackUsed: v.boolean(), finishReason: v.optional(v.string()), createdAt: v.number(), ...expectedActorArgs,
  },
  handler: async (ctx, args) => {
    const actor = await requireAgentPlatformActor(ctx, args);
    const { expectedTenantId: _tenant, expectedUserId: _user, ...input } = args;
    await ctx.db.insert("agentPlatformUsage", { ...input, tenantId: actor.tenantId, actorUserId: actor.userId });
  },
});

export const listUsage = query({
  args: { runId: v.string(), limit: v.number(), ...expectedActorArgs },
  handler: async (ctx, args) => {
    const actor = await requireAgentPlatformActor(ctx, args);
    const run = await tenantRun(ctx, actor.tenantId, args.runId);
    if (!run || !canReadTenantRun(actor, run)) throw new ConvexError("RUN_FORBIDDEN");
    const limit = Math.max(1, Math.min(50, Math.floor(args.limit)));
    return await ctx.db.query("agentPlatformUsage")
      .withIndex("by_tenant_run", (q) => q.eq("tenantId", actor.tenantId).eq("runId", args.runId))
      .order("asc").take(limit);
  },
});
