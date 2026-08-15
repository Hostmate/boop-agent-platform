import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type { ActorContextInput } from "../contracts/actor-context.js";
import type { ConvexControlPlaneClient } from "./convex-control-plane-repository.js";

export class AuthenticatedConvexHttpClient implements ConvexControlPlaneClient {
  private readonly client: ConvexHttpClient;

  constructor(url: string, token: string) {
    this.client = new ConvexHttpClient(url);
    this.client.setAuth(token);
  }

  mutation<T>(name: string, args: Record<string, unknown>): Promise<T> {
    return this.client.mutation(makeFunctionReference<"mutation">(name), args) as Promise<T>;
  }

  query<T>(name: string, args: Record<string, unknown>): Promise<T> {
    return this.client.query(makeFunctionReference<"query">(name), args) as Promise<T>;
  }

  currentActor(): Promise<ActorContextInput> {
    return this.query<ActorContextInput>("agentPlatform:currentActor", {});
  }
}
