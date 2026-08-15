import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type { ActorContextInput } from "../contracts/actor-context.js";
import type { ConvexControlPlaneClient } from "./convex-control-plane-repository.js";

export class AuthenticatedConvexHttpClient implements ConvexControlPlaneClient {
  private readonly client: ConvexHttpClient;
  private readonly mutationCounts = new Map<string, number>();

  constructor(url: string, token: string) {
    this.client = new ConvexHttpClient(url);
    this.client.setAuth(token);
  }

  mutation<T>(name: string, args: Record<string, unknown>): Promise<T> {
    this.mutationCounts.set(name, (this.mutationCounts.get(name) ?? 0) + 1);
    return this.client.mutation(makeFunctionReference<"mutation">(name), args) as Promise<T>;
  }

  query<T>(name: string, args: Record<string, unknown>): Promise<T> {
    return this.client.query(makeFunctionReference<"query">(name), args) as Promise<T>;
  }

  currentActor(): Promise<ActorContextInput> {
    return this.query<ActorContextInput>("agentPlatform:currentActor", {});
  }

  writeMetrics(): { mutations: Record<string, number>; estimatedDocumentWrites: number } {
    const mutations = Object.fromEntries(this.mutationCounts);
    const weights: Record<string, number> = {
      'agentPlatform:appendMessage': 2,
    };
    const estimatedDocumentWrites = [...this.mutationCounts].reduce(
      (total, [name, count]) => total + count * (weights[name] ?? 1),
      0,
    );
    return { mutations, estimatedDocumentWrites };
  }
}
