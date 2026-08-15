import express from "express";
import { z } from "zod";
import { createActorContext } from "../contracts/actor-context.js";
import { entityRefSchema } from "../contracts/execution-result.js";
import { ConvexControlPlaneRepository } from "../control-plane/convex-control-plane-repository.js";
import type { AgentMessageRecord } from "../control-plane/repository.js";
import { AuthenticatedConvexHttpClient } from "../control-plane/convex-http-client.js";
import { HostmateHttpLeadSearchPort } from "../product-tools/crm/hostmate-http-lead-search-port.js";
import { HostmateHttpLeadContextPort } from "../product-tools/crm/hostmate-http-lead-context-port.js";
import { HostmateHttpLeadVisitsPort } from "../product-tools/visits/hostmate-http-lead-visits-port.js";
import { HostmateHttpVisitDetailPort } from "../product-tools/visits/hostmate-http-visit-detail-port.js";
import { HostmateHttpPropertySearchPort } from "../product-tools/property/hostmate-http-property-search-port.js";
import { HostmateHttpPropertyDetailPort } from "../product-tools/property/hostmate-http-property-detail-port.js";
import { OpenRouterAdapter } from "../runtime/openrouter-adapter.js";
import { CrmSearchLeadsVerticalSlice } from "../vertical-slices/crm-search-leads.js";
import { PropertySearchPropertiesVerticalSlice } from "../vertical-slices/property-search-properties.js";
import { classifyInteractionTurn } from "../interaction/turn-classifier.js";
import { createActorTokenVerifier, type VerifiedActorClaims } from '../security/actor-token-verifier.js';
import { randomUUID } from 'node:crypto';

const requestSchema = z.object({
  conversationId: z.string().uuid(),
  message: z.string().trim().min(1).max(500),
  selectedEntityRef: entityRefSchema.extend({ type: z.enum(["crm.lead", "visits.visit", "visits.group_visit", "property.property"]) }).strict().optional(),
}).strict();

type RuntimeTurnRequest = z.infer<typeof requestSchema>;
type RuntimeRequestContext = { requestId: string; abortController: AbortController };
type RuntimeTurnExecutor = (token: string, input: RuntimeTurnRequest, context: RuntimeRequestContext) => Promise<unknown>;

export type AgentPlatformRuntimeConfig = Readonly<{
  convexUrl: string;
  hostmateApiBaseUrl: string;
  openRouterApiKey: string;
  model: string;
  fallbackModels?: readonly string[];
  maxConcurrentTurns?: number;
  isReady?: () => boolean;
  issuer?: string;
  audience?: string;
  jwksUrl?: string;
  verifyActorToken?: (token: string) => Promise<VerifiedActorClaims>;
  /** Test seam; production uses the authority-bound implementation below. */
  executeTurn?: RuntimeTurnExecutor;
}>;

