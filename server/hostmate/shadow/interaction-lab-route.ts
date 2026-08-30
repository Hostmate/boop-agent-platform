import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import {
  runBoopInteractionShadow,
  type ConversationProposal,
} from "./boop-interaction-shadow.js";
import {
  HOSTMATE_GENERATIVE_FALLBACK_MODELS,
  HOSTMATE_GENERATIVE_MODEL,
  HOSTMATE_GENERATIVE_REASONING_EFFORT,
} from "../runtime/model-policy.js";
import { InteractionLabHostmateConnection } from "./interaction-lab-hostmate.js";
import { buildCanonicalConversationEvidence } from "./canonical-conversation-evidence.js";
import { InteractionLabConversationStore } from "./interaction-lab-conversation.js";
import { interactionActionLabel } from "../interaction/capability-catalog.js";

const labMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(4_000),
}).strict();

const labRequestSchema = z.object({
  conversationId: z.string().trim().min(1).max(120).optional(),
  messages: z.array(labMessageSchema).max(20).default([]),
  content: z.string().trim().min(1).max(4_000),
}).strict();

export type InteractionLabMessage = z.infer<typeof labMessageSchema>;

export function interactionLabReply(proposal: ConversationProposal | null): string {
  if (!proposal) {
    return "No he podido interpretar este mensaje. Puedes probar a expresarlo de otra forma.";
  }
  if (proposal.needsClarification) return proposal.clarificationQuestion;
  if (proposal.action === "unsupported") {
    return "He entendido la petición, pero no corresponde a una capacidad disponible del agente.";
  }
  const action = interactionActionLabel(proposal.action);
  return `He entendido que quieres ${action}. En este laboratorio no ejecutaré la acción.`;
}

export function createInteractionLabRouter(connection?: InteractionLabHostmateConnection) {
  const router = Router();
  const conversations = new InteractionLabConversationStore();

  router.get("/status", (_req, res) => {
    res.json({ tenant: connection?.status() ?? { connected: false, mode: "read_only" } });
  });

  router.post("/chat", async (req, res) => {
    const parsed = labRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "INVALID_LAB_REQUEST",
        message: "El mensaje o el historial del laboratorio no son válidos.",
      });
      return;
    }

    const apiKey = process.env.OPENROUTER_API_KEY?.trim();
    if (!apiKey) {
      res.status(503).json({
        error: "LAB_MODEL_UNAVAILABLE",
        message: "El laboratorio no tiene configurada la conexión con el modelo.",
      });
      return;
    }

    const conversationId = parsed.data.conversationId ?? `interaction-lab-${randomUUID()}`;
    const status = connection?.status();
    const scope = {
      tenantId: status?.tenantId ?? "interaction-lab",
      userId: status?.userId ?? "interaction-lab-user",
    };
    const stored = conversations.getOrHydrate({
      conversationId,
      scope,
      history: parsed.data.messages,
    });
    const evidence = buildCanonicalConversationEvidence({
      actor: scope,
      conversationId,
      messages: stored.messages,
      historyWindow: 10,
      resultWindow: 10,
    });
    const history = evidence.conversationHistory.slice(-10);

    const result = await runBoopInteractionShadow({
      conversationId,
      turn: history.filter((message) => message.role === "user").length + 1,
      currentMessage: parsed.data.content,
      history,
      evidence,
    }, {
      apiKey,
      model: HOSTMATE_GENERATIVE_MODEL,
      reasoningEffort: HOSTMATE_GENERATIVE_REASONING_EFFORT,
      fallbackModels: HOSTMATE_GENERATIVE_FALLBACK_MODELS,
      timeoutMs: 120_000,
      maxCostUsd: 0.05,
      temperature: 0,
    });

    if (result.proposalStatus !== "captured" || !result.proposal) {
      res.status(502).json({
        error: result.error?.code ?? "LAB_PROPOSAL_UNAVAILABLE",
        message: "El agente no ha podido completar esta respuesta. Inténtalo de nuevo.",
      });
      return;
    }

    let readResult = null;
    try {
      readResult = connection
        ? await connection.executeRead({
            conversationId,
            proposal: result.proposal,
            message: parsed.data.content,
            evidence,
            priorMessages: stored.messages,
            previousRead: conversations.previousRead(conversationId, result.proposal.action),
            openRouterApiKey: apiKey,
            model: HOSTMATE_GENERATIVE_MODEL,
            reasoningEffort: HOSTMATE_GENERATIVE_REASONING_EFFORT,
            fallbackModels: HOSTMATE_GENERATIVE_FALLBACK_MODELS,
          })
        : null;
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message.slice(0, 240) : "unknown";
      res.status(502).json({
        error: "LAB_READ_FAILED",
        message: "La lectura autorizada no ha podido completarse.",
        diagnostic: detail,
      });
      return;
    }

    conversations.appendUser(conversationId, parsed.data.content);
    if (readResult) {
      conversations.rememberRead(conversationId, {
        action: readResult.action,
        effectiveInput: readResult.effectiveInput,
      });
    }
    conversations.appendAssistant({
      conversationId,
      content: readResult?.summary ?? interactionLabReply(result.proposal),
      blocks: readResult?.blocks,
      entities: readResult?.entities,
    });

    res.json({
      conversationId,
      reply: readResult?.summary ?? interactionLabReply(result.proposal),
      proposal: result.proposal,
      validation: result.validation,
      readResult,
      telemetry: {
        model: result.usage.model,
        latencyMs: result.latencyMs,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        costUsd: result.usage.costUsd,
        promptHash: result.promptHash,
      },
      safety: {
        proposalOnly: !readResult,
        readOnly: true,
        toolsExecuted: readResult?.toolCalls ?? 0,
        productDataMutations: 0,
      },
    });
  });

  return router;
}
