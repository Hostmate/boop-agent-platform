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
}>;

export type PropertyOrderRecall = Readonly<{
  record: ScopedMemoryRecord;
  order: "price_asc" | "price_desc" | "newest";
  mode: "vector" | "scoped-index";
  score?: number;
  embedding: EmbeddingResult | null;
  latencyMs: number;
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
    const embedding = await embedWithMetadata(input.candidate.content);
    const stored = await this.client.mutation<ScopedMemoryRecord & { supersededMemoryIds?: string[] }>("agentPlatformMemory:upsertExplicit", {
      memoryId: makeMemoryId(), content: input.candidate.content, scope: "user",
      category: input.candidate.category, preferenceKey: input.candidate.preferenceKey,
      tier: input.candidate.tier, segment: input.candidate.segment,
      importance: input.candidate.importance, decayRate: input.candidate.decayRate,
      sourceRunId: input.sourceRunId, conversationId: input.conversationId,
      embedding: embedding?.vector, embeddingProvider: embedding?.provider,
      embeddingModel: embedding?.model, containsSensitiveData: false, ...audit(actor),
    });
    const { supersededMemoryIds = [], ...record } = stored;
    return { record, supersededMemoryIds, embedding };
  }

  async forget(actor: ActorContext, input: { preferenceKey: string; sourceRunId: string; conversationId: string }) {
    return await this.client.mutation<{ deleted: number; memoryIds: string[] }>("agentPlatformMemory:forgetPreference", { ...input, ...audit(actor) });
  }

  async recallPropertyOrder(actor: ActorContext, conversationId: string): Promise<PropertyOrderRecall | null> {
    const startedAt = Date.now();
    const embedding = await embedWithMetadata("preferencia estable del usuario para ordenar resultados de inmuebles por precio o fecha");
    if (embedding) {
      const hits = await this.client.action<Array<{ score: number; record: ScopedMemoryRecord }>>("agentPlatformMemory:vectorSearch", {
        embedding: embedding.vector, limit: 8, ...audit(actor),
      });
      const hit = hits.find((candidate) => candidate.record.preferenceKey === "property_order" && orderFromContent(candidate.record));
      if (hit) {
        await this.client.mutation("agentPlatformMemory:markAccessed", { memoryId: hit.record.memoryId, conversationId, ...audit(actor) });
        return { record: hit.record, order: orderFromContent(hit.record)!, mode: "vector", score: hit.score, embedding, latencyMs: Date.now() - startedAt };
      }
    }
    const record = await this.client.query<ScopedMemoryRecord | null>("agentPlatformMemory:currentPreference", { preferenceKey: "property_order", ...audit(actor) });
    const order = record ? orderFromContent(record) : null;
    if (!record || !order) return null;
    await this.client.mutation("agentPlatformMemory:markAccessed", { memoryId: record.memoryId, conversationId, ...audit(actor) });
    return { record, order, mode: "scoped-index", embedding, latencyMs: Date.now() - startedAt };
  }
}
