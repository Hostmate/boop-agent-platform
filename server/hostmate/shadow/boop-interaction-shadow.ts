import { createHash } from "node:crypto";
import { z } from "zod";
import {
  buildInteractionPrompt,
  type InteractionPromptMessage,
} from "../../interaction-prompt.js";
import { defineRuntimeTool } from "../../runtimes/tool.js";
import { runtimeText, type RuntimeRunRequest } from "../../runtimes/types.js";
import {
  OpenRouterAdapter,
  type OpenRouterReasoningEffort,
  type OpenRouterRuntimeResult,
} from "../runtime/openrouter-adapter.js";
import type { ActorContext } from "../contracts/actor-context.js";
import type { AgentMessageRecord } from "../control-plane/repository.js";
import {
  buildCanonicalConversationEvidence,
  type CanonicalConversationEvidence,
  type CanonicalEvidenceEntity,
} from "./canonical-conversation-evidence.js";
import {
  formatOrderedContextForLlm,
  formatEvidenceDetailsForLlm,
  ORDERED_CONTEXT_INTERPRETATION_GUIDE,
} from "./ordered-context-prompt.js";
import {
  HOSTMATE_INTERACTION_CAPABILITIES,
  HOSTMATE_INTERACTION_ORCHESTRATION_TARGETS,
  HOSTMATE_INTERACTION_SYSTEM,
} from "./hostmate-interaction-prompt.js";
import {
  expectedDelegationFor,
  interactionDefinition,
  type HostmateInteractionAction,
} from "../interaction/capability-catalog.js";

const READY_ACTIONS = [
  ...HOSTMATE_INTERACTION_CAPABILITIES,
  ...HOSTMATE_INTERACTION_ORCHESTRATION_TARGETS,
] as const;

const SHADOW_ACTIONS = [
  ...READY_ACTIONS,
  "needs_clarification",
  "unsupported",
] as const;

const decisionOutcomeSchema = z.enum(["ready", "needs_input", "unsupported"]);
const missingInputSchema = z.enum(["lead", "property", "datetime", "entity", "request"]);

const semanticCandidateShape = z.object({
  evidenceKey: z.string().trim().min(1),
  type: z.string().trim().min(1),
}).strict();

const visitDraftShape = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  temporalPhrase: z.string().trim().min(1).max(160),
}).strict();

const decisionVisitDraftShape = z.object({
  startDate: z.string().trim().max(10).nullable(),
  startTime: z.string().trim().max(8).nullable(),
  temporalPhrase: z.string().trim().max(160),
}).strict();

const targetSearchShape = z.object({
  leadQuery: z.string().trim().min(2).max(120)
    .describe("Named Lead search text. Null only when a Lead candidate already exists or the chosen action does not require a Lead.")
    .nullable(),
  propertyQuery: z.string().trim().min(2).max(120)
    .describe("Named Property search text. Null only when a Property candidate already exists or the chosen action does not require a Property.")
    .nullable(),
}).strict();

const decisionTargetSearchShape = z.object({
  leadQuery: z.string().trim().max(120).nullable(),
  propertyQuery: z.string().trim().max(120).nullable(),
}).strict();

function isExactVisitDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function canonicalVisitTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return value;
  if (/^(?:[01]\d|2[0-3]):[0-5]\d:00$/.test(value)) return value.slice(0, 5);
  return null;
}

function isUsableTargetQuery(value: unknown): value is string {
  return typeof value === "string" && value.trim().length >= 2;
}

function hasUsableTargetSearch(value: z.infer<typeof decisionTargetSearchShape> | null): boolean {
  return isUsableTargetQuery(value?.leadQuery) || isUsableTargetQuery(value?.propertyQuery);
}

function hasVisitDraftContent(value: z.infer<typeof decisionVisitDraftShape> | null): boolean {
  if (!value) return false;
  return !isEmptyWireText(value.startDate)
    || !isEmptyWireText(value.startTime)
    || !isEmptyWireText(value.temporalPhrase);
}

