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
import { OpenRouterAdapter, type OpenRouterReasoningEffort } from "../runtime/openrouter-adapter.js";
import { OpenRouterTelemetryMonitor } from "../runtime/openrouter-telemetry.js";
import { CrmSearchLeadsVerticalSlice } from "../vertical-slices/crm-search-leads.js";
import { PropertySearchPropertiesVerticalSlice } from "../vertical-slices/property-search-properties.js";
import { classifyBriefSkillIntent, classifyInteractionTurn } from "../interaction/turn-classifier.js";
import { createActorTokenVerifier, type VerifiedActorClaims } from '../security/actor-token-verifier.js';
import { randomUUID } from 'node:crypto';
import { classifyExplicitMemoryCommand, explicitPropertyOrder } from '../memory/policy.js';
import { BoopScopedMemoryRepository, type PropertyOrderRecall } from '../memory/repository.js';
import { ExplicitUserMemoryVerticalSlice } from '../vertical-slices/explicit-user-memory.js';
import { createRuntimeSkillExecutor } from '../skills/runtime-dispatcher.js';
import { classifyOrchestrationIntent, createRuntimeOrchestrationExecutor } from '../orchestration/runtime-dispatcher.js';
import { classifyLeadStatusWriteIntent, CRM_UPDATE_LEAD_STATUS_PERMISSION, CRM_UPDATE_LEAD_STATUS_TOOL_ID, CRM_UPDATE_LEAD_STATUS_TOOL_VERSION } from '../product-tools/crm/update-lead-status.js';
import { HostmateHttpLeadStatusWritePort as HttpLeadStatusWritePort } from '../product-tools/crm/hostmate-http-lead-status-write-port.js';
import { CrmUpdateLeadStatusVerticalSlice } from '../vertical-slices/crm-update-lead-status.js';
import { classifyLeadNoteWriteIntent, CRM_ADD_LEAD_NOTE_PERMISSION, CRM_ADD_LEAD_NOTE_TOOL_ID, CRM_ADD_LEAD_NOTE_TOOL_VERSION } from '../product-tools/crm/add-lead-note.js';
import { HostmateHttpLeadNoteWritePort } from '../product-tools/crm/hostmate-http-lead-note-write-port.js';
import { CrmAddLeadNoteVerticalSlice } from '../vertical-slices/crm-add-lead-note.js';
import { verifyWriteIntentConfirmationToken, verifyWriteIntentSignature } from '../drafts/contracts.js';
import type { SignedWriteIntent } from '../drafts/contracts.js';
import type { ActorContext } from '../contracts/actor-context.js';
import { SafeWriteCommitError, SafeWriteCommitRegistry } from '../drafts/safe-write-commit-registry.js';

const requestSchema = z.object({
  conversationId: z.string().uuid(),
  message: z.string().trim().min(1).max(10_500),
  selectedEntityRef: entityRefSchema.extend({ type: z.enum(["crm.lead", "visits.visit", "visits.group_visit", "property.property"]) }).strict().optional(),
}).strict();

type RuntimeTurnRequest = z.infer<typeof requestSchema>;
type RuntimeRequestContext = { requestId: string; abortController: AbortController };
type RuntimeTurnExecutor = (token: string, input: RuntimeTurnRequest, context: RuntimeRequestContext) => Promise<unknown>;

export function safeWriteErrorSignal(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const candidate = error as { message?: unknown; data?: unknown };
  const data = typeof candidate.data === "string"
    ? candidate.data
    : candidate.data === undefined ? "" : JSON.stringify(candidate.data);
  return `${typeof candidate.message === "string" ? candidate.message : String(error)} ${data}`.trim();
}

