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

export type AgentPlatformRuntimeConfig = Readonly<{
  convexUrl: string;
  hostmateApiBaseUrl: string;
  openRouterApiKey: string;
  model: string;
  fallbackModels?: readonly string[];
}>;

export function createAgentPlatformRuntimeApp(config: AgentPlatformRuntimeConfig) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));
  app.get("/health", (_req, res) => res.json({ ok: true, capabilities: ["crm.search_leads.v1", "crm.get_lead_context.v1", "visits.list_lead_visits.v1", "visits.get_visit.v1"] }));
  app.post("/v1/turn", async (req, res) => {
    const authorization = req.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "UNAUTHENTICATED" });
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: "INVALID_REQUEST", details: parsed.error.flatten() });
    const token = authorization.slice(7);
    try {
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
      const result = await slice.execute(actor, parsed.data);
      res.setHeader("cache-control", "no-store");
      return res.json({ success: true, data: result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(/UNAUTHENTICATED|JWT|identity/i.test(message) ? 401 : 500).json({ success: false, error: message });
    }
  });
  return app;
}
