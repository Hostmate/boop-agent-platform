import express from "express";
import { z } from "zod";
import { createActorContext } from "../contracts/actor-context.js";
import { entityRefSchema } from "../contracts/execution-result.js";
import { ConvexControlPlaneRepository } from "../control-plane/convex-control-plane-repository.js";
import { AuthenticatedConvexHttpClient } from "../control-plane/convex-http-client.js";
import { HostmateHttpLeadSearchPort } from "../product-tools/crm/hostmate-http-lead-search-port.js";
import { HostmateHttpLeadContextPort } from "../product-tools/crm/hostmate-http-lead-context-port.js";
import { HostmateHttpLeadVisitsPort } from "../product-tools/visits/hostmate-http-lead-visits-port.js";
import { HostmateHttpVisitDetailPort } from "../product-tools/visits/hostmate-http-visit-detail-port.js";
import { OpenRouterAdapter } from "../runtime/openrouter-adapter.js";
import { CrmSearchLeadsVerticalSlice } from "../vertical-slices/crm-search-leads.js";

const requestSchema = z.object({
  conversationId: z.string().uuid(),
  message: z.string().trim().min(1).max(500),
  selectedEntityRef: entityRefSchema.extend({ type: z.enum(["crm.lead", "visits.visit", "visits.group_visit"]) }).strict().optional(),
}).strict();

type RuntimeTurnRequest = z.infer<typeof requestSchema>;
type RuntimeTurnExecutor = (token: string, input: RuntimeTurnRequest) => Promise<unknown>;

export type AgentPlatformRuntimeConfig = Readonly<{
  convexUrl: string;
  hostmateApiBaseUrl: string;
  openRouterApiKey: string;
  model: string;
  fallbackModels?: readonly string[];
  maxConcurrentTurns?: number;
  isReady?: () => boolean;
  /** Test seam; production uses the authority-bound implementation below. */
  executeTurn?: RuntimeTurnExecutor;
}>;

export function createAgentPlatformRuntimeApp(config: AgentPlatformRuntimeConfig) {
  const app = express();
  const capabilities = ["crm.search_leads.v1", "crm.get_lead_context.v1", "visits.list_lead_visits.v1", "visits.get_visit.v1"] as const;
  const maxConcurrentTurns = Math.max(1, Math.floor(config.maxConcurrentTurns ?? 8));
  let activeTurns = 0;
  const executeTurn: RuntimeTurnExecutor = config.executeTurn ?? (async (token, input) => {
    // Convex verifies the RS256 identity. A fresh client per request prevents
    // credentials from bleeding between tenants.
    const convex = new AuthenticatedConvexHttpClient(config.convexUrl, token);
    const trusted = await convex.currentActor();
    const actor = createActorContext({ ...trusted, isSuperAdmin: trusted.role === "superadmin" });
    const slice = new CrmSearchLeadsVerticalSlice(
      new ConvexControlPlaneRepository(convex),
      new HostmateHttpLeadSearchPort(config.hostmateApiBaseUrl, token),
      new HostmateHttpLeadContextPort(config.hostmateApiBaseUrl, token),
      new HostmateHttpLeadVisitsPort(config.hostmateApiBaseUrl, token),
      new HostmateHttpVisitDetailPort(config.hostmateApiBaseUrl, token),
      new OpenRouterAdapter({ apiKey: config.openRouterApiKey, appName: "Hostmate Agent Platform" }),
      { model: config.model, fallbackModels: config.fallbackModels },
    );
    return await slice.execute(actor, input);
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
    if (!(config.isReady?.() ?? true)) return res.status(503).json({ success: false, error: "RUNTIME_NOT_READY" });
    if (activeTurns >= maxConcurrentTurns) {
      res.setHeader("retry-after", "1");
      return res.status(503).json({ success: false, error: "RUNTIME_BUSY" });
    }
    const token = authorization.slice(7);
    activeTurns += 1;
    try {
      const result = await executeTurn(token, parsed.data);
      res.setHeader("cache-control", "no-store");
      return res.json({ success: true, data: result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const unauthenticated = /UNAUTHENTICATED|JWT|identity/i.test(message);
      process.stderr.write(`${JSON.stringify({ component: "agent-platform-runtime", event: "turn_failed", kind: error instanceof Error ? error.name : "unknown", unauthenticated })}\n`);
      return res.status(unauthenticated ? 401 : 500).json({ success: false, error: unauthenticated ? "UNAUTHENTICATED" : "INTERNAL_ERROR" });
    } finally {
      activeTurns -= 1;
    }
  });
  return app;
}
