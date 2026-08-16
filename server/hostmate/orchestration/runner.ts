import { createHash, randomUUID } from "node:crypto";
import type { ActorContext } from "../contracts/actor-context.js";
import type { EntityRef } from "../contracts/domain.js";
import type { ExecutionResult, MultiAgentSummaryBlock } from "../contracts/execution-result.js";
import type { AgentMessageRecord, ControlPlaneRepository } from "../control-plane/repository.js";
import {
  createCrmGetLeadContextTool, CRM_GET_LEAD_CONTEXT_TOOL_ID,
  toCrmLeadContextExecutionResult, type CrmGetLeadContextOutput, type LeadContextPort,
} from "../product-tools/crm/get-lead-context.js";
import {
  createPropertySearchPropertiesTool, PROPERTY_SEARCH_PROPERTIES_TOOL_ID,
  toPropertySearchExecutionResult, type PropertySearchPort, type PropertySearchPropertiesOutput,
} from "../product-tools/property/search-properties.js";
import {
  createListLeadVisitsTool, toLeadVisitsExecutionResult,
  VISITS_LIST_LEAD_VISITS_TOOL_ID, type LeadVisitsPort, type ListLeadVisitsOutput,
} from "../product-tools/visits/list-lead-visits.js";
import { BoundedExecutionAgent } from "./bounded-execution-agent.js";
import {
  agentHandoffSchema, MAX_CHILD_RUNS, type AgentHandoff, type ChildExecutionResult,
  type ImmutableOrchestrationContext, type OrchestrationBudget,
} from "./contracts.js";
import {
  activeDemandToPropertyFilters, LEAD_OPPORTUNITY_OBJECTIVE,
  LEAD_OPPORTUNITY_ORCHESTRATION,
} from "./lead-opportunity-definition.js";

export type MultiAgentTurnInput = Readonly<{
  conversationId: string;
  message: string;
  selectedEntityRef?: EntityRef;
  priorMessages: readonly AgentMessageRecord[];
}>;

export type MultiAgentTurnResult = Readonly<{
  conversationId: string;
  interactionRunId?: string;
  executionRunId?: string;
  childRunIds: readonly string[];
  result: ExecutionResult<Readonly<{
    objectiveClass: typeof LEAD_OPPORTUNITY_OBJECTIVE;
    branches: readonly ChildExecutionResult[];
  }>>;
}>;

type Dependencies = Readonly<{
  repository: ControlPlaneRepository;
  leadContextPort: LeadContextPort;
  leadVisitsPort: LeadVisitsPort;
  propertySearchPort: PropertySearchPort;
}>;

function selectedLead(input: MultiAgentTurnInput): EntityRef | undefined {
  if (input.selectedEntityRef?.type === "crm.lead") return input.selectedEntityRef;
  for (const message of [...input.priorMessages].reverse()) {
    const lead = message.contextRefs?.selected.lead;
    if (lead?.type === "crm.lead") return lead;
  }
  return undefined;
}

function handoff(input: AgentHandoff): AgentHandoff {
  return Object.freeze(agentHandoffSchema.parse(input));
}

function field(label: string, value: string | number | undefined | null) {
  return value === undefined || value === null || value === "" ? [] : [{ label, value: String(value) }];
}