function isEmptyWireText(value: string | null): boolean {
  return value === null || value === "" || value.toLowerCase() === "null";
}

/**
 * Minimal semantic decision requested from the Interaction LLM.
 *
 * Catalog metadata (domain, delegation and fresh-read policy) is deliberately
 * absent: it is derived from the selected action. Search hints also have one
 * representation, avoiding the former visit/property duplicate fields.
 */
export const conversationDecisionShape = {
  intent: z.string().trim().min(1),
  outcome: decisionOutcomeSchema.describe("The single readiness decision: ready, needs_input, or unsupported."),
  action: z.enum(READY_ACTIONS)
    .describe("One available capability only when outcome is ready; otherwise null.")
    .nullable(),
  candidateRefs: z.array(semanticCandidateShape),
  missingInputs: z.array(missingInputSchema)
    .max(3)
    .describe("Required information still missing. Empty only when outcome is ready or unsupported."),
  clarificationQuestion: z.string().trim().max(500)
    .describe("One contextual question for needs_input. Empty or null for ready and unsupported.")
    .nullable(),
  targetSearch: decisionTargetSearchShape
    .describe("Search hints for unresolved named targets. Null never means that a required target may be silently omitted.")
    .nullable(),
  visitDraft: decisionVisitDraftShape
    .describe("Exact known Visit date and time. Required for a ready Create Visit; may preserve known time during needs_input and is null when unknown or irrelevant.")
    .nullable(),
} satisfies z.ZodRawShape;

export const conversationDecisionSchema = z.object(conversationDecisionShape).strict().superRefine((value, context) => {
  if (value.outcome === "ready") {
    if (!value.action) context.addIssue({ code: z.ZodIssueCode.custom, path: ["action"], message: "A ready decision requires one action" });
    if (value.missingInputs.length > 0) context.addIssue({ code: z.ZodIssueCode.custom, path: ["missingInputs"], message: "A ready decision cannot have missing inputs" });
    if (!isEmptyWireText(value.clarificationQuestion)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["clarificationQuestion"], message: "A ready decision cannot ask a clarification question" });
  } else if (value.outcome === "needs_input") {
    if (value.action !== null) context.addIssue({ code: z.ZodIssueCode.custom, path: ["action"], message: "A needs_input decision cannot select an action yet" });
    if (value.missingInputs.length === 0) context.addIssue({ code: z.ZodIssueCode.custom, path: ["missingInputs"], message: "A needs_input decision must identify what is missing" });
    if (isEmptyWireText(value.clarificationQuestion)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["clarificationQuestion"], message: "A needs_input decision requires one clarification question" });
  } else {
    if (value.action !== null) context.addIssue({ code: z.ZodIssueCode.custom, path: ["action"], message: "An unsupported decision cannot select an action" });
    if (value.missingInputs.length > 0) context.addIssue({ code: z.ZodIssueCode.custom, path: ["missingInputs"], message: "An unsupported decision does not request missing input" });
    if (!isEmptyWireText(value.clarificationQuestion)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["clarificationQuestion"], message: "An unsupported decision cannot ask a clarification question" });
    if (hasUsableTargetSearch(value.targetSearch)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["targetSearch"], message: "An unsupported decision cannot start a target search" });
    if (hasVisitDraftContent(value.visitDraft)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["visitDraft"], message: "An unsupported decision cannot prepare a Visit Draft" });
  }

  if (value.outcome !== "ready" || !value.action) return;
  if (value.action === "visits.create_visit.v1") {
    const leadCount = value.candidateRefs.filter((candidate) => candidate.type === "crm.lead").length;
    const propertyCount = value.candidateRefs.filter((candidate) => candidate.type === "property.property").length;
    if (!value.visitDraft
      || !isExactVisitDate(value.visitDraft.startDate)
      || !canonicalVisitTime(value.visitDraft.startTime)
      || isEmptyWireText(value.visitDraft.temporalPhrase)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["visitDraft"], message: "A ready Create Visit requires an exact date and time" });
    }
    if (leadCount > 1 || propertyCount > 1) context.addIssue({ code: z.ZodIssueCode.custom, path: ["candidateRefs"], message: "A ready Create Visit accepts at most one Lead and one Property" });
    if (leadCount !== 1 && !isUsableTargetQuery(value.targetSearch?.leadQuery)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["targetSearch", "leadQuery"], message: "A ready Create Visit requires one known Lead or a Lead search query" });
    if (propertyCount !== 1 && !isUsableTargetQuery(value.targetSearch?.propertyQuery)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["targetSearch", "propertyQuery"], message: "A ready Create Visit requires one known Property or a Property search query" });
    return;
  }
  if (hasVisitDraftContent(value.visitDraft)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["visitDraft"], message: "visitDraft is only valid for Create Visit" });
  if (value.action === "property.search_properties.v1") {
    if (value.targetSearch?.leadQuery) context.addIssue({ code: z.ZodIssueCode.custom, path: ["targetSearch", "leadQuery"], message: "Property search cannot contain a Lead query" });
  } else if (hasUsableTargetSearch(value.targetSearch)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["targetSearch"], message: "targetSearch is only valid for Create Visit or Property search" });
  }
});
export type ConversationDecision = z.infer<typeof conversationDecisionSchema>;

