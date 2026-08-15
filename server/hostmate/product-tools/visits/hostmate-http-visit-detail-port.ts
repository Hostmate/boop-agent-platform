import type { ActorContext } from "../../contracts/actor-context.js";
import {
  VisitDetailPortError,
  type GetVisitInput,
  type VisitDetailPort,
  type VisitDetailServiceResult,
} from "./get-visit.js";

export class HostmateHttpVisitDetailPort implements VisitDetailPort {
  constructor(
    private readonly baseUrl: string,
    private readonly actorToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getVisit(_actor: ActorContext, input: GetVisitInput): Promise<VisitDetailServiceResult> {
    const response = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/api/v2/internal/agent-platform/visits/get-visit`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.actorToken}`, "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const payload = await response.json() as { success?: boolean; data?: VisitDetailServiceResult; error?: string };
    if (!response.ok || !payload.success || !payload.data) {
      const code = payload.error;
      if (code === "NOT_FOUND" || code === "PERMISSION_DENIED" || code === "STALE_REFERENCE") {
        throw new VisitDetailPortError(code, `Hostmate rejected visit detail (${response.status})`);
      }
      throw new Error(`Hostmate visit detail service failed (${response.status}): ${code ?? "unknown"}`);
    }
    return payload.data;
  }
}
