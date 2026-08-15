import { createHash } from "node:crypto";
import { z } from "zod";
import { defineRuntimeTool } from "../../runtimes/tool.js";
import type { RuntimeTool } from "../../runtimes/types.js";
import type { ActorContext } from "../contracts/actor-context.js";
import type { ExecutionProfileId, RiskLevel, ToolMode } from "../contracts/domain.js";
import type { PolicyEngine } from "../policy/engine.js";

export type ProductToolDefinition<T extends z.ZodRawShape = z.ZodRawShape> = Readonly<{
  toolId: string;
  namespace: string;
  name: string;
  version: number;
  description: string;
  ownerDomain: ExecutionProfileId;
  compatibleProfiles: readonly ExecutionProfileId[];
  capabilities: readonly string[];
  mode: ToolMode;
  risk: RiskLevel;
  requiredPermission: string;
  inputSchema: T;
  outputSchema: z.ZodTypeAny;
  availability: "active" | "planned" | "web-only";
  idempotency: "none" | "required";
  handler: (input: z.infer<z.ZodObject<T>>, context: ActorContext) => Promise<unknown>;
}>;

type RegisteredProductToolDefinition = Omit<ProductToolDefinition<any>, "handler"> & Readonly<{
  // `never` safely erases heterogeneous input shapes: every concrete handler
  // can accept it, while callers still cannot bypass the runtime parser.
  handler: (input: never, context: ActorContext) => Promise<unknown>;
}>;

export type ToolResolution = Readonly<{
  tools: readonly RegisteredProductToolDefinition[];
  rejected: readonly { toolId: string; reason: string }[];
  registryHash: string;
}>;

export class ProductToolRegistry {
  private readonly tools: readonly RegisteredProductToolDefinition[];

  constructor(tools: readonly RegisteredProductToolDefinition[]) {
    const ids = new Set<string>();
    for (const tool of tools) {
      if (ids.has(tool.toolId)) throw new Error(`Duplicate tool id: ${tool.toolId}`);
      ids.add(tool.toolId);
      if (tool.mode !== "read" && tool.idempotency !== "required") {
        throw new Error(`Write-capable tool ${tool.toolId} must require idempotency`);
      }
    }
    this.tools = Object.freeze([...tools]);
  }

  resolve(input: {
    profileId: ExecutionProfileId;
    objectiveCapabilities: readonly string[];
    actor: ActorContext;
    allowedToolIds?: readonly string[];
    featureEnabled: (toolId: string) => boolean;
    readOnly: boolean;
  }): ToolResolution {
    const requiredCapabilities = new Set(input.objectiveCapabilities);
    const allowlist = input.allowedToolIds ? new Set(input.allowedToolIds) : null;
    const tools: RegisteredProductToolDefinition[] = [];
    const rejected: { toolId: string; reason: string }[] = [];
    for (const tool of this.tools) {
      let reason: string | null = null;
      if (tool.availability !== "active") reason = `availability:${tool.availability}`;
      else if (!tool.compatibleProfiles.includes(input.profileId)) reason = "profile_incompatible";
      else if (!tool.capabilities.some((capability) => requiredCapabilities.has(capability))) reason = "objective_incompatible";
      else if (allowlist && !allowlist.has(tool.toolId)) reason = "not_allowlisted";
      else if (!input.featureEnabled(tool.toolId)) reason = "feature_disabled";
      else if (input.readOnly && tool.mode !== "read") reason = "read_only";
      else if (!input.actor.isSuperAdmin && !input.actor.permissions.includes(tool.requiredPermission)) reason = "missing_permission";
      if (reason) rejected.push({ toolId: tool.toolId, reason });
      else tools.push(tool);
    }
    const fingerprint = tools.map((tool) => `${tool.toolId}@${tool.version}`).sort().join("\n");
    return Object.freeze({
      tools: Object.freeze(tools),
      rejected: Object.freeze(rejected),
      registryHash: createHash("sha256").update(fingerprint).digest("hex"),
    });
  }

  compileRuntimeTools(input: {
    resolved: ToolResolution;
    actor: ActorContext;
    policy: PolicyEngine;
    profileId: ExecutionProfileId;
    decisionId: (toolId: string) => string;
    hasRequiredPreconditions: (toolId: string, args: Record<string, unknown>) => boolean;
    confirmedDraftId?: string;
  }): readonly RuntimeTool[] {
    return Object.freeze(
      input.resolved.tools.map((tool) =>
        defineRuntimeTool(tool.namespace, tool.name, tool.description, tool.inputSchema, async (args) => {
          const decision = input.policy.evaluate({
            decisionId: input.decisionId(tool.toolId), actor: input.actor, profileId: input.profileId,
            toolId: tool.toolId, mode: tool.mode, risk: tool.risk, requiredPermission: tool.requiredPermission,
            featureEnabled: true, writeEnabled: true,
            hasRequiredPreconditions: input.hasRequiredPreconditions(tool.toolId, args),
            confirmedDraftId: input.confirmedDraftId,
          });
          if (decision.effect !== "allow") {
            return { text: JSON.stringify({ ok: false, policy: decision }), success: false };
          }
          const output = tool.outputSchema.parse(await tool.handler(args as never, input.actor));
          return { text: JSON.stringify({ ok: true, data: output }), success: true };
        }),
      ),
    );
  }
}
