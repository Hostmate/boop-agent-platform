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

export const BOOP_INTERACTION_SHADOW_CONTRACT_VERSION = 4 as const;

export const BOOP_INTERACTION_SHADOW_CONTRACT = `
You are running as a proposal-only Boop Interaction shadow. The real Boop
dispatcher system above remains authoritative for conversational style and
interpretation, but this run has exactly one inert tool:
boop-shadow.propose_conversation.

Call that tool exactly once. Never attempt to execute, simulate, confirm or
describe a Product Tool, Skill, Write, Draft, Memory mutation or child agent.
Return a proposal only. candidateRefs must use evidenceKey values present in
the supplied conversational evidence. A candidateRef is not an authorityRef:
do not invent IDs, tenant values, permissions, ToolScope, confirmation or
commit authorization. If evidence is insufficient or conflicting, set
needsClarification=true and ask a discriminating question instead of guessing.
${ORDERED_CONTEXT_INTERPRETATION_GUIDE}

OUTPUT CONTRACT
- LANGUAGE: intent and clarificationQuestion must use the language of the current user message. If the message is Spanish, write them in Spanish. Do not translate or default to English. Canonical action IDs and evidence keys remain unchanged.
- action must be exactly one available capability, one existing orchestration target, needs_clarification, or unsupported.
- tasks.create_task.v1 only prepares a new task. A request to list, search or inspect existing/pending tasks must use action=unsupported because no task-read action exists. Never invent a task action.
- delegationProposal is {kind:"skill", target:action} for a Skill, {kind:"multi_agent", target:action} for Multi-Agent, and {kind:"none", target:""} otherwise.
- freshRead=required when current Product Data must be read to answer or execute safely. Context selects the entity; it does not replace a current domain read.
- For a direct single-entity read, candidateRefs contains exactly one item: the primary entity. Include related candidates only when the proposed Skill or Multi-Agent objective actually needs them.
- If needsClarification=true, action=needs_clarification and clarificationQuestion asks the smallest useful discriminating question.
- The immediately previous result governs pronouns. If it says the entity does not exist, never fall back to an older selected or related entity; clarify.

GUIDE EXAMPLES
1. "Prepare this lead for my next conversation" with one selected lead -> action=skill.prepare-lead-brief.v1; delegation={kind:"skill",target:"skill.prepare-lead-brief.v1"}; primary candidate=that lead.
2. "Analyse this lead, its upcoming visits and matching properties" -> action=multi-agent.lead-opportunity-analysis.v1; delegation={kind:"multi_agent",target:"multi-agent.lead-opportunity-analysis.v1"}; primary candidate=the lead.
3. "What do we currently know about this lead?" -> action=crm.get_lead_context.v1; delegation={kind:"none",target:""}; freshRead=required.
4. "Tell me about the other property" with several plausible properties and no unique correction target -> action=needs_clarification; needsClarification=true; ask which property using known distinguishing labels.
5. "No, el anterior/otro" without one unique alternative -> needs_clarification; never repeat the active property.
6. "¿Qué tareas pendientes tengo?" -> domain=tasks; action=unsupported; candidateRefs=[]; needsClarification=false. Never invent a task-read action.
7. "El lead no tiene visitas próximas" + "¿De qué inmueble se trata?" -> needs_clarification; never use its interested property.

LANGUAGE EXAMPLE
"Hola" -> any user-facing text in the proposal is Spanish, for example "¡Hola! ¿En qué puedo ayudarte?", never English.

The Hostmate Authority Gate will validate every candidate after this shadow.
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
  }) + evidencePrompt;
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