export const conversationProposalShape = {
  // The shadow records the model's interpretation verbatim. Do not make a
  // verbose but otherwise valid proposal fail merely because the harness
  // imposed the old short-label limit.
  intent: z.string().trim().min(1),
  domain: z.enum(["crm", "property", "visits", "tasks", "memory", "unknown"]),
  action: z.enum(SHADOW_ACTIONS),
  candidateRefs: z.array(semanticCandidateShape),
  needsClarification: z.boolean(),
  clarificationQuestion: z.string().trim(),
  delegationProposal: z.object({
    kind: z.enum(["none", "skill", "multi_agent"]),
    target: z.string().trim(),
  }).strict(),
  freshRead: z.enum(["required", "not_required"]),
  visitDraft: visitDraftShape.nullable().default(null),
  visitTargetSearch: targetSearchShape.nullable().default(null),
  propertyTargetSearch: z.object({
    query: z.string().trim().min(2).max(120),
  }).strict().nullable().default(null),
} satisfies z.ZodRawShape;

export const conversationProposalSchema = z.object(conversationProposalShape).strict().superRefine((value, context) => {
  if (value.needsClarification && !value.clarificationQuestion.trim()) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["clarificationQuestion"], message: "A clarification question is required when needsClarification is true" });
  }
  if (!value.needsClarification && value.clarificationQuestion.trim()) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["clarificationQuestion"], message: "clarificationQuestion must be empty when no clarification is needed" });
  }
  if (value.delegationProposal.kind !== "none" && !value.delegationProposal.target.trim()) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["delegationProposal", "target"], message: "A delegation target is required when delegation kind is not none" });
  }
  if (value.delegationProposal.kind === "none" && value.delegationProposal.target.trim()) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["delegationProposal", "target"], message: "delegation target must be empty when delegation kind is none" });
  }
  if (value.delegationProposal.kind === "skill" && !value.action.startsWith("skill.")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["action"], message: "Skill delegation requires a skill action" });
  }
  if (value.delegationProposal.kind === "multi_agent" && !value.action.startsWith("multi-agent.")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["action"], message: "Multi-Agent delegation requires a multi-agent action" });
  }
  if (value.action !== "needs_clarification" && value.action !== "unsupported") {
    const action = value.action as HostmateInteractionAction;
    const definition = interactionDefinition(action);
    const expected = expectedDelegationFor(action);
    if (value.domain !== definition.domain) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["domain"], message: "Action domain must match the canonical Interaction catalog" });
    }
    if (value.delegationProposal.kind !== expected.kind || value.delegationProposal.target !== expected.target) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["delegationProposal"], message: "Delegation must match the canonical Interaction catalog" });
    }
  }
  if (value.action === "visits.create_visit.v1") {
    const leadCount = value.candidateRefs.filter((candidate) => candidate.type === "crm.lead").length;
    const propertyCount = value.candidateRefs.filter((candidate) => candidate.type === "property.property").length;
    if (!value.visitDraft) context.addIssue({ code: z.ZodIssueCode.custom, path: ["visitDraft"], message: "Create Visit requires an exact date and time" });
    if (leadCount > 1 || propertyCount > 1) context.addIssue({ code: z.ZodIssueCode.custom, path: ["candidateRefs"], message: "Create Visit accepts at most one known lead and one known property candidate" });
    if (leadCount !== 1 && !value.visitTargetSearch?.leadQuery) context.addIssue({ code: z.ZodIssueCode.custom, path: ["visitTargetSearch", "leadQuery"], message: "Create Visit requires one known lead or a lead search query" });
    if (propertyCount !== 1 && !value.visitTargetSearch?.propertyQuery) context.addIssue({ code: z.ZodIssueCode.custom, path: ["visitTargetSearch", "propertyQuery"], message: "Create Visit requires one known property or a property search query" });
  } else if (value.visitDraft !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["visitDraft"], message: "visitDraft is only valid for Create Visit" });
  } else if (value.visitTargetSearch !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["visitTargetSearch"], message: "visitTargetSearch is only valid for Create Visit" });
  }
  if (value.action === "property.search_properties.v1") {
    if (value.propertyTargetSearch && value.candidateRefs.some((candidate) => candidate.type === "property.property")) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["propertyTargetSearch"], message: "A concrete Property lookup must use either known evidence or a target search, never both" });
    }
  } else if (value.propertyTargetSearch !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["propertyTargetSearch"], message: "propertyTargetSearch is only valid for Property search" });
  }
});
export type ConversationProposal = z.infer<typeof conversationProposalSchema>;