function summaryBlock(input: {
  crm: ChildExecutionResult<CrmGetLeadContextOutput>;
  visits?: ChildExecutionResult<ListLeadVisitsOutput>;
  property?: ChildExecutionResult<PropertySearchPropertiesOutput>;
}): MultiAgentSummaryBlock {
  const crm = input.crm.result?.data;
  const visits = input.visits?.result?.data;
  const properties = input.property?.result?.data;
  const limitations: string[] = [];
  if (!crm?.activeDemand) limitations.push("No existe una demanda activa; no se ha realizado una búsqueda genérica de inmuebles.");
  if (input.visits?.status === "failed") limitations.push("No se pudieron consultar las próximas visitas.");
  if (input.property?.status === "failed") limitations.push("La búsqueda de inmuebles no estuvo disponible.");
  return {
    type: "multi_agent_summary", title: "Análisis del lead",
    status: limitations.length || input.visits?.status === "partial" || input.property?.status === "partial" ? "partial" : "complete",
    sections: [
      {
        key: "lead", title: "Lead", availability: crm ? "available" : "unavailable",
        summary: crm ? `${crm.lead.name}${crm.lead.status ? ` · ${crm.lead.status}` : ""}` : "Contexto no disponible.",
        items: crm ? [{ ref: crm.lead.ref, title: crm.lead.name, fields: [
          ...field("Estado", crm.lead.status), ...field("Comercial", crm.assignedAgent?.name),
          ...field("Ciudad demandada", crm.activeDemand?.city), ...field("Presupuesto máximo", crm.activeDemand?.priceMax),
        ] }] : undefined,
      },
      {
        key: "visits", title: "Próximas visitas", availability: visits ? "available" : "unavailable",
        summary: visits ? (visits.visits.length ? `${visits.visits.length} próxima${visits.visits.length === 1 ? "" : "s"} visita${visits.visits.length === 1 ? "" : "s"}.` : "No hay próximas visitas.") : "Visitas no disponibles.",
        items: visits?.visits.map((visit) => ({
          ref: visit.ref, title: visit.property?.title ?? visit.property?.reference ?? "Visita",
          subtitle: new Intl.DateTimeFormat("es-ES", { dateStyle: "medium", timeStyle: "short", timeZone: visits.timezone }).format(new Date(visit.at)),
          fields: [...field("Estado", visit.status), ...field("Referencia", visit.property?.reference)],
        })),
      },
      {
        key: "properties", title: "Inmuebles potencialmente compatibles", availability: properties ? "available" : "unavailable",
        summary: properties ? (properties.matches.length ? `${properties.matches.length} candidato${properties.matches.length === 1 ? "" : "s"} visible${properties.matches.length === 1 ? "" : "s"}.` : "No hay inmuebles con los criterios disponibles.") : "Matching no disponible.",
        items: properties?.matches.slice(0, 5).map((property) => ({
          ref: property.ref, title: property.title, subtitle: [property.reference, property.city, property.neighborhood].filter(Boolean).join(" · "),
          fields: [...field("Precio", property.price), ...field("Tipo", property.propertyType), ...field("Habitaciones", property.rooms)],
        })),
      },
      {
        key: "limitations", title: "Limitaciones", availability: limitations.length ? "available" : "unavailable",
        summary: limitations.length ? limitations.join(" ") : "Sin limitaciones relevantes con los datos disponibles.",
      },
    ],
  };
}

function needsLead(): MultiAgentTurnResult {
  return {
    conversationId: "", childRunIds: [],
    result: {
      status: "needs_input", summary: "Selecciona primero un lead autorizado para analizarlo.", entities: [],
      errors: [{ code: "MISSING_REQUIRED_FIELD", message: "contextRefs.selected.lead is required", retryable: false }],
    },
  };
}

export class LeadOpportunityOrchestrationRunner {
  private readonly executionAgent: BoundedExecutionAgent;

  constructor(private readonly dependencies: Dependencies, private readonly enabled: boolean) {
    this.executionAgent = new BoundedExecutionAgent(dependencies.repository);
  }

