import { createHash, randomUUID } from "node:crypto";
import type { ActorContext } from "../contracts/actor-context.js";
import type { ExecutionResult } from "../contracts/execution-result.js";
import type { AgentMessageRecord, ControlPlaneRepository, ConversationContextRefs } from "../control-plane/repository.js";
import { redactEventPayload } from "../events/contracts.js";
import { BoopScopedMemoryRepository } from "../memory/repository.js";
import { evaluateExplicitMemory, preferenceKeyForForget, type ExplicitMemoryCommand } from "../memory/policy.js";

type ExplicitMemoryData = Readonly<{
  operation: "remember" | "forget";
  memoryId?: string;
  deleted?: number;
  category?: string;
  preferenceKey?: string;
  supersededMemoryIds?: readonly string[];
}>;

export type ExplicitMemoryTurnResult = Readonly<{
  conversationId: string;
  interactionRunId: string;
  executionRunId: string;
  result: ExecutionResult<ExplicitMemoryData>;
  embeddingUsage?: Readonly<{ requestedModel: string; resolvedModel: string; provider: string; inputTokens: number; costUsd: number; latencyMs: number }>;
}>;

function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }

export class ExplicitUserMemoryVerticalSlice {
  constructor(private readonly controlPlane: ControlPlaneRepository, private readonly memory: BoopScopedMemoryRepository) {}

