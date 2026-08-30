import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createActorContext, type ActorContext } from "../contracts/actor-context.js";
import { DefaultPolicyEngine } from "../policy/engine.js";
import {
  createCrmSearchLeadsTool,
  toCrmSearchExecutionResult,
  type CrmSearchLeadsInput,
  type LeadSearchPort,
  type LeadSearchServiceResult,
} from "../product-tools/crm/search-leads.js";
import {
  createPropertySearchPropertiesTool,
  toPropertySearchExecutionResult,
  type PropertySearchFilters,
  type PropertySearchPort,
  type PropertySearchServiceItem,
  type PropertySearchServiceResult,
} from "../product-tools/property/search-properties.js";
import {
  createPropertyGetPropertyTool,
  toPropertyGetExecutionResult,
  type PropertyDetailPort,
  type PropertyDetailServiceResult,
  type PropertyGetPropertyOutput,
} from "../product-tools/property/get-property.js";
import {
  createCrmGetLeadContextTool,
  toCrmLeadContextExecutionResult,
  type CrmGetLeadContextOutput,
  type LeadContextPort,
  type LeadContextServiceResult,
} from "../product-tools/crm/get-lead-context.js";
import {
  createListLeadVisitsTool,
  toLeadVisitsExecutionResult,
  type LeadVisitsPort,
  type LeadVisitsServiceResult,
  type ListLeadVisitsInput,
  type ListLeadVisitsOutput,
} from "../product-tools/visits/list-lead-visits.js";
import {
  createGetVisitTool,
  toVisitDetailExecutionResult,
  type GetVisitOutput,
  type VisitDetailPort,
  type VisitDetailServiceResult,
} from "../product-tools/visits/get-visit.js";
import {
  createSearchVisitsTool,
  toSearchVisitsExecutionResult,
  type SearchVisitsInput,
  type SearchVisitsOutput,
  type VisitSearchPort,
  type VisitSearchServiceResult,
} from "../product-tools/visits/search-visits.js";
import { OpenRouterAdapter } from "../runtime/openrouter-adapter.js";
import { ProductToolRegistry } from "../tools/registry.js";
import type { AgentContentBlock, ExecutionResult } from "../contracts/execution-result.js";
import type { EntityRef, ExecutionProfileId } from "../contracts/domain.js";
import type { AgentMessageRecord } from "../control-plane/repository.js";
import type { RuntimeTool } from "../../runtimes/types.js";
import type { ConversationProposal } from "./boop-interaction-shadow.js";
import type { ShadowEvidence } from "./boop-interaction-shadow.js";
import {
  buildInteractionExecutionBrief,
  formatInteractionExecutionBrief,
  type PreviousReadContext,
} from "./interaction-execution-brief.js";
import { InteractionLabControlPlaneRepository } from "./interaction-lab-control-plane.js";
import { PrepareLeadBriefVerticalSlice } from "../skills/prepare-lead-brief.js";
import { PrepareVisitBriefVerticalSlice } from "../skills/prepare-visit-brief.js";
import { LeadOpportunityOrchestrationRunner } from "../orchestration/runner.js";

type LoginUser = {
  id: number | string;
  tenant_id: number | string;
  role: "agent" | "admin" | "superadmin";
  tenant_name?: string;
};

type LoginResponse = {
  accessToken?: string;
  user?: LoginUser;
  data?: { accessToken?: string; user?: LoginUser };
};

type ListResponse<T> = {
  success?: boolean;
  data?: { items?: T[]; total?: number; page?: number; limit?: number };
  error?: string;
};

type DetailResponse<T> = { success?: boolean; data?: T; error?: string };

export type InteractionLabTenantStatus = Readonly<{
  connected: boolean;
  tenantId?: string;
  tenantName?: string;
  userId?: string;
  role?: string;
  mode: "read_only";
}>;

export type InteractionLabAuthenticatedSession = Readonly<{
  accessToken: string;
  tenantId: string;
  userId: string;
  role: "agent" | "admin" | "superadmin";
  tenantName?: string;
  sessionId: string;
  effectiveTenantOverride?: boolean;
}>;

export type InteractionLabReadResult = Readonly<{
  action: string;
  executionKind: "tool" | "skill" | "workflow" | "write";
  summary: string;
  blocks?: readonly AgentContentBlock[];
  entities: readonly { type: string; id: string; label?: string; deepLink?: string }[];
  status: ExecutionResult<unknown>["status"];
  effectiveInput: Readonly<Record<string, unknown>>;
  toolCalls: number;
  runCount: number;
  telemetry: { model: string; latencyMs: number; inputTokens: number; outputTokens: number; costUsd: number };
  writeDraft?: Readonly<{ signedIntent: unknown; confirmationToken: string }>;
}>;

type InteractionLabReadTool =
  | ReturnType<typeof createCrmSearchLeadsTool>
  | ReturnType<typeof createPropertySearchPropertiesTool>
  | ReturnType<typeof createPropertyGetPropertyTool>
  | ReturnType<typeof createCrmGetLeadContextTool>
  | ReturnType<typeof createSearchVisitsTool>
  | ReturnType<typeof createListLeadVisitsTool>
  | ReturnType<typeof createGetVisitTool>;

type ReadToolPlan = Readonly<{
  tool: InteractionLabReadTool;
  profileId: ExecutionProfileId;
  capability: string;
  systemPrompt: string;
  target?: Readonly<{ field: "property" | "lead" | "visit"; ref: EntityRef }>;
  toExecution: (data: unknown) => ExecutionResult<unknown>;
}>;

