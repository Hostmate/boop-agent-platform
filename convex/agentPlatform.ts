import { ConvexError, v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { assertConversationOwner, canReadTenantRun, requireAgentPlatformActor } from "./agentPlatformAuth";

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

const writeIntentStatus = v.union(
  v.literal("proposed"), v.literal("confirmed"), v.literal("committing"),
  v.literal("committed"), v.literal("cancelled"), v.literal("expired"),
  v.literal("failed"), v.literal("stale"),
);

type DatabaseCtx = QueryCtx | MutationCtx;

async function tenantRun(ctx: DatabaseCtx, tenantId: string, runId: string) {
  return await ctx.db.query("agentPlatformRuns")
    .withIndex("by_tenant_run", (q) => q.eq("tenantId", tenantId).eq("runId", runId))
    .unique();
}

async function ownedTenantRun(ctx: DatabaseCtx, tenantId: string, userId: string, runId: string) {
  const run = await tenantRun(ctx, tenantId, runId);
  if (!run || run.actorUserId !== userId) throw new ConvexError("RUN_FORBIDDEN");
  return run;
}

async function tenantConversation(ctx: DatabaseCtx, tenantId: string, conversationId: string) {
  return await ctx.db.query("agentPlatformConversations")
    .withIndex("by_tenant_conversation", (q) => q.eq("tenantId", tenantId).eq("conversationId", conversationId))
    .unique();
}

async function tenantAttempt(ctx: DatabaseCtx, tenantId: string, attemptId: string) {
  return await ctx.db.query("agentPlatformAttempts")
    .withIndex("by_tenant_attempt", (q) => q.eq("tenantId", tenantId).eq("attemptId", attemptId)).unique();
}

async function ownedAttempt(ctx: DatabaseCtx, tenantId: string, userId: string, attemptId: string) {
  const attempt = await tenantAttempt(ctx, tenantId, attemptId);
  if (!attempt) throw new ConvexError("ATTEMPT_NOT_FOUND");
  await ownedTenantRun(ctx, tenantId, userId, attempt.runId);
  return attempt;
}

async function tenantWriteIntent(ctx: DatabaseCtx, tenantId: string, draftId: string) {
  return await ctx.db.query("agentPlatformWriteIntents")
    .withIndex("by_tenant_draft", (q) => q.eq("tenantId", tenantId).eq("draftId", draftId)).unique();
}

async function ownedWriteIntent(ctx: DatabaseCtx, tenantId: string, userId: string, draftId: string) {
  const draft = await tenantWriteIntent(ctx, tenantId, draftId);
  if (!draft || draft.actorUserId !== userId) throw new ConvexError("WRITE_INTENT_FORBIDDEN");
  return draft;
}

export const currentActor = query({
  args: {},
  handler: async (ctx) => await requireAgentPlatformActor(ctx),
});

export const createConversation = mutation({
  args: { conversationId: v.string(), title: v.optional(v.string()), ...expectedActorArgs },
  handler: async (ctx, args) => {
    const actor = await requireAgentPlatformActor(ctx, args);
    const existing = await tenantConversation(ctx, actor.tenantId, args.conversationId);
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
    contentRedacted: v.string(), blocks: v.optional(v.any()), contextRefs: v.optional(v.any()), runId: v.optional(v.string()), sequence: v.number(), createdAt: v.number(), ...expectedActorArgs,
  },
  handler: async (ctx, args) => {
    const actor = await requireAgentPlatformActor(ctx, args);
    const conversation = await tenantConversation(ctx, actor.tenantId, args.conversationId);
    if (!conversation) return [];
    if (conversation.ownerUserId !== actor.userId) throw new ConvexError("CONVERSATION_FORBIDDEN");
    if (args.runId) {
      const run = await ownedTenantRun(ctx, actor.tenantId, actor.userId, args.runId);
      if (run.conversationId !== args.conversationId) throw new ConvexError("RUN_CONVERSATION_MISMATCH");
    }
    const value = {
      messageId: args.messageId, conversationId: args.conversationId, tenantId: actor.tenantId,
      actorUserId: actor.userId, role: args.role, contentRedacted: args.contentRedacted,
      blocks: args.blocks, contextRefs: args.contextRefs, runId: args.runId,
      sequence: args.sequence, createdAt: args.createdAt,
    };
    await ctx.db.insert("agentPlatformMessages", value);
    await ctx.db.patch(conversation._id, { updatedAt: Date.now() });
    return value;
  },
});

export const listMessages = query({
  args: { conversationId: v.string(), limit: v.number(), ...expectedActorArgs },
  handler: async (ctx, args) => {
    const actor = await requireAgentPlatformActor(ctx, args);
    const conversation = await tenantConversation(ctx, actor.tenantId, args.conversationId);
    if (!assertConversationOwner(actor, conversation)) throw new ConvexError("CONVERSATION_NOT_FOUND");
    const limit = Math.max(1, Math.min(200, Math.floor(args.limit)));
    const messages = await ctx.db.query("agentPlatformMessages")
      .withIndex("by_tenant_conversation_sequence", (q) => q.eq("tenantId", actor.tenantId).eq("conversationId", args.conversationId))
      .order("desc").take(limit);
    return messages.reverse();
  },
});

export const listMessagesIfPresent = query({
  args: { conversationId: v.string(), limit: v.number(), ...expectedActorArgs },
  handler: async (ctx, args) => {
    const actor = await requireAgentPlatformActor(ctx, args);
    const conversation = await tenantConversation(ctx, actor.tenantId, args.conversationId);
    // The browser allocates an ID before the first turn creates the durable
    // conversation. Its empty state must render without weakening ownership.
    if (!assertConversationOwner(actor, conversation)) return [];
    const limit = Math.max(1, Math.min(200, Math.floor(args.limit)));
    const messages = await ctx.db.query("agentPlatformMessages")
      .withIndex("by_tenant_conversation_sequence", (q) => q.eq("tenantId", actor.tenantId).eq("conversationId", args.conversationId))
      .order("desc").take(limit);
    return messages.reverse();
  },
});

export const createRun = mutation({
  args: {
    runId: v.string(), conversationId: v.optional(v.string()), kind: v.union(v.literal("interaction"), v.literal("execution")),
    profileId: v.optional(v.string()), profileVersion: v.optional(v.number()), objectiveHash: v.string(), objectiveRedacted: v.optional(v.string()), parentRunId: v.optional(v.string()),
    orchestrationId: v.optional(v.string()), branchKey: v.optional(v.string()), orchestrationDepth: v.optional(v.number()),
    dependencyRunIds: v.array(v.string()), registryHash: v.string(), skillVersions: v.any(), skillRefs: v.optional(v.any()), toolScope: v.array(v.string()),
    requestedModel: v.optional(v.string()), visibility: v.union(v.literal("user"), v.literal("tenant_admin"), v.literal("platform_admin")),
    ...expectedActorArgs,
  },
  handler: async (ctx, args) => {
    const actor = await requireAgentPlatformActor(ctx, args);
    if (await tenantRun(ctx, actor.tenantId, args.runId)) throw new ConvexError("RUN_ALREADY_EXISTS");
    if (args.conversationId) {
      const conversation = await tenantConversation(ctx, actor.tenantId, args.conversationId);
      if (!conversation || conversation.ownerUserId !== actor.userId) throw new ConvexError("CONVERSATION_FORBIDDEN");
    }
    const linkedRunIds = [args.parentRunId, ...args.dependencyRunIds].filter((runId): runId is string => Boolean(runId));
    for (const linkedRunId of linkedRunIds) await ownedTenantRun(ctx, actor.tenantId, actor.userId, linkedRunId);
    if (args.orchestrationDepth !== undefined && (!Number.isInteger(args.orchestrationDepth) || args.orchestrationDepth < 0 || args.orchestrationDepth > 1)) {
      throw new ConvexError("ORCHESTRATION_DEPTH_EXCEEDED");
    }
    if (args.kind === "execution" && args.orchestrationId && (!args.parentRunId || args.orchestrationDepth !== 1 || !args.branchKey)) {
      throw new ConvexError("INVALID_ORCHESTRATION_CHILD");
    }
    if (args.parentRunId) {
      const parent = await ownedTenantRun(ctx, actor.tenantId, actor.userId, args.parentRunId);
      if (parent.kind !== "interaction") throw new ConvexError("CHILD_RUN_CANNOT_SPAWN");
      if (args.orchestrationId && parent.orchestrationId !== args.orchestrationId) throw new ConvexError("ORCHESTRATION_PARENT_MISMATCH");
    }
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
    const run = await ownedTenantRun(ctx, actor.tenantId, actor.userId, args.runId);
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
    if (args.conversationId) {
      const conversation = await tenantConversation(ctx, actor.tenantId, args.conversationId);
      if (!conversation || conversation.ownerUserId !== actor.userId) throw new ConvexError("CONVERSATION_FORBIDDEN");
    }
    for (const runId of [args.interactionRunId, args.executionRunId]) {
      if (runId) await ownedTenantRun(ctx, actor.tenantId, actor.userId, runId);
    }
    if (args.attemptId) {
      const attempt = await ownedAttempt(ctx, actor.tenantId, actor.userId, args.attemptId);
      if (args.executionRunId && attempt.runId !== args.executionRunId) throw new ConvexError("ATTEMPT_RUN_MISMATCH");
    }
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
    await ownedTenantRun(ctx, actor.tenantId, actor.userId, args.runId);
    if (await tenantAttempt(ctx, actor.tenantId, args.attemptId)) throw new ConvexError("ATTEMPT_ALREADY_EXISTS");
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
    const attempt = await ownedAttempt(ctx, actor.tenantId, actor.userId, args.attemptId);
    if (args.expectedStatus && attempt.status !== args.expectedStatus) throw new ConvexError("ATTEMPT_STATUS_CONFLICT");
    await ctx.db.patch(attempt._id, args.patch);
    return { ...attempt, ...args.patch };
  },
});

export const acquireLease = mutation({
  args: { runId: v.string(), attemptId: v.string(), leaseOwner: v.string(), now: v.number(), leaseDurationMs: v.number(), ...expectedActorArgs },
  handler: async (ctx, args) => {
    const actor = await requireAgentPlatformActor(ctx, args);
    const attempt = await tenantAttempt(ctx, actor.tenantId, args.attemptId);
    if (!attempt || attempt.runId !== args.runId) return null;
    await ownedTenantRun(ctx, actor.tenantId, actor.userId, attempt.runId);
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
    const attempt = await tenantAttempt(ctx, actor.tenantId, args.attemptId);
    if (!attempt || attempt.runId !== args.runId || attempt.status !== "running" || attempt.leaseOwner !== args.leaseOwner || attempt.fencingToken !== args.fencingToken) return false;
    await ownedTenantRun(ctx, actor.tenantId, actor.userId, attempt.runId);
    await ctx.db.patch(attempt._id, { heartbeatAt: Date.now(), leaseExpiresAt: args.leaseExpiresAt });
    return true;
  },
});

export const requestCancellation = mutation({
  args: { runId: v.string(), requestedAt: v.number(), ...expectedActorArgs },
  handler: async (ctx, args) => {
    const actor = await requireAgentPlatformActor(ctx, args);
    const run = await ownedTenantRun(ctx, actor.tenantId, actor.userId, args.runId);
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
    await ownedTenantRun(ctx, actor.tenantId, actor.userId, args.runId);
    const attempt = await ownedAttempt(ctx, actor.tenantId, actor.userId, args.attemptId);
    if (attempt.runId !== args.runId) throw new ConvexError("ATTEMPT_RUN_MISMATCH");
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

export const createWriteIntent = mutation({
  args: {
    intent: v.any(), status: writeIntentStatus, createdAt: v.number(),
    confirmedAt: v.optional(v.number()), commitStartedAt: v.optional(v.number()), terminalAt: v.optional(v.number()),
    result: v.optional(v.any()), errorCode: v.optional(v.string()), ...expectedActorArgs,
  },
  handler: async (ctx, args) => {
    const actor = await requireAgentPlatformActor(ctx, args);
    const signed = args.intent as { envelope?: Record<string, unknown>; signature?: unknown };
    const envelope = signed?.envelope;
    if (!envelope || typeof signed.signature !== "string"
      || envelope.tenantId !== actor.tenantId || envelope.actorUserId !== actor.userId
      || typeof envelope.draftId !== "string" || typeof envelope.sourceRunId !== "string"
      || typeof envelope.conversationId !== "string" || args.status !== "proposed") {
      throw new ConvexError("INVALID_WRITE_INTENT");
    }
    if (await tenantWriteIntent(ctx, actor.tenantId, envelope.draftId)) throw new ConvexError("WRITE_INTENT_ALREADY_EXISTS");
    const run = await ownedTenantRun(ctx, actor.tenantId, actor.userId, envelope.sourceRunId);
    if (run.conversationId !== envelope.conversationId || run.status !== "awaiting_confirmation") {
      throw new ConvexError("WRITE_INTENT_RUN_MISMATCH");
    }
    const value = {
      draftId: envelope.draftId, tenantId: actor.tenantId, actorUserId: actor.userId,
      intent: args.intent, status: "proposed" as const, createdAt: args.createdAt,
    };
    await ctx.db.insert("agentPlatformWriteIntents", value);
    return value;
  },
});

/** Authority-bound raw record used only by the authenticated runtime. */
export const getWriteIntent = query({
  args: { draftId: v.string(), ...expectedActorArgs },
  handler: async (ctx, args) => {
    const actor = await requireAgentPlatformActor(ctx, args);
    return await ownedWriteIntent(ctx, actor.tenantId, actor.userId, args.draftId);
  },
});

/** Sanitized realtime projection consumed by the confirmation component. */
export const getWriteIntentStatus = query({
  args: { draftId: v.string() },
  handler: async (ctx, args) => {
    const actor = await requireAgentPlatformActor(ctx);
    const row = await ownedWriteIntent(ctx, actor.tenantId, actor.userId, args.draftId);
    const envelope = (row.intent as { envelope: { expiresAt: number } }).envelope;
    return { draftId: row.draftId, status: row.status, expiresAt: envelope.expiresAt, confirmedAt: row.confirmedAt, terminalAt: row.terminalAt, result: row.result, errorCode: row.errorCode };
  },
});

export const confirmWriteIntent = mutation({
  args: { draftId: v.string(), now: v.number(), ...expectedActorArgs },
  handler: async (ctx, args) => {
    const actor = await requireAgentPlatformActor(ctx, args);
    const row = await ownedWriteIntent(ctx, actor.tenantId, actor.userId, args.draftId);
    const expiresAt = Number((row.intent as { envelope: { expiresAt: number } }).envelope.expiresAt);
    if (row.status === "committed" || row.status === "confirmed" || row.status === "committing") return row;
    if (row.status !== "proposed") throw new ConvexError(`WRITE_INTENT_${row.status.toUpperCase()}`);
    if (!Number.isFinite(expiresAt) || expiresAt <= args.now) {
      const patch = { status: "expired" as const, terminalAt: args.now, errorCode: "DRAFT_EXPIRED" };
      await ctx.db.patch(row._id, patch);
      return { ...row, ...patch };
    }
    const patch = { status: "confirmed" as const, confirmedAt: args.now };
    await ctx.db.patch(row._id, patch);
    return { ...row, ...patch };
  },
});

export const claimWriteIntentCommit = mutation({
  args: { draftId: v.string(), now: v.number(), ...expectedActorArgs },
  handler: async (ctx, args) => {
    const actor = await requireAgentPlatformActor(ctx, args);
    const row = await ownedWriteIntent(ctx, actor.tenantId, actor.userId, args.draftId);
    if (row.status === "committed") return row;
    if (row.status === "committing") {
      if ((row.commitStartedAt ?? 0) + 30_000 > args.now) throw new ConvexError("WRITE_INTENT_COMMIT_IN_PROGRESS");
      const recovered = { commitStartedAt: args.now };
      await ctx.db.patch(row._id, recovered);
      return { ...row, ...recovered };
    }
    if (row.status !== "confirmed") throw new ConvexError("WRITE_INTENT_NOT_CONFIRMED");
    const patch = { status: "committing" as const, commitStartedAt: args.now };
    await ctx.db.patch(row._id, patch);
    return { ...row, ...patch };
  },
});

export const cancelWriteIntent = mutation({
  args: { draftId: v.string(), now: v.number(), ...expectedActorArgs },
  handler: async (ctx, args) => {
    const actor = await requireAgentPlatformActor(ctx, args);
    const row = await ownedWriteIntent(ctx, actor.tenantId, actor.userId, args.draftId);
    if (row.status === "cancelled") return row;
    if (row.status !== "proposed") throw new ConvexError("WRITE_INTENT_NOT_CANCELLABLE");
    const expiresAt = Number((row.intent as { envelope: { expiresAt: number } }).envelope.expiresAt);
    const patch = expiresAt <= args.now
      ? { status: "expired" as const, terminalAt: args.now, errorCode: "DRAFT_EXPIRED" }
      : { status: "cancelled" as const, terminalAt: args.now };
    await ctx.db.patch(row._id, patch);
    return { ...row, ...patch };
  },
});

export const finalizeWriteIntent = mutation({
  args: {
    draftId: v.string(), expectedStatus: v.literal("committing"),
    status: v.union(v.literal("committed"), v.literal("failed"), v.literal("stale")),
    now: v.number(), result: v.optional(v.any()), errorCode: v.optional(v.string()), ...expectedActorArgs,
  },
  handler: async (ctx, args) => {
    const actor = await requireAgentPlatformActor(ctx, args);
    const row = await ownedWriteIntent(ctx, actor.tenantId, actor.userId, args.draftId);
    if (row.status === "committed" && args.status === "committed") return row;
    if (row.status !== args.expectedStatus) throw new ConvexError("WRITE_INTENT_STATUS_CONFLICT");
    const patch = { status: args.status, terminalAt: args.now, result: args.result, errorCode: args.errorCode };
    await ctx.db.patch(row._id, patch);
    return { ...row, ...patch };
  },
});

const RETENTION_MS = {
  messages_context_refs: 180 * 24 * 60 * 60 * 1_000,
  runs_attempts: 90 * 24 * 60 * 60 * 1_000,
  detailed_events: 30 * 24 * 60 * 60 * 1_000,
  raw_usage: 90 * 24 * 60 * 60 * 1_000,
  terminal_lease_detail: 7 * 24 * 60 * 60 * 1_000,
} as const;

function dryRunRow(tenantId: string, type: keyof typeof RETENTION_MS, values: unknown[], timestamps: number[]) {
  const eligibleTimestamps = timestamps.filter(Number.isFinite);
  return {
    tenantId,
    type,
    count: values.length,
    oldest: eligibleTimestamps.length ? Math.min(...eligibleTimestamps) : undefined,
    newest: eligibleTimestamps.length ? Math.max(...eligibleTimestamps) : undefined,
    estimatedBytes: values.reduce<number>((total, value) => total + new TextEncoder().encode(JSON.stringify(value)).byteLength, 0),
  };
}

/** Read-only retention projection. It never deletes or patches data. */
export const retentionDryRun = query({
  args: { now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const actor = await requireAgentPlatformActor(ctx);
    if (actor.role !== 'admin' && actor.role !== 'superadmin') throw new ConvexError('RETENTION_ADMIN_REQUIRED');
    const now = args.now ?? Date.now();
    const [messages, runs, attempts, events, usage] = await Promise.all([
      ctx.db.query('agentPlatformMessages').withIndex('by_tenant_conversation_sequence', (q) => q.eq('tenantId', actor.tenantId)).collect(),
      ctx.db.query('agentPlatformRuns').withIndex('by_tenant_created', (q) => q.eq('tenantId', actor.tenantId)).collect(),
      ctx.db.query('agentPlatformAttempts').withIndex('by_tenant_status_lease', (q) => q.eq('tenantId', actor.tenantId)).collect(),
      ctx.db.query('agentPlatformEvents').withIndex('by_tenant_occurred', (q) => q.eq('tenantId', actor.tenantId)).collect(),
      ctx.db.query('agentPlatformUsage').withIndex('by_tenant_created', (q) => q.eq('tenantId', actor.tenantId)).collect(),
    ]);
    const oldMessages = messages.filter((row) => row.createdAt < now - RETENTION_MS.messages_context_refs);
    const oldRuns = runs.filter((row) => row.createdAt < now - RETENTION_MS.runs_attempts);
    const oldRunIds = new Set(oldRuns.map((row) => row.runId));
    const oldAttempts = attempts.filter((row) => oldRunIds.has(row.runId));
    const oldEvents = events.filter((row) => row.occurredAt < now - RETENTION_MS.detailed_events);
    const oldUsage = usage.filter((row) => row.createdAt < now - RETENTION_MS.raw_usage);
    const terminalLease = attempts.filter((row) => row.completedAt !== undefined && row.completedAt < now - RETENTION_MS.terminal_lease_detail);
    return [
      dryRunRow(actor.tenantId, 'messages_context_refs', oldMessages, oldMessages.map((row) => row.createdAt)),
      dryRunRow(actor.tenantId, 'runs_attempts', [...oldRuns, ...oldAttempts], [...oldRuns.map((row) => row.createdAt), ...oldAttempts.map((row) => row.completedAt ?? row.startedAt ?? 0)]),
      dryRunRow(actor.tenantId, 'detailed_events', oldEvents, oldEvents.map((row) => row.occurredAt)),
      dryRunRow(actor.tenantId, 'raw_usage', oldUsage, oldUsage.map((row) => row.createdAt)),
      dryRunRow(actor.tenantId, 'terminal_lease_detail', terminalLease, terminalLease.map((row) => row.completedAt ?? 0)),
    ];
  },
});
