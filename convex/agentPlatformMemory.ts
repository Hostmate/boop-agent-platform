import { ConvexError, v } from "convex/values";
import { action, mutation, query, type MutationCtx } from "./_generated/server";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireAgentPlatformActor, type ConvexActor } from "./agentPlatformAuth";

const scopeV = v.union(v.literal("user"), v.literal("tenant"));
const tierV = v.union(v.literal("short"), v.literal("long"), v.literal("permanent"));
const segmentV = v.union(v.literal("identity"), v.literal("preference"), v.literal("correction"), v.literal("relationship"), v.literal("project"), v.literal("knowledge"), v.literal("context"));
const categoryV = v.union(v.literal("preference"), v.literal("communication_style"), v.literal("formatting"), v.literal("workflow_preference"), v.literal("correction"));
const lifecycleV = v.union(v.literal("active"), v.literal("archived"), v.literal("pruned"));
const expectedActorArgs = { expectedTenantId: v.optional(v.string()), expectedUserId: v.optional(v.string()) };
const MAX_EXPLICIT_WRITES_PER_ROLLING_DAY = 20;
const DAY_MS = 24 * 60 * 60 * 1_000;

function requireMemoryPermission(actor: ConvexActor, permission: "memory.read" | "memory.write") {
  if (!actor.permissions.includes(permission)) throw new ConvexError("MEMORY_FORBIDDEN");
}

function assertUserScope(scope: "user" | "tenant") {
  if (scope !== "user") throw new ConvexError("TENANT_MEMORY_DISABLED");
}

function vectorScopeKey(actor: ConvexActor, lifecycle: "active" | "archived" | "pruned") {
  return `${actor.tenantId}:${actor.userId}:user:${lifecycle}`;
}

async function emit(ctx: MutationCtx, actor: ConvexActor, input: {
  eventType: string;
  memoryId?: string;
  conversationId?: string;
  data: Record<string, unknown>;
}) {
  await ctx.db.insert("memoryEvents", {
    eventType: input.eventType,
    memoryId: input.memoryId,
    conversationId: input.conversationId,
    data: JSON.stringify(input.data),
    tenantId: actor.tenantId,
    ownerUserId: actor.userId,
    scope: "user",
    visibility: "private",
    createdAt: Date.now(),
  });
}

export const upsertExplicit = mutation({
  args: {
    memoryId: v.string(), content: v.string(), scope: scopeV, category: categoryV,
    preferenceKey: v.string(), tier: tierV, segment: segmentV, importance: v.number(), decayRate: v.number(),
    sourceRunId: v.string(), conversationId: v.string(), embedding: v.optional(v.array(v.float64())),
    embeddingProvider: v.optional(v.string()), embeddingModel: v.optional(v.string()),
    containsSensitiveData: v.boolean(), ...expectedActorArgs,
  },
  handler: async (ctx, args) => {
    const actor = await requireAgentPlatformActor(ctx, args);
    requireMemoryPermission(actor, "memory.write");
    assertUserScope(args.scope);
    if (args.containsSensitiveData) throw new ConvexError("SENSITIVE_MEMORY_REJECTED");
    const content = args.content.trim();
    if (!content || content.length > 500) throw new ConvexError("MEMORY_CONTENT_INVALID");
    if (!/^[a-z][a-z0-9_.-]{2,80}$/.test(args.preferenceKey)) throw new ConvexError("MEMORY_KEY_INVALID");
    if (args.importance < 0 || args.importance > 1 || args.decayRate < 0 || args.decayRate > 1) throw new ConvexError("MEMORY_WEIGHT_INVALID");
    const collision = await ctx.db.query("memoryRecords").withIndex("by_memory_id", (q) => q.eq("memoryId", args.memoryId)).unique();
    if (collision) throw new ConvexError("MEMORY_ID_EXISTS");

    const recent = await ctx.db.query("memoryEvents")
      .withIndex("by_scope_created", (q) => q.eq("tenantId", actor.tenantId).eq("ownerUserId", actor.userId).eq("scope", "user"))
      .order("desc").take(MAX_EXPLICIT_WRITES_PER_ROLLING_DAY);
    if (recent.filter((row) => ["memory.created", "memory.superseded"].includes(row.eventType) && row.createdAt > Date.now() - DAY_MS).length >= MAX_EXPLICIT_WRITES_PER_ROLLING_DAY) {
      throw new ConvexError("MEMORY_DAILY_WRITE_BUDGET_EXCEEDED");
    }

    const previous = await ctx.db.query("memoryRecords")
      .withIndex("by_scope_preference_lifecycle", (q) => q.eq("tenantId", actor.tenantId).eq("ownerUserId", actor.userId).eq("scope", "user").eq("preferenceKey", args.preferenceKey).eq("lifecycle", "active"))
      .collect();
    for (const row of previous) await ctx.db.patch(row._id, {
      lifecycle: "archived", vectorScopeKey: vectorScopeKey(actor, "archived"),
    });
    const now = Date.now();
    const supersedes = previous.map((row) => row.memoryId);
    const id = await ctx.db.insert("memoryRecords", {
      memoryId: args.memoryId, content, tier: args.tier, segment: args.segment,
      importance: args.importance, decayRate: args.decayRate, accessCount: 0,
      lastAccessedAt: now, lifecycle: "active", createdAt: now,
      supersedes: supersedes.length ? supersedes : undefined,
      embedding: args.embedding, tenantId: actor.tenantId, ownerUserId: actor.userId,
      scope: "user", category: args.category, preferenceKey: args.preferenceKey,
      sourceType: "explicit_user", sourceRunId: args.sourceRunId, visibility: "private",
      consentBasis: "explicit_request", containsSensitiveData: false,
      retentionPolicy: "user-controlled-v1", embeddingProvider: args.embeddingProvider,
      embeddingModel: args.embeddingModel,
      vectorScopeKey: vectorScopeKey(actor, "active"),
    });
    await emit(ctx, actor, {
      eventType: previous.length ? "memory.superseded" : "memory.created",
      memoryId: args.memoryId, conversationId: args.conversationId,
      data: { category: args.category, preferenceKey: args.preferenceKey, tier: args.tier, supersededCount: previous.length },
    });
    return { ...(await ctx.db.get(id))!, supersededMemoryIds: supersedes };
  },
});

