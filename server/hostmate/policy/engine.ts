import type { ActorContext } from "../contracts/actor-context.js";
import { actorHasPermission } from "../contracts/actor-context.js";
import type { ExecutionProfileId, RiskLevel, ToolMode } from "../contracts/domain.js";

export type PolicyDecision = Readonly<{
  effect: "allow" | "deny" | "require_confirmation";
  reason: string;
  decisionId: string;
}>;

export type PolicyInput = Readonly<{
  decisionId: string;
  actor: ActorContext;
  profileId: ExecutionProfileId;
  toolId: string;
  mode: ToolMode;
  risk: RiskLevel;
  requiredPermission: string;
  featureEnabled: boolean;
  writeEnabled: boolean;
  entityTenantId?: string;
  hasRequiredPreconditions: boolean;
  confirmedDraftId?: string;
}>;

export interface PolicyEngine {
  evaluate(input: PolicyInput): PolicyDecision;
}

export class DefaultPolicyEngine implements PolicyEngine {
  evaluate(input: PolicyInput): PolicyDecision {
    const deny = (reason: string): PolicyDecision => ({ effect: "deny", reason, decisionId: input.decisionId });
    if (!input.featureEnabled) return deny("feature_disabled");
    if (input.entityTenantId && input.entityTenantId !== input.actor.tenantId) return deny("cross_tenant_entity");
    if (!actorHasPermission(input.actor, input.requiredPermission)) return deny("missing_permission");
    if (input.mode !== "read" && !input.writeEnabled) return deny("writes_disabled");
    if (input.mode !== "read" && !input.hasRequiredPreconditions) return deny("missing_preconditions");
    // Draft preparation is the non-mutating safety boundary. Product writes
    // and external effects always require a separately confirmed draft; high
    // risk operations retain the same requirement even in future modes.
    // A draft Tool is read-only preparation even when the eventual operation
    // is R2/R3. Confirmation is enforced by the separate, non-Tool commit
    // path; requiring a confirmed draft here would make safe preparation
    // impossible for higher-risk actions.
    if (input.mode === "write" || input.mode === "external") {
      if (!input.confirmedDraftId) {
        return { effect: "require_confirmation", reason: "signed_draft_required", decisionId: input.decisionId };
      }
    }
    return { effect: "allow", reason: "policy_satisfied", decisionId: input.decisionId };
  }
}