export function enrichConversationProposal(decision: ConversationDecision): ConversationProposal {
  const proposalAction = decision.outcome === "ready"
    ? decision.action as HostmateInteractionAction
    : decision.outcome === "needs_input" ? "needs_clarification" : "unsupported";
  const action = decision.outcome === "ready" ? proposalAction as HostmateInteractionAction : null;
  const domain = action ? interactionDefinition(action).domain : "unknown";
  const delegationProposal = action ? expectedDelegationFor(action) : { kind: "none" as const, target: "" as const };
  const readyTargetSearch = decision.outcome === "ready" && hasUsableTargetSearch(decision.targetSearch)
    ? {
        leadQuery: isUsableTargetQuery(decision.targetSearch?.leadQuery) ? decision.targetSearch.leadQuery : null,
        propertyQuery: isUsableTargetQuery(decision.targetSearch?.propertyQuery) ? decision.targetSearch.propertyQuery : null,
      }
    : null;
  const readyVisitDraft = action === "visits.create_visit.v1"
    && decision.visitDraft
    && isExactVisitDate(decision.visitDraft.startDate)
    && canonicalVisitTime(decision.visitDraft.startTime)
    ? {
        startDate: decision.visitDraft.startDate,
        startTime: canonicalVisitTime(decision.visitDraft.startTime),
        temporalPhrase: decision.visitDraft.temporalPhrase,
      }
    : null;

  return conversationProposalSchema.parse({
    intent: decision.intent,
    domain,
    action: proposalAction,
    candidateRefs: decision.candidateRefs,
    needsClarification: decision.outcome === "needs_input",
    clarificationQuestion: decision.outcome === "needs_input" && !isEmptyWireText(decision.clarificationQuestion)
      ? decision.clarificationQuestion
      : "",
    delegationProposal,
    freshRead: action ? "required" : "not_required",
    visitDraft: readyVisitDraft,
    visitTargetSearch: action === "visits.create_visit.v1" ? readyTargetSearch : null,
    propertyTargetSearch: action === "property.search_properties.v1" && readyTargetSearch?.propertyQuery
      ? { query: readyTargetSearch.propertyQuery }
      : null,
  });
}

