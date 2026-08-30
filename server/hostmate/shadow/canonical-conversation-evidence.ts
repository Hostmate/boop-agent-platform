import type { ActorContext } from "../contracts/actor-context.js";
import type { EntityRef } from "../contracts/domain.js";
import type { AgentContentBlock } from "../contracts/execution-result.js";
import type { AgentMessageRecord, ConversationContextRefs } from "../control-plane/repository.js";

export type CanonicalEvidenceSource = "selected" | "referenced" | "block" | "history" | "emitted";

export type CanonicalEvidenceEntity = Readonly<{
  evidenceKey: string;
  type: string;
  label?: string;
  source: CanonicalEvidenceSource;
  summary?: string;
}>;

export type CanonicalEvidenceIndexEntry = Readonly<{
  evidenceKey: string;
  ref: EntityRef;
  sources: readonly CanonicalEvidenceSource[];
  messageIds: readonly string[];
}>;

export type CanonicalEvidenceRelation = Readonly<{
  fromKey: string;
  toKey: string;
  relation: "lead_visit" | "lead_property";
  source: "multi_agent_summary";
  messageId: string;
}>;

export type CanonicalOrderedContext = Readonly<{
  /** Factual presentation order only. The LLM, not this adapter, interprets ordinals and anaphora. */
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
  /** Distinct singular entities shown by the assistant, newest first. Repeated renders of the same card are collapsed. */
  recentFocusedEntities: readonly Readonly<{
    recency: number;
    evidenceKey: string;
    type: string;
    label?: string;
  }>[];
}>;

export type CanonicalConversationEvidence = Readonly<{
  currentSelection: Readonly<Record<string, CanonicalEvidenceEntity>>;
  referencedEntities: readonly CanonicalEvidenceEntity[];
  recentResultEvidence: readonly Readonly<{
    type: AgentContentBlock["type"];
    summary: string;
    entityKeys: readonly string[];
    block: Readonly<Record<string, unknown>>;
    messageId: string;
    sequence: number;
  }>[];
  conversationHistory: readonly Readonly<{ role: AgentMessageRecord["role"]; content: string }>[];
  emittedEntityRefs: readonly CanonicalEvidenceEntity[];
  candidateRefs: readonly CanonicalEvidenceEntity[];
  knownRelations: readonly CanonicalEvidenceRelation[];
  orderedContext: CanonicalOrderedContext;
  /** Internal shadow validator index. It is deliberately excluded from the LLM prompt. */
  entityIndex: Readonly<Record<string, CanonicalEvidenceIndexEntry>>;
  captureStatus: Readonly<{
    referenced: "captured";
    blocks: "captured";
    prompt: "captured";
  }>;
  captureMetrics: Readonly<{
    inputMessages: number;
    historyMessages: number;
    selectedRefs: number;
    referencedRefs: number;
    blockRefs: number;
    resultBlocks: number;
    orderedResultSets: number;
    focusedEntities: number;
    candidateRefs: number;
  }>;
}>;

export type CanonicalEvidenceAudit = Readonly<{
  completeness: number;
  expectedRefs: number;
  indexedRefs: number;
  invalidOpaqueKeys: readonly string[];
  missingCandidateIndexKeys: readonly string[];
  relationContradictions: readonly string[];
  crossScopeMessages: 0;
  pass: boolean;
}>;

type MutableIndexEntry = {
  evidenceKey: string;
  ref: EntityRef;
  sources: Set<CanonicalEvidenceSource>;
  messageIds: Set<string>;
  label?: string;
  summary?: string;
};

const EVIDENCE_KEY = /^e[1-9][0-9]*$/;
const MAX_TEXT = 500;
const MAX_FIELD_TEXT = 240;

function refIdentity(ref: EntityRef): string {
  return `${ref.type}:${ref.id}`;
}

function validRef(value: unknown): value is EntityRef {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<EntityRef>;
  return typeof candidate.type === "string" && candidate.type.length > 0
    && typeof candidate.id === "string" && candidate.id.length > 0;
}

