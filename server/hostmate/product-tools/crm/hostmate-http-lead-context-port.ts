import type { ActorContext } from "../../contracts/actor-context.js";
import {
  LeadContextPortError,
  type CrmGetLeadContextInput,
  type LeadContextPort,
  type LeadContextServiceResult,
} from "./get-lead-context.js";

export class HostmateHttpLeadContextPort implements LeadContextPort {
  constructor(
    private readonly baseUrl: string,
    private readonly actorToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getContext(_actor: ActorContext, input: CrmGetLeadContextInput): Promise<LeadContextServiceResult> {
    const response = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/api/v2/internal/agent-platform/crm/get-lead-context`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.actorToken}`, "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const payload = await response.json() as { success?: boolean; data?: LeadContextServiceResult; error?: string };
    if (!response.ok || !payload.success || !payload.data) {
      const code = payload.error;
      if (code === "NOT_FOUND" || code === "PERMISSION_DENIED" || code === "STALE_REFERENCE") {
        throw new LeadContextPortError(code, `Hostmate rejected lead context (${response.status})`);
      }
      throw new Error(`Hostmate lead context service failed (${response.status}): ${code ?? "unknown"}`);
    }
    return payload.data;
  }
}