export const listOwn = query({
  args: { tier: v.optional(tierV), segment: v.optional(segmentV), lifecycle: v.optional(lifecycleV), limit: v.optional(v.number()), ...expectedActorArgs },
  handler: async (ctx, args) => {
    const actor = await requireAgentPlatformActor(ctx, args);
    requireMemoryPermission(actor, "memory.read");
    const lifecycle = args.lifecycle ?? "active";
    const limit = Math.max(1, Math.min(args.limit ?? 200, 500));
    const rows = await ctx.db.query("memoryRecords")
      .withIndex("by_scope_lifecycle_created", (q) => q.eq("tenantId", actor.tenantId).eq("ownerUserId", actor.userId).eq("scope", "user").eq("lifecycle", lifecycle))
      .order("desc").take(500);
    return rows.filter((row) => (!args.tier || row.tier === args.tier) && (!args.segment || row.segment === args.segment)).slice(0, limit);
  },
});

export const currentPreference = query({
  args: { preferenceKey: v.string(), ...expectedActorArgs },
  handler: async (ctx, args) => {
    const actor = await requireAgentPlatformActor(ctx, args);
    requireMemoryPermission(actor, "memory.read");
    return await ctx.db.query("memoryRecords")
      .withIndex("by_scope_preference_lifecycle", (q) => q.eq("tenantId", actor.tenantId).eq("ownerUserId", actor.userId).eq("scope", "user").eq("preferenceKey", args.preferenceKey).eq("lifecycle", "active"))
      .order("desc").first();
  },
});

export const getByIds = query({
  args: { ids: v.array(v.id("memoryRecords")), ...expectedActorArgs },
  handler: async (ctx, args) => {
    const actor = await requireAgentPlatformActor(ctx, args);
    requireMemoryPermission(actor, "memory.read");
    const rows: Doc<"memoryRecords">[] = [];
    for (const id of args.ids) {
      const row = await ctx.db.get(id);
      if (row && row.tenantId === actor.tenantId && row.ownerUserId === actor.userId && row.scope === "user" && row.lifecycle === "active") rows.push(row);
    }
    return rows;
  },
});

export const vectorSearch = action({
  args: { embedding: v.array(v.float64()), limit: v.optional(v.number()), ...expectedActorArgs },
  handler: async (ctx, args): Promise<{
    hits: Array<{ _id: Id<"memoryRecords">; score: number; record: Doc<"memoryRecords"> }>;
    telemetry: { vectorSearchMs: number; documentFetchMs: number };
  }> => {
    const actor = await requireAgentPlatformActor(ctx, args);
    requireMemoryPermission(actor, "memory.read");
    const limit = Math.max(1, Math.min(args.limit ?? 10, 50));
    // Scope is part of Convex's ANN candidate filter. No foreign tenant/user
    // can enter top-K and there is no post-search authorization filter.
    const vectorStartedAt = Date.now();
    const hits = await ctx.vectorSearch("memoryRecords", "by_embedding", {
      vector: args.embedding,
      limit,
      filter: (q) => q.eq("vectorScopeKey", vectorScopeKey(actor, "active")),
    });
    const vectorSearchMs = Date.now() - vectorStartedAt;
    const documentFetchStartedAt = Date.now();
    const records = await ctx.runQuery(api.agentPlatformMemory.getByIds, {
      ids: hits.map((hit) => hit._id), expectedTenantId: actor.tenantId, expectedUserId: actor.userId,
    });
    const byId = new Map(records.map((record) => [record._id, record]));
    const authorizedHits = hits.flatMap((hit) => {
      const record = byId.get(hit._id);
      return record ? [{ _id: hit._id, score: hit._score, record }] : [];
    });
    return { hits: authorizedHits, telemetry: { vectorSearchMs, documentFetchMs: Date.now() - documentFetchStartedAt } };
  },
});