export type ShadowEvidenceItem = CanonicalEvidenceEntity;

export type ConversationEvidence = Readonly<{
  currentSelection: Readonly<Record<string, ShadowEvidenceItem>>;
  referencedEntities: readonly ShadowEvidenceItem[];
  recentResultEvidence: readonly Readonly<{
    type: string;
    summary: string;
    entityKeys: readonly string[];
    block?: Readonly<Record<string, unknown>>;
  }>[];
  conversationHistory: readonly Readonly<{ role: string; content: string }>[];
  emittedEntityRefs: readonly ShadowEvidenceItem[];
  candidateRefs: readonly ShadowEvidenceItem[];
  captureStatus: Readonly<{
    referenced: "captured" | "not_captured";
    blocks: "captured" | "not_captured";
    prompt: "captured" | "not_captured";
  }>;
  knownRelations?: CanonicalConversationEvidence["knownRelations"];
  orderedContext?: CanonicalConversationEvidence["orderedContext"];
  entityIndex?: CanonicalConversationEvidence["entityIndex"];
  captureMetrics?: CanonicalConversationEvidence["captureMetrics"];
}>;

export type ShadowEvidence = ConversationEvidence;

export type BoopInteractionShadowInput = Readonly<{
  conversationId: string;
  turn: number;
  currentMessage: string;
  history: readonly InteractionPromptMessage[];
  evidence: ShadowEvidence;
}>;

export type BoopInteractionShadowConfig = Readonly<{
  apiKey: string;
  model: string;
  reasoningEffort?: OpenRouterReasoningEffort;
  fallbackModels?: readonly string[];
  timeoutMs?: number;
  maxCostUsd?: number;
  temperature?: number;
  adapter?: OpenRouterAdapter;
  onToolUse?: (toolName: string, args: unknown) => void | Promise<void>;
}>;

export type ShadowCandidateValidation = Readonly<{
  proposedCandidateKeys: readonly string[];
  validatedCandidateKeys: readonly string[];
  unauthorizedCandidateKeys: readonly string[];
  invalidCandidateKeys: readonly string[];
  typeMismatchCandidateKeys: readonly string[];
  authorityRefIssued: false;
}>;

export type ShadowPromptMeasurements = Readonly<{
  systemChars: number;
  contractChars: number;
  promptChars: number;
  historyChars: number;
  evidenceChars: number;
  historyMessages: number;
  historyWindow: number;
  approximateInputTokens: number;
  method: "utf8_bytes_div_4";
}>;

export type BoopInteractionShadowResult = Readonly<{
  conversationId: string;
  turn: number;
  promptHash: string;
  historyTurnsSupplied: number;
  proposal: ConversationProposal | null;
  proposalStatus: "captured" | "no_proposal" | "runtime_error";
  validation: ShadowCandidateValidation;
  promptMeasurements: ShadowPromptMeasurements;
  runtime: "openrouter";
  usage: OpenRouterRuntimeResult["usage"];
  detailedUsage: OpenRouterRuntimeResult["detailedUsage"] | null;
  latencyMs: number;
  error?: Readonly<{ code: string; message: string }>;
}>;

export const BOOP_INTERACTION_SHADOW_CONTRACT_VERSION = 11 as const;

