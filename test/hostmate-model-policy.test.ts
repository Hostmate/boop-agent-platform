import { describe, expect, it } from "vitest";
import {
  HOSTMATE_GENERATIVE_FALLBACK_MODELS,
  HOSTMATE_GENERATIVE_MODEL,
  HOSTMATE_GENERATIVE_REASONING_EFFORT,
} from "../server/hostmate/runtime/model-policy.js";

describe("Hostmate generative model policy", () => {
  it("pins every Hostmate inference to Gemini 3.5 Flash Lite without fallback", () => {
    expect(HOSTMATE_GENERATIVE_MODEL).toBe("google/gemini-3.5-flash-lite");
    expect(HOSTMATE_GENERATIVE_REASONING_EFFORT).toBe("minimal");
    expect(HOSTMATE_GENERATIVE_FALLBACK_MODELS).toEqual([]);
  });
});
