import type { ActorContext } from "../../contracts/actor-context.js";
import { SafeWriteCommitError, type SafeWriteCommitErrorCode, type SafeWriteCommitResult } from "../../drafts/safe-write-commit-registry.js";
import type { CrmAddLeadNoteInput, LeadNotePreparation, LeadNoteWritePort } from "./add-lead-note.js";

export class HostmateHttpLeadNoteWritePort implements LeadNoteWritePort {
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
      const supported: SafeWriteCommitErrorCode[] = ["NOT_FOUND", "PERMISSION_DENIED", "STALE_REFERENCE", "PRECONDITION_FAILED", "CONFLICT"];
      const code = supported.includes(payload.error as SafeWriteCommitErrorCode) ? payload.error as SafeWriteCommitErrorCode : "CONFLICT";
      throw new SafeWriteCommitError(code, payload.error ?? `Hostmate write facade failed (${response.status})`);
    }
    return payload.data;
  }

  prepare(_actor: ActorContext, input: CrmAddLeadNoteInput): Promise<LeadNotePreparation> {
    return this.call("/api/v2/internal/agent-platform/crm/prepare-lead-note", input);
  }

  commit(_actor: ActorContext, input: { signedIntent: unknown }): Promise<SafeWriteCommitResult> {
    return this.call("/api/v2/internal/agent-platform/crm/commit-lead-note", input);
  }
}
