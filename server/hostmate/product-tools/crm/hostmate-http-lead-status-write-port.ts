import type { ActorContext } from "../../contracts/actor-context.js";
import type { CrmUpdateLeadStatusInput, LeadStatusPreparation, LeadStatusWritePort } from "./update-lead-status.js";
import { LeadStatusWritePortError } from "./update-lead-status.js";

export class HostmateHttpLeadStatusWritePort implements LeadStatusWritePort {
  constructor(
    private readonly baseUrl: string,
    private readonly actorToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly requestId?: string,
    private readonly signal?: AbortSignal,
  ) {}

  private async call<T>(path: string, body: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.actorToken}`, "content-type": "application/json", ...(this.requestId ? { "x-request-id": this.requestId } : {}) },
      body: JSON.stringify(body), signal: this.signal,
    });
    const payload = await response.json() as { success?: boolean; data?: T; error?: string };
    if (!response.ok || !payload.success || !payload.data) {
      const code = ["NOT_FOUND", "PERMISSION_DENIED", "STALE_REFERENCE", "PRECONDITION_FAILED", "CONFLICT"].includes(payload.error ?? "")
        ? payload.error as LeadStatusWritePortError["code"] : "CONFLICT";
      throw new LeadStatusWritePortError(code, payload.error ?? `Hostmate write facade failed (${response.status})`);
    }
    return payload.data;
  }

  prepare(_actor: ActorContext, input: CrmUpdateLeadStatusInput): Promise<LeadStatusPreparation> {
    return this.call("/api/v2/internal/agent-platform/crm/prepare-lead-status-update", input);
  }

  commit(_actor: ActorContext, input: { signedIntent: unknown }): Promise<{ outcome: "committed"; idempotent: boolean }> {
    return this.call("/api/v2/internal/agent-platform/crm/commit-lead-status-update", input);
  }
}