export const BOOP_INTERACTION_SHADOW_CONTRACT = `
You are a proposal-only Boop Interaction shadow. Call the inert
boop-shadow.propose_conversation tool once. Never execute, simulate or confirm
Tools, Skills, Writes, Drafts, Memory or child agents.

candidateRefs use only supplied evidenceKey values. They are evidence, never
authority: do not invent IDs, tenant, permissions, ToolScope or confirmation.
When evidence is insufficient or conflicting, clarify instead of guessing.
${ORDERED_CONTEXT_INTERPRETATION_GUIDE}

OUTPUT CONTRACT
- Preserve the current user's language in intent and clarificationQuestion. If the message is Spanish, write them in Spanish; never English.
- outcome is the single readiness switch: ready has one action and no missing input; needs_input has action=null, names what is missing and asks one contextual question; unsupported has action=null and no missing input.
- For ready or unsupported, clarificationQuestion is null or ""; never write the text "null".
- needs_input may preserve known fields; unknowns are null and never invented. Time is HH:mm; HH:mm:00 is accepted only with zero seconds.
- A task read is unsupported because no task-read action exists; tasks.create_task.v1 only prepares a new task.
- Return only semantic choices. Hostmate derives domain, delegation and fresh-read policy from action; do not output those catalog fields.
- A direct single-entity read uses exactly one item: the primary entity.
- targetSearch carries unresolved named targets. Null means that role is known in candidateRefs or irrelevant; it never hides a missing required target.
- A ready Create Visit requires one Lead candidate/search, one Property candidate/search and exact Europe/Madrid date+time. If any is absent, use needs_input; never infer it. A named person is the Lead, not the authenticated commercial.
- Property discovery ("busca pisos con terraza") uses property.search_properties.v1 with targetSearch=null. Concrete identification without evidence ("cuánto cuesta el piso de Bonavista") uses the same action plus targetSearch={leadQuery:null,propertyQuery:"Bonavista"}.
- A Property already present in evidence uses property.get_property.v1 with its candidate. For ordinals, never launch a new search to manufacture context.
- A descriptive Property clue selects known evidence only when exactly one candidate matches. If several share it, clarify. Order applies only to ordinals; active focus only to "este"/"ese".
- "otro" never means "anterior": select only when exactly one alternative of the required type exists. With two or more alternatives, clarify; never repeat the active property.
- In needs_input, ask the smallest question and restate known Lead, Property and time. Never fall back past an explicit no-result.

GUIDE EXAMPLES
1. Selected lead + "Prepare this lead" -> skill.prepare-lead-brief.v1.
2. Lead + coordinated lead/visits/properties analysis -> multi-agent.lead-opportunity-analysis.v1.
3. No relevant list + "Enséñame el segundo inmueble" -> outcome=needs_input, action=null, missingInputs=["entity"]; never run an unfiltered search.
4. "¿Qué tareas pendientes tengo?" -> outcome=unsupported, action=null.
5. Known Lead+Property + "Agenda una visita mañana a las 17:00" -> ready Create Visit with both candidates and exact visitDraft.
6. "Agenda una visita mañana a las 10:00 para el piso de Loreto con Cliente Ejemplo" -> ready Create Visit; targetSearch has both queries and Cliente Ejemplo is the Lead.
7. Missing exact hour, Property or Lead -> needs_input, action=null, missingInputs=["datetime"], ["property"] or ["lead"]; restate known details.
8. No Property evidence + "¿Cuánto costaba el piso de Bonavista?" -> ready Property search with propertyQuery="Bonavista".
9. After "Busca el de Girona" + "No he encontrado ningún inmueble", "¿Y ese piso?" -> needs_input; never reuse an older selected Property.
`;

const OPAQUE_EVIDENCE_KEY = /^e[1-9][0-9]*$/;
const RESERVED_EVIDENCE_KEYS = new Set(["selected", "referenced", "history"]);

function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

function promptEvidence(evidence: ShadowEvidence): string {
  return [
    "\n\n",
    formatOrderedContextForLlm({ currentSelection: evidence.currentSelection, orderedContext: evidence.orderedContext }),
    "\n\n",
    formatEvidenceDetailsForLlm({
      referencedEntities: evidence.referencedEntities,
      recentResultEvidence: evidence.recentResultEvidence,
      candidateRefs: evidence.candidateRefs,
      knownRelations: evidence.knownRelations,
    }),
  ].join("\n");
}