export const markAccessed = mutation({
  args: { memoryId: v.string(), conversationId: v.optional(v.string()), ...expectedActorArgs },
  handler: async (ctx, args) => {
    const actor = await requireAgentPlatformActor(ctx, args);
    requireMemoryPermission(actor, "memory.read");
    const row = await ctx.db.query("memoryRecords")
      .withIndex("by_scope_lifecycle_created", (q) => q.eq("tenantId", actor.tenantId).eq("ownerUserId", actor.userId).eq("scope", "user").eq("lifecycle", "active"))
      .filter((q) => q.eq(q.field("memoryId"), args.memoryId)).unique();
    if (!row) return null;
    await ctx.db.patch(row._id, { accessCount: row.accessCount + 1, lastAccessedAt: Date.now() });
    await emit(ctx, actor, { eventType: "memory.recalled", memoryId: row.memoryId, conversationId: args.conversationId, data: { category: row.category, preferenceKey: row.preferenceKey } });
    return row._id;
  },
});

export const forgetPreference = mutation({
  args: { preferenceKey: v.string(), conversationId: v.string(), sourceRunId: v.string(), ...expectedActorArgs },
  handler: async (ctx, args) => {
    const actor = await requireAgentPlatformActor(ctx, args);
    requireMemoryPermission(actor, "memory.write");
    const rows = await ctx.db.query("memoryRecords")
      .withIndex("by_scope_preference_lifecycle", (q) => q.eq("tenantId", actor.tenantId).eq("ownerUserId", actor.userId).eq("scope", "user").eq("preferenceKey", args.preferenceKey).eq("lifecycle", "active"))
      .collect();
    const deletedAt = Date.now();
    for (const row of rows) {
      await ctx.db.patch(row._id, {
        lifecycle: "pruned", deletedAt, vectorScopeKey: vectorScopeKey(actor, "pruned"),
      });
      await emit(ctx, actor, { eventType: "memory.deleted", memoryId: row.memoryId, conversationId: args.conversationId, data: { category: row.category, preferenceKey: row.preferenceKey, sourceRunId: args.sourceRunId } });
    }
    return { deleted: rows.length, memoryIds: rows.map((row) => row.memoryId) };
  },
});

export const deleteOwn = mutation({
  args: { memoryId: v.string(), ...expectedActorArgs },
  handler: async (ctx, args) => {
    const actor = await requireAgentPlatformActor(ctx, args);
    requireMemoryPermission(actor, "memory.write");
    const row = await ctx.db.query("memoryRecords")
      .withIndex("by_scope_lifecycle_created", (q) => q.eq("tenantId", actor.tenantId).eq("ownerUserId", actor.userId).eq("scope", "user").eq("lifecycle", "active"))
      .filter((q) => q.eq(q.field("memoryId"), args.memoryId)).unique();
    if (!row) return false;
    await ctx.db.patch(row._id, {
      lifecycle: "pruned", deletedAt: Date.now(), vectorScopeKey: vectorScopeKey(actor, "pruned"),
    });
    await emit(ctx, actor, { eventType: "memory.deleted", memoryId: row.memoryId, data: { category: row.category, preferenceKey: row.preferenceKey, source: "memory_ui" } });
    return true;
  },
});

export const embeddingStatsOwn = query({
  args: { ...expectedActorArgs },
  handler: async (ctx, args) => {
    const actor = await requireAgentPlatformActor(ctx, args);
    requireMemoryPermission(actor, "memory.read");
    const rows = await ctx.db.query("memoryRecords")
      .withIndex("by_scope_lifecycle_created", (q) => q.eq("tenantId", actor.tenantId).eq("ownerUserId", actor.userId).eq("scope", "user").eq("lifecycle", "active"))
      .take(500);
    return {
      total: rows.length,
      withEmbedding: rows.filter((row) => row.embedding?.length).length,
      withoutEmbedding: rows.filter((row) => !row.embedding?.length).length,
      providers: [...new Set(rows.map((row) => row.embeddingProvider).filter(Boolean))],
    };
  },
});

export const recentEventsOwn = query({
  args: { limit: v.optional(v.number()), ...expectedActorArgs },
  handler: async (ctx, args) => {
    const actor = await requireAgentPlatformActor(ctx, args);
    requireMemoryPermission(actor, "memory.read");
    return await ctx.db.query("memoryEvents")
      .withIndex("by_scope_created", (q) => q.eq("tenantId", actor.tenantId).eq("ownerUserId", actor.userId).eq("scope", "user"))
      .order("desc").take(Math.max(1, Math.min(args.limit ?? 100, 200)));
  },
});
