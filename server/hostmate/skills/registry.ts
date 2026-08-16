import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ActorContext } from "../contracts/actor-context.js";
import type { ExecutionProfileId } from "../contracts/domain.js";

export type SkillDefinition = Readonly<{
  id: string;
  version: number;
  title: string;
  description: string;
  sourcePath: string;
  compatibleProfiles: readonly ExecutionProfileId[];
  objectiveClasses: readonly string[];
  requiredToolCapabilities: readonly string[];
  optionalToolCapabilities: readonly string[];
  securityClass: "standard" | "sensitive";
  status: "active" | "planned" | "deprecated";
  featureGate?: string;
  modelCompatibility?: readonly string[];
  trustedSource: "engineering-repository";
  content: string;
}>;

export type ResolvedSkill = SkillDefinition & Readonly<{ hash: string }>;

type SkillFrontmatter = Readonly<{ name: string; description: string }>;

function parseSkillMarkdown(source: string): { frontmatter: SkillFrontmatter; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]+)$/.exec(source.replace(/\r\n/g, "\n"));
  if (!match) throw new Error("SKILL.md must contain YAML frontmatter and a body");
  const values = new Map<string, string>();
  for (const line of match[1]!.split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) throw new Error("SKILL.md frontmatter must use scalar key/value entries");
    values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const name = values.get("name") ?? "";
  const description = values.get("description") ?? "";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || !description) throw new Error("SKILL.md name or description is invalid");
  return { frontmatter: { name, description }, body: match[2]!.trim() };
}

const skill = (definition: SkillDefinition): SkillDefinition => Object.freeze({
  ...definition,
  compatibleProfiles: Object.freeze([...definition.compatibleProfiles]),
  objectiveClasses: Object.freeze([...definition.objectiveClasses]),
  requiredToolCapabilities: Object.freeze([...definition.requiredToolCapabilities]),
  optionalToolCapabilities: Object.freeze([...definition.optionalToolCapabilities]),
  modelCompatibility: definition.modelCompatibility ? Object.freeze([...definition.modelCompatibility]) : undefined,
});

const prepareVisitBriefSkill = readFileSync(resolve(process.cwd(), ".agents/skills/prepare-visit-brief/SKILL.md"), "utf8");
const prepareVisitBrief = parseSkillMarkdown(prepareVisitBriefSkill);
const prepareLeadBriefSkill = readFileSync(resolve(process.cwd(), ".agents/skills/prepare-lead-brief/SKILL.md"), "utf8");
const prepareLeadBrief = parseSkillMarkdown(prepareLeadBriefSkill);

const planned = (input: Omit<SkillDefinition, "description" | "sourcePath" | "status" | "trustedSource">): SkillDefinition => skill({
  ...input, description: input.title, sourcePath: "legacy:foundation-placeholder", status: "planned", trustedSource: "engineering-repository",
});

