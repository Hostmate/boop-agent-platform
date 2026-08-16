import { createHash, createHmac, timingSafeEqual } from "node:crypto";
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

export type WriteIntentStatus = "proposed" | "confirmed" | "committing" | "committed" | "cancelled" | "expired" | "failed" | "stale";

/**
 * Generic authority-bound write intent. The LLM-facing tool can only prepare
 * this envelope; it is deliberately not executable and contains no free-form
 * patch or caller-supplied authority fields.
 */
export type WriteIntentEnvelope = Readonly<{
  draftId: string;
  tenantId: string;
  actorUserId: string;
  sessionId: string;
  permissionsVersion: string;
  effectiveTenantOverride: boolean;
  conversationId: string;
  sourceRunId: string;
  profileId: string;
  toolId: string;
  toolVersion: number;
  toolScope: readonly string[];
  target: EntityRef;
  operationType: "update" | "create";
  operation: string;
  requestedValue: string;
  preconditions: readonly { kind: string; expected: string }[];
  argsHash: string;
  idempotencyKey: string;
  risk: Exclude<RiskLevel, "R0">;
  policyDecisionId: string;
  expiresAt: number;
  confirmationTokenHash: string;
}>;

export type SignedWriteIntent = Readonly<{
  envelope: WriteIntentEnvelope;
  signature: string;
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

export function canonicalDraftJson(value: unknown): string {
  return stableJson(value);
}

export function hashDraftArguments(args: unknown): string {
  return createHash("sha256").update(stableJson(args)).digest("hex");
}

export function hashConfirmationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function signWriteIntent(envelope: WriteIntentEnvelope, secret: string): string {
  if (secret.length < 32) throw new Error("WRITE_INTENT_SECRET_TOO_SHORT");
  return createHmac("sha256", secret).update(stableJson(envelope)).digest("hex");
}

export function verifyWriteIntentSignature(intent: SignedWriteIntent, secret: string): boolean {
  const expected = Buffer.from(signWriteIntent(intent.envelope, secret), "hex");
  const received = Buffer.from(intent.signature, "hex");
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export function verifyWriteIntentConfirmationToken(intent: SignedWriteIntent, token: string): boolean {
  const expected = Buffer.from(intent.envelope.confirmationTokenHash, "hex");
  const received = Buffer.from(hashConfirmationToken(token), "hex");
  return expected.length === received.length && timingSafeEqual(expected, received);
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