function redactEvidenceText(value: unknown, maxLength = MAX_TEXT): string {
  const text = String(value ?? "")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/(?:\+?\d[\s().-]*){8,}/g, "[phone]")
    .replace(/\b(?:sk|pk|api|token|secret)[-_][A-Za-z0-9_-]{12,}\b/gi, "[secret]")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, maxLength);
}

function frozen<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) frozen(item);
    return Object.freeze(value);
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) frozen(item);
    return Object.freeze(value);
  }
  return value;
}

function sortedMessages(messages: readonly AgentMessageRecord[]): readonly AgentMessageRecord[] {
  return [...messages].sort((left, right) => left.sequence - right.sequence || left.createdAt - right.createdAt || left.messageId.localeCompare(right.messageId));
}

function latestContext(messages: readonly AgentMessageRecord[]): ConversationContextRefs {
  return [...messages].reverse().find((message) => message.contextRefs)?.contextRefs ?? { selected: {}, referenced: [] };
}

function blockRefs(block: AgentContentBlock): readonly EntityRef[] {
  if (block.type === "entity_list") return block.items.map((item) => item.ref);
  if (block.type === "entity_detail") return [block.ref];
  if (block.type === "action_confirmation") return [block.target];
  if (block.type === "multi_agent_summary") {
    return block.sections.flatMap((section) => section.items?.flatMap((item) => validRef(item.ref) ? [item.ref] : []) ?? []);
  }
  return [];
}

function blockLabel(block: AgentContentBlock, ref: EntityRef): string | undefined {
  if (block.type === "entity_list") return block.items.find((item) => refIdentity(item.ref) === refIdentity(ref))?.title;
  if (block.type === "entity_detail" && refIdentity(block.ref) === refIdentity(ref)) return block.title;
  if (block.type === "action_confirmation" && refIdentity(block.target) === refIdentity(ref)) return block.target.label ?? block.title;
  if (block.type === "multi_agent_summary") {
    return block.sections.flatMap((section) => section.items ?? []).find((item) => item.ref && refIdentity(item.ref) === refIdentity(ref))?.title;
  }
  return undefined;
}

function safeFields(fields: readonly Readonly<{ label: string; value: string }>[]): readonly Record<string, string>[] {
  return fields.map((field) => ({
    label: redactEvidenceText(field.label, 80),
    value: redactEvidenceText(field.value, MAX_FIELD_TEXT),
  }));
}

