import type { ActorContext } from "../../contracts/actor-context.js";
import type { PropertySearchFilters, PropertySearchPort, PropertySearchServiceResult } from "./search-properties.js";

export class HostmateHttpPropertySearchPort implements PropertySearchPort {
  constructor(
    private readonly baseUrl: string,
    private readonly actorToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly requestId?: string,
    private readonly signal?: AbortSignal,
  ) {}

  async search(_actor: ActorContext, input: PropertySearchFilters): Promise<PropertySearchServiceResult> {
    const response = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/api/v2/internal/agent-platform/property/search-properties`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.actorToken}`, "content-type": "application/json", ...(this.requestId ? { "x-request-id": this.requestId } : {}) },
      body: JSON.stringify(input),
      signal: this.signal,
    });
    const payload = await response.json() as { success?: boolean; data?: PropertySearchServiceResult; error?: string };
    if (!response.ok || !payload.success || !payload.data) {
      throw new Error(`Hostmate property service rejected search (${response.status}): ${payload.error ?? "unknown"}`);
    }
    return payload.data;
  }
}
