import type { ConversationProposal, ShadowEvidence } from "./boop-interaction-shadow.js";

export type PreviousReadContext = Readonly<{
  action: string;
  effectiveInput: Readonly<Record<string, unknown>>;
}>;

export type InteractionExecutionBrief = Readonly<{
  objective: string;
  domain: ConversationProposal["domain"];
  action: ConversationProposal["action"];
  candidateRefs: readonly ConversationProposal["candidateRefs"][number][];
  currentMessage: string;
  conversationHistory: readonly Readonly<{ role: string; content: string }>[];
  currentSelection: ShadowEvidence["currentSelection"];
  recentResultEvidence: ShadowEvidence["recentResultEvidence"];
  orderedContext: ShadowEvidence["orderedContext"];
  previousRead: PreviousReadContext | null;
}>;

/**
 * Carries Interaction's decision and the factual conversation evidence to an
 * existing Execution Agent. It deliberately does not resolve pronouns,
 * ordinals or filters in backend code: those remain LLM responsibilities.
 */
export function buildInteractionExecutionBrief(input: Readonly<{
  proposal: ConversationProposal;
  currentMessage: string;
  evidence: ShadowEvidence;
  previousRead?: PreviousReadContext | null;
}>): InteractionExecutionBrief {
  return Object.freeze({
    objective: input.proposal.intent,
    domain: input.proposal.domain,
    action: input.proposal.action,
    candidateRefs: Object.freeze([...input.proposal.candidateRefs]),
    currentMessage: input.currentMessage,
    conversationHistory: Object.freeze([...input.evidence.conversationHistory]),
    currentSelection: input.evidence.currentSelection,
    recentResultEvidence: Object.freeze([...input.evidence.recentResultEvidence]),
    orderedContext: input.evidence.orderedContext,
    previousRead: input.previousRead ?? null,
  });
}

export function formatInteractionExecutionBrief(brief: InteractionExecutionBrief): string {
  return [
    "INTERACTION EXECUTION BRIEF",
    "The Interaction Agent already selected the scoped capability. Use the conversation evidence to interpret the current request; do not route again.",
    "The current message may refine or verify the previous read. Preserve compatible earlier criteria unless the user explicitly replaces or clears them.",
    "Do not inherit criteria from another domain or an unrelated older request. Never invent tenant, IDs, filters or authority.",
    JSON.stringify(brief),
  ].join("\n");
}