function sanitizeBlock(block: AgentContentBlock, keyFor: (ref: EntityRef) => string): Readonly<Record<string, unknown>> {
  if (block.type === "entity_list") {
    return frozen({
      type: block.type,
      title: redactEvidenceText(block.title, 160),
      items: block.items.map((item) => ({
        evidenceKey: keyFor(item.ref), type: item.ref.type,
        title: redactEvidenceText(item.title, 160),
        ...(item.subtitle ? { subtitle: redactEvidenceText(item.subtitle, 200) } : {}),
        fields: safeFields(item.fields),
      })),
    });
  }
  if (block.type === "entity_detail") {
    return frozen({
      type: block.type, evidenceKey: keyFor(block.ref), entityType: block.ref.type,
      title: redactEvidenceText(block.title, 160),
      ...(block.subtitle ? { subtitle: redactEvidenceText(block.subtitle, 200) } : {}),
      ...(block.badges ? { badges: block.badges.map((badge) => redactEvidenceText(badge, 80)) } : {}),
      ...(block.description ? { description: redactEvidenceText(block.description) } : {}),
      sections: block.sections.map((section) => ({ title: redactEvidenceText(section.title, 120), fields: safeFields(section.fields) })),
    });
  }
  if (block.type === "brief") {
    return frozen({
      type: block.type, title: redactEvidenceText(block.title, 160), status: block.status,
      sections: block.sections.map((section) => ({
        key: section.key, title: redactEvidenceText(section.title, 120), availability: section.availability,
        fields: safeFields(section.fields),
        ...(section.notes ? { notes: section.notes.map((note) => redactEvidenceText(note, MAX_FIELD_TEXT)) } : {}),
      })),
    });
  }
  if (block.type === "multi_agent_summary") {
    return frozen({
      type: block.type, title: redactEvidenceText(block.title, 160), status: block.status,
      sections: block.sections.map((section) => ({
        key: section.key, title: redactEvidenceText(section.title, 120), availability: section.availability,
        summary: redactEvidenceText(section.summary),
        items: section.items?.map((item) => ({
          ...(item.ref ? { evidenceKey: keyFor(item.ref), type: item.ref.type } : {}),
          title: redactEvidenceText(item.title, 160),
          ...(item.subtitle ? { subtitle: redactEvidenceText(item.subtitle, 200) } : {}),
          ...(item.fields ? { fields: safeFields(item.fields) } : {}),
        })) ?? [],
      })),
    });
  }
  return frozen({
    type: block.type, title: redactEvidenceText(block.title, 160),
    description: redactEvidenceText(block.description),
    targetKey: keyFor(block.target), targetType: block.target.type,
    changes: block.changes.map((change) => ({
      field: redactEvidenceText(change.field, 100),
      ...(change.from ? { from: redactEvidenceText(change.from, MAX_FIELD_TEXT) } : {}),
      to: redactEvidenceText(change.to, MAX_FIELD_TEXT),
    })),
    warnings: block.warnings?.map((warning) => redactEvidenceText(warning, MAX_FIELD_TEXT)) ?? [],
    sideEffects: block.sideEffects?.map((effect) => redactEvidenceText(effect, MAX_FIELD_TEXT)) ?? [],
    risk: block.risk,
    expiresAt: block.expiresAt,
  });
}

function relationsFromBlock(
  block: AgentContentBlock,
  messageId: string,
  keyFor: (ref: EntityRef) => string,
): readonly CanonicalEvidenceRelation[] {
  if (block.type !== "multi_agent_summary") return [];
  const refsFor = (key: "lead" | "visits" | "properties") => block.sections
    .filter((section) => section.key === key)
    .flatMap((section) => section.items?.flatMap((item) => validRef(item.ref) ? [item.ref] : []) ?? []);
  const leads = refsFor("lead").filter((ref) => ref.type === "crm.lead");
  if (leads.length !== 1) return [];
  const leadKey = keyFor(leads[0]!);
  return [
    ...refsFor("visits").filter((ref) => ref.type === "visits.visit" || ref.type === "visits.group_visit").map((ref) => ({
      fromKey: leadKey, toKey: keyFor(ref), relation: "lead_visit" as const, source: "multi_agent_summary" as const, messageId,
    })),
    ...refsFor("properties").filter((ref) => ref.type === "property.property").map((ref) => ({
      fromKey: leadKey, toKey: keyFor(ref), relation: "lead_property" as const, source: "multi_agent_summary" as const, messageId,
    })),
  ];
}

