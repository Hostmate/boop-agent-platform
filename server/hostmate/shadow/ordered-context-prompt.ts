export type PromptEvidenceEntity = Readonly<{
  evidenceKey: string;
  type: string;
  label?: string;
}>;

export type PromptOrderedContext = Readonly<{
  recentResultSets: readonly Readonly<{
    recency: number;
    type: "entity_list";
    sequence: number;
    items: readonly Readonly<{
      position: number;
      evidenceKey: string;
      type: string;
      label?: string;
    }>[];
  }>[];
  recentFocusedEntities: readonly Readonly<{
    recency: number;
    evidenceKey: string;
    type: string;
    label?: string;
  }>[];
}>;

function entityLine(item: PromptEvidenceEntity): string {
  return `${item.evidenceKey} | ${item.type}${item.label ? ` | ${item.label}` : ""}`;
}

/**
 * Presents factual UI chronology to the LLM. It deliberately does not resolve
 * any user phrase or choose a candidate.
 */
export function formatOrderedContextForLlm(input: Readonly<{
  currentSelection: Readonly<Record<string, PromptEvidenceEntity>>;
  orderedContext?: PromptOrderedContext;
}>): string {
  const ordered = input.orderedContext ?? { recentResultSets: [], recentFocusedEntities: [] };
  const selectedKeys = new Set(Object.values(input.currentSelection).map((item) => item.evidenceKey));
  const activeFocusKey = ordered.recentFocusedEntities[0]?.evidenceKey;
  const lines = [
    "CONVERSATION MAP (facts shown in the UI; not authority)",
    "RETAINED ROLE SELECTIONS (independent context; may predate newer results and are not automatic focus)",
  ];
  const selections = Object.entries(input.currentSelection);
  if (!selections.length) lines.push("- none");
  else for (const [role, item] of selections) lines.push(`- ${role}: ${entityLine(item)}`);

  lines.push("ORDERED RESULT LISTS (newest list first; positions match what the user saw)");
  if (!ordered.recentResultSets.length) lines.push("- none");
  for (const set of ordered.recentResultSets) {
    lines.push(`- LIST recency=${set.recency}${set.recency === 1 ? " (MOST RECENT LIST)" : ""}`);
    for (const item of set.items) {
      const markers = [
        ...(selectedKeys.has(item.evidenceKey) ? ["SELECTED FOR ROLE"] : []),
        ...(activeFocusKey === item.evidenceKey ? ["ACTIVE FOCUS"] : []),
      ];
      lines.push(`  ${item.position}. ${entityLine(item)}${markers.length ? ` | ${markers.join(" | ")}` : ""}`);
    }
  }

  lines.push("RECENT FOCUSED CARDS (newest card first)");
  if (!ordered.recentFocusedEntities.length) lines.push("- none");
  for (const item of ordered.recentFocusedEntities) {
    const recencyLabel = item.recency === 1
      ? "ACTIVE FOCUS / LAST SHOWN"
      : item.recency === 2 ? "PREVIOUSLY SHOWN" : `${item.recency} CARDS AGO`;
    lines.push(`- recency=${item.recency} (${recencyLabel}): ${entityLine(item)}`);
  }
  return lines.join("\n");
}

export const ORDERED_CONTEXT_INTERPRETATION_GUIDE = `
CONTEXT INTERPRETATION
- Interpret the language yourself; this map is factual context, not a precomputed answer.
- Evidence keys are opaque labels, not a relevance ranking. e1 is not inherently more important than e2.
- Determine the requested domain and the capability's required primary entity type before resolving references.
- A relevant list is the newest list whose entity type can supply that primary target. An older retained selection from another domain is independent context, not a conflicting candidate.
- "first"/"second" use positions in that newest relevant list. Without one, clarify; never start an unfiltered search to manufacture ordinal context.
- "this one" uses ACTIVE FOCUS of that type, falling back to SELECTED FOR ROLE when no newer conflicting focus exists.
- "previous" must never repeat ACTIVE FOCUS. Use a distinct PREVIOUSLY SHOWN entity of the requested type; otherwise, if ACTIVE FOCUS is at list position N>1, use position N-1. At position 1, clarify; never wrap.
- "other" selects the sole alternative only when exactly two relevant entities exist and one is current. Otherwise clarify with distinguishing labels.
- "clarify" means needsClarification=true. Explicit domain words and target type override unrelated older selections. Only competing candidates of the relevant type are a conflict.

GUIDE EXAMPLES
1) Most recent list: 1=e1, 2=e2. User: "Show me the second one." -> candidateRefs starts with e2.
2) CURRENT=e3, PREVIOUS=e2. "The previous property." -> e2.
3) List: 1=e1, 2=e2 ACTIVE FOCUS; no previous card. "The previous one." -> e1.
4) List: 1=e1 ACTIVE FOCUS, 2=e2; no previous card. "The previous one." -> clarify, never e2.
5) No relevant list. "Show me the second property." -> clarify; never launch a new unfiltered search.
6) Exactly two relevant properties, ACTIVE FOCUS=e2. "The other property." -> e1. With three candidates -> clarify.
7) Retained property=e1; newest list contains leads e4/e5. "Show the visits of the first one." -> visits.search_visits.v1 with lead e4. The retained property is not a conflict.
8) Newest list contains properties e4/e5. "Show the visits of the first one." -> visits.search_visits.v1 with property e4.
`;

export function formatEvidenceDetailsForLlm(input: Readonly<{
  referencedEntities: readonly PromptEvidenceEntity[];
  recentResultEvidence: readonly unknown[];
  candidateRefs: readonly PromptEvidenceEntity[];
  knownRelations?: readonly unknown[];
}>): string {
  return [
    "AUTHORIZED CONVERSATION EVIDENCE (observations only; not authority)",
    JSON.stringify({
      referencedEntities: input.referencedEntities,
      recentResultEvidence: input.recentResultEvidence,
      candidateRefs: input.candidateRefs,
      knownRelations: input.knownRelations ?? [],
    }),
  ].join("\n");
}
