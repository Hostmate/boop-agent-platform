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

const SHADOW_ACTIONS = [
  ...HOSTMATE_INTERACTION_CAPABILITIES,
  ...HOSTMATE_INTERACTION_ORCHESTRATION_TARGETS,
  "needs_clarification",
  "unsupported",
] as const;

export const conversationProposalShape = {
  // The shadow records the model's interpretation verbatim. Do not make a
  // verbose but otherwise valid proposal fail merely because the harness
  // imposed the old short-label limit.
  intent: z.string().trim().min(1),
  domain: z.enum(["crm", "property", "visits", "tasks", "memory", "unknown"]),
  action: z.enum(SHADOW_ACTIONS),
  candidateRefs: z.array(z.object({
    evidenceKey: z.string().trim().min(1),
    type: z.string().trim().min(1),
  }).strict()),
  needsClarification: z.boolean(),
  clarificationQuestion: z.string().trim(),
  delegationProposal: z.object({
    kind: z.enum(["none", "skill", "multi_agent"]),
    target: z.string().trim(),
  }).strict(),
  freshRead: z.enum(["required", "not_required"]),
  visitDraft: z.object({
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    startTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    temporalPhrase: z.string().trim().min(1).max(160),
  }).strict().nullable().default(null),
  visitTargetSearch: z.object({
    leadQuery: z.string().trim().min(2).max(120).nullable(),
    propertyQuery: z.string().trim().min(2).max(120).nullable(),
  }).strict().nullable().default(null),
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

export const BOOP_INTERACTION_SHADOW_CONTRACT_VERSION = 9 as const;

export const BOOP_INTERACTION_SHADOW_CONTRACT = `
You are a proposal-only Boop Interaction shadow. Call the inert
boop-shadow.propose_conversation tool exactly once. Do not execute, simulate,
confirm or describe Tools, Skills, Writes, Drafts, Memory or child agents.

candidateRefs may only use supplied evidenceKey values. They are evidence, not
authority: never invent IDs, tenant, permissions, ToolScope or confirmation.
When evidence is insufficient or conflicting, clarify instead of guessing.
${ORDERED_CONTEXT_INTERPRETATION_GUIDE}

OUTPUT CONTRACT
- Preserve the current user's language in intent and clarificationQuestion. If the message is Spanish, write them in Spanish; never English.
- action is one available capability/orchestration target, needs_clarification or unsupported.
- A task read is unsupported because no task-read action exists; tasks.create_task.v1 only prepares a new task.
- delegationProposal uses kind=skill for a Skill, multi_agent for Multi-Agent, otherwise none. target equals action except for none, whose target is empty.
- freshRead=required for current Product Data. Context selects an entity but never replaces the read.
- A direct single-entity read uses exactly one item: the primary entity.
- visitDraft and visitTargetSearch exist only for visits.create_visit.v1. Require exact Europe/Madrid date+time; never infer a missing hour. A named person is the Lead, while the commercial is the authenticated actor.
- Property discovery ("busca pisos con terraza") uses property.search_properties.v1 with propertyTargetSearch=null. Concrete identification without evidence ("cuánto cuesta el piso de Bonavista") uses the same action plus propertyTargetSearch={query:"Bonavista"}.
- A Property already present in evidence uses property.get_property.v1 with its candidate. For ordinals, never launch a new search to manufacture context.
- A descriptive Property clue selects known evidence only when exactly one candidate matches. If several share it, clarify. Candidate order applies only to explicit ordinals; active focus only to "este"/"ese".
- "otro" never means "anterior": select only when exactly one alternative of the required type exists. With two or more alternatives, clarify; never repeat the active property.
- If needsClarification=true, action=needs_clarification and ask the smallest discriminating question. The latest result governs pronouns; never fall back past an explicit no-result.

GUIDE EXAMPLES
1. Selected lead + "Prepare this lead" -> skill.prepare-lead-brief.v1.
2. Lead + coordinated lead/visits/properties analysis -> multi-agent.lead-opportunity-analysis.v1.
3. No relevant list + "Enséñame el segundo inmueble" -> needs_clarification; never run an unfiltered search.
4. Three known Properties A/B/C with C active + "No, el otro piso" -> needs_clarification because two alternatives remain. Select only when there is exactly one alternative.
5. Older selected Property A + latest result "No he encontrado ningún inmueble en Girona" + "¿Y ese piso?" -> needs_clarification; never fall back to A.
6. "¿Qué tareas pendientes tengo?" -> domain=tasks; action=unsupported.
7. Known Lead+Property + "Agenda una visita mañana a las 17:00" -> visits.create_visit.v1 with both candidates and exact visitDraft.
8. No known targets + "Agenda una visita mañana a las 10:00 para el piso en calle de Loreto con Roger Closas" -> visitTargetSearch for both targets; Roger Closas is the lead.
9. "Agenda una visita mañana por la tarde" -> needs_clarification.
10. No Property evidence + "¿Cuánto costaba el piso de Bonavista?" -> property.search_properties.v1 with propertyTargetSearch={query:"Bonavista"}.
11. Two known Comte d'Urgell Properties + "el piso de Comte d'Urgell" -> needs_clarification; never pick the first.
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
    conversationProposalShape,
    async (args) => {
      const proposal = conversationProposalSchema.parse(args);
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
