import type { ActorContext } from "../contracts/actor-context.js";
import type { ConvexControlPlaneClient } from "../control-plane/convex-control-plane-repository.js";
import { embedWithMetadata, type EmbeddingResult } from "../../embeddings.js";
import { makeMemoryId } from "../../memory/types.js";
import type { MemoryCandidate } from "./policy.js";

export type ScopedMemoryRecord = Readonly<{
  _id?: string;
  memoryId: string;
  content: string;
  tier: "short" | "long" | "permanent";
  segment: string;
  category?: string;
  preferenceKey?: string;
  importance: number;
  decayRate: number;
  accessCount: number;
  lifecycle: "active" | "archived" | "pruned";
  supersedes?: string[];
  createdAt: number;
}>;

export type MemoryWriteResult = Readonly<{
  record: ScopedMemoryRecord;
  supersededMemoryIds: string[];
  embedding: EmbeddingResult | null;
  timings: Readonly<{ embeddingMs: number; convexWriteMs: number }>;
}>;

export type PropertyOrderRecall = Readonly<{
  record: ScopedMemoryRecord;
  order: "price_asc" | "price_desc" | "newest";
  mode: "vector" | "scoped-index";
  score?: number;
  embedding: EmbeddingResult | null;
  latencyMs: number;
  timings: Readonly<{ embeddingMs: number; vectorSearchMs: number; documentFetchMs: number; markAccessedMs: number; totalMs: number }>;
}>;

function audit(actor: ActorContext) {
  return { expectedTenantId: actor.tenantId, expectedUserId: actor.userId };
}

function orderFromContent(record: ScopedMemoryRecord): PropertyOrderRecall["order"] | null {
  const value = record.content.toLowerCase();
  if (value.includes("ascendente")) return "price_asc";
  if (value.includes("descendente")) return "price_desc";
  if (value.includes("recientes")) return "newest";
  return null;
}

/**
 * Thin authenticated adapter over Boop's original memoryRecords table,
 * embedding pipeline, IDs, tiers and superseding semantics.
 */
export class BoopScopedMemoryRepository {
  constructor(private readonly client: ConvexControlPlaneClient) {}

  async remember(actor: ActorContext, input: { candidate: MemoryCandidate; sourceRunId: string; conversationId: string }): Promise<MemoryWriteResult> {
    const embeddingStartedAt = Date.now();
    const embedding = await embedWithMetadata(input.candidate.content);
    const embeddingMs = Date.now() - embeddingStartedAt;
    const convexWriteStartedAt = Date.now();
    const stored = await this.client.mutation<ScopedMemoryRecord & { supersededMemoryIds?: string[] }>("agentPlatformMemory:upsertExplicit", {
      memoryId: makeMemoryId(), content: input.candidate.content, scope: "user",
      category: input.candidate.category, preferenceKey: input.candidate.preferenceKey,
      tier: input.candidate.tier, segment: input.candidate.segment,
      importance: input.candidate.importance, decayRate: input.candidate.decayRate,
      sourceRunId: input.sourceRunId, conversationId: input.conversationId,
      embedding: embedding?.vector, embeddingProvider: embedding?.provider,
      embeddingModel: embedding?.model, containsSensitiveData: false, ...audit(actor),
    });
    const convexWriteMs = Date.now() - convexWriteStartedAt;
    const { supersededMemoryIds = [], ...record } = stored;
    return { record, supersededMemoryIds, embedding, timings: { embeddingMs, convexWriteMs } };
  }

  async forget(actor: ActorContext, input: { preferenceKey: string; sourceRunId: string; conversationId: string }) {
    return await this.client.mutation<{ deleted: number; memoryIds: string[] }>("agentPlatformMemory:forgetPreference", { ...input, ...audit(actor) });
  }

  async recallPropertyOrder(actor: ActorContext, conversationId: string): Promise<PropertyOrderRecall | null> {
    const startedAt = Date.now();
    const embeddingStartedAt = Date.now();
    const embedding = await embedWithMetadata("preferencia estable del usuario para ordenar resultados de inmuebles por precio o fecha");
    const embeddingMs = Date.now() - embeddingStartedAt;
    if (embedding) {
      const search = await this.client.action<{ hits: Array<{ score: number; record: ScopedMemoryRecord }>; telemetry: { vectorSearchMs: number; documentFetchMs: number } }>("agentPlatformMemory:vectorSearch", {
        embedding: embedding.vector, limit: 8, ...audit(actor),
      });
      const hit = search.hits.find((candidate) => candidate.record.preferenceKey === "property_order" && orderFromContent(candidate.record));
      if (hit) {
        const markAccessedStartedAt = Date.now();
        await this.client.mutation("agentPlatformMemory:markAccessed", { memoryId: hit.record.memoryId, conversationId, ...audit(actor) });
        const markAccessedMs = Date.now() - markAccessedStartedAt;
        const totalMs = Date.now() - startedAt;
        return { record: hit.record, order: orderFromContent(hit.record)!, mode: "vector", score: hit.score, embedding, latencyMs: totalMs, timings: { embeddingMs, ...search.telemetry, markAccessedMs, totalMs } };
      }
    }
    const documentFetchStartedAt = Date.now();
    const record = await this.client.query<ScopedMemoryRecord | null>("agentPlatformMemory:currentPreference", { preferenceKey: "property_order", ...audit(actor) });
    const documentFetchMs = Date.now() - documentFetchStartedAt;
    const order = record ? orderFromContent(record) : null;
    if (!record || !order) return null;
    const markAccessedStartedAt = Date.now();
    await this.client.mutation("agentPlatformMemory:markAccessed", { memoryId: record.memoryId, conversationId, ...audit(actor) });
    const markAccessedMs = Date.now() - markAccessedStartedAt;
    const totalMs = Date.now() - startedAt;
    return { record, order, mode: "scoped-index", embedding, latencyMs: totalMs, timings: { embeddingMs, vectorSearchMs: 0, documentFetchMs, markAccessedMs, totalMs } };
  }
}