function isOpaqueEvidenceKey(key: string): boolean {
  return OPAQUE_EVIDENCE_KEY.test(key) && !RESERVED_EVIDENCE_KEYS.has(key);
}

function validateCandidates(
  proposal: ConversationProposal | null,
  evidence: ShadowEvidence,
): ShadowCandidateValidation {
  const candidates = new Map<string, ShadowEvidenceItem>();
  for (const item of evidence.candidateRefs) candidates.set(item.evidenceKey, item);
  for (const item of Object.values(evidence.currentSelection)) candidates.set(item.evidenceKey, item);
  for (const item of evidence.referencedEntities) candidates.set(item.evidenceKey, item);
  for (const item of evidence.emittedEntityRefs) candidates.set(item.evidenceKey, item);

  const proposedCandidateKeys = proposal?.candidateRefs.map((ref) => ref.evidenceKey) ?? [];
  const invalidCandidateKeys = proposedCandidateKeys.filter((key) => !isOpaqueEvidenceKey(key));
  const unauthorizedCandidateKeys = proposedCandidateKeys.filter((key) => !isOpaqueEvidenceKey(key) || !candidates.has(key));
  const typeMismatchCandidateKeys = proposedCandidateKeys.filter((key, index) => {
    const item = candidates.get(key);
    const ref = proposal?.candidateRefs[index];
    return Boolean(item && ref && item.type !== ref.type);
  });
  const validatedCandidateKeys = proposedCandidateKeys.filter(
    (key) => isOpaqueEvidenceKey(key) && candidates.has(key) && !typeMismatchCandidateKeys.includes(key),
  );
  return {
    proposedCandidateKeys,
    validatedCandidateKeys,
    unauthorizedCandidateKeys,
    invalidCandidateKeys,
    typeMismatchCandidateKeys,
    authorityRefIssued: false,
  };
}

function proposalTool(onProposal: (proposal: ConversationProposal) => void) {
  return defineRuntimeTool(
    "boop-shadow",
    "propose_conversation",
    "Record one proposal-only conversational interpretation for a shadow comparison. This tool has no side effects.",
    conversationDecisionShape,
    async (args) => {
      const decision = conversationDecisionSchema.parse(args);
      const proposal = enrichConversationProposal(decision);
      onProposal(proposal);
      return runtimeText("Proposal recorded. No tools, writes, drafts or agents were executed.");
    },
  );
}

