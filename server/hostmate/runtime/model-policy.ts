import type { OpenRouterReasoningEffort } from "./openrouter-adapter.js";

/**
 * Single generative-model policy for the Hostmate Agent Platform.
 *
 * Keep this in the Hostmate adapter layer: Boop Core remains model-agnostic,
 * while every Hostmate Interaction/Execution inference uses the same model.
 */
export const HOSTMATE_GENERATIVE_MODEL = "google/gemini-3.5-flash-lite";
export const HOSTMATE_GENERATIVE_REASONING_EFFORT = "minimal" satisfies OpenRouterReasoningEffort;
export const HOSTMATE_GENERATIVE_FALLBACK_MODELS: readonly string[] = [];
