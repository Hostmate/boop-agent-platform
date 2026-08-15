import type { ActorContext } from "../../contracts/actor-context.js";
import type { CrmSearchLeadsInput, LeadSearchPort, LeadSearchServiceResult } from "./search-leads.js";

export class HostmateHttpLeadSearchPort implements LeadSearchPort {
  constructor(
    private readonly baseUrl: string,
    private readonly actorToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async search(_actor: ActorContext, input: CrmSearchLeadsInput): Promise<LeadSearchServiceResult> {
    const response = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/api/v2/internal/agent-platform/crm/search-leads`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.actorToken}`, "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const payload = await response.json() as { success?: boolean; data?: LeadSearchServiceResult; error?: string };
    if (!response.ok || !payload.success || !payload.data) {
      throw new Error(`Hostmate lead service rejected search (${response.status}): ${payload.error ?? "unknown"}`);
    }
    return payload.data;
  }
}
