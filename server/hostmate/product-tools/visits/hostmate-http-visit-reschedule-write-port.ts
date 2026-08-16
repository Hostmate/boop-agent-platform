import type { ActorContext } from "../../contracts/actor-context.js";
import { SafeWriteCommitError, type SafeWriteCommitErrorCode, type SafeWriteCommitResult } from "../../drafts/safe-write-commit-registry.js";
import type { VisitReschedulePreparation, VisitRescheduleWritePort, VisitsRescheduleVisitInput } from "./reschedule-visit.js";

export class HostmateHttpVisitRescheduleWritePort implements VisitRescheduleWritePort {
  constructor(private readonly baseUrl: string, private readonly actorToken: string, private readonly fetchImpl: typeof fetch = fetch, private readonly requestId?: string, private readonly signal?: AbortSignal) {}
  private async call<T>(path: string, body: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      method: "POST", headers: { authorization: `Bearer ${this.actorToken}`, "content-type": "application/json", ...(this.requestId ? { "x-request-id": this.requestId } : {}) }, body: JSON.stringify(body), signal: this.signal,
    });
    const payload = await response.json() as { success?: boolean; data?: T; error?: string };
    if (!response.ok || !payload.success || !payload.data) {
      const map: Record<string, SafeWriteCommitErrorCode> = { NOT_FOUND: "NOT_FOUND", PERMISSION_DENIED: "PERMISSION_DENIED", STALE_REFERENCE: "STALE_REFERENCE", PRECONDITION_FAILED: "PRECONDITION_FAILED", HARD_CONSTRAINT_FAILED: "PRECONDITION_FAILED", GROUP_VISIT_UNSUPPORTED: "PRECONDITION_FAILED" };
      throw new SafeWriteCommitError(map[payload.error ?? ""] ?? "CONFLICT", payload.error ?? `Hostmate visit reschedule facade failed (${response.status})`);
    }
    return payload.data;
  }
  prepare(_actor: ActorContext, input: VisitsRescheduleVisitInput): Promise<VisitReschedulePreparation> { return this.call("/api/v2/internal/agent-platform/visits/prepare-visit-reschedule", input); }
  commit(_actor: ActorContext, input: { signedIntent: unknown }): Promise<SafeWriteCommitResult> { return this.call("/api/v2/internal/agent-platform/visits/commit-visit-reschedule", input); }
}
