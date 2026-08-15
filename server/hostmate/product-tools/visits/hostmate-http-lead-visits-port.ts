import type { ActorContext } from "../../contracts/actor-context.js";
import {
  LeadVisitsPortError,
  type LeadVisitsPort,
  type LeadVisitsServiceResult,
  type ListLeadVisitsInput,
} from "./list-lead-visits.js";

export class HostmateHttpLeadVisitsPort implements LeadVisitsPort {
  constructor(
    private readonly baseUrl: string,
    private readonly actorToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async listLeadVisits(_actor: ActorContext, input: ListLeadVisitsInput): Promise<LeadVisitsServiceResult> {
    const response = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/api/v2/internal/agent-platform/visits/list-lead-visits`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.actorToken}`, "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const payload = await response.json() as { success?: boolean; data?: LeadVisitsServiceResult; error?: string };
    if (!response.ok || !payload.success || !payload.data) {
      const code = payload.error;
      if (code === "NOT_FOUND" || code === "PERMISSION_DENIED" || code === "STALE_REFERENCE") {
        throw new LeadVisitsPortError(code, `Hostmate rejected lead visits (${response.status})`);
      }
      throw new Error(`Hostmate lead visits service failed (${response.status}): ${code ?? "unknown"}`);
    }
    return payload.data;
  }
}
