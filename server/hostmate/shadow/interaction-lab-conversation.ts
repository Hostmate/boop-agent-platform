import type { EntityRef } from "../contracts/domain.js";
import type { AgentContentBlock } from "../contracts/execution-result.js";
import type { AgentMessageRecord, ConversationContextRefs } from "../control-plane/repository.js";
import type { PreviousReadContext } from "./interaction-execution-brief.js";

type InteractionLabHistoryMessage = Readonly<{
  role: "user" | "assistant";
  content: string;
}>;

type ConversationScope = Readonly<{ tenantId: string; userId: string }>;

type StoredConversation = {
  scope: ConversationScope;
  messages: AgentMessageRecord[];
  previousReads: Map<string, PreviousReadContext>;
};

function sameRef(left: EntityRef, right: EntityRef): boolean {
  return left.type === right.type && left.id === right.id;
}

function uniqueRefs(refs: readonly EntityRef[]): EntityRef[] {
  const result: EntityRef[] = [];
  for (const ref of refs) if (!result.some((candidate) => sameRef(candidate, ref))) result.push(ref);
  return result;
}

function roleFor(ref: EntityRef): string | null {
  if (ref.type === "property.property") return "property";
  if (ref.type === "crm.lead") return "lead";
  if (ref.type === "visits.visit" || ref.type === "visits.group_visit") return "visit";
  return null;
}

export class InteractionLabConversationStore {
  private readonly conversations = new Map<string, StoredConversation>();

  getOrHydrate(input: Readonly<{
    conversationId: string;
    scope: ConversationScope;
    history: readonly InteractionLabHistoryMessage[];
  }>): StoredConversation {
    const current = this.conversations.get(input.conversationId);
    if (current) {
      if (current.scope.tenantId !== input.scope.tenantId || current.scope.userId !== input.scope.userId) {
        throw new Error("INTERACTION_LAB_CONVERSATION_SCOPE_MISMATCH");
      }
      return current;
    }
    const stored: StoredConversation = {
      scope: input.scope,
      messages: input.history.map((message, index) => this.message({
        conversationId: input.conversationId,
        scope: input.scope,
        role: message.role,
        content: message.content,
        sequence: index + 1,
      })),
      previousReads: new Map(),
    };
    this.conversations.set(input.conversationId, stored);
    return stored;
  }

  appendUser(conversationId: string, content: string): AgentMessageRecord {
    const stored = this.required(conversationId);
    const message = this.message({
      conversationId,
      scope: stored.scope,
      role: "user",
      content,
      sequence: stored.messages.length + 1,
      contextRefs: this.latestContext(stored.messages),
    });
    stored.messages.push(message);
    return message;
  }

  appendAssistant(input: Readonly<{
    conversationId: string;
    content: string;
    blocks?: readonly AgentContentBlock[];
    entities?: readonly EntityRef[];
  }>): AgentMessageRecord {
    const stored = this.required(input.conversationId);
    const before = this.latestContext(stored.messages);
    const entities = input.entities ?? [];
    const selected = { ...before.selected };
    for (const role of ["lead", "property", "visit"] as const) {
      const candidates = uniqueRefs(entities.filter((entity) => roleFor(entity) === role));
      if (candidates.length === 1) selected[role] = candidates[0];
    }
    const contextRefs: ConversationContextRefs = {
      selected,
      referenced: uniqueRefs([...before.referenced, ...entities]),
    };
    const message = this.message({
      conversationId: input.conversationId,
      scope: stored.scope,
      role: "assistant",
      content: input.content,
      sequence: stored.messages.length + 1,
      blocks: input.blocks,
      contextRefs,
    });
    stored.messages.push(message);
    return message;
  }

  messages(conversationId: string): readonly AgentMessageRecord[] {
    return [...this.required(conversationId).messages];
  }

  previousRead(conversationId: string, action: string): PreviousReadContext | null {
    return this.required(conversationId).previousReads.get(action) ?? null;
  }

  rememberRead(conversationId: string, read: PreviousReadContext): void {
    this.required(conversationId).previousReads.set(read.action, Object.freeze({
      action: read.action,
      effectiveInput: Object.freeze({ ...read.effectiveInput }),
    }));
  }

  private required(conversationId: string): StoredConversation {
    const stored = this.conversations.get(conversationId);
    if (!stored) throw new Error("INTERACTION_LAB_CONVERSATION_NOT_FOUND");
    return stored;
  }

  private latestContext(messages: readonly AgentMessageRecord[]): ConversationContextRefs {
    return [...messages].reverse().find((message) => message.contextRefs)?.contextRefs
      ?? { selected: {}, referenced: [] };
  }

  private message(input: Readonly<{
    conversationId: string;
    scope: ConversationScope;
    role: AgentMessageRecord["role"];
    content: string;
    sequence: number;
    blocks?: readonly AgentContentBlock[];
    contextRefs?: ConversationContextRefs;
  }>): AgentMessageRecord {
    return Object.freeze({
      messageId: `${input.conversationId}:${input.sequence}`,
      conversationId: input.conversationId,
      tenantId: input.scope.tenantId,
      actorUserId: input.scope.userId,
      role: input.role,
      contentRedacted: input.content,
      blocks: input.blocks,
      contextRefs: input.contextRefs,
      sequence: input.sequence,
      createdAt: Date.now() + input.sequence,
    });
  }
}
