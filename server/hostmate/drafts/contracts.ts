import { createHash } from "node:crypto";
import type { EntityRef, RiskLevel } from "../contracts/domain.js";

export type DraftStatus = "pending" | "approved" | "committing" | "committed" | "rejected" | "expired" | "failed" | "unknown";

export type SignedDraft = Readonly<{
  draftId: string;
  tenantId: string;
  actorUserId: string;
  sourceRunId: string;
  toolId: string;
  toolVersion: number;
  argsProtected: unknown;
  argsHash: string;
  entityRefs: readonly EntityRef[];
  diff: readonly unknown[];
  recipients?: readonly { channel: string; redactedTarget: string }[];
  preconditions: readonly { kind: string; expected: string }[];
  idempotencyKey: string;
  risk: Exclude<RiskLevel, "R0">;
  policyDecisionId: string;
  expiresAt: number;
  confirmationTokenHash: string;
  status: DraftStatus;
  createdAt: number;
  approvedAt?: number;
  committedAt?: number;
}>;

const TRANSITIONS: Record<DraftStatus, readonly DraftStatus[]> = {
  pending: ["approved", "rejected", "expired"],
  approved: ["committing", "expired"],
  committing: ["committed", "failed", "unknown"],
  failed: ["committing"],
  committed: [], rejected: [], expired: [], unknown: [],
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashDraftArguments(args: unknown): string {
  return createHash("sha256").update(stableJson(args)).digest("hex");
}

export function hashConfirmationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function canTransitionDraft(from: DraftStatus, to: DraftStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertDraftConfirmable(draft: SignedDraft, input: { tenantId: string; actorUserId: string; token: string; now: number; args: unknown }): void {
  if (draft.status !== "pending") throw new Error("DRAFT_NOT_PENDING");
  if (draft.expiresAt <= input.now) throw new Error("DRAFT_EXPIRED");
  if (draft.tenantId !== input.tenantId || draft.actorUserId !== input.actorUserId) throw new Error("DRAFT_FORBIDDEN");
  if (draft.confirmationTokenHash !== hashConfirmationToken(input.token)) throw new Error("DRAFT_TOKEN_INVALID");
  if (draft.argsHash !== hashDraftArguments(input.args)) throw new Error("DRAFT_ARGS_CHANGED");
}