export async function runBoopInteractionShadow(
  input: BoopInteractionShadowInput,
  config: BoopInteractionShadowConfig,
): Promise<BoopInteractionShadowResult> {
  const history = input.history.slice(-10);
  const evidencePrompt = promptEvidence(input.evidence);
  const prompt = buildInteractionPrompt({
    history,
    currentMessage: input.currentMessage,
  }) + `\n\nCURRENT TIME (authoritative only for interpreting relative dates): ${new Date().toLocaleString("sv-SE", { timeZone: "Europe/Madrid" })} Europe/Madrid` + evidencePrompt;
  const promptHash = hashPrompt(prompt);
  const systemPrompt = `${HOSTMATE_INTERACTION_SYSTEM}\n${BOOP_INTERACTION_SHADOW_CONTRACT}`;
  const encoder = new TextEncoder();
  const utf8Bytes = (value: string) => encoder.encode(value).byteLength;
  const promptMeasurements: ShadowPromptMeasurements = {
    systemChars: utf8Bytes(HOSTMATE_INTERACTION_SYSTEM),
    contractChars: utf8Bytes(BOOP_INTERACTION_SHADOW_CONTRACT),
    promptChars: utf8Bytes(prompt),
    historyChars: utf8Bytes(history.map((message) => `${message.role}:${message.content}`).join("\n")),
    evidenceChars: utf8Bytes(evidencePrompt),
    historyMessages: history.length,
    historyWindow: 10,
    approximateInputTokens: Math.ceil(utf8Bytes(systemPrompt + prompt) / 4),
    method: "utf8_bytes_div_4",
  };
  let proposal: ConversationProposal | null = null;
  const tool = proposalTool((value) => { proposal = value; });
  const adapter = config.adapter ?? new OpenRouterAdapter({
    apiKey: config.apiKey,
    appName: "Hostmate Boop Pareto Interaction Shadow",
    maxTransportRetries: 0,
  });
  const request: RuntimeRunRequest = {
    prompt,
    systemPrompt,
    model: config.model,
    tools: [tool],
    allowedTools: ["boop-shadow.propose_conversation"],
    disallowedTools: ["WebSearch", "WebFetch", "Bash", "Read", "Write", "Edit", "Glob", "Grep", "Agent", "Skill"],
    mode: "dispatcher",
    onToolUse: config.onToolUse,
  };
  try {
    const runtime = await adapter.run(request, {
      budget: {
        timeoutMs: config.timeoutMs ?? 180_000,
        maxToolRounds: 0,
        ...(config.maxCostUsd !== undefined ? { maxCostUsd: config.maxCostUsd } : {}),
      },
      fallbackModels: config.fallbackModels,
      reasoningEffort: config.reasoningEffort,
      temperature: config.temperature ?? 0,
      toolChoice: "required",
      stopAfterToolResult: true,
      metadata: { run_kind: "boop_interaction_pareto_shadow", turn: input.turn },
    });
    return {
      conversationId: input.conversationId,
      turn: input.turn,
      promptHash,
      historyTurnsSupplied: Math.min(input.history.length, 10),
      proposal,
      proposalStatus: proposal ? "captured" : "no_proposal",
      validation: validateCandidates(proposal, input.evidence),
      promptMeasurements,
      runtime: "openrouter",
      usage: runtime.usage,
      detailedUsage: runtime.detailedUsage,
      latencyMs: runtime.latencyMs,
    };
  } catch (error) {
    const candidate = error as { code?: unknown; message?: unknown };
    return {
      conversationId: input.conversationId,
      turn: input.turn,
      promptHash,
      historyTurnsSupplied: Math.min(input.history.length, 10),
      proposal,
      proposalStatus: "runtime_error",
      validation: validateCandidates(proposal, input.evidence),
      promptMeasurements,
      runtime: "openrouter",
      usage: { model: config.model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 },
      detailedUsage: null,
      latencyMs: 0,
      error: {
        code: typeof candidate.code === "string" ? candidate.code : "UNKNOWN",
        message: typeof candidate.message === "string" ? candidate.message.slice(0, 240) : "Shadow runtime failed",
      },
    };
  }
}

/**
 * Preferred shadow entry point. Evidence is derived only from actor-scoped
 * Control Plane messages; callers cannot inject candidates from ground truth.
 * `messages` contains prior turns because `currentMessage` is supplied
 * separately to the Interaction prompt.
 */
export async function runBoopInteractionShadowFromMessages(
  input: Readonly<{
    actor: Pick<ActorContext, "tenantId" | "userId">;
    conversationId: string;
    turn: number;
    currentMessage: string;
    messages: readonly AgentMessageRecord[];
  }>,
  config: BoopInteractionShadowConfig,
): Promise<BoopInteractionShadowResult> {
  const evidence = buildCanonicalConversationEvidence({
    actor: input.actor,
    conversationId: input.conversationId,
    messages: input.messages,
    historyWindow: 10,
    resultWindow: 10,
  });
  return runBoopInteractionShadow({
    conversationId: input.conversationId,
    turn: input.turn,
    currentMessage: input.currentMessage,
    history: evidence.conversationHistory,
    evidence,
  }, config);
}