  async execute(actor: ActorContext, input: MultiAgentTurnInput): Promise<MultiAgentTurnResult> {
    if (!this.enabled) return { ...needsLead(), conversationId: input.conversationId, result: { ...needsLead().result, status: "permission_denied", summary: "La orquestación multi-agent no está habilitada para este actor.", errors: [{ code: "PERMISSION_DENIED", message: "MULTI_AGENT_CANARY_DISABLED", retryable: false }] } };
    const lead = selectedLead(input);
    if (!lead) return { ...needsLead(), conversationId: input.conversationId };
    if (LEAD_OPPORTUNITY_ORCHESTRATION.branches.length > MAX_CHILD_RUNS) throw new Error("ORCHESTRATION_CHILD_LIMIT_EXCEEDED");

    const repository = this.dependencies.repository;
    if (input.priorMessages.length === 0) {
      try { await repository.createConversation(actor, { conversationId: input.conversationId, title: "Análisis de oportunidades" }); } catch { /* Existing empty conversation. */ }
    }
    const now = Date.now();
    const interactionRunId = randomUUID();
    const orchestrationId = randomUUID();
    const budget: OrchestrationBudget = Object.freeze({
      maxChildRuns: 3, maxToolCalls: 3, maxInferenceCalls: 0, maxInputTokens: 0, maxCostUsd: 0, deadlineAt: now + 45_000,
    });
    await repository.createRun(actor, {
      runId: interactionRunId, conversationId: input.conversationId, kind: "interaction",
      objectiveHash: createHash("sha256").update(input.message).digest("hex"), objectiveRedacted: input.message.slice(0, 240),
      orchestrationId, orchestrationDepth: 0, dependencyRunIds: [], registryHash: `${LEAD_OPPORTUNITY_ORCHESTRATION.id}@${LEAD_OPPORTUNITY_ORCHESTRATION.version}`,
      skillVersions: {}, toolScope: [], visibility: "user",
    });
    await repository.updateRun(actor, interactionRunId, { status: "running" }, "queued");
    const sequence = input.priorMessages.reduce((max, message) => Math.max(max, message.sequence), 0);
    await repository.appendMessage(actor, {
      messageId: randomUUID(), conversationId: input.conversationId, role: "user", contentRedacted: input.message,
      contextRefs: { selected: { lead }, referenced: [] }, runId: interactionRunId, sequence: sequence + 1, createdAt: now,
    });
    const context: ImmutableOrchestrationContext = Object.freeze({ actor, interactionRunId, orchestrationId, conversationId: input.conversationId, budget });
    const rootHandoff = handoff({
      sourceRunId: interactionRunId, targetProfile: "crm", objective: "Reautorizar el lead y obtener su contexto CRM estructurado.",
      entityRefs: [lead], structuredContext: { selectedLead: lead },
      provenance: [{ field: "selectedLead", sourceToolId: "interaction.context_refs", sourceRunId: interactionRunId }],
    });
    const crm = await this.executionAgent.execute<CrmGetLeadContextOutput>(actor, context, {
      branchKey: "crm", profileId: "crm", objective: "Obtener contexto autorizado del lead seleccionado.",
      objectiveClasses: ["lead.lookup"], objectiveCapabilities: ["crm.lead.context"], dependencyRunIds: [interactionRunId], handoff: rootHandoff,
      tool: createCrmGetLeadContextTool({ port: this.dependencies.leadContextPort }), toolInput: { lead }, toResult: (output) => toCrmLeadContextExecutionResult(output as CrmGetLeadContextOutput),
    });
    if (crm.status === "cancelled") return this.finishCancelled(actor, input, interactionRunId, sequence, [crm]);
    if (crm.status === "failed" || !crm.result?.data) return this.finishAuthorityOrRootFailure(actor, input, interactionRunId, sequence, crm);

    const crmOutput = crm.result.data;
    const baseProvenance = [{ field: "lead", sourceToolId: CRM_GET_LEAD_CONTEXT_TOOL_ID, sourceRunId: crm.runId }];
    const visitsHandoff = handoff({
      sourceRunId: crm.runId, targetProfile: "visits", objective: "Listar próximas visitas del lead reautorizado.", entityRefs: [crmOutput.lead.ref],
      structuredContext: { lead: crmOutput.lead.ref }, provenance: baseProvenance,
    });
    const filters = activeDemandToPropertyFilters(crmOutput.activeDemand);
    const propertyHandoff = handoff({
      sourceRunId: crm.runId, targetProfile: "property", objective: "Buscar candidatos usando exclusivamente filtros derivados de demanda activa.", entityRefs: [crmOutput.lead.ref],
      structuredContext: filters ? { filters } : { unavailableReason: "no_active_demand" },
      provenance: filters ? Object.keys(filters).map((fieldName) => ({ field: `filters.${fieldName}`, sourceToolId: CRM_GET_LEAD_CONTEXT_TOOL_ID, sourceRunId: crm.runId })) : baseProvenance,
    });
    const noDemand: ExecutionResult<PropertySearchPropertiesOutput> | undefined = filters ? undefined : {
      status: "partial", summary: "No existe una demanda activa; no se ha ejecutado una búsqueda genérica.", entities: [],
      errors: [{ code: "MISSING_REQUIRED_FIELD", message: "activeDemand is required for matching", retryable: false }],
    };
    const [visitsSettled, propertySettled] = await Promise.allSettled([
      this.executionAgent.execute<ListLeadVisitsOutput>(actor, context, {
        branchKey: "visits", profileId: "visits", objective: "Listar próximas visitas del lead seleccionado.",
        objectiveClasses: ["visit.lookup"], objectiveCapabilities: ["visits.lead.list"], dependencyRunIds: [crm.runId], handoff: visitsHandoff,
        tool: createListLeadVisitsTool({ port: this.dependencies.leadVisitsPort }), toolInput: { lead: crmOutput.lead.ref, scope: "upcoming" },
        toResult: (output) => toLeadVisitsExecutionResult(output as ListLeadVisitsOutput),
      }),
      this.executionAgent.execute<PropertySearchPropertiesOutput>(actor, context, {
        branchKey: "property", profileId: "property", objective: "Buscar inmuebles compatibles con la demanda activa estructurada.",
        objectiveClasses: ["property.search"], objectiveCapabilities: ["property.property.search"], dependencyRunIds: [crm.runId], handoff: propertyHandoff,
        tool: createPropertySearchPropertiesTool({ port: this.dependencies.propertySearchPort }), toolInput: filters, noToolResult: noDemand,
        toResult: (output) => toPropertySearchExecutionResult(output as PropertySearchPropertiesOutput),
      }),
    ]);
    const rejectedBranch = <T>(branchKey: "visits" | "property", reason: unknown): ChildExecutionResult<T> => ({
      runId: "rejected", branchKey, profileId: branchKey, status: "failed", toolScope: [], errorCode: "INTERNAL", attempts: 0,
      latencyMs: 0, result: { status: "failed", summary: "Rama no disponible.", entities: [], errors: [{ code: "INTERNAL", message: String(reason), retryable: false }] },
    });
    const visits = visitsSettled.status === "fulfilled" ? visitsSettled.value : rejectedBranch<ListLeadVisitsOutput>("visits", visitsSettled.reason);
    const property = propertySettled.status === "fulfilled" ? propertySettled.value : rejectedBranch<PropertySearchPropertiesOutput>("property", propertySettled.reason);
    const branches = [crm, visits, property];
    const parent = await repository.getRun(actor, interactionRunId);
    if (parent?.cancelRequestedAt || branches.some((branch) => branch.status === "cancelled")) return this.finishCancelled(actor, input, interactionRunId, sequence, branches);
    if (branches.some((branch) => branch.errorCode === "PERMISSION_DENIED" || branch.errorCode === "POLICY_DENIED")) {
      return this.finishAuthorityOrRootFailure(actor, input, interactionRunId, sequence, branches.find((branch) => branch.errorCode === "PERMISSION_DENIED" || branch.errorCode === "POLICY_DENIED")!);
    }
    const block = summaryBlock({ crm, visits, property });
    const status = block.status === "partial" || branches.some((branch) => branch.status !== "completed") ? "partial" : "completed";
    const entities = [...new Map(branches.flatMap((branch) => branch.result?.entities ?? []).map((ref) => [`${ref.type}:${ref.id}`, ref])).values()];
    const result: MultiAgentTurnResult["result"] = {
      status, summary: status === "completed" ? "He analizado el lead, sus próximas visitas y los inmuebles compatibles con su demanda." : "He completado el análisis con algunas limitaciones.",
      entities, data: { objectiveClass: LEAD_OPPORTUNITY_OBJECTIVE, branches }, blocks: [block], errors: branches.flatMap((branch) => branch.result?.errors ?? []),
    };
    await repository.updateRun(actor, interactionRunId, { status, resultSummary: result.summary, completedAt: Date.now() }, "running");
    await repository.appendMessage(actor, {
      messageId: randomUUID(), conversationId: input.conversationId, role: "assistant", contentRedacted: result.summary,
      blocks: result.blocks, contextRefs: { selected: { lead: crmOutput.lead.ref }, referenced: entities }, runId: interactionRunId,
      sequence: sequence + 2, createdAt: Date.now(),
    });
    return { conversationId: input.conversationId, interactionRunId, executionRunId: crm.runId, childRunIds: branches.map((branch) => branch.runId), result };
  }

