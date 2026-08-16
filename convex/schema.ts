import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  messages: defineTable({
    conversationId: v.string(),
    role: v.union(v.literal("user"), v.literal("assistant"), v.literal("system")),
    content: v.string(),
    agentId: v.optional(v.string()),
    turnId: v.optional(v.string()),
    createdAt: v.number(),
    imageStorageIds: v.optional(v.array(v.id("_storage"))),
    mediaError: v.optional(v.string()),
  })
    .index("by_conversation", ["conversationId"])
    .index("by_conversation_turn", ["conversationId", "turnId"])
    .index("by_createdAt", ["createdAt"]),

  conversations: defineTable({
    conversationId: v.string(),
    title: v.optional(v.string()),
    summary: v.optional(v.string()),
    messageCount: v.number(),
    lastActivityAt: v.number(),
  }).index("by_conversation", ["conversationId"]),

  memoryRecords: defineTable({
    memoryId: v.string(),
    content: v.string(),
    tier: v.union(v.literal("short"), v.literal("long"), v.literal("permanent")),
    segment: v.union(
      v.literal("identity"),
      v.literal("preference"),
      v.literal("correction"),
      v.literal("relationship"),
      v.literal("project"),
      v.literal("knowledge"),
      v.literal("context"),
    ),
    importance: v.number(),
    decayRate: v.number(),
    accessCount: v.number(),
    lastAccessedAt: v.number(),
    sourceTurn: v.optional(v.string()),
    lifecycle: v.union(v.literal("active"), v.literal("archived"), v.literal("pruned")),
    supersedes: v.optional(v.array(v.string())),
    embedding: v.optional(v.array(v.float64())),
    // Structured sidecar data (JSON blob). Currently used to carry
    // `corrects` text on correction-segment memories. Intentionally loose
    // so extraction prompts can stash provider-specific hints without
    // schema churn.
    metadata: v.optional(v.string()),
    createdAt: v.number(),
    imageStorageIds: v.optional(v.array(v.id("_storage"))),
    // Hostmate's SaaS scope is an optional sidecar on the original Boop
    // record. Legacy personal-Boop rows remain valid, while Agent Platform
    // functions require every field below and never query unscoped rows.
    tenantId: v.optional(v.string()),
    ownerUserId: v.optional(v.string()),
    scope: v.optional(v.union(v.literal("user"), v.literal("tenant"))),
    category: v.optional(v.union(
      v.literal("preference"),
      v.literal("communication_style"),
      v.literal("formatting"),
      v.literal("workflow_preference"),
      v.literal("correction"),
    )),
    preferenceKey: v.optional(v.string()),
    sourceType: v.optional(v.union(v.literal("explicit_user"), v.literal("automatic_extraction"), v.literal("consolidation"))),
    sourceRunId: v.optional(v.string()),
    visibility: v.optional(v.literal("private")),
    consentBasis: v.optional(v.literal("explicit_request")),
    containsSensitiveData: v.optional(v.boolean()),
    retentionPolicy: v.optional(v.string()),
    embeddingProvider: v.optional(v.string()),
    embeddingModel: v.optional(v.string()),
    vectorScopeKey: v.optional(v.string()),
    deletedAt: v.optional(v.number()),
  })
    .index("by_memory_id", ["memoryId"])
    .index("by_tier", ["tier"])
    .index("by_segment", ["segment"])
    .index("by_lifecycle", ["lifecycle"])
    .index("by_scope_lifecycle_created", ["tenantId", "ownerUserId", "scope", "lifecycle", "createdAt"])
    .index("by_scope_preference_lifecycle", ["tenantId", "ownerUserId", "scope", "preferenceKey", "lifecycle"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1024,
      filterFields: ["lifecycle", "vectorScopeKey"],
    }),

  executionAgents: defineTable({
    agentId: v.string(),
    conversationId: v.optional(v.string()),
    name: v.string(),
    task: v.string(),
    runtime: v.optional(v.union(v.literal("claude"), v.literal("codex"))),
    model: v.optional(v.string()),
    reasoningEffort: v.optional(v.string()),
    billingMode: v.optional(v.union(v.literal("api"), v.literal("codex-subscription"))),
    status: v.union(
      v.literal("spawned"),
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("cancelled"),
      v.literal("paused"),
    ),
    result: v.optional(v.string()),
    error: v.optional(v.string()),
    mcpServers: v.array(v.string()),
    inputTokens: v.number(),
    outputTokens: v.number(),
    cacheReadTokens: v.optional(v.number()),
    cacheCreationTokens: v.optional(v.number()),
    costUsd: v.number(),
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_agent_id", ["agentId"])
    .index("by_status", ["status"])
    .index("by_conversation", ["conversationId"]),

  // Append-only LLM usage log. Every model call (dispatcher, execution,
  // extract, consolidation) writes a row here so you can query total cost
  // by source, conversation, or time range.
  usageRecords: defineTable({
    source: v.union(
      v.literal("dispatcher"),
      v.literal("execution"),
      v.literal("extract"),
      v.literal("consolidation-proposer"),
      v.literal("consolidation-adversary"),
      v.literal("consolidation-judge"),
      v.literal("proactive"),
    ),
    conversationId: v.optional(v.string()),
    turnId: v.optional(v.string()),
    agentId: v.optional(v.string()),
    runId: v.optional(v.string()),
    runtime: v.optional(v.union(v.literal("claude"), v.literal("codex"))),
    billingMode: v.optional(v.union(v.literal("api"), v.literal("codex-subscription"))),
    model: v.string(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    cacheReadTokens: v.number(),
    cacheCreationTokens: v.number(),
    costUsd: v.number(),
    durationMs: v.number(),
    createdAt: v.number(),
  })
    .index("by_conversation", ["conversationId"])
    .index("by_agent", ["agentId"])
    .index("by_source", ["source"]),

  agentLogs: defineTable({
    agentId: v.string(),
    logType: v.union(
      v.literal("thinking"),
      v.literal("tool_use"),
      v.literal("tool_result"),
      v.literal("text"),
      v.literal("error"),
    ),
    toolName: v.optional(v.string()),
    // Composio account aliases targeted by this tool call (e.g. ["gmail_charry-fusc"]).
    // Populated when the input names a specific connected account, so multi-account
    // toolkits make it visible which inbox / workspace was actually hit.
    accounts: v.optional(v.array(v.string())),
    content: v.string(),
    createdAt: v.number(),
  }).index("by_agent", ["agentId"]),

  memoryEvents: defineTable({
    eventType: v.string(),
    conversationId: v.optional(v.string()),
    memoryId: v.optional(v.string()),
    agentId: v.optional(v.string()),
    data: v.string(),
    createdAt: v.number(),
    tenantId: v.optional(v.string()),
    ownerUserId: v.optional(v.string()),
    scope: v.optional(v.union(v.literal("user"), v.literal("tenant"))),
    visibility: v.optional(v.literal("private")),
  })
    .index("by_conversation", ["conversationId"])
    .index("by_type", ["eventType"])
    .index("by_scope_created", ["tenantId", "ownerUserId", "scope", "createdAt"])
    .index("by_scope_type_created", ["tenantId", "ownerUserId", "scope", "eventType", "createdAt"]),

  memoryPurgePlans: defineTable({
    target: v.union(v.literal("memoryRecords"), v.literal("memoryEvents")),
    tenantId: v.string(), ownerUserId: v.string(), scope: v.literal("user"),
    lifecycle: v.optional(v.union(v.literal("active"), v.literal("archived"), v.literal("pruned"))),
    eventType: v.optional(v.string()), before: v.number(), limit: v.number(), matched: v.number(),
    withEmbedding: v.optional(v.number()), createdBy: v.string(), createdAt: v.number(), expiresAt: v.number(), consumedAt: v.optional(v.number()),
  }).index("by_expiry", ["expiresAt"]),

  automations: defineTable({
    automationId: v.string(),
    name: v.string(),
    task: v.string(),
    integrations: v.array(v.string()),
    schedule: v.string(),
    // IANA timezone the cron expression is evaluated in. Stored at create
    // time so changing the user's global timezone later doesn't shift
    // existing automations. Optional for backwards compatibility — pre-TZ
    // automations fall back to the user's current setting at run time.
    timezone: v.optional(v.string()),
    enabled: v.boolean(),
    conversationId: v.optional(v.string()),
    notifyConversationId: v.optional(v.string()),
    lastRunAt: v.optional(v.number()),
    nextRunAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_automation_id", ["automationId"])
    .index("by_enabled", ["enabled"]),

  sendblueDedup: defineTable({
    handle: v.string(),
    claimedAt: v.number(),
  }).index("by_handle", ["handle"]),

  drafts: defineTable({
    draftId: v.string(),
    conversationId: v.string(),
    kind: v.string(),
    summary: v.string(),
    payload: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("sent"),
      v.literal("rejected"),
      v.literal("expired"),
    ),
    createdAt: v.number(),
    decidedAt: v.optional(v.number()),
  })
    .index("by_draft_id", ["draftId"])
    .index("by_conversation_status", ["conversationId", "status"]),

  consolidationRuns: defineTable({
    runId: v.string(),
    trigger: v.string(),
    status: v.union(
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    proposalsCount: v.number(),
    mergedCount: v.number(),
    prunedCount: v.number(),
    notes: v.optional(v.string()),
    // JSON blob: { proposals: [...], decisions: [...], applied: [...] }
    // Captured so you can inspect the reasoning for any historical run.
    details: v.optional(v.string()),
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_run_id", ["runId"])
    .index("by_status", ["status"]),

  // Runtime overrides for things normally pinned by env vars (e.g. the Claude
  // model). Lets the user say "use opus" via iMessage and have the next agent
  // run respect it without a redeploy.
  settings: defineTable({
    key: v.string(),
    value: v.string(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  automationRuns: defineTable({
    runId: v.string(),
    automationId: v.string(),
    status: v.union(
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    result: v.optional(v.string()),
    error: v.optional(v.string()),
    agentId: v.optional(v.string()),
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_automation", ["automationId"])
    .index("by_run_id", ["runId"]),

  agentPlatformConversations: defineTable({
    conversationId: v.string(), tenantId: v.string(), ownerUserId: v.string(), title: v.optional(v.string()),
    createdAt: v.number(), updatedAt: v.number(),
  }).index("by_tenant_conversation", ["tenantId", "conversationId"]),

  agentPlatformMessages: defineTable({
    messageId: v.string(), conversationId: v.string(), tenantId: v.string(), actorUserId: v.string(),
    role: v.union(v.literal("user"), v.literal("assistant"), v.literal("system")),
    contentRedacted: v.string(), blocks: v.optional(v.any()), contextRefs: v.optional(v.any()), runId: v.optional(v.string()), sequence: v.number(), createdAt: v.number(),
  }).index("by_tenant_conversation_sequence", ["tenantId", "conversationId", "sequence"]),

  agentPlatformRuns: defineTable({
    runId: v.string(), tenantId: v.string(), actorUserId: v.string(), conversationId: v.optional(v.string()),
    kind: v.union(v.literal("interaction"), v.literal("execution")), profileId: v.optional(v.string()), profileVersion: v.optional(v.number()),
    parentRunId: v.optional(v.string()), orchestrationId: v.optional(v.string()), branchKey: v.optional(v.string()), orchestrationDepth: v.optional(v.number()), dependencyRunIds: v.array(v.string()),
    status: v.union(v.literal("queued"), v.literal("waiting_dependency"), v.literal("resolving_scope"), v.literal("running"), v.literal("awaiting_confirmation"), v.literal("completed"), v.literal("partial"), v.literal("failed"), v.literal("cancelled"), v.literal("timeout")),
    objectiveHash: v.string(), objectiveRedacted: v.optional(v.string()), registryHash: v.string(), skillVersions: v.any(), skillRefs: v.optional(v.any()), toolScope: v.array(v.string()),
    requestedModel: v.optional(v.string()), resolvedModel: v.optional(v.string()), provider: v.optional(v.string()), finishReason: v.optional(v.string()),
    visibility: v.union(v.literal("user"), v.literal("tenant_admin"), v.literal("platform_admin")),
    resultSummary: v.optional(v.string()), errorCode: v.optional(v.string()), cancelRequestedAt: v.optional(v.number()),
    createdAt: v.number(), updatedAt: v.number(), completedAt: v.optional(v.number()),
  })
    .index("by_tenant_run", ["tenantId", "runId"])
    .index("by_tenant_created", ["tenantId", "createdAt"])
    .index("by_tenant_status_created", ["tenantId", "status", "createdAt"])
    .index("by_tenant_actor_created", ["tenantId", "actorUserId", "createdAt"]),

  agentPlatformAttempts: defineTable({
    attemptId: v.string(), runId: v.string(), tenantId: v.string(), attemptNumber: v.number(),
    status: v.union(v.literal("queued"), v.literal("running"), v.literal("succeeded"), v.literal("failed"), v.literal("cancelled"), v.literal("timeout"), v.literal("unknown")),
    leaseOwner: v.optional(v.string()), fencingToken: v.number(), leaseExpiresAt: v.optional(v.number()), heartbeatAt: v.optional(v.number()),
    retryOfAttemptId: v.optional(v.string()), startedAt: v.optional(v.number()), completedAt: v.optional(v.number()), errorCode: v.optional(v.string()),
  })
    .index("by_tenant_attempt", ["tenantId", "attemptId"])
    .index("by_tenant_run_attempt", ["tenantId", "runId", "attemptNumber"])
    .index("by_tenant_status_lease", ["tenantId", "status", "leaseExpiresAt"]),

  agentPlatformEvents: defineTable({
    eventId: v.string(), tenantId: v.string(), actorUserId: v.string(), conversationId: v.optional(v.string()),
    interactionRunId: v.optional(v.string()), executionRunId: v.optional(v.string()), attemptId: v.optional(v.string()),
    sequence: v.number(), type: v.string(), visibility: v.union(v.literal("user"), v.literal("tenant_admin"), v.literal("platform_admin")),
    payloadRedacted: v.any(), occurredAt: v.number(),
  })
    .index("by_tenant_execution_sequence", ["tenantId", "executionRunId", "sequence"])
    .index("by_tenant_occurred", ["tenantId", "occurredAt"]),

  agentPlatformUsage: defineTable({
    usageId: v.string(), tenantId: v.string(), actorUserId: v.string(), runId: v.string(), attemptId: v.string(),
    requestedModel: v.string(), resolvedModel: v.string(), provider: v.optional(v.string()),
    inputTokens: v.number(), outputTokens: v.number(), reasoningTokens: v.number(), cachedTokens: v.number(),
    costUsd: v.number(), latencyMs: v.number(), fallbackUsed: v.boolean(), finishReason: v.optional(v.string()), createdAt: v.number(),
  })
    .index("by_tenant_run", ["tenantId", "runId"])
    .index("by_tenant_created", ["tenantId", "createdAt"]),

  agentPlatformWriteIntents: defineTable({
    draftId: v.string(), tenantId: v.string(), actorUserId: v.string(),
    intent: v.any(),
    status: v.union(
      v.literal("proposed"), v.literal("confirmed"), v.literal("committing"),
      v.literal("committed"), v.literal("cancelled"), v.literal("expired"),
      v.literal("failed"), v.literal("stale"),
    ),
    createdAt: v.number(), confirmedAt: v.optional(v.number()), commitStartedAt: v.optional(v.number()),
    terminalAt: v.optional(v.number()), result: v.optional(v.any()), errorCode: v.optional(v.string()),
  })
    .index("by_tenant_draft", ["tenantId", "draftId"])
    .index("by_tenant_actor_created", ["tenantId", "actorUserId", "createdAt"])
    .index("by_tenant_status_created", ["tenantId", "status", "createdAt"]),
});
