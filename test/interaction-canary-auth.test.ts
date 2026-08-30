import { describe, expect, it } from "vitest";
import { isInteractionCanaryAuthorized } from "../server/hostmate/shadow/interaction-canary-auth.js";

describe("production Interaction canary internal authentication", () => {
  const token = Buffer.from("a-production-length-internal-token");

  it("accepts only the exact bearer token", () => {
    expect(isInteractionCanaryAuthorized(`Bearer ${token.toString()}`, token)).toBe(true);
    expect(isInteractionCanaryAuthorized(`Bearer ${token.toString()}x`, token)).toBe(false);
    expect(isInteractionCanaryAuthorized("Bearer wrong-token", token)).toBe(false);
    expect(isInteractionCanaryAuthorized(undefined, token)).toBe(false);
  });
});