function required(name: string): string {
  const path = process.env[`${name}_FILE`]?.trim();
  const value = path ? readFileSync(path, "utf8").trim() : process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the connected Interaction Lab`);
  return value;
}

function queryString(values: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  return query.toString();
}

function madridDateKey(offsetDays = 0): string {
  const current = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const [year, month, day] = current.split("-").map(Number);
  const shifted = new Date(Date.UTC(year!, month! - 1, day! + offsetDays));
  return shifted.toISOString().slice(0, 10);
}

function madridWeekRange(): Readonly<{ from: string; to: string }> {
  const today = madridDateKey();
  const [year, month, day] = today.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  const mondayOffset = -((date.getUTCDay() + 6) % 7);
  return { from: madridDateKey(mondayOffset), to: madridDateKey(mondayOffset + 6) };
}

function propertyFeatures(item: Record<string, unknown>): string[] {
  const flags: Array<[string, string]> = [
    ["is_exterior", "exterior"], ["has_elevator", "ascensor"], ["has_garage", "garaje"],
    ["has_pool", "piscina"], ["has_garden", "jardin"], ["has_terrace", "terraza"],
    ["has_ac", "aire_acondicionado"], ["has_storage", "trastero"], ["a_reformar", "a_reformar"],
    ["reformado", "reformado"], ["amueblado", "amueblado"], ["balcon", "balcon"],
  ];
  return flags.filter(([key]) => Boolean(item[key])).map(([, feature]) => feature);
}

export function resolveAuthorizedEvidenceCandidate(
  proposal: ConversationProposal,
  evidence: ShadowEvidence,
  allowedTypes: readonly string[],
): EntityRef {
  const proposed = proposal.candidateRefs.find((candidate) => allowedTypes.includes(candidate.type));
  const indexed = proposed ? evidence.entityIndex?.[proposed.evidenceKey] : undefined;
  if (!proposed || !indexed || indexed.ref.type !== proposed.type || !allowedTypes.includes(indexed.ref.type)) {
    throw new Error("INTERACTION_LAB_AUTHORIZED_TARGET_REQUIRED");
  }
  return indexed.ref;
}

export function sanitizeInteractionLabEffectiveInput(args: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const values = { ...args };
  delete values.property;
  delete values.lead;
  delete values.visit;
  return Object.freeze(values);
}

export function isInteractionLabMissingAuthorizedTarget(cause: unknown): boolean {
  return cause instanceof Error && cause.message === "INTERACTION_LAB_AUTHORIZED_TARGET_REQUIRED";
}

export function interactionLabMissingTargetSummary(proposal: ConversationProposal): string {
  if (proposal.domain === "visits") {
    return "No tengo una visita concreta y autorizada a la que referirme. ¿Qué visita quieres consultar?";
  }
  if (proposal.domain === "property") {
    return "No tengo un inmueble concreto y autorizado al que referirme. ¿Qué inmueble quieres consultar?";
  }
  if (proposal.domain === "crm") {
    return "No tengo un lead concreto y autorizado al que referirme. ¿Qué lead quieres consultar?";
  }
  return "No tengo una entidad concreta y autorizada a la que referirme. ¿Cuál quieres consultar?";
}

export class InteractionLabHostmateConnection {
  private accessToken?: string;
  private actor?: ActorContext;
  private tenantName?: string;

  private readonly baseUrl = (process.env.INTERACTION_LAB_HOSTMATE_BASE_URL ?? "https://realestate.hostmate.es").replace(/\/$/, "");
  constructor(session?: InteractionLabAuthenticatedSession) {
    if (!session) return;
    this.accessToken = session.accessToken;
    this.tenantName = session.tenantName;
    this.actor = createActorContext({
      tenantId: session.tenantId,
      userId: session.userId,
      role: session.role,
      isSuperAdmin: session.role === "superadmin",
      permissions: ["crm.read", "property.read", "visits.read"],
      locale: "es-ES",
      timezone: "Europe/Madrid",
      sessionId: session.sessionId,
      permissionsVersion: "production-read-only-v1",
      effectiveTenantOverride: session.effectiveTenantOverride ?? false,
    });
  }

  async connect(): Promise<InteractionLabTenantStatus> {
    if (this.accessToken && this.actor) return this.status();
    const expectedTenantId = required("INTERACTION_LAB_HOSTMATE_TENANT_ID");
    const response = await fetch(`${this.baseUrl}/api/v2/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: required("INTERACTION_LAB_HOSTMATE_EMAIL"),
        password: required("INTERACTION_LAB_HOSTMATE_PASSWORD"),
        tenant_id: Number(expectedTenantId),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json() as LoginResponse;
    const token = payload.accessToken ?? payload.data?.accessToken;
    const user = payload.user ?? payload.data?.user;
    if (!response.ok || !token || !user) throw new Error(`Hostmate login failed (${response.status})`);
    if (String(user.tenant_id) !== expectedTenantId) throw new Error("Authenticated tenant does not match the configured lab tenant");

    this.accessToken = token;
    this.tenantName = user.tenant_name;
    this.actor = createActorContext({
      tenantId: String(user.tenant_id),
      userId: String(user.id),
      role: user.role,
      isSuperAdmin: user.role === "superadmin",
      permissions: ["crm.read", "property.read", "visits.read"],
      locale: "es-ES",
      timezone: "Europe/Madrid",
      sessionId: `interaction-lab-${randomUUID()}`,
      permissionsVersion: "lab-read-only-v1",
      effectiveTenantOverride: false,
    });
    return this.status();
  }

  status(): InteractionLabTenantStatus {
    return {
      connected: Boolean(this.accessToken && this.actor),
      tenantId: this.actor?.tenantId,
      tenantName: this.tenantName,
      userId: this.actor?.userId,
      role: this.actor?.role,
      mode: "read_only",
    };
  }

  async executeRead(input: {
    conversationId: string;
    proposal: ConversationProposal;
    message: string;
    evidence: ShadowEvidence;
    priorMessages?: readonly AgentMessageRecord[];
    previousRead?: PreviousReadContext | null;
    openRouterApiKey: string;
    model: string;
    reasoningEffort: "max" | "xhigh" | "high" | "medium" | "low" | "minimal" | "none";
    fallbackModels?: readonly string[];
  }): Promise<InteractionLabReadResult | null> {
    if (!this.actor || !this.accessToken) await this.connect();
    const actor = this.actor!;
    const runtime = new OpenRouterAdapter({ apiKey: input.openRouterApiKey, appName: "Hostmate Interaction Lab" });
    try {
      if (input.proposal.action === "skill.prepare-lead-brief.v1" || input.proposal.action === "skill.prepare-visit-brief.v1") {
        return this.executeSkill({ ...input, actor, runtime, priorMessages: input.priorMessages ?? [] });
      }
      if (input.proposal.action === "multi-agent.lead-opportunity-analysis.v1") {
        return this.executeLeadOpportunityWorkflow({ ...input, actor, runtime, priorMessages: input.priorMessages ?? [] });
      }
      const brief = buildInteractionExecutionBrief({
        proposal: input.proposal,
        currentMessage: input.message,
        evidence: input.evidence,
        previousRead: input.previousRead,
      });
      const executionPrompt = formatInteractionExecutionBrief(brief);
      const plan = this.readToolPlan(input.proposal, input.evidence);
      if (!plan) return null;
      return this.runTool({
        ...input,
        actor,
        runtime,
        ...plan,
        message: executionPrompt,
        currentUserMessage: input.message,
      });
    } catch (cause) {
      if (!isInteractionLabMissingAuthorizedTarget(cause)) throw cause;
      return {
        action: input.proposal.action,
        executionKind: input.proposal.delegationProposal.kind === "skill"
          ? "skill"
          : input.proposal.delegationProposal.kind === "multi_agent"
            ? "workflow"
            : "tool",
        summary: interactionLabMissingTargetSummary(input.proposal),
        entities: [],
        status: "needs_input",
        effectiveInput: {},
        toolCalls: 0,
        runCount: 0,
        telemetry: { model: input.model, latencyMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
      };
    }
  }

  async prepareVisitDraft(input: {
    conversationId: string;
    proposal: ConversationProposal;
    evidence: ShadowEvidence;
    model: string;
  }): Promise<InteractionLabReadResult> {
    if (!this.actor || !this.accessToken) await this.connect();
    if (!input.proposal.visitDraft) throw new Error("INTERACTION_VISIT_TEMPORAL_REQUIRED");
    const leadProposal = input.proposal.candidateRefs.find((candidate) => candidate.type === "crm.lead");
    const propertyProposal = input.proposal.candidateRefs.find((candidate) => candidate.type === "property.property");
    const lead = this.authorizedCandidate(input.proposal, input.evidence, ["crm.lead"]);
    const property = this.authorizedCandidate(input.proposal, input.evidence, ["property.property"]);
    if (!leadProposal || !propertyProposal) throw new Error("INTERACTION_LAB_AUTHORIZED_TARGET_REQUIRED");
    const payload = await this.post<{ success?: boolean; data?: {
      confirmationToken: string;
      signedIntent: unknown;
      card: { title: string; risk: "R2"; fields: Array<{ label: string; value: string }>; effects: string[]; expiresAt: string };
    }; error?: string; message?: string }>("/api/v2/ai-interaction/visit-drafts", {
      conversationId: input.conversationId,
      leadId: lead.id,
      propertyId: property.id,
      startDate: input.proposal.visitDraft.startDate,
      startTime: input.proposal.visitDraft.startTime,
      temporalPhrase: input.proposal.visitDraft.temporalPhrase,
      provenance: { leadEvidenceKey: leadProposal.evidenceKey, propertyEvidenceKey: propertyProposal.evidenceKey },
    });
    if (!payload.success || !payload.data) {
      const denied = payload.error === "PERMISSION_DENIED";
      return {
        action: "visits.create_visit.v1", executionKind: "write",
        summary: payload.message ?? (denied ? "No tienes permiso para crear visitas con el agente." : "No puedo preparar esta visita con los datos actuales."),
        entities: [lead, property], status: denied ? "permission_denied" : "needs_input",
        effectiveInput: {}, toolCalls: 0, runCount: 0,
        telemetry: { model: input.model, latencyMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
      };
    }
    const card = payload.data.card;
    return {
      action: "visits.create_visit.v1",
      executionKind: "write",
      summary: "He preparado la visita. Revisa los datos y confirma solo si son correctos.",
      blocks: [{
        type: "action_confirmation",
        draftId: String((payload.data.signedIntent as { envelope?: { draftId?: string } }).envelope?.draftId ?? ""),
        confirmationToken: payload.data.confirmationToken,
        title: card.title,
        description: "La visita todavía no se ha creado.",
        target: lead,
        changes: card.fields.map((field) => ({ field: field.label, to: field.value })),
        sideEffects: card.effects,
        risk: card.risk,
        expiresAt: Date.parse(card.expiresAt),
        successMessage: "Visita creada correctamente.",
      }],
      entities: [lead, property],
      status: "completed",
      effectiveInput: { startDate: input.proposal.visitDraft.startDate, startTime: input.proposal.visitDraft.startTime },
      toolCalls: 0,
      runCount: 0,
      telemetry: { model: input.model, latencyMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
      writeDraft: { signedIntent: payload.data.signedIntent, confirmationToken: payload.data.confirmationToken },
    };
  }

  private async executeSkill(input: Readonly<{
    proposal: ConversationProposal;
    conversationId: string;
    message: string;
    evidence: ShadowEvidence;
    priorMessages: readonly AgentMessageRecord[];
    actor: ActorContext;
    runtime: OpenRouterAdapter;
    model: string;
    reasoningEffort: "max" | "xhigh" | "high" | "medium" | "low" | "minimal" | "none";
    fallbackModels?: readonly string[];
  }>): Promise<InteractionLabReadResult> {
    const startedAt = performance.now();
    const repository = new InteractionLabControlPlaneRepository(input.priorMessages);
    const turn = input.proposal.action === "skill.prepare-lead-brief.v1"
      ? await new PrepareLeadBriefVerticalSlice(
          repository,
          { getContext: (_actor, detailInput) => this.getLeadContext(detailInput.lead.id) },
          true,
        ).execute(input.actor, {
          conversationId: input.conversationId,
          message: input.message,
          selectedEntityRef: this.authorizedCandidate(input.proposal, input.evidence, ["crm.lead"]),
        })
      : await new PrepareVisitBriefVerticalSlice(
          repository,
          { getVisit: (_actor, detailInput) => this.getVisitDetail(detailInput.visit) },
          { getContext: (_actor, detailInput) => this.getLeadContext(detailInput.lead.id) },
          { get: (_actor, detailInput) => this.getPropertyDetail(detailInput.property.id) },
          true,
        ).execute(input.actor, {
          conversationId: input.conversationId,
          message: input.message,
          selectedEntityRef: this.authorizedCandidate(input.proposal, input.evidence, ["visits.visit", "visits.group_visit"]),
        });
    return this.toCompositeResult({
      action: input.proposal.action,
      executionKind: "skill",
      execution: turn.result,
      repository,
      runtime: input.runtime,
      currentMessage: input.message,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      fallbackModels: input.fallbackModels,
      startedAt,
    });
  }

  private async executeLeadOpportunityWorkflow(input: Readonly<{
    proposal: ConversationProposal;
    conversationId: string;
    message: string;
    evidence: ShadowEvidence;
    priorMessages: readonly AgentMessageRecord[];
    actor: ActorContext;
    runtime: OpenRouterAdapter;
    model: string;
    reasoningEffort: "max" | "xhigh" | "high" | "medium" | "low" | "minimal" | "none";
    fallbackModels?: readonly string[];
  }>): Promise<InteractionLabReadResult> {
    const startedAt = performance.now();
    const repository = new InteractionLabControlPlaneRepository(input.priorMessages);
    const lead = this.authorizedCandidate(input.proposal, input.evidence, ["crm.lead"]);
    const workflow = await new LeadOpportunityOrchestrationRunner({
      repository,
      leadContextPort: { getContext: (_actor, detailInput) => this.getLeadContext(detailInput.lead.id) },
      leadVisitsPort: { listLeadVisits: (_actor, listInput) => this.listLeadVisits(listInput) },
      propertySearchPort: { search: (_actor, filters) => this.searchProperties(filters) },
    }, true).execute(input.actor, {
      conversationId: input.conversationId,
      message: input.message,
      selectedEntityRef: lead,
      priorMessages: input.priorMessages,
    });
    return this.toCompositeResult({
      action: input.proposal.action,
      executionKind: "workflow",
      execution: workflow.result,
      repository,
      runtime: input.runtime,
      currentMessage: input.message,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      fallbackModels: input.fallbackModels,
      startedAt,
    });
  }

  private async toCompositeResult(input: Readonly<{
    action: string;
    executionKind: "skill" | "workflow";
    execution: ExecutionResult<unknown>;
    repository: InteractionLabControlPlaneRepository;
    runtime: OpenRouterAdapter;
    currentMessage: string;
    model: string;
    reasoningEffort: "max" | "xhigh" | "high" | "medium" | "low" | "minimal" | "none";
    fallbackModels?: readonly string[];
    startedAt: number;
  }>): Promise<InteractionLabReadResult> {
    const reply = await this.composeReadReply({
      runtime: input.runtime,
      currentMessage: input.currentMessage,
      execution: input.execution,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      fallbackModels: input.fallbackModels,
    });
    const snapshot = input.repository.snapshot();
    return {
      action: input.action,
      executionKind: input.executionKind,
      summary: reply.text,
      blocks: input.execution.blocks,
      entities: input.execution.entities,
      status: input.execution.status,
      effectiveInput: {},
      toolCalls: snapshot.events.filter((event) => event.type === "tool.completed").length,
      runCount: snapshot.runs.length,
      telemetry: {
        model: reply.model,
        latencyMs: performance.now() - input.startedAt,
        inputTokens: reply.inputTokens,
        outputTokens: reply.outputTokens,
        costUsd: reply.costUsd,
      },
    };
  }

  private readToolPlan(proposal: ConversationProposal, evidence: ShadowEvidence): ReadToolPlan | null {
    if (!this.accessToken) throw new Error("Interaction Lab is not authenticated");
    if (proposal.action === "crm.search_leads.v1") {
      const port: LeadSearchPort = { search: (_actor, filters) => this.searchLeads(filters) };
      return {
        tool: createCrmSearchLeadsTool({ port }), profileId: "crm", capability: "crm.lead.search",
        systemPrompt: [
          "Eres el Execution Agent de solo lectura para buscar leads en Hostmate.",
          "Llama exactamente una vez a crm.search_leads.",
          "Extrae los filtros efectivos del Interaction Execution Brief. Conserva criterios compatibles de la lectura anterior cuando el mensaje actual sea una continuación.",
          "Nombre, teléfono o email van en query. No inventes IDs, tenant, ciudad, estado ni datos personales.",
        ].join("\n"),
        toExecution: (data) => toCrmSearchExecutionResult(data as never),
      };
    }
    if (proposal.action === "property.search_properties.v1") {
      const port: PropertySearchPort = { search: (_actor, filters) => this.searchProperties(filters) };
      return {
        tool: createPropertySearchPropertiesTool({ port }), profileId: "property", capability: "property.property.search",
        systemPrompt: [
          "Eres el Execution Agent de solo lectura para buscar inmuebles en Hostmate.",
          "Llama exactamente una vez a property.search_properties.",
          "Extrae los filtros efectivos del Interaction Execution Brief y usa solo el schema de la Tool.",
          "Si el mensaje actual refina o verifica la búsqueda anterior, conserva sus criterios compatibles; si inicia otra búsqueda, sustitúyelos.",
          "No inventes tenant, IDs, ubicación, operación, precio, características ni orden.",
        ].join("\n"),
        toExecution: (data) => toPropertySearchExecutionResult(data as never),
      };
    }
    if (proposal.action === "property.get_property.v1") {
      const ref = this.authorizedCandidate(proposal, evidence, ["property.property"]);
      const port: PropertyDetailPort = { get: (_actor, detailInput) => this.getPropertyDetail(detailInput.property.id) };
      return {
        tool: createPropertyGetPropertyTool({ port }),
        profileId: "property", capability: "property.property.read",
        systemPrompt: "Eres el Execution Agent de solo lectura para consultar un inmueble. Llama exactamente una vez a property.get_property usando exactamente el AUTHORIZED TARGET del brief. No busques ni cambies el target.",
        target: { field: "property", ref },
        toExecution: (data) => toPropertyGetExecutionResult(data as PropertyGetPropertyOutput),
      };
    }
    if (proposal.action === "crm.get_lead_context.v1") {
      const ref = this.authorizedCandidate(proposal, evidence, ["crm.lead"]);
      const port: LeadContextPort = { getContext: (_actor, detailInput) => this.getLeadContext(detailInput.lead.id) };
      return {
        tool: createCrmGetLeadContextTool({ port }),
        profileId: "crm", capability: "crm.lead.context",
        systemPrompt: "Eres el Execution Agent de solo lectura para consultar el contexto de un lead. Llama exactamente una vez a crm.get_lead_context usando exactamente el AUTHORIZED TARGET del brief. No busques ni cambies el target.",
        target: { field: "lead", ref },
        toExecution: (data) => toCrmLeadContextExecutionResult(data as CrmGetLeadContextOutput),
      };
    }
    if (proposal.action === "visits.search_visits.v1") {
      const proposedTarget = proposal.candidateRefs.find((candidate) =>
        candidate.type === "crm.lead" || candidate.type === "property.property");
      const ref = proposedTarget
        ? this.authorizedCandidate(proposal, evidence, [proposedTarget.type])
        : undefined;
      const port: VisitSearchPort = { searchVisits: (actor, searchInput) => this.searchVisits(actor, searchInput) };
      return {
        tool: createSearchVisitsTool({ port }),
        profileId: "visits", capability: "visits.visit.search",
        systemPrompt: [
          "Eres el Execution Agent de solo lectura para consultar la agenda de visitas.",
          "Llama exactamente una vez a visits.search_visits.",
          "Traduce únicamente el periodo, estado y ámbito expresados por el usuario.",
          "Si existe AUTHORIZED TARGET, úsalo exactamente como lead o property. No inventes relaciones, IDs ni tenant.",
          "Si existe AUTHORIZED TARGET y el usuario no expresa periodo, usa timeframe=all y ownership=tenant: la EntityRef ya acota la consulta.",
          "Sin target, usa timeframe=upcoming y ownership=mine salvo que un Admin pida explícitamente la agenda del equipo o del tenant.",
        ].join("\n"),
        ...(ref ? { target: { field: ref.type === "crm.lead" ? "lead" as const : "property" as const, ref } } : {}),
        toExecution: (data) => toSearchVisitsExecutionResult(data as SearchVisitsOutput),
      };
    }
    if (proposal.action === "visits.list_lead_visits.v1") {
      const ref = this.authorizedCandidate(proposal, evidence, ["crm.lead"]);
      const port: LeadVisitsPort = { listLeadVisits: (_actor, listInput) => this.listLeadVisits(listInput) };
      return {
        tool: createListLeadVisitsTool({ port }),
        profileId: "visits", capability: "visits.lead.list",
        systemPrompt: "Eres el Execution Agent de solo lectura para listar visitas. Llama exactamente una vez a visits.list_lead_visits usando exactamente el AUTHORIZED TARGET del brief. Solo interpreta scope/status cuando el usuario los haya expresado.",
        target: { field: "lead", ref },
        toExecution: (data) => toLeadVisitsExecutionResult(data as ListLeadVisitsOutput),
      };
    }
    if (proposal.action === "visits.get_visit.v1") {
      const ref = this.authorizedCandidate(proposal, evidence, ["visits.visit", "visits.group_visit"]);
      const port: VisitDetailPort = { getVisit: (_actor, detailInput) => this.getVisitDetail(detailInput.visit) };
      return {
        tool: createGetVisitTool({ port }),
        profileId: "visits", capability: "visits.visit.detail",
        systemPrompt: "Eres el Execution Agent de solo lectura para consultar una visita. Llama exactamente una vez a visits.get_visit usando exactamente el AUTHORIZED TARGET del brief. No busques ni cambies el target.",
        target: { field: "visit", ref },
        toExecution: (data) => toVisitDetailExecutionResult(data as GetVisitOutput),
      };
    }
    return null;
  }

  private authorizedCandidate(
    proposal: ConversationProposal,
    evidence: ShadowEvidence,
    allowedTypes: readonly string[],
  ): EntityRef {
    return resolveAuthorizedEvidenceCandidate(proposal, evidence, allowedTypes);
  }

  private async runTool(input: {
    actor: ActorContext;
    runtime: OpenRouterAdapter;
    tool: InteractionLabReadTool;
    profileId: ExecutionProfileId;
    capability: string;
    message: string;
    currentUserMessage: string;
    systemPrompt: string;
    model: string;
    reasoningEffort: "max" | "xhigh" | "high" | "medium" | "low" | "minimal" | "none";
    fallbackModels?: readonly string[];
    target?: ReadToolPlan["target"];
    toExecution: ReadToolPlan["toExecution"];
  }): Promise<InteractionLabReadResult> {
    const registry = new ProductToolRegistry([input.tool]);
    const resolved = registry.resolve({
      profileId: input.profileId,
      objectiveCapabilities: [input.capability],
      actor: input.actor,
      allowedToolIds: [input.tool.toolId],
      featureEnabled: (toolId) => toolId === input.tool.toolId,
      readOnly: true,
    });
    if (resolved.tools.length !== 1) throw new Error("Read Tool is outside the authenticated actor scope");
    const runtimeTools = registry.compileRuntimeTools({
      resolved,
      actor: input.actor,
      policy: new DefaultPolicyEngine(),
      profileId: input.profileId,
      decisionId: () => randomUUID(),
      hasRequiredPreconditions: () => true,
    });
    const targetBoundTools = input.target
      ? runtimeTools.map((tool) => this.bindAuthorizedTarget(tool, input.target!))
      : runtimeTools;
    const targetPrompt = input.target
      ? `\nAUTHORIZED TARGET (validated conversation provenance): ${JSON.stringify(input.target.ref)}`
      : "";
    let effectiveInput: Readonly<Record<string, unknown>> = {};
    const result = await input.runtime.run({
      prompt: `${input.message}${targetPrompt}`,
      systemPrompt: input.systemPrompt,
      model: input.model,
      mode: "execution",
      onToolUse: (_toolName, args) => {
        if (args && typeof args === "object" && !Array.isArray(args)) {
          effectiveInput = sanitizeInteractionLabEffectiveInput(args as Record<string, unknown>);
        }
      },
      tools: [...targetBoundTools],
      allowedTools: [input.tool.name],
    }, {
      fallbackModels: input.fallbackModels,
      reasoningEffort: input.reasoningEffort,
      budget: { timeoutMs: 120_000, maxToolRounds: 0, maxCostUsd: 0.05 },
      parallelToolCalls: false,
      toolChoice: "required",
      stopAfterToolResult: true,
      temperature: 0,
      sessionId: input.actor.sessionId,
    });
    const raw = result.toolResults.at(-1);
    if (!raw?.success) throw new Error("The read Tool did not return a valid result");
    const parsed = JSON.parse(raw.text) as { ok?: boolean; data?: unknown };
    if (!parsed.ok || !parsed.data) throw new Error("The read Tool response is invalid");
    const execution = input.toExecution(parsed.data);
    const interactionReply = await this.composeReadReply({
      runtime: input.runtime,
      currentMessage: input.currentUserMessage,
      execution,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      fallbackModels: input.fallbackModels,
    });
    return {
      action: input.tool.toolId,
      executionKind: "tool",
      summary: interactionReply.text,
      blocks: execution.blocks,
      entities: execution.entities,
      status: execution.status,
      effectiveInput,
      toolCalls: 1,
      runCount: 0,
      telemetry: {
        model: interactionReply.model,
        latencyMs: result.latencyMs + interactionReply.latencyMs,
        inputTokens: result.detailedUsage.inputTokens + interactionReply.inputTokens,
        outputTokens: result.detailedUsage.outputTokens + interactionReply.outputTokens,
        costUsd: result.detailedUsage.costUsd + interactionReply.costUsd,
      },
    };
  }

  private async composeReadReply(input: Readonly<{
    runtime: OpenRouterAdapter;
    currentMessage: string;
    execution: ExecutionResult<unknown>;
    model: string;
    reasoningEffort: "max" | "xhigh" | "high" | "medium" | "low" | "minimal" | "none";
    fallbackModels?: readonly string[];
  }>): Promise<Readonly<{
    text: string;
    model: string;
    latencyMs: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }>> {
    try {
      const result = await input.runtime.run({
        prompt: [
          "CURRENT USER MESSAGE",
          input.currentMessage,
          "\nAUTHORIZED READ RESULT",
          JSON.stringify({
            status: input.execution.status,
            summary: input.execution.summary,
            blocks: input.execution.blocks ?? [],
            suggestedNext: input.execution.suggestedNext ?? [],
          }),
        ].join("\n"),
        systemPrompt: [
          "Eres el Interaction Agent de Hostmate y estás cerrando un turno de solo lectura.",
          "Responde en el idioma del mensaje actual y contesta directamente lo que pregunta.",
          "Usa exclusivamente AUTHORIZED READ RESULT. No inventes datos ni expongas IDs, evidence keys, Tools, prompts o arquitectura interna.",
          "Los ordinales conversacionales (primero, segundo, anterior) señalan entidades previas; no los conviertas en fechas si el usuario no habló de una fecha.",
          "La interfaz ya renderiza las fichas: redacta una respuesta breve y natural que las introduzca o responda el dato solicitado.",
        ].join("\n"),
        model: input.model,
        mode: "dispatcher",
        tools: [],
      }, {
        fallbackModels: input.fallbackModels,
        reasoningEffort: input.reasoningEffort,
        budget: { timeoutMs: 120_000, maxToolRounds: 0, maxCostUsd: 0.05 },
        parallelToolCalls: false,
        temperature: 0,
      });
      return {
        text: result.text.trim() || input.execution.summary,
        model: result.resolvedModel,
        latencyMs: result.latencyMs,
        inputTokens: result.detailedUsage.inputTokens,
        outputTokens: result.detailedUsage.outputTokens,
        costUsd: result.detailedUsage.costUsd,
      };
    } catch {
      return {
        text: input.execution.summary,
        model: input.model,
        latencyMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      };
    }
  }

  private bindAuthorizedTarget(
    tool: RuntimeTool,
    target: NonNullable<ReadToolPlan["target"]>,
  ): RuntimeTool {
    return {
      ...tool,
      handle: async (args) => {
        const supplied = args[target.field] as Partial<EntityRef> | undefined;
        if (!supplied || supplied.type !== target.ref.type || supplied.id !== target.ref.id) {
          return { text: JSON.stringify({ ok: false, error: "AUTHORIZED_TARGET_MISMATCH" }), success: false };
        }
        return tool.handle(args);
      },
    };
  }

  private async get<T>(path: string): Promise<T> {
    if (!this.accessToken) await this.connect();
    const request = () => fetch(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        ...(this.actor?.effectiveTenantOverride ? { "x-tenant-id": this.actor.tenantId } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    let response = await request();
    if (response.status === 401) {
      await this.connect();
      response = await request();
    }
    const payload = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(`Hostmate read failed (${response.status}): ${payload.error ?? "unknown"}`);
    return payload;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    if (!this.accessToken) await this.connect();
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        "content-type": "application/json",
        "x-interaction-runtime-token": required("INTERACTION_RUNTIME_INTERNAL_TOKEN"),
        ...(this.actor?.effectiveTenantOverride ? { "x-tenant-id": this.actor.tenantId } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await response.json() as T;
    if (!response.ok) return payload;
    return payload;
  }

  private async searchLeads(input: CrmSearchLeadsInput): Promise<LeadSearchServiceResult> {
    const startedAt = performance.now();
    const payload = await this.get<ListResponse<Record<string, unknown>>>(`/api/v2/leads?${queryString({
      page: input.page,
      limit: input.limit,
      search: input.query,
      status: input.status,
      prop_city: input.city,
    })}`);
    if (!payload.success || !payload.data?.items) throw new Error("Hostmate lead response is invalid");
    return {
      items: payload.data.items.map((item) => ({
        id: String(item.id),
        client_name: typeof item.client_name === "string" ? item.client_name : null,
        client_phone: typeof item.client_phone === "string" ? item.client_phone : null,
        client_email: typeof item.client_email === "string" ? item.client_email : null,
        status: typeof item.status === "string" ? item.status : null,
        property_title: typeof item.property_title === "string" ? item.property_title : null,
        property_ref: typeof item.property_ref === "string" ? item.property_ref : null,
        agent_name: typeof item.agent_name === "string" ? item.agent_name : null,
        created_at: typeof item.created_at === "string" ? item.created_at : null,
      })),
      total: Number(payload.data.total ?? 0),
      page: Number(payload.data.page ?? input.page),
      limit: Number(payload.data.limit ?? input.limit),
      telemetry: { service: "lead.service.list", latencyMs: performance.now() - startedAt },
    };
  }

  private async searchProperties(input: PropertySearchFilters): Promise<PropertySearchServiceResult> {
    const startedAt = performance.now();
    const featureMap: Record<string, string> = {
      exterior: "is_exterior", ascensor: "has_elevator", garaje: "has_garage", piscina: "has_pool",
      jardin: "has_garden", terraza: "has_terrace", aire_acondicionado: "has_ac", trastero: "has_storage",
      a_reformar: "a_reformar", reformado: "reformado", amueblado: "amueblado", balcon: "balcon",
    };
    const params: Record<string, string | number | undefined> = {
      page: 1, limit: 6, search: input.query, city: input.city, neighborhood: input.neighborhood,
      type: input.operation, property_subtype: input.propertyType, status: input.status,
      min_price: input.minPrice, max_price: input.maxPrice, rooms: input.rooms, bathrooms: input.bathrooms,
      min_area: input.minArea, max_area: input.maxArea,
      sort_by: input.order ? (input.order === "newest" ? "created_at" : "price") : undefined,
      sort_dir: input.order ? (input.order === "price_asc" ? "ASC" : "DESC") : undefined,
    };
    for (const feature of input.features ?? []) params[featureMap[feature]!] = "true";
    const payload = await this.get<ListResponse<Record<string, unknown>>>(`/api/v2/properties?${queryString(params)}`);
    if (!payload.success || !payload.data?.items) throw new Error("Hostmate property response is invalid");
    const items: PropertySearchServiceItem[] = payload.data.items.map((item) => ({
      id: String(item.id),
      reference: typeof item.reference === "string" ? item.reference : String(item.id),
      title: typeof item.title === "string" ? item.title : `Inmueble ${String(item.id)}`,
      operation: typeof item.type === "string" ? item.type : null,
      propertyType: typeof item.property_subtype === "string" ? item.property_subtype : null,
      price: typeof item.price === "number" ? item.price : Number(item.price) || null,
      currency: "EUR",
      city: typeof item.city === "string" ? item.city : null,
      neighborhood: typeof item.neighborhood === "string" ? item.neighborhood : null,
      rooms: typeof item.rooms === "number" ? item.rooms : Number(item.rooms) || null,
      bathrooms: typeof item.bathrooms === "number" ? item.bathrooms : Number(item.bathrooms) || null,
      areaBuilt: typeof item.area_built === "number" ? item.area_built : Number(item.area_built) || null,
      status: typeof item.status === "string" ? item.status : null,
      imageUrl: typeof item.image_thumb === "string" ? item.image_thumb : typeof item.image === "string" ? item.image : undefined,
      features: propertyFeatures(item),
      associatedAgent: typeof item.agent_name === "string" ? item.agent_name : null,
    }));
    const total = Number(payload.data.total ?? 0);
    return {
      items,
      total,
      returned: items.length,
      hasMore: total > items.length,
      telemetry: { service: "property.service.list", latencyMs: performance.now() - startedAt },
    };
  }

  private async getPropertyDetail(id: string): Promise<PropertyDetailServiceResult> {
    const startedAt = performance.now();
    const payload = await this.get<DetailResponse<Record<string, unknown>>>(`/api/v2/properties/${encodeURIComponent(id)}`);
    if (!payload.success || !payload.data) throw new Error("Hostmate property detail response is invalid");
    const item = payload.data;
    const numberOrNull = (value: unknown) => value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
    const textOrNull = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
    const images = [item.image, item.image_medium, item.image_thumb]
      .filter((value, index, all): value is string => typeof value === "string" && value.length > 0 && all.indexOf(value) === index)
      .slice(0, 8)
      .map((url) => ({ url, thumbnailUrl: textOrNull(item.image_thumb), caption: null }));
    return {
      id: String(item.id),
      reference: textOrNull(item.reference) ?? id,
      title: textOrNull(item.title) ?? `Inmueble ${id}`,
      operation: textOrNull(item.type),
      propertyType: textOrNull(item.property_subtype),
      status: textOrNull(item.status),
      price: numberOrNull(item.price),
      currency: "EUR",
      location: { city: textOrNull(item.city), neighborhood: textOrNull(item.neighborhood), province: textOrNull(item.province) },
      specifications: {
        rooms: numberOrNull(item.rooms), bathrooms: numberOrNull(item.bathrooms), areaBuilt: numberOrNull(item.area_built),
        areaUseful: numberOrNull(item.area_useful), plotArea: numberOrNull(item.plot_area), floor: textOrNull(item.floor),
        yearBuilt: numberOrNull(item.year_built), ceilingHeight: numberOrNull(item.ceiling_height),
        loadingDocks: numberOrNull(item.loading_docks), powerSupplyKw: numberOrNull(item.power_supply_kw),
        officeArea: numberOrNull(item.office_area), storefrontCount: numberOrNull(item.storefront_count),
        grossYieldPct: numberOrNull(item.gross_yield_pct),
      },
      features: propertyFeatures(item),
      description: textOrNull(item.description),
      publicNotes: textOrNull(item.public_notes),
      images,
      associatedAgents: item.agent_id ? [{ id: String(item.agent_id), name: textOrNull(item.agent_name) ?? "Comercial", priority: 1 }] : [],
      telemetry: { services: ["property.service.getById"], latencyMs: performance.now() - startedAt },
    };
  }

  private async getLeadContext(id: string): Promise<LeadContextServiceResult> {
    const startedAt = performance.now();
    const payload = await this.get<DetailResponse<Record<string, unknown>>>(`/api/v2/leads/${encodeURIComponent(id)}`);
    if (!payload.success || !payload.data) throw new Error("Hostmate lead detail response is invalid");
    const item = payload.data;
    const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
    const num = (value: unknown) => value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
    return {
      lead: {
        id: String(item.id), name: text(item.client_name) ?? `Lead ${id}`, phone: text(item.client_phone), email: text(item.client_email),
        status: text(item.status), source: text(item.source), createdAt: text(item.created_at), lastActivityAt: text(item.updated_at),
        qualification: item.qualification_grade || item.qualification_score ? { grade: text(item.qualification_grade), score: num(item.qualification_score) } : null,
      },
      assignedAgent: item.agent_id ? { id: String(item.agent_id), name: text(item.agent_name) } : null,
      property: item.property_id ? {
        id: String(item.property_id), title: text(item.property_title), reference: text(item.property_ref),
        address: text(item.property_address), price: num(item.property_price), status: text(item.property_status),
      } : null,
      opportunity: null,
      activeDemand: null,
      nextVisit: null,
      pendingTasks: [],
      telemetry: { services: ["lead.service.getById"], latencyMs: performance.now() - startedAt },
    };
  }

  private async listLeadVisits(input: ListLeadVisitsInput): Promise<LeadVisitsServiceResult> {
    const startedAt = performance.now();
    if (!this.actor) await this.connect();
    const [leadPayload, searchResult] = await Promise.all([
      this.get<DetailResponse<Record<string, unknown>>>(`/api/v2/leads/${encodeURIComponent(input.lead.id)}`),
      this.searchVisits(this.actor!, {
        timeframe: input.scope,
        ownership: "tenant",
        status: input.status,
        lead: input.lead,
        limit: 10,
      }),
    ]);
    if (!leadPayload.success || !leadPayload.data) {
      throw new Error("Hostmate lead visits response is invalid");
    }
    const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
    return {
      lead: { id: String(leadPayload.data.id), name: text(leadPayload.data.client_name) ?? `Lead ${input.lead.id}` },
      visits: searchResult.visits.map((visit) => ({
        id: visit.id, kind: "individual" as const, at: visit.at,
        status: visit.status, property: visit.property ? {
          id: visit.property.id ?? undefined,
          title: visit.property.title,
          reference: visit.property.reference,
          address: visit.property.address,
        } : null,
        assignedAgent: visit.assignedAgent?.name ? { name: visit.assignedAgent.name } : null,
        visitType: visit.visitType, durationMinutes: visit.durationMinutes,
        clientConfirmation: null, isGroup: Boolean(visit.isGroup),
      })),
      metadata: {
        scope: input.scope, ...(input.status ? { status: input.status } : {}), total: searchResult.total,
        returned: searchResult.returned, hasMore: searchResult.hasMore, limit: 10,
      },
      telemetry: { services: ["visit.service.list", "lead.service.getById"], latencyMs: performance.now() - startedAt },
    };
  }

  private async searchVisits(actor: ActorContext, input: SearchVisitsInput): Promise<VisitSearchServiceResult> {
    const startedAt = performance.now();
    const week = input.timeframe === "this_week" ? madridWeekRange() : undefined;
    const dateFrom = input.timeframe === "today" ? madridDateKey()
      : input.timeframe === "tomorrow" ? madridDateKey(1)
        : input.timeframe === "this_week" ? week?.from
          : input.timeframe === "upcoming" ? madridDateKey()
            : undefined;
    const dateTo = input.timeframe === "today" ? madridDateKey()
      : input.timeframe === "tomorrow" ? madridDateKey(1)
        : input.timeframe === "this_week" ? week?.to
          : input.timeframe === "past" ? madridDateKey()
            : undefined;
    const payload = await this.get<ListResponse<Record<string, unknown>>>(`/api/v2/visits?${queryString({
      page: 1,
      limit: input.limit,
      status: input.status,
      lead_id: input.lead?.id,
      property_id: input.property?.id,
      agent_id: input.ownership === "mine" ? actor.userId : undefined,
      date_from: dateFrom,
      date_to: dateTo,
      sort_by: "visit_datetime",
      sort_dir: input.timeframe === "past" ? "desc" : "asc",
    })}`);
    if (!payload.success || !payload.data?.items) throw new Error("Hostmate visit search response is invalid");
    const now = Date.now();
    const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
    const scoped = payload.data.items.filter((visit) => {
      const at = new Date(String(visit.visit_datetime ?? visit.scheduled_at ?? "")).getTime();
      if (!Number.isFinite(at)) return false;
      if (input.timeframe === "upcoming") return at >= now;
      if (input.timeframe === "past") return at < now;
      return true;
    });
    const visits = scoped.map((visit) => ({
      id: String(visit.id),
      at: String(visit.visit_datetime ?? visit.scheduled_at),
      status: String(visit.status),
      clientName: text(visit.client_name),
      property: visit.property_id ? {
        id: String(visit.property_id),
        title: text(visit.property_title),
        reference: text(visit.property_ref),
        address: text(visit.property_address),
      } : null,
      lead: visit.lead_id ? { id: String(visit.lead_id), name: text(visit.client_name) } : null,
      assignedAgent: visit.agent_id || visit.agent_name ? {
        id: visit.agent_id ? String(visit.agent_id) : null,
        name: text(visit.agent_name),
      } : null,
      visitType: text(visit.visit_type),
      durationMinutes: Number(visit.duration_minutes) || null,
      isGroup: Boolean(visit.is_group_slot),
    }));
    return {
      visits,
      total: visits.length,
      returned: visits.length,
      hasMore: Number(payload.data.total ?? visits.length) > payload.data.items.length,
      telemetry: { service: "visit.service.list", latencyMs: performance.now() - startedAt },
    };
  }

  private async getVisitDetail(ref: EntityRef): Promise<VisitDetailServiceResult> {
    if (ref.type !== "visits.visit") throw new Error("Group visit detail is unavailable in the read-only lab adapter");
    const startedAt = performance.now();
    const payload = await this.get<DetailResponse<Record<string, unknown>>>(`/api/v2/visits/${encodeURIComponent(ref.id)}`);
    if (!payload.success || !payload.data) throw new Error("Hostmate visit detail response is invalid");
    const item = payload.data;
    const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
    const propertyId = item.property_id ? String(item.property_id) : null;
    let property = propertyId ? {
      id: propertyId,
      title: text(item.property_title),
      reference: text(item.property_ref),
      address: text(item.property_address),
    } : null;
    const services = ["visit.service.getById"];

    // RE_Visits keeps title/address as the historical scheduling snapshot. For
    // conversational identity, property_id is canonical: hydrate the current
    // tenant-scoped Property and retain the snapshot only as a safe fallback.
    if (propertyId && property) {
      try {
        const currentPayload = await this.get<DetailResponse<Record<string, unknown>>>(
          `/api/v2/properties/${encodeURIComponent(propertyId)}`,
        );
        const current = currentPayload.success ? currentPayload.data : undefined;
        if (current && String(current.id) === propertyId) {
          property = {
            id: propertyId,
            title: text(current.title) ?? property.title,
            reference: text(current.reference) ?? property.reference,
            address: text(current.address) ?? property.address,
          };
          services.push("property.service.getById");
        }
      } catch {
        // A historical Visit must remain readable if its Property is no longer
        // available. The immutable Visit snapshot is the bounded fallback.
      }
    }
    return {
      kind: "individual", id: String(item.id), at: String(item.visit_datetime ?? item.scheduled_at), status: String(item.status),
      visitType: text(item.visit_type), durationMinutes: Number(item.duration_minutes) || null,
      clientConfirmation: text(item.client_confirmation),
      property,
      lead: item.lead_id ? { id: String(item.lead_id), name: text(item.client_name ?? item.lead_name) ?? `Lead ${String(item.lead_id)}` } : null,
      assignedAgent: item.agent_id ? { id: String(item.agent_id), name: text(item.agent_name) } : null,
      state: { isGroupSlot: Boolean(item.is_group_slot), capacity: Number(item.capacity) || null, registeredCount: Number(item.registered_count) || null },
      lastReschedule: null,
      telemetry: { services, latencyMs: performance.now() - startedAt },
    };
  }
}