export type AgentPlatformRuntimeConfig = Readonly<{
  convexUrl: string;
  hostmateApiBaseUrl: string;
  openRouterApiKey: string;
  model: string;
  fallbackModels?: readonly string[];
  reasoningEffort?: OpenRouterReasoningEffort;
  memory?: Readonly<{
    enabled: boolean;
    allowedTenantIds: readonly string[];
    allowedUserIds: readonly string[];
    automaticExtractionEnabled: false;
    tenantScopeEnabled: false;
    consolidationEnabled: false;
  }>;
  skills?: Readonly<{
    enabledSkillIds: readonly ("prepare-visit-brief" | "prepare-lead-brief")[];
    allowedTenantIds: readonly string[];
    allowedUserIds: readonly string[];
  }>;
  multiAgent?: Readonly<{
    enabled: boolean;
    allowedTenantIds: readonly string[];
    allowedUserIds: readonly string[];
  }>;
  safeWrites?: Readonly<{
    enabled: boolean;
    allowedTenantIds: readonly string[];
    allowedUserIds: readonly string[];
    signingSecret: string;
    ttlMs?: number;
  }>;
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
  const openRouterTelemetry = new OpenRouterTelemetryMonitor();
  const capabilities = ["crm.search_leads.v1", "crm.get_lead_context.v1", "visits.list_lead_visits.v1", "visits.get_visit.v1", "property.search_properties.v1", "property.get_property.v1", "skill.prepare-visit-brief.v1", "skill.prepare-lead-brief.v1", "crm.update_lead_status.v1", "crm.add_lead_note.v1"] as const;
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
    const memoryAllowed = Boolean(
      config.memory?.enabled
      && config.memory.allowedTenantIds.includes(actor.tenantId)
      && config.memory.allowedUserIds.includes(actor.userId)
      && actor.permissions.includes("memory.read")
      && actor.permissions.includes("memory.write"),
    );
    const classificationStartedAt = performance.now();
    const memoryCommand = classifyExplicitMemoryCommand(input.message);
    const classificationMs = performance.now() - classificationStartedAt;
    const noteWriteIntent = classifyLeadNoteWriteIntent(input.message);
    if (noteWriteIntent.kind !== "none") {
      const writePort = new HostmateHttpLeadNoteWritePort(config.hostmateApiBaseUrl, token, fetch, context.requestId, context.abortController.signal);
      return {
        ...await new CrmAddLeadNoteVerticalSlice(repository, writePort, config.safeWrites ?? {
          enabled: false, allowedTenantIds: [], allowedUserIds: [], signingSecret: "disabled-disabled-disabled-disabled",
        }).execute(actor, {
          conversationId: input.conversationId, message: input.message, selectedEntityRef: input.selectedEntityRef,
          content: noteWriteIntent.kind === "note" ? noteWriteIntent.content : undefined,
          issue: noteWriteIntent.kind === "needs_input" ? noteWriteIntent.reason : undefined,
        }),
        controlPlaneWrites: convex.writeMetrics(),
      };
    }
    const statusWriteIntent = classifyLeadStatusWriteIntent(input.message);
    if (statusWriteIntent.kind !== "none") {
      const writePort = new HttpLeadStatusWritePort(config.hostmateApiBaseUrl, token, fetch, context.requestId, context.abortController.signal);
      return {
        ...await new CrmUpdateLeadStatusVerticalSlice(repository, writePort, config.safeWrites ?? {
          enabled: false, allowedTenantIds: [], allowedUserIds: [], signingSecret: "disabled-disabled-disabled-disabled",
        }).execute(actor, {
          conversationId: input.conversationId, message: input.message, selectedEntityRef: input.selectedEntityRef,
          requestedStatus: statusWriteIntent.kind === "status" ? statusWriteIntent.status : undefined,
        }),
        controlPlaneWrites: convex.writeMetrics(),
      };
    }
    if (memoryCommand) {
      if (!memoryAllowed) throw new Error("MEMORY_FORBIDDEN");
      return {
        ...await new ExplicitUserMemoryVerticalSlice(repository, new BoopScopedMemoryRepository(convex))
          .execute(actor, { conversationId: input.conversationId, message: input.message, command: memoryCommand, classificationMs }),
        controlPlaneWrites: convex.writeMetrics(),
      };
    }
    const briefSkillIntent = classifyBriefSkillIntent(input.message);
    if (briefSkillIntent) {
      const leadContextPort = new HostmateHttpLeadContextPort(config.hostmateApiBaseUrl, token, fetch, context.requestId, context.abortController.signal);
      const skill = createRuntimeSkillExecutor(briefSkillIntent, actor, config.skills, {
        repository,
        leadContextPort,
        visitDetailPort: new HostmateHttpVisitDetailPort(config.hostmateApiBaseUrl, token, fetch, context.requestId, context.abortController.signal),
        propertyDetailPort: new HostmateHttpPropertyDetailPort(config.hostmateApiBaseUrl, token, fetch, context.requestId, context.abortController.signal),
      });
      return {
        ...await skill.execute(actor, input),
        controlPlaneWrites: convex.writeMetrics(),
      };
    }
    const orchestrationIntent = classifyOrchestrationIntent(input.message);
    if (orchestrationIntent) {
      const executor = createRuntimeOrchestrationExecutor(orchestrationIntent, actor, config.multiAgent, {
        repository,
        leadContextPort: new HostmateHttpLeadContextPort(config.hostmateApiBaseUrl, token, fetch, context.requestId, context.abortController.signal),
        leadVisitsPort: new HostmateHttpLeadVisitsPort(config.hostmateApiBaseUrl, token, fetch, context.requestId, context.abortController.signal),
        propertySearchPort: new HostmateHttpPropertySearchPort(config.hostmateApiBaseUrl, token, fetch, context.requestId, context.abortController.signal),
      });
      return { ...await executor.execute(actor, { ...input, priorMessages }), controlPlaneWrites: convex.writeMetrics() };
    }
    const profile = classifyInteractionTurn({ message: input.message, selectedEntityRef: input.selectedEntityRef, priorMessages });
    if (profile === "property") {
      let weakPreference: PropertyOrderRecall | undefined;
      if (memoryAllowed && !explicitPropertyOrder(input.message)) {
        weakPreference = await new BoopScopedMemoryRepository(convex).recallPropertyOrder(actor, input.conversationId) ?? undefined;
      }
      const slice = new PropertySearchPropertiesVerticalSlice(
        repository,
        new HostmateHttpPropertySearchPort(config.hostmateApiBaseUrl, token, fetch, context.requestId, context.abortController.signal),
        new HostmateHttpPropertyDetailPort(config.hostmateApiBaseUrl, token, fetch, context.requestId, context.abortController.signal),
        new OpenRouterAdapter({ apiKey: config.openRouterApiKey, appName: "Hostmate Agent Platform", onObservation: openRouterTelemetry.record }),
        { model: config.model, fallbackModels: config.fallbackModels, reasoningEffort: config.reasoningEffort, weakPreference },
      );
      const result = await slice.execute(actor, { ...input, requestId: context.requestId, abortController: context.abortController });
      return { ...result, memoryTimings: weakPreference?.timings, controlPlaneWrites: convex.writeMetrics() };
    }
    const slice = new CrmSearchLeadsVerticalSlice(
      repository,
      new HostmateHttpLeadSearchPort(config.hostmateApiBaseUrl, token, fetch, context.requestId, context.abortController.signal),
      new HostmateHttpLeadContextPort(config.hostmateApiBaseUrl, token, fetch, context.requestId, context.abortController.signal),
      new HostmateHttpLeadVisitsPort(config.hostmateApiBaseUrl, token, fetch, context.requestId, context.abortController.signal),
      new HostmateHttpVisitDetailPort(config.hostmateApiBaseUrl, token, fetch, context.requestId, context.abortController.signal),
      new OpenRouterAdapter({ apiKey: config.openRouterApiKey, appName: "Hostmate Agent Platform", onObservation: openRouterTelemetry.record }),
      { model: config.model, fallbackModels: config.fallbackModels, reasoningEffort: config.reasoningEffort },
    );
    const result = await slice.execute(actor, { ...input, requestId: context.requestId, abortController: context.abortController });
    return { ...result, controlPlaneWrites: convex.writeMetrics() };
  });

  async function safeWriteContext(token: string): Promise<{ actor: ActorContext; repository: ConvexControlPlaneRepository; convex: AuthenticatedConvexHttpClient }> {
    if (!verifyActorToken) throw new Error("SAFE_WRITES_UNAUTHENTICATED");
    const claims = await verifyActorToken(token);
    const convex = new AuthenticatedConvexHttpClient(config.convexUrl, token);
    const trusted = await convex.currentActor();
    if (trusted.tenantId !== claims.tenant_id || trusted.userId !== claims.user_id
      || trusted.sessionId !== claims.session_id || trusted.permissionsVersion !== claims.permissions_version) {
      throw new Error("ACTOR_CONTEXT_VERIFICATION_MISMATCH");
    }
    const actor = createActorContext({ ...trusted, isSuperAdmin: trusted.role === "superadmin" });
    if (!config.safeWrites?.enabled || !config.safeWrites.allowedTenantIds.includes(actor.tenantId)
      || !config.safeWrites.allowedUserIds.includes(actor.userId)) {
      throw new Error("SAFE_WRITES_FORBIDDEN");
    }
    return { actor, repository: new ConvexControlPlaneRepository(convex), convex };
  }

  function commitRegistry(token = "", requestId?: string): SafeWriteCommitRegistry {
    return new SafeWriteCommitRegistry([
      {
        toolId: CRM_UPDATE_LEAD_STATUS_TOOL_ID, toolVersion: CRM_UPDATE_LEAD_STATUS_TOOL_VERSION,
        requiredPermission: CRM_UPDATE_LEAD_STATUS_PERMISSION, operationType: "update", operation: "lead.status.set",
        commit: (actor, intent) => new HttpLeadStatusWritePort(config.hostmateApiBaseUrl, token, fetch, requestId).commit(actor, { signedIntent: intent }),
      },
      {
        toolId: CRM_ADD_LEAD_NOTE_TOOL_ID, toolVersion: CRM_ADD_LEAD_NOTE_TOOL_VERSION,
        requiredPermission: CRM_ADD_LEAD_NOTE_PERMISSION, operationType: "create", operation: "lead.note.append",
        commit: (actor, intent) => new HostmateHttpLeadNoteWritePort(config.hostmateApiBaseUrl, token, fetch, requestId).commit(actor, { signedIntent: intent }),
      },
    ]);
  }

  function assertIntentOwner(actor: ActorContext, intent: SignedWriteIntent): void {
    const envelope = intent.envelope;
    if (!config.safeWrites || !verifyWriteIntentSignature(intent, config.safeWrites.signingSecret)) throw new Error("DRAFT_SIGNATURE_INVALID");
    commitRegistry().resolve(intent);
    if (envelope.tenantId !== actor.tenantId || envelope.actorUserId !== actor.userId) {
      throw new Error("DRAFT_ACTOR_MISMATCH");
    }
  }

  function assertIntentAuthority(actor: ActorContext, intent: SignedWriteIntent): void {
    assertIntentOwner(actor, intent);
    if (intent.envelope.sessionId !== actor.sessionId || intent.envelope.permissionsVersion !== actor.permissionsVersion) {
      throw new Error("DRAFT_ACTOR_MISMATCH");
    }
  }

  async function appendWriteEvent(repository: ConvexControlPlaneRepository, actor: ActorContext, intent: SignedWriteIntent, type: string, payload: unknown): Promise<void> {
    const existing = await repository.listEvents(actor, { executionRunId: intent.envelope.sourceRunId, limit: 500 });
    await repository.appendEvent(actor, {
      eventId: randomUUID(), conversationId: intent.envelope.conversationId, executionRunId: intent.envelope.sourceRunId,
      sequence: (existing.at(-1)?.sequence ?? 0) + 1, type, visibility: "user", payload, occurredAt: Date.now(),
    });
  }
  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));
  app.get("/health/live", (_req, res) => res.json({ ok: true }));
  app.get("/health/ready", (_req, res) => {
    const ready = config.isReady?.() ?? true;
    return res.status(ready ? 200 : 503).json({ ok: ready, activeTurns, maxConcurrentTurns });
  });
  app.get("/health", (_req, res) => res.json({ ok: true, capabilities }));
  app.get("/metrics/openrouter", (_req, res) => {
    res.setHeader("cache-control", "no-store");
    res.json({ ok: true, ...openRouterTelemetry.snapshot() });
  });
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
      const forbidden = /FORBIDDEN/.test(message);
      process.stderr.write(`${JSON.stringify({ component: "agent-platform-runtime", event: "turn_failed", requestId, kind: error instanceof Error ? error.name : "unknown", unauthenticated })}\n`);
      return res.status(unauthenticated ? 401 : forbidden ? 403 : 500).json({ success: false, error: unauthenticated ? "UNAUTHENTICATED" : forbidden ? "FORBIDDEN" : "INTERNAL_ERROR" });
    } finally {
      activeTurns -= 1;
    }
  });

  const draftIdSchema = z.object({ draftId: z.string().uuid() }).strict();
  const confirmSchema = z.object({ confirmationToken: z.string().min(32).max(128) }).strict();

  app.post("/v1/write-drafts/:draftId/confirm", async (req, res) => {
    const authorization = req.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "UNAUTHENTICATED" });
    const params = draftIdSchema.safeParse(req.params);
    const body = confirmSchema.safeParse(req.body);
    if (!params.success || !body.success) return res.status(400).json({ success: false, error: "INVALID_DRAFT_CONFIRMATION" });
    try {
      const token = authorization.slice(7);
      const { actor, repository } = await safeWriteContext(token);
      const record = await repository.getWriteIntent(actor, params.data.draftId);
      if (!record) return res.status(404).json({ success: false, error: "DRAFT_NOT_FOUND" });
      assertIntentAuthority(actor, record.intent);
      const registry = commitRegistry(token, String(req.headers["x-request-id"] ?? randomUUID()));
      const definition = registry.resolve(record.intent);
      if (!actor.isSuperAdmin && !actor.permissions.includes(definition.requiredPermission)) throw new Error("SAFE_WRITES_FORBIDDEN");
      if (!verifyWriteIntentConfirmationToken(record.intent, body.data.confirmationToken)) throw new Error("DRAFT_TOKEN_INVALID");
      if (record.status === "committed") return res.json({ success: true, data: { draftId: params.data.draftId, status: "committed", idempotent: true } });
      const confirmationNow = Date.now();
      const confirmed = await repository.confirmWriteIntent(actor, { draftId: params.data.draftId, now: confirmationNow });
      if (confirmed.status === "expired") {
        await appendWriteEvent(repository, actor, record.intent, "draft.expired", { draftId: params.data.draftId });
        await repository.updateRun(actor, record.intent.envelope.sourceRunId, { status: "failed", errorCode: "DRAFT_EXPIRED", resultSummary: "Draft expired", completedAt: Date.now() }, "awaiting_confirmation");
        return res.status(409).json({ success: false, error: "DRAFT_EXPIRED" });
      }
      if (record.status === "proposed" && confirmed.confirmedAt === confirmationNow) {
        await appendWriteEvent(repository, actor, record.intent, "draft.confirmed", { draftId: params.data.draftId, actorUserId: actor.userId });
      }
      let claimed;
      try {
        claimed = await repository.claimWriteIntentCommit(actor, { draftId: params.data.draftId, now: Date.now() });
      } catch (error) {
        if (!safeWriteErrorSignal(error).includes("WRITE_INTENT_COMMIT_IN_PROGRESS")) throw error;
        // A concurrent confirmation already owns the short Convex commit
        // lease. Wait for its terminal result so double-click/retry callers
        // observe idempotent success instead of a transient failure.
        let concurrent = await repository.getWriteIntent(actor, params.data.draftId);
        for (let attempt = 0; attempt < 50 && concurrent?.status === "committing"; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          concurrent = await repository.getWriteIntent(actor, params.data.draftId);
        }
        if (concurrent?.status === "committed") {
          return res.json({ success: true, data: { draftId: params.data.draftId, status: "committed", idempotent: true } });
        }
        if (concurrent?.status === "stale") return res.status(409).json({ success: false, error: "DRAFT_STALE" });
        if (concurrent?.status === "failed") return res.status(500).json({ success: false, error: concurrent.errorCode ?? "INTERNAL_ERROR" });
        return res.status(409).json({ success: false, error: "DRAFT_IN_PROGRESS" });
      }
      if (claimed.status === "committed") return res.json({ success: true, data: { draftId: params.data.draftId, status: "committed", idempotent: true } });
      await appendWriteEvent(repository, actor, record.intent, "write.started", { draftId: params.data.draftId, toolId: record.intent.envelope.toolId });
      try {
        const committed = await definition.commit(actor, record.intent);
        await repository.finalizeWriteIntent(actor, { draftId: params.data.draftId, expectedStatus: "committing", status: "committed", now: Date.now(), result: committed });
        await appendWriteEvent(repository, actor, record.intent, "write.committed", { draftId: params.data.draftId, outcome: committed.outcome, idempotent: committed.idempotent });
        const run = await repository.getRun(actor, record.intent.envelope.sourceRunId);
        if (run?.status === "awaiting_confirmation") await repository.updateRun(actor, run.runId, { status: "completed", resultSummary: "Confirmed write committed", completedAt: Date.now() }, "awaiting_confirmation");
        return res.json({ success: true, data: { draftId: params.data.draftId, status: "committed", idempotent: committed.idempotent } });
      } catch (error) {
        const code = error instanceof SafeWriteCommitError ? error.code : "INTERNAL";
        const stale = code === "PRECONDITION_FAILED" || code === "STALE_REFERENCE";
        await repository.finalizeWriteIntent(actor, { draftId: params.data.draftId, expectedStatus: "committing", status: stale ? "stale" : "failed", now: Date.now(), errorCode: code });
        await appendWriteEvent(repository, actor, record.intent, stale ? "draft.stale" : "write.failed", { draftId: params.data.draftId, errorCode: code });
        if (stale) await appendWriteEvent(repository, actor, record.intent, "write.failed", { draftId: params.data.draftId, errorCode: code, mutation: false });
        const run = await repository.getRun(actor, record.intent.envelope.sourceRunId);
        if (run?.status === "awaiting_confirmation") await repository.updateRun(actor, run.runId, { status: "failed", errorCode: code, resultSummary: stale ? "Draft became stale" : "Confirmed write failed", completedAt: Date.now() }, "awaiting_confirmation");
        return res.status(stale ? 409 : code === "PERMISSION_DENIED" ? 403 : 500).json({ success: false, error: stale ? "DRAFT_STALE" : code });
      }
    } catch (error) {
      const message = safeWriteErrorSignal(error);
      const forbidden = /FORBIDDEN|ACTOR_MISMATCH/.test(message);
      const conflict = /IN_PROGRESS|CANCELLED|STALE|EXPIRED|NOT_CONFIRMED/.test(message);
      return res.status(forbidden ? 403 : conflict ? 409 : /TOKEN|SIGNATURE|INVALID/.test(message) ? 400 : 500).json({ success: false, error: forbidden ? "FORBIDDEN" : conflict ? "DRAFT_CONFLICT" : /TOKEN/.test(message) ? "DRAFT_TOKEN_INVALID" : /SIGNATURE/.test(message) ? "DRAFT_SIGNATURE_INVALID" : "INTERNAL_ERROR" });
    }
  });

  app.post("/v1/write-drafts/:draftId/cancel", async (req, res) => {
    const authorization = req.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "UNAUTHENTICATED" });
    const params = draftIdSchema.safeParse(req.params);
    if (!params.success) return res.status(400).json({ success: false, error: "INVALID_DRAFT_CANCELLATION" });
    try {
      const { actor, repository } = await safeWriteContext(authorization.slice(7));
      const record = await repository.getWriteIntent(actor, params.data.draftId);
      if (!record) return res.status(404).json({ success: false, error: "DRAFT_NOT_FOUND" });
      // Cancellation is a non-escalating terminal action. The same actor in the
      // same tenant may cancel after re-authentication or session rotation; only
      // confirmation remains bound to the exact originating session/version.
      assertIntentOwner(actor, record.intent);
      const cancelled = await repository.cancelWriteIntent(actor, { draftId: params.data.draftId, now: Date.now() });
      await appendWriteEvent(repository, actor, record.intent, cancelled.status === "expired" ? "draft.expired" : "draft.cancelled", { draftId: params.data.draftId });
      const run = await repository.getRun(actor, record.intent.envelope.sourceRunId);
      if (run?.status === "awaiting_confirmation") await repository.updateRun(actor, run.runId, { status: cancelled.status === "expired" ? "failed" : "cancelled", errorCode: cancelled.status === "expired" ? "DRAFT_EXPIRED" : undefined, resultSummary: cancelled.status === "expired" ? "Draft expired" : "Draft cancelled", completedAt: Date.now() }, "awaiting_confirmation");
      return res.json({ success: true, data: { draftId: params.data.draftId, status: cancelled.status } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(/FORBIDDEN|ACTOR_MISMATCH/.test(message) ? 403 : /CANCELLABLE|EXPIRED/.test(message) ? 409 : 500).json({ success: false, error: /FORBIDDEN|ACTOR_MISMATCH/.test(message) ? "FORBIDDEN" : "DRAFT_CONFLICT" });
    }
  });
  return app;
}
