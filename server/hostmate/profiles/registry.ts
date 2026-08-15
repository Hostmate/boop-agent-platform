import type { ExecutionProfileId, RiskLevel } from "../contracts/domain.js";

export type ModelRoute = "cheap-read" | "balanced" | "strong-reasoning";

export type ExecutionProfileDefinition = Readonly<{
  id: ExecutionProfileId;
  version: number;
  responsibility: string;
  boundaries: readonly string[];
  compatibleToolBundles: readonly string[];
  compatibleSkillIds: readonly string[];
  objectiveClasses: readonly string[];
  limits: Readonly<{
    maxToolCalls: number;
    maxIterations: number;
    timeoutMs: number;
    maxResultBytes: number;
  }>;
  writePolicy: Readonly<{
    enabled: boolean;
    maxRisk: RiskLevel;
    requirePreconditions: boolean;
  }>;
  modelRoute: ModelRoute;
}>;

function profile(input: ExecutionProfileDefinition): ExecutionProfileDefinition {
  return Object.freeze({
    ...input,
    boundaries: Object.freeze([...input.boundaries]),
    compatibleToolBundles: Object.freeze([...input.compatibleToolBundles]),
    compatibleSkillIds: Object.freeze([...input.compatibleSkillIds]),
    objectiveClasses: Object.freeze([...input.objectiveClasses]),
    limits: Object.freeze({ ...input.limits }),
    writePolicy: Object.freeze({ ...input.writePolicy }),
  });
}

const STANDARD_LIMITS = { maxToolCalls: 8, maxIterations: 6, timeoutMs: 60_000, maxResultBytes: 128_000 } as const;

export const FOUNDATION_PROFILES: Readonly<Record<ExecutionProfileId, ExecutionProfileDefinition>> = Object.freeze({
  memory: profile({
    id: "memory", version: 1, responsibility: "Private user preferences backed by Boop Memory.",
    boundaries: ["No product data, authority, tenant-shared memory, automatic extraction or product writes."],
    compatibleToolBundles: ["boop-memory.user"], compatibleSkillIds: [],
    objectiveClasses: ["memory.remember", "memory.forget", "memory.recall"], limits: STANDARD_LIMITS,
    writePolicy: { enabled: true, maxRisk: "R1", requirePreconditions: true }, modelRoute: "cheap-read",
  }),
  crm: profile({
    id: "crm", version: 1, responsibility: "Leads, opportunities, tasks, notes, ownership and tags.",
    boundaries: ["No property, matching, visit or external communication writes."],
    compatibleToolBundles: ["crm.read", "crm.internal-write"],
    compatibleSkillIds: ["resolve-ambiguous-lead", "update-lead-safely"],
    objectiveClasses: ["lead.lookup", "lead.update", "opportunity.update", "task.manage"],
    limits: STANDARD_LIMITS,
    writePolicy: { enabled: true, maxRisk: "R2", requirePreconditions: true }, modelRoute: "balanced",
  }),
  "demand-matching": profile({
    id: "demand-matching", version: 1, responsibility: "Property demand criteria, matches, outcomes and price alerts.",
    boundaries: ["Never sends a match or mutates lead/property records."],
    compatibleToolBundles: ["demand.read", "demand.internal-write"],
    compatibleSkillIds: ["create-property-search", "inspect-demand-matches"],
    objectiveClasses: ["demand.lookup", "demand.create", "matching.inspect"], limits: STANDARD_LIMITS,
    writePolicy: { enabled: true, maxRisk: "R2", requirePreconditions: true }, modelRoute: "strong-reasoning",
  }),
  property: profile({
    id: "property", version: 1, responsibility: "Property inventory, search and allowlisted listing changes.",
    boundaries: ["No visits, binary media, complex legal settings or external sends."],
    compatibleToolBundles: ["property.read", "property.internal-write"],
    compatibleSkillIds: ["update-property-listing-safely"],
    objectiveClasses: ["property.lookup", "property.search", "property.update"], limits: STANDARD_LIMITS,
    writePolicy: { enabled: true, maxRisk: "R2", requirePreconditions: true }, modelRoute: "balanced",
  }),
  visits: profile({
    id: "visits", version: 1, responsibility: "Availability, routing and visit lifecycle.",
    boundaries: ["Never invents a slot and never sends a client message directly."],
    compatibleToolBundles: ["visits.read", "visits.internal-write"],
    compatibleSkillIds: ["prepare-property-visit", "reschedule-visit-safely", "prepare-visit-brief"],
    objectiveClasses: ["visit.lookup", "visit.availability", "visit.create", "visit.update", "visit.prepare_brief"], limits: STANDARD_LIMITS,
    writePolicy: { enabled: true, maxRisk: "R2", requirePreconditions: true }, modelRoute: "balanced",
  }),
  communications: profile({
    id: "communications", version: 1, responsibility: "Conversation context, channel windows, drafts and approved sends.",
    boundaries: ["External effects require a Signed Draft and deterministic commit."],
    compatibleToolBundles: ["communications.read", "communications.draft", "communications.commit"],
    compatibleSkillIds: ["draft-client-reply"], objectiveClasses: ["conversation.lookup", "message.draft", "message.send"],
    limits: STANDARD_LIMITS, writePolicy: { enabled: true, maxRisk: "R2", requirePreconditions: true }, modelRoute: "balanced",
  }),
  marketing: profile({
    id: "marketing", version: 1, responsibility: "Campaign and scheduled-content operations.",
    boundaries: ["No OAuth, binary uploads or unconfirmed publication."],
    compatibleToolBundles: ["marketing.read", "marketing.draft"], compatibleSkillIds: [],
    objectiveClasses: ["campaign.lookup", "post.lookup", "post.draft"], limits: STANDARD_LIMITS,
    writePolicy: { enabled: false, maxRisk: "R2", requirePreconditions: true }, modelRoute: "balanced",
  }),
  insights: profile({
    id: "insights", version: 1, responsibility: "Read-only operational summaries, KPIs and intelligence.",
    boundaries: ["Metrics never trigger mutations as a side effect."], compatibleToolBundles: ["insights.read"],
    compatibleSkillIds: [], objectiveClasses: ["summary.read", "analytics.read"], limits: STANDARD_LIMITS,
    writePolicy: { enabled: false, maxRisk: "R0", requirePreconditions: false }, modelRoute: "cheap-read",
  }),
  "workspace-admin": profile({
    id: "workspace-admin", version: 1, responsibility: "Allowlisted workspace, team and knowledge administration.",
    boundaries: ["No credentials, deploys, migrations or infrastructure commands."],
    compatibleToolBundles: ["workspace.read", "workspace.admin-draft"], compatibleSkillIds: [],
    objectiveClasses: ["workspace.lookup", "workspace.configure"], limits: STANDARD_LIMITS,
    writePolicy: { enabled: false, maxRisk: "R3", requirePreconditions: true }, modelRoute: "balanced",
  }),
});

export class ExecutionProfileRegistry {
  constructor(private readonly definitions = FOUNDATION_PROFILES) {}

  get(id: ExecutionProfileId): ExecutionProfileDefinition {
    const definition = this.definitions[id];
    if (!definition) throw new Error(`Unknown execution profile: ${id}`);
    return definition;
  }

  list(): readonly ExecutionProfileDefinition[] {
    return Object.freeze(Object.values(this.definitions));
  }
}