export function buildCanonicalConversationEvidence(input: Readonly<{
  actor: Pick<ActorContext, "tenantId" | "userId">;
  conversationId: string;
  messages: readonly AgentMessageRecord[];
  historyWindow?: number;
  resultWindow?: number;
}>): CanonicalConversationEvidence {
  const historyWindow = Math.max(1, Math.min(input.historyWindow ?? 10, 50));
  const resultWindow = Math.max(1, Math.min(input.resultWindow ?? 10, 50));
  for (const message of input.messages) {
    if (message.tenantId !== input.actor.tenantId || message.actorUserId !== input.actor.userId || message.conversationId !== input.conversationId) {
      throw new Error("CANONICAL_EVIDENCE_SCOPE_MISMATCH");
    }
  }
  const messages = sortedMessages(input.messages);
  const recentMessages = messages.slice(-historyWindow);
  const context = latestContext(messages);
  const entries = new Map<string, MutableIndexEntry>();
  let nextKey = 1;
  const register = (ref: EntityRef, source: CanonicalEvidenceSource, messageId?: string, label?: string, summary?: string): MutableIndexEntry => {
    const identity = refIdentity(ref);
    let entry = entries.get(identity);
    if (!entry) {
      entry = { evidenceKey: `e${nextKey++}`, ref: { ...ref }, sources: new Set(), messageIds: new Set() };
      entries.set(identity, entry);
    }
    entry.sources.add(source);
    if (messageId) entry.messageIds.add(messageId);
    if (!entry.label) entry.label = redactEvidenceText(label ?? ref.label, 160) || undefined;
    if (!entry.summary && summary) entry.summary = redactEvidenceText(summary, MAX_FIELD_TEXT) || undefined;
    return entry;
  };
  const latestContextMessage = [...messages].reverse().find((message) => message.contextRefs);
  for (const [role, ref] of Object.entries(context.selected).sort(([left], [right]) => left.localeCompare(right))) {
    if (validRef(ref)) register(ref, "selected", latestContextMessage?.messageId, ref.label, role);
  }
  for (const ref of context.referenced) if (validRef(ref)) register(ref, "referenced", latestContextMessage?.messageId, ref.label);
  for (const message of recentMessages) {
    for (const block of message.blocks ?? []) {
      for (const ref of blockRefs(block)) register(ref, "block", message.messageId, blockLabel(block, ref), message.contentRedacted);
    }
  }
  const keyFor = (ref: EntityRef): string => register(ref, "block").evidenceKey;
  const toItem = (ref: EntityRef, source: CanonicalEvidenceSource): CanonicalEvidenceEntity => {
    const entry = entries.get(refIdentity(ref)) ?? register(ref, source);
    return frozen({
      evidenceKey: entry.evidenceKey, type: entry.ref.type,
      ...(entry.label ? { label: entry.label } : {}), source,
      ...(entry.summary ? { summary: entry.summary } : {}),
    });
  };
  const currentSelection = Object.fromEntries(Object.entries(context.selected)
    .filter((entry): entry is [string, EntityRef] => validRef(entry[1]))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([role, ref]) => [role, toItem(ref, "selected")]));
  const referencedEntities = [...new Map(context.referenced.filter(validRef).map((ref) => [refIdentity(ref), toItem(ref, "referenced")])).values()];
  const emittedRefs = recentMessages.flatMap((message) => (message.blocks ?? []).flatMap(blockRefs));
  const emittedEntityRefs = [...new Map(emittedRefs.map((ref) => [refIdentity(ref), toItem(ref, "emitted")])).values()];
  const resultBlocks = recentMessages.flatMap((message) => (message.blocks ?? []).map((block) => ({ message, block }))).slice(-resultWindow);
  const recentResultEvidence = resultBlocks.map(({ message, block }) => ({
    type: block.type,
    summary: redactEvidenceText(message.contentRedacted || block.title),
    entityKeys: [...new Set(blockRefs(block).map(keyFor))],
    block: sanitizeBlock(block, keyFor),
    messageId: message.messageId,
    sequence: message.sequence,
  }));
  const recentResultSets = resultBlocks
    .filter((item): item is { message: AgentMessageRecord; block: Extract<AgentContentBlock, { type: "entity_list" }> } => item.block.type === "entity_list")
    .reverse()
    .map(({ message, block }, index) => ({
      recency: index + 1,
      type: "entity_list" as const,
      sequence: message.sequence,
      items: block.items.map((item, itemIndex) => {
        const entry = entries.get(refIdentity(item.ref)) ?? register(item.ref, "block", message.messageId, item.title);
        return {
          position: itemIndex + 1,
          evidenceKey: entry.evidenceKey,
          type: entry.ref.type,
          ...(entry.label ? { label: entry.label } : {}),
        };
      }),
    }));
  const focusedEntityKeys = new Set<string>();
  const recentFocusedEntities = resultBlocks
    .filter((item): item is { message: AgentMessageRecord; block: Extract<AgentContentBlock, { type: "entity_detail" }> } => item.block.type === "entity_detail")
    .reverse()
    .flatMap(({ message, block }) => {
      const entry = entries.get(refIdentity(block.ref)) ?? register(block.ref, "block", message.messageId, block.title);
      if (focusedEntityKeys.has(entry.evidenceKey)) return [];
      focusedEntityKeys.add(entry.evidenceKey);
      return [{
        recency: focusedEntityKeys.size,
        evidenceKey: entry.evidenceKey,
        type: entry.ref.type,
        ...(entry.label ? { label: entry.label } : {}),
      }];
    });
  const knownRelations = resultBlocks.flatMap(({ message, block }) => relationsFromBlock(block, message.messageId, keyFor));
  const sourcePriority: readonly CanonicalEvidenceSource[] = ["selected", "referenced", "emitted", "block", "history"];
  const candidateRefs = [...entries.values()].map((entry) => {
    const source = sourcePriority.find((candidate) => entry!.sources.has(candidate)) ?? "block";
    return toItem(entry.ref, source);
  });
  const entityIndex = Object.fromEntries([...entries.values()].map((entry) => [entry.evidenceKey, frozen({
    evidenceKey: entry.evidenceKey,
    ref: { ...entry.ref },
    sources: [...entry.sources],
    messageIds: [...entry.messageIds],
  })]));
  return frozen({
    currentSelection,
    referencedEntities,
    recentResultEvidence,
    conversationHistory: recentMessages.map((message) => ({ role: message.role, content: redactEvidenceText(message.contentRedacted) })),
    emittedEntityRefs,
    candidateRefs,
    knownRelations,
    orderedContext: { recentResultSets, recentFocusedEntities },
    entityIndex,
    captureStatus: { referenced: "captured", blocks: "captured", prompt: "captured" },
    captureMetrics: {
      inputMessages: messages.length,
      historyMessages: recentMessages.length,
      selectedRefs: Object.keys(currentSelection).length,
      referencedRefs: referencedEntities.length,
      blockRefs: new Set(emittedRefs.map(refIdentity)).size,
      resultBlocks: recentResultEvidence.length,
      orderedResultSets: recentResultSets.length,
      focusedEntities: recentFocusedEntities.length,
      candidateRefs: candidateRefs.length,
    },
  });
}