export function createAgentPlatformRuntimeApp(config: AgentPlatformRuntimeConfig) {
  const app = express();
  const capabilities = ["crm.search_leads.v1", "crm.get_lead_context.v1", "visits.list_lead_visits.v1", "visits.get_visit.v1", "property.search_properties.v1", "property.get_property.v1"] as const;
  const maxConcurrentTurns = Math.max(1, Math.floor(config.maxConcurrentTurns ?? 8));
  let activeTurns = 0;
  const verifyActorToken = config.verifyActorToken ?? (
    config.issuer && config.audience && config.jwksUrl
      ? createActorTokenVerifier({ issuer: config.issuer, audience: config.audience, jwksUrl: config.jwksUrl })
      : undefined
  );
  if (!config.executeTurn && !verifyActorToken) throw new Error('Runtime JWT issuer, audience and JWKS URL are required');
  const executeTurn: RuntimeTurnExecutor = config.executeTurn ?? (async (token, input, context) => {
    const claims = await verifyActorToken!(token);
    // Convex verifies the RS256 identity. A fresh client per request prevents
    // credentials from bleeding between tenants.
    const convex = new AuthenticatedConvexHttpClient(config.convexUrl, token);
    const trusted = await convex.currentActor();
    if (trusted.tenantId !== claims.tenant_id || trusted.userId !== claims.user_id
      || trusted.sessionId !== claims.session_id || trusted.permissionsVersion !== claims.permissions_version) {
      throw new Error('ACTOR_CONTEXT_VERIFICATION_MISMATCH');
    }
    const actor = createActorContext({ ...trusted, isSuperAdmin: trusted.role === "superadmin" });
    const repository = new ConvexControlPlaneRepository(convex);
    let priorMessages: readonly AgentMessageRecord[] = [];
    try { priorMessages = [...await repository.listMessages(actor, { conversationId: input.conversationId, limit: 200 })]; } catch { /* New conversation. */ }
    const profile = classifyInteractionTurn({ message: input.message, selectedEntityRef: input.selectedEntityRef, priorMessages });
    if (profile === "property") {
      const slice = new PropertySearchPropertiesVerticalSlice(
        repository,
        new HostmateHttpPropertySearchPort(config.hostmateApiBaseUrl, token, fetch, context.requestId, context.abortController.signal),
        new HostmateHttpPropertyDetailPort(config.hostmateApiBaseUrl, token, fetch, context.requestId, context.abortController.signal),
        new OpenRouterAdapter({ apiKey: config.openRouterApiKey, appName: "Hostmate Agent Platform" }),
        { model: config.model, fallbackModels: config.fallbackModels },
      );
      const result = await slice.execute(actor, { ...input, requestId: context.requestId, abortController: context.abortController });
      return { ...result, controlPlaneWrites: convex.writeMetrics() };
    }
    const slice = new CrmSearchLeadsVerticalSlice(
      repository,
      new HostmateHttpLeadSearchPort(config.hostmateApiBaseUrl, token, fetch, context.requestId, context.abortController.signal),
      new HostmateHttpLeadContextPort(config.hostmateApiBaseUrl, token, fetch, context.requestId, context.abortController.signal),
      new HostmateHttpLeadVisitsPort(config.hostmateApiBaseUrl, token, fetch, context.requestId, context.abortController.signal),
      new HostmateHttpVisitDetailPort(config.hostmateApiBaseUrl, token, fetch, context.requestId, context.abortController.signal),
      new OpenRouterAdapter({ apiKey: config.openRouterApiKey, appName: "Hostmate Agent Platform" }),
      { model: config.model, fallbackModels: config.fallbackModels },
    );
    const result = await slice.execute(actor, { ...input, requestId: context.requestId, abortController: context.abortController });
    return { ...result, controlPlaneWrites: convex.writeMetrics() };
  });
  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));
  app.get("/health/live", (_req, res) => res.json({ ok: true }));
  app.get("/health/ready", (_req, res) => {
    const ready = config.isReady?.() ?? true;
    return res.status(ready ? 200 : 503).json({ ok: ready, activeTurns, maxConcurrentTurns });
  });
  app.get("/health", (_req, res) => res.json({ ok: true, capabilities }));
  app.post("/v1/turn", async (req, res) => {
    const authorization = req.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "UNAUTHENTICATED" });
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: "INVALID_REQUEST", details: parsed.error.flatten() });
    const requestId = typeof req.headers['x-request-id'] === 'string' && req.headers['x-request-id'].length <= 128
      ? req.headers['x-request-id']
      : randomUUID();
    res.setHeader('x-request-id', requestId);
    if (!(config.isReady?.() ?? true)) {
      process.stderr.write(`${JSON.stringify({ component: "agent-platform-runtime", event: "turn_rejected", requestId, reason: "not_ready" })}\n`);
      return res.status(503).json({ success: false, error: "RUNTIME_NOT_READY" });
    }
    if (activeTurns >= maxConcurrentTurns) {
      res.setHeader("retry-after", "1");
      process.stderr.write(`${JSON.stringify({ component: "agent-platform-runtime", event: "turn_rejected", requestId, reason: "busy", activeTurns, maxConcurrentTurns })}\n`);
      return res.status(503).json({ success: false, error: "RUNTIME_BUSY" });
    }
    const token = authorization.slice(7);
    const abortController = new AbortController();
    res.once('close', () => {
      if (!res.writableEnded) abortController.abort(new Error('client_disconnected'));
    });
    activeTurns += 1;
    try {
      const result = await executeTurn(token, parsed.data, { requestId, abortController });
      const runIds = result && typeof result === 'object' ? result as { interactionRunId?: unknown; executionRunId?: unknown } : {};
      process.stdout.write(`${JSON.stringify({
        component: "agent-platform-runtime", event: "turn_completed", requestId,
        interactionRunId: typeof runIds.interactionRunId === 'string' ? runIds.interactionRunId : undefined,
        executionRunId: typeof runIds.executionRunId === 'string' ? runIds.executionRunId : undefined,
      })}\n`);
      res.setHeader("cache-control", "no-store");
      return res.json({ success: true, data: result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const unauthenticated = /UNAUTHENTICATED|JWT|identity/i.test(message);
      process.stderr.write(`${JSON.stringify({ component: "agent-platform-runtime", event: "turn_failed", requestId, kind: error instanceof Error ? error.name : "unknown", unauthenticated })}\n`);
      return res.status(unauthenticated ? 401 : 500).json({ success: false, error: unauthenticated ? "UNAUTHENTICATED" : "INTERNAL_ERROR" });
    } finally {
      activeTurns -= 1;
    }
  });
  return app;
}
