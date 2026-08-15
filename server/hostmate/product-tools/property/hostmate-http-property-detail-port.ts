import type { ActorContext } from "../../contracts/actor-context.js";
import type { PropertyDetailPort, PropertyDetailServiceResult, PropertyGetPropertyInput } from "./get-property.js";

export class HostmateHttpPropertyDetailPort implements PropertyDetailPort {
  constructor(
    private readonly baseUrl: string,
    private readonly actorToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly requestId?: string,
    private readonly signal?: AbortSignal,
  ) {}

  async get(_actor: ActorContext, input: PropertyGetPropertyInput): Promise<PropertyDetailServiceResult> {
    const response = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/api/v2/internal/agent-platform/property/get-property`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.actorToken}`, "content-type": "application/json", ...(this.requestId ? { "x-request-id": this.requestId } : {}) },
      body: JSON.stringify(input),
      signal: this.signal,
    });
    const payload = await response.json() as { success?: boolean; data?: PropertyDetailServiceResult; error?: string };
    if (!response.ok || !payload.success || !payload.data) {
      throw new Error(`Hostmate property service rejected detail (${response.status}): ${payload.error ?? "unknown"}`);
    }
    return payload.data;
  }
}
