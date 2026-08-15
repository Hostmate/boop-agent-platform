import { createHash } from "node:crypto";
import type { ActorContext } from "../contracts/actor-context.js";
import type { ExecutionProfileId } from "../contracts/domain.js";

export type SkillDefinition = Readonly<{
  id: string;
  version: number;
  title: string;
  compatibleProfiles: readonly ExecutionProfileId[];
  objectiveClasses: readonly string[];
  requiredToolCapabilities: readonly string[];
  optionalToolCapabilities: readonly string[];
  content: string;
  securityClass: "standard" | "sensitive";
  status: "active" | "deprecated";
}>;

export type ResolvedSkill = SkillDefinition & Readonly<{ hash: string }>;

const skill = (definition: SkillDefinition): SkillDefinition => Object.freeze(definition);

export const FOUNDATION_SKILLS: readonly SkillDefinition[] = Object.freeze([
  skill({ id: "resolve-ambiguous-lead", version: 1, title: "Resolve an ambiguous lead", compatibleProfiles: ["crm"], objectiveClasses: ["lead.lookup"], requiredToolCapabilities: ["crm.lead.search"], optionalToolCapabilities: ["crm.lead.read"], securityClass: "standard", status: "active", content: "Search using available signals. Return safe candidates and request a user choice unless exactly one candidate is authoritative." }),
  skill({ id: "update-lead-safely", version: 1, title: "Update a lead safely", compatibleProfiles: ["crm"], objectiveClasses: ["lead.update"], requiredToolCapabilities: ["crm.lead.update"], optionalToolCapabilities: ["crm.lead.read"], securityClass: "sensitive", status: "active", content: "Resolve the lead, preserve the expected version, restrict the patch to allowed fields, and report the resulting diff." }),
  skill({ id: "create-property-search", version: 1, title: "Create a property search", compatibleProfiles: ["demand-matching"], objectiveClasses: ["demand.create"], requiredToolCapabilities: ["demand.create"], optionalToolCapabilities: ["demand.match.read"], securityClass: "standard", status: "active", content: "Normalize operation, location, budget and requirements. Detect duplicates. Calculate matches without sending any message." }),
  skill({ id: "inspect-demand-matches", version: 1, title: "Inspect demand matches", compatibleProfiles: ["demand-matching"], objectiveClasses: ["matching.inspect"], requiredToolCapabilities: ["demand.match.read"], optionalToolCapabilities: [], securityClass: "standard", status: "active", content: "Separate hard and soft criteria, explain score evidence, and never represent correlation as certainty." }),
  skill({ id: "update-property-listing-safely", version: 1, title: "Update a property listing safely", compatibleProfiles: ["property"], objectiveClasses: ["property.update"], requiredToolCapabilities: ["property.update"], optionalToolCapabilities: ["property.read"], securityClass: "sensitive", status: "active", content: "Resolve the property reference, validate each editable field, preserve the expected version and return a concise diff." }),
  skill({ id: "prepare-property-visit", version: 1, title: "Prepare a property visit", compatibleProfiles: ["visits"], objectiveClasses: ["visit.availability", "visit.create"], requiredToolCapabilities: ["visits.availability.read"], optionalToolCapabilities: ["visits.create"], securityClass: "sensitive", status: "active", content: "Resolve lead and property, apply actor timezone, check current availability and routing, and preserve commit-time preconditions." }),
  skill({ id: "reschedule-visit-safely", version: 1, title: "Reschedule a visit safely", compatibleProfiles: ["visits"], objectiveClasses: ["visit.update"], requiredToolCapabilities: ["visits.read", "visits.reschedule"], optionalToolCapabilities: [], securityClass: "sensitive", status: "active", content: "Read current state, recheck the target slot at commit, record the lifecycle event, and keep client communication separate." }),
  skill({ id: "draft-client-reply", version: 1, title: "Draft a client reply", compatibleProfiles: ["communications"], objectiveClasses: ["message.draft"], requiredToolCapabilities: ["communications.context.read"], optionalToolCapabilities: ["communications.draft"], securityClass: "sensitive", status: "active", content: "Gather bounded context, respect channel windows, produce a draft, and never execute the external send." }),
]);

export class SkillRegistry {
  constructor(private readonly definitions = FOUNDATION_SKILLS) {}

  resolve(input: {
    profileId: ExecutionProfileId;
    objectiveClasses: readonly string[];
    skillHints?: readonly string[];
    availableToolCapabilities: readonly string[];
    actor: ActorContext;
  }): readonly ResolvedSkill[] {
    const available = new Set(input.availableToolCapabilities);
    const hints = new Set(input.skillHints ?? []);
    return Object.freeze(
      this.definitions
        .filter((candidate) => candidate.status === "active")
        .filter((candidate) => candidate.compatibleProfiles.includes(input.profileId))
        .filter((candidate) => candidate.objectiveClasses.some((value) => input.objectiveClasses.includes(value)))
        .filter((candidate) => hints.size === 0 || hints.has(candidate.id))
        .filter((candidate) => candidate.requiredToolCapabilities.every((capability) => available.has(capability)))
        .map((candidate) => ({
          ...candidate,
          hash: createHash("sha256").update(`${candidate.id}@${candidate.version}\n${candidate.content}`).digest("hex"),
        })),
    );
  }
}