  async execute(actor: ActorContext, input: { conversationId: string; message: string; command: ExplicitMemoryCommand }): Promise<ExplicitMemoryTurnResult> {
    const startedAt = Date.now();
    let priorMessages: readonly AgentMessageRecord[];
    try { priorMessages = await this.controlPlane.listMessages(actor, { conversationId: input.conversationId, limit: 200 }); }
    catch { await this.controlPlane.createConversation(actor, { conversationId: input.conversationId, title: "AI Chat" }); priorMessages = []; }
    const context: ConversationContextRefs = [...priorMessages].reverse().find((message) => message.contextRefs)?.contextRefs ?? { selected: {}, referenced: [] };
    let sequence = (priorMessages.at(-1)?.sequence ?? 0) + 1;
    await this.controlPlane.appendMessage(actor, {
      messageId: randomUUID(), conversationId: input.conversationId, role: "user", contentRedacted: input.message,
      contextRefs: context, sequence: sequence++, createdAt: Date.now(),
    });

    const interactionRunId = randomUUID();
    const executionRunId = randomUUID();
    const attemptId = randomUUID();
    let eventSequence = 0;
    const event = async (type: string, payload: unknown) => await this.controlPlane.appendEvent(actor, {
      eventId: randomUUID(), conversationId: input.conversationId, interactionRunId, executionRunId, attemptId,
      sequence: ++eventSequence, type, visibility: "user", payload: redactEventPayload(payload), occurredAt: Date.now(),
    });
    const tool = input.command.kind === "remember" ? "boop-memory.write_memory@1" : "boop-memory.forget_memory@1";
    await this.controlPlane.createRun(actor, {
      runId: interactionRunId, conversationId: input.conversationId, kind: "interaction", objectiveHash: hash(input.message),
      objectiveRedacted: input.message.slice(0, 240), dependencyRunIds: [], registryHash: "interaction-memory-v1",
      skillVersions: {}, toolScope: [], visibility: "user",
    });
    await this.controlPlane.updateRun(actor, interactionRunId, { status: "running" }, "queued");
    await this.controlPlane.createRun(actor, {
      runId: executionRunId, conversationId: input.conversationId, kind: "execution", profileId: "memory", profileVersion: 1,
      objectiveHash: hash(input.message), objectiveRedacted: input.message.slice(0, 240), parentRunId: interactionRunId,
      dependencyRunIds: [], registryHash: "boop-memory-explicit-v1", skillVersions: {}, toolScope: [tool], visibility: "user",
    });
    await this.controlPlane.createAttempt(actor, { attemptId, runId: executionRunId, attemptNumber: 1, status: "queued", fencingToken: 0 });
    await this.controlPlane.updateAttempt(actor, { attemptId, expectedStatus: "queued", patch: { status: "running", startedAt: Date.now() } });
    await this.controlPlane.updateRun(actor, executionRunId, { status: "running" }, "queued");
    await event("memory.candidate", { operation: input.command.kind, sourceType: "explicit_user", scope: "user" });

    let result: ExecutionResult<ExplicitMemoryData>;
    let embeddingUsage: ExplicitMemoryTurnResult["embeddingUsage"];
    if (input.command.kind === "remember") {
      const decision = evaluateExplicitMemory(input.command.rawContent, "explicit_user");
      if (decision.decision === "reject") {
        await event("memory.rejected", { code: decision.code, sourceType: "explicit_user", scope: "user" });
        result = {
          status: decision.code === "CATEGORY_NOT_ALLOWLISTED" ? "needs_input" : "permission_denied",
          summary: decision.explanation, entities: [], data: { operation: "remember" },
          errors: [{ code: "POLICY_DENIED", message: decision.code, retryable: false }],
        };
      } else {
        const embeddingStartedAt = Date.now();
        const written = await this.memory.remember(actor, { candidate: decision.candidate, sourceRunId: executionRunId, conversationId: input.conversationId });
        if (written.embedding) {
          embeddingUsage = {
            requestedModel: written.embedding.model, resolvedModel: written.embedding.model,
            provider: written.embedding.provider, inputTokens: written.embedding.inputTokens,
            costUsd: written.embedding.costUsd, latencyMs: Date.now() - embeddingStartedAt,
          };
          await this.controlPlane.recordUsage(actor, {
            usageId: randomUUID(), runId: executionRunId, attemptId,
            requestedModel: embeddingUsage.requestedModel, resolvedModel: embeddingUsage.resolvedModel,
            provider: embeddingUsage.provider, inputTokens: embeddingUsage.inputTokens, outputTokens: 0,
            reasoningTokens: 0, cachedTokens: 0, costUsd: embeddingUsage.costUsd,
            latencyMs: embeddingUsage.latencyMs, fallbackUsed: false, finishReason: "embedding", createdAt: Date.now(),
          });
        }
        await event(written.supersededMemoryIds.length ? "memory.superseded" : "memory.created", {
          memoryId: written.record.memoryId, category: decision.candidate.category,
          preferenceKey: decision.candidate.preferenceKey, scope: "user",
          embeddingProvider: written.embedding?.provider ?? "pending", supersededCount: written.supersededMemoryIds.length,
        });
        result = {
          status: "completed", summary: `Recordaré esta preferencia: ${written.record.content}`,
          entities: [], errors: [], data: {
            operation: "remember", memoryId: written.record.memoryId, category: decision.candidate.category,
            preferenceKey: decision.candidate.preferenceKey, supersededMemoryIds: written.supersededMemoryIds,
          },
        };
      }
    } else {
      const preferenceKey = preferenceKeyForForget(input.command.rawContent);
      if (!preferenceKey) {
        await event("memory.rejected", { code: "FORGET_TARGET_NOT_ALLOWLISTED", scope: "user" });
        result = {
          status: "needs_input", summary: "No identifico una preferencia Memory concreta que pueda olvidar en esta fase.",
          entities: [], errors: [{ code: "MISSING_REQUIRED_FIELD", message: "FORGET_TARGET_NOT_ALLOWLISTED", retryable: false }], data: { operation: "forget" },
        };
      } else {
        const forgotten = await this.memory.forget(actor, { preferenceKey, sourceRunId: executionRunId, conversationId: input.conversationId });
        await event("memory.deleted", { preferenceKey, deleted: forgotten.deleted, scope: "user" });
        result = {
          status: "completed",
          summary: forgotten.deleted ? "He olvidado esa preferencia. Ya no se utilizará en búsquedas futuras." : "No había una preferencia activa de ese tipo.",
          entities: [], errors: [], data: { operation: "forget", deleted: forgotten.deleted, preferenceKey },
        };
      }
    }

    await this.controlPlane.updateAttempt(actor, { attemptId, expectedStatus: "running", patch: { status: "succeeded", completedAt: Date.now() } });
    await this.controlPlane.updateRun(actor, executionRunId, {
      status: "completed", resultSummary: result.summary,
      resolvedModel: embeddingUsage?.resolvedModel, provider: embeddingUsage?.provider,
      finishReason: embeddingUsage ? "embedding" : "deterministic", completedAt: Date.now(),
    }, "running");
    await this.controlPlane.updateRun(actor, interactionRunId, { status: "completed", resultSummary: result.summary, completedAt: Date.now() }, "running");
    await event("memory.execution.completed", { operation: input.command.kind, status: result.status, latencyMs: Date.now() - startedAt });
    await this.controlPlane.appendMessage(actor, {
      messageId: randomUUID(), conversationId: input.conversationId, role: "assistant", contentRedacted: result.summary,
      contextRefs: context, runId: executionRunId, sequence, createdAt: Date.now(),
    });
    return { conversationId: input.conversationId, interactionRunId, executionRunId, result, embeddingUsage };
  }
}
