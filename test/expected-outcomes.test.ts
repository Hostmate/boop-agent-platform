import { describe, expect, it } from "vitest";
import { normalizeExpectedExecutionError } from "../server/hostmate/drafts/expected-outcomes.js";

describe("expected preparation outcomes", () => {
  it("normalizes policy and canonical domain outcomes without exposing raw errors", () => {
    expect(normalizeExpectedExecutionError(new Error("Hostmate rejected prepare (409): VISIT_TEMPORAL_MISMATCH"))).toMatchObject({ status: "needs_input", code: "PRECONDITION_FAILED" });
    expect(normalizeExpectedExecutionError(new Error("POLICY_DENIED:skill_disabled"))).toMatchObject({ status: "permission_denied", code: "PERMISSION_DENIED" });
    expect(normalizeExpectedExecutionError(new Error("HARD_CONSTRAINT_FAILED:slot occupied"))).toMatchObject({ status: "needs_input", code: "CONFLICT" });
    expect(normalizeExpectedExecutionError(new Error("database connection exploded"))).toBeUndefined();
  });
});