export const FOUNDATION_SKILLS: readonly SkillDefinition[] = Object.freeze([
  planned({ id: "resolve-ambiguous-lead", version: 1, title: "Resolve an ambiguous lead", compatibleProfiles: ["crm"], objectiveClasses: ["lead.lookup"], requiredToolCapabilities: ["crm.lead.search"], optionalToolCapabilities: ["crm.lead.read"], securityClass: "standard", content: "Planned foundation procedure." }),
  planned({ id: "update-lead-safely", version: 1, title: "Update a lead safely", compatibleProfiles: ["crm"], objectiveClasses: ["lead.update"], requiredToolCapabilities: ["crm.lead.update"], optionalToolCapabilities: ["crm.lead.read"], securityClass: "sensitive", content: "Planned foundation procedure." }),
  planned({ id: "create-property-search", version: 1, title: "Create a property search", compatibleProfiles: ["demand-matching"], objectiveClasses: ["demand.create"], requiredToolCapabilities: ["demand.create"], optionalToolCapabilities: ["demand.match.read"], securityClass: "standard", content: "Planned foundation procedure." }),
  planned({ id: "inspect-demand-matches", version: 1, title: "Inspect demand matches", compatibleProfiles: ["demand-matching"], objectiveClasses: ["matching.inspect"], requiredToolCapabilities: ["demand.match.read"], optionalToolCapabilities: [], securityClass: "standard", content: "Planned foundation procedure." }),
  planned({ id: "update-property-listing-safely", version: 1, title: "Update a property listing safely", compatibleProfiles: ["property"], objectiveClasses: ["property.update"], requiredToolCapabilities: ["property.update"], optionalToolCapabilities: ["property.read"], securityClass: "sensitive", content: "Planned foundation procedure." }),
  planned({ id: "prepare-property-visit", version: 1, title: "Prepare a property visit", compatibleProfiles: ["visits"], objectiveClasses: ["visit.availability", "visit.create"], requiredToolCapabilities: ["visits.availability.read"], optionalToolCapabilities: ["visits.create"], securityClass: "sensitive", content: "Planned foundation procedure." }),
  planned({ id: "reschedule-visit-safely", version: 1, title: "Reschedule a visit safely", compatibleProfiles: ["visits"], objectiveClasses: ["visit.update"], requiredToolCapabilities: ["visits.read", "visits.reschedule"], optionalToolCapabilities: [], securityClass: "sensitive", content: "Planned foundation procedure." }),
  planned({ id: "draft-client-reply", version: 1, title: "Draft a client reply", compatibleProfiles: ["communications"], objectiveClasses: ["message.draft"], requiredToolCapabilities: ["communications.context.read"], optionalToolCapabilities: ["communications.draft"], securityClass: "sensitive", content: "Planned foundation procedure." }),
  skill({
    id: prepareVisitBrief.frontmatter.name,
    version: 1,
    title: "Prepare visit brief",
    description: prepareVisitBrief.frontmatter.description,
    sourcePath: ".agents/skills/prepare-visit-brief/SKILL.md",
    compatibleProfiles: ["visits"],
    objectiveClasses: ["visit.prepare_brief"],
    requiredToolCapabilities: ["visits.visit.detail", "crm.lead.context", "property.property.read"],
    optionalToolCapabilities: [],
    securityClass: "standard",
    status: "active",
    featureGate: "AGENT_PLATFORM_SKILLS_PREPARE_VISIT_BRIEF_ENABLED",
    modelCompatibility: ["openrouter"],
    trustedSource: "engineering-repository",
    content: prepareVisitBriefSkill.replace(/\r\n/g, "\n").trim(),
  }),
  skill({
    id: prepareLeadBrief.frontmatter.name,
    version: 1,
    title: "Prepare lead brief",
    description: prepareLeadBrief.frontmatter.description,
    sourcePath: ".agents/skills/prepare-lead-brief/SKILL.md",
    compatibleProfiles: ["crm"],
    objectiveClasses: ["lead.prepare_brief"],
    requiredToolCapabilities: ["crm.lead.context"],
    optionalToolCapabilities: [],
    securityClass: "standard",
    status: "active",
    featureGate: "AGENT_PLATFORM_SKILLS_PREPARE_LEAD_BRIEF_ENABLED",
    modelCompatibility: ["openrouter"],
    trustedSource: "engineering-repository",
    content: prepareLeadBriefSkill.replace(/\r\n/g, "\n").trim(),
  }),
]);

export class SkillRegistry {
  constructor(private readonly definitions = FOUNDATION_SKILLS) {}

  resolve(input: {
    profileId: ExecutionProfileId;
    eligibleSkillIds: readonly string[];
    objectiveClasses: readonly string[];
    internalSkillHints?: readonly string[];
    availableToolCapabilities: readonly string[];
    actor: ActorContext;
    featureEnabled?: (featureGate: string) => boolean;
  }): readonly ResolvedSkill[] {
    const available = new Set(input.availableToolCapabilities);
    const eligible = new Set(input.eligibleSkillIds);
    const hints = new Set(input.internalSkillHints ?? []);
    return Object.freeze(
      this.definitions
        .filter((candidate) => candidate.status === "active")
        .filter((candidate) => eligible.has(candidate.id))
        .filter((candidate) => candidate.compatibleProfiles.includes(input.profileId))
        .filter((candidate) => candidate.objectiveClasses.some((value) => input.objectiveClasses.includes(value)))
        .filter((candidate) => hints.size === 0 || hints.has(candidate.id))
        .filter((candidate) => !candidate.featureGate || (input.featureEnabled?.(candidate.featureGate) ?? false))
        .filter((candidate) => candidate.requiredToolCapabilities.every((capability) => available.has(capability)))
        .map((candidate) => ({
          ...candidate,
          hash: createHash("sha256").update(candidate.content).digest("hex"),
        })),
    );
  }

  list(): readonly SkillDefinition[] {
    return Object.freeze([...this.definitions]);
  }
}