  private async finishCancelled(actor: ActorContext, input: MultiAgentTurnInput, interactionRunId: string, sequence: number, branches: readonly ChildExecutionResult[]): Promise<MultiAgentTurnResult> {
    const result: MultiAgentTurnResult["result"] = { status: "failed", summary: "Análisis cancelado.", entities: [], data: { objectiveClass: LEAD_OPPORTUNITY_OBJECTIVE, branches }, errors: [{ code: "CANCELLED", message: "Parent orchestration cancelled", retryable: false }] };
    const current = await this.dependencies.repository.getRun(actor, interactionRunId);
    if (current?.status === "running") await this.dependencies.repository.updateRun(actor, interactionRunId, { status: "cancelled", errorCode: "CANCELLED", resultSummary: result.summary, completedAt: Date.now() }, "running");
    await this.dependencies.repository.appendMessage(actor, { messageId: randomUUID(), conversationId: input.conversationId, role: "assistant", contentRedacted: result.summary, runId: interactionRunId, sequence: sequence + 2, createdAt: Date.now() });
    return { conversationId: input.conversationId, interactionRunId, executionRunId: branches[0]?.runId, childRunIds: branches.map((branch) => branch.runId).filter((id) => id !== "not-spawned"), result };
  }

  private async finishAuthorityOrRootFailure(actor: ActorContext, input: MultiAgentTurnInput, interactionRunId: string, sequence: number, branch: ChildExecutionResult): Promise<MultiAgentTurnResult> {
    const authority = branch.errorCode === "PERMISSION_DENIED" || branch.errorCode === "POLICY_DENIED";
    const result: MultiAgentTurnResult["result"] = {
      status: authority ? "permission_denied" : "failed", summary: authority ? "El análisis se ha detenido porque una rama ya no está autorizada." : "No se pudo obtener el contexto raíz del lead.",
      entities: [], data: { objectiveClass: LEAD_OPPORTUNITY_OBJECTIVE, branches: [branch] }, errors: branch.result?.errors ?? [{ code: branch.errorCode ?? "INTERNAL", message: "Root branch failed", retryable: false }],
    };
    await this.dependencies.repository.updateRun(actor, interactionRunId, { status: "failed", errorCode: branch.errorCode ?? "INTERNAL", resultSummary: result.summary, completedAt: Date.now() }, "running");
    await this.dependencies.repository.appendMessage(actor, { messageId: randomUUID(), conversationId: input.conversationId, role: "assistant", contentRedacted: result.summary, runId: interactionRunId, sequence: sequence + 2, createdAt: Date.now() });
    return { conversationId: input.conversationId, interactionRunId, executionRunId: branch.runId, childRunIds: [branch.runId], result };
  }
}

export function multiAgentEnabled(actor: Pick<ActorContext, "tenantId" | "userId">, config: Readonly<{ enabled: boolean; allowedTenantIds: readonly string[]; allowedUserIds: readonly string[] }> | undefined): boolean {
  return Boolean(config?.enabled && config.allowedTenantIds.includes(actor.tenantId) && config.allowedUserIds.includes(actor.userId));
}
