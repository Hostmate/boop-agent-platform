/**
 * Thin embeddings wrapper. Tries Voyage → OpenAI → OpenRouter → local Transformers.js
 * (Xenova/bge-large-en-v1.5). All three produce 1024-dim vectors so the
 * Convex vector index stays compatible regardless of which provider runs.
 *
 * Local fallback ensures `recall()` always works — no API key required.
 * First local call downloads ~1.3GB and caches under Boop's local data folder.
 */

import type { FeatureExtractionPipeline } from "@huggingface/transformers";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VOYAGE_MODEL = "voyage-3";
const OPENAI_MODEL = "text-embedding-3-large";
const OPENROUTER_MODEL = "baai/bge-large-en-v1.5";
const LOCAL_MODEL = "Xenova/bge-large-en-v1.5";
// Keep the optional native-backed local fallback external to the small
// Hostmate runtime bundle. Development installs still resolve it normally.
const LOCAL_TRANSFORMERS_PACKAGE = "@huggingface/transformers";
const DIMENSIONS = 1024;
const LOCAL_CACHE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "data",
  "huggingface-cache",
);

// Local pipeline is loaded lazily (model download is ~1.3GB) and cached
// in-process. `loading` dedupes parallel callers during the first load.
let extractor: FeatureExtractionPipeline | null = null;
let loading: Promise<FeatureExtractionPipeline> | null = null;

export type EmbeddingProvider = "voyage" | "openai" | "openrouter" | "local";

export type EmbeddingResult = Readonly<{
  vector: number[];
  provider: EmbeddingProvider;
  model: string;
  inputTokens: number;
  costUsd: number;
}>;

export function activeProvider(): EmbeddingProvider {
  if (process.env.VOYAGE_API_KEY) return "voyage";
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.OPENROUTER_API_KEY) return "openrouter";
  return "local";
}

// Always true now — local is always available. Kept for back-compat with
// callsites that still gate on it.
export function embeddingsAvailable(): boolean {
  return true;
}

async function embedVoyage(text: string): Promise<number[]> {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      model: VOYAGE_MODEL,
      input: [text],
      output_dimension: DIMENSIONS,
    }),
  });
  if (!res.ok) throw new Error(`voyage ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { data: { embedding: number[] }[] };
  return json.data[0].embedding;
}

async function embedOpenAI(text: string): Promise<number[]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: text,
      dimensions: DIMENSIONS,
    }),
  });
  if (!res.ok) throw new Error(`openai embeddings ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { data: { embedding: number[] }[] };
  return json.data[0].embedding;
}

async function embedOpenRouter(text: string): Promise<EmbeddingResult> {
  const model = process.env.AGENT_PLATFORM_MEMORY_EMBEDDING_MODEL?.trim() || OPENROUTER_MODEL;
  const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "HTTP-Referer": process.env.OPENROUTER_APP_URL?.trim() || "https://realestate.hostmate.es",
      "X-Title": "Hostmate Agent Platform Memory",
    },
    body: JSON.stringify({ model, input: text }),
  });
  if (!res.ok) throw new Error(`openrouter embeddings ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as {
    data?: Array<{ embedding?: number[] }>;
    usage?: { prompt_tokens?: number; total_tokens?: number; cost?: number };
  };
  const vector = json.data?.[0]?.embedding;
  if (!vector || vector.length !== DIMENSIONS) {
    throw new Error(`openrouter embedding returned ${vector?.length ?? 0} dims, expected ${DIMENSIONS}`);
  }
  return {
    vector,
    provider: "openrouter",
    model,
    inputTokens: json.usage?.prompt_tokens ?? json.usage?.total_tokens ?? 0,
    costUsd: json.usage?.cost ?? 0,
  };
}

async function getLocalExtractor(): Promise<FeatureExtractionPipeline> {
  if (extractor) return extractor;
  if (loading) return loading;
  const attempt = (async () => {
    const { env, pipeline } = await import(LOCAL_TRANSFORMERS_PACKAGE);
    await mkdir(LOCAL_CACHE_DIR, { recursive: true });
    env.cacheDir = LOCAL_CACHE_DIR;
    console.log(`[embeddings] loading local model ${LOCAL_MODEL} (~1.3GB on first run)…`);
    const start = Date.now();
    const ext = await pipeline("feature-extraction", LOCAL_MODEL, {
      dtype: "fp32",
    });
    console.log(`[embeddings] local model ready in ${Date.now() - start}ms`);
    extractor = ext;
    return ext;
  })();
  loading = attempt;
  // If the load rejects (transient network failure during the model
  // download, etc.) we MUST clear `loading` so the next call re-attempts
  // instead of replaying the cached rejection forever. Detach the cleanup
  // from the returned promise via .catch(() => {}) so callers see the
  // original rejection while the slot still resets.
  attempt.catch(() => {
    if (loading === attempt) loading = null;
  });
  return loading;
}

async function embedLocal(text: string): Promise<number[]> {
  const ext = await getLocalExtractor();
  const out = await ext(text, { pooling: "mean", normalize: true });
  // Tensor → number[]. BGE-large outputs 1024 floats; verify shape so a
  // future model swap doesn't silently produce mis-sized vectors that the
  // Convex vector index would reject.
  const arr = Array.from(out.data as ArrayLike<number>);
  if (arr.length !== DIMENSIONS) {
    throw new Error(
      `local embedding returned ${arr.length} dims, expected ${DIMENSIONS}`,
    );
  }
  return arr;
}

// Preload the local model in the background so the first user-facing
// recall() doesn't pay the ~5–15s model load. Safe to call at server
// startup — failures are logged, not thrown.
export function preloadLocalModel(): void {
  if (process.env.VOYAGE_API_KEY || process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY) return;
  getLocalExtractor().catch((err) => {
    console.warn("[embeddings] local model preload failed:", err);
  });
}

export async function embedWithMetadata(text: string): Promise<EmbeddingResult | null> {
  try {
    if (process.env.VOYAGE_API_KEY) return { vector: await embedVoyage(text), provider: "voyage", model: VOYAGE_MODEL, inputTokens: 0, costUsd: 0 };
    if (process.env.OPENAI_API_KEY) return { vector: await embedOpenAI(text), provider: "openai", model: OPENAI_MODEL, inputTokens: 0, costUsd: 0 };
    if (process.env.OPENROUTER_API_KEY) return await embedOpenRouter(text);
    return { vector: await embedLocal(text), provider: "local", model: LOCAL_MODEL, inputTokens: 0, costUsd: 0 };
  } catch (err) {
    console.warn("[embeddings] failed:", err);
    return null;
  }
}

export async function embed(text: string): Promise<number[] | null> {
  return (await embedWithMetadata(text))?.vector ?? null;
}
