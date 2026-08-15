import { createHash } from "node:crypto";
import type { ActorContext } from "../contracts/actor-context.js";
import type { EntityRef, ExecutionProfileId } from "../contracts/domain.js";
import type { ExecutionProfileDefinition, ExecutionProfileRegistry } from "../profiles/registry.js";
import type { ResolvedSkill, SkillRegistry } from "../skills/registry.js";
import type { ProductToolRegistry, ToolResolution } from "../tools/registry.js";

export type SpawnExecutionRequest = Readonly<{
  profileId: ExecutionProfileId;
  objective: string;
  objectiveClasses: readonly string[];
  objectiveCapabilities: readonly string[];
  inputRefs: readonly EntityRef[];
  dependencyRunIds: readonly string[];
  skillHints?: readonly string[];
  constraints: Readonly<{ readOnly: boolean; deadlineMs?: number; maxResults?: number }>;
}>;

export type ResolvedExecutionDispatch = Readonly<{
  profile: ExecutionProfileDefinition;
  objective: string;
  objectiveHash: string;
  inputRefs: readonly EntityRef[];
  dependencyRunIds: readonly string[];
  toolResolution: ToolResolution;
  skills: readonly ResolvedSkill[];
}>;

export class ExecutionDispatchResolver {
  constructor(
    private readonly profiles: ExecutionProfileRegistry,
    private readonly tools: ProductToolRegistry,
    private readonly skills: SkillRegistry,
  ) {}

  resolve(input: {
    actor: ActorContext;
    request: SpawnExecutionRequest;
    allowedToolIds: readonly string[];
    featureEnabled: (toolId: string) => boolean;
  }): ResolvedExecutionDispatch {
    const profile = this.profiles.get(input.request.profileId);
    if (!input.request.objective.trim()) throw new Error("Execution objective is required");
    if (!input.request.objectiveClasses.every((value) => profile.objectiveClasses.includes(value))) {
      throw new Error("Objective class is incompatible with the selected profile");
    }
    const toolResolution = this.tools.resolve({
      profileId: profile.id,
      objectiveCapabilities: input.request.objectiveCapabilities,
      actor: input.actor,
      allowedToolIds: input.allowedToolIds,
      featureEnabled: input.featureEnabled,
      readOnly: input.request.constraints.readOnly,
    });
    const capabilities = [...new Set(toolResolution.tools.flatMap((tool) => tool.capabilities))];
    const skills = this.skills.resolve({
      profileId: profile.id,
      objectiveClasses: input.request.objectiveClasses,
      skillHints: input.request.skillHints,
      availableToolCapabilities: capabilities,
      actor: input.actor,
    });
    return Object.freeze({
      profile,
      objective: input.request.objective.trim(),
      objectiveHash: createHash("sha256").update(input.request.objective.trim()).digest("hex"),
      inputRefs: Object.freeze([...input.request.inputRefs]),
      dependencyRunIds: Object.freeze([...input.request.dependencyRunIds]),
      toolResolution,
      skills,
    });
  }
}
