import type { ActorContext } from "../contracts/actor-context.js";
import type { ControlPlaneRepository } from "../control-plane/repository.js";
import type { BriefSkillIntent } from "../interaction/turn-classifier.js";
import type { LeadContextPort } from "../product-tools/crm/get-lead-context.js";
import type { PropertyDetailPort } from "../product-tools/property/get-property.js";
import type { VisitDetailPort } from "../product-tools/visits/get-visit.js";
import { PrepareLeadBriefVerticalSlice } from "./prepare-lead-brief.js";
import { PrepareVisitBriefVerticalSlice } from "./prepare-visit-brief.js";
import type { DeterministicSkillInput, DeterministicSkillTurn } from "./execution-helpers.js";

type SkillExecutor = Readonly<{
  execute(actor: ActorContext, input: DeterministicSkillInput): Promise<DeterministicSkillTurn<unknown>>;
}>;

type RuntimeSkillDependencies = Readonly<{
  repository: ControlPlaneRepository;
  leadContextPort: LeadContextPort;
  visitDetailPort: VisitDetailPort;
  propertyDetailPort: PropertyDetailPort;
}>;

type RuntimeSkillsConfig = Readonly<{
  enabledSkillIds: readonly BriefSkillIntent[];
  allowedTenantIds: readonly string[];
  allowedUserIds: readonly string[];
}>;

type SkillFactory = (dependencies: RuntimeSkillDependencies, enabled: boolean) => SkillExecutor;

const factories: Readonly<Record<BriefSkillIntent, SkillFactory>> = {
  "prepare-visit-brief": (dependencies, enabled) => new PrepareVisitBriefVerticalSlice(
    dependencies.repository,
    dependencies.visitDetailPort,
    dependencies.leadContextPort,
    dependencies.propertyDetailPort,
    enabled,
  ),
  "prepare-lead-brief": (dependencies, enabled) => new PrepareLeadBriefVerticalSlice(
    dependencies.repository,
    dependencies.leadContextPort,
    enabled,
  ),
};

export function runtimeSkillEnabled(
  skillId: BriefSkillIntent,
  actor: Pick<ActorContext, "tenantId" | "userId">,
  config: RuntimeSkillsConfig | undefined,
): boolean {
  return Boolean(
    config?.enabledSkillIds.includes(skillId)
    && config.allowedTenantIds.includes(actor.tenantId)
    && config.allowedUserIds.includes(actor.userId),
  );
}

export function createRuntimeSkillExecutor(
  skillId: BriefSkillIntent,
  actor: Pick<ActorContext, "tenantId" | "userId">,
  config: RuntimeSkillsConfig | undefined,
  dependencies: RuntimeSkillDependencies,
): SkillExecutor {
  return factories[skillId](dependencies, runtimeSkillEnabled(skillId, actor, config));
}