export function auditCanonicalConversationEvidence(evidence: CanonicalConversationEvidence): CanonicalEvidenceAudit {
  const keys = evidence.candidateRefs.map((candidate) => candidate.evidenceKey);
  const invalidOpaqueKeys = keys.filter((key) => !EVIDENCE_KEY.test(key));
  const missingCandidateIndexKeys = keys.filter((key) => !evidence.entityIndex[key]);
  const expectedIdentities = new Set([
    ...Object.values(evidence.currentSelection).map((item) => item.evidenceKey),
    ...evidence.referencedEntities.map((item) => item.evidenceKey),
    ...evidence.emittedEntityRefs.map((item) => item.evidenceKey),
  ]);
  const indexedRefs = [...expectedIdentities].filter((key) => Boolean(evidence.entityIndex[key])).length;
  const relationOwners = new Map<string, Set<string>>();
  for (const relation of evidence.knownRelations) {
    const relationKey = `${relation.relation}:${relation.toKey}`;
    const owners = relationOwners.get(relationKey) ?? new Set<string>();
    owners.add(relation.fromKey);
    relationOwners.set(relationKey, owners);
  }
  const relationContradictions = [...relationOwners.entries()].filter(([, owners]) => owners.size > 1).map(([key]) => key);
  const expectedRefs = expectedIdentities.size;
  const completeness = expectedRefs === 0 ? 1 : indexedRefs / expectedRefs;
  return frozen({
    completeness,
    expectedRefs,
    indexedRefs,
    invalidOpaqueKeys,
    missingCandidateIndexKeys,
    relationContradictions,
    crossScopeMessages: 0,
    pass: completeness === 1 && invalidOpaqueKeys.length === 0 && missingCandidateIndexKeys.length === 0 && relationContradictions.length === 0,
  });
}
