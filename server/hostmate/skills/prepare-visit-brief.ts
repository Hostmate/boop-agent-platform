import { createHash, randomUUID } from "node:crypto";
import type { ActorContext } from "../contracts/actor-context.js";
import type { EntityRef } from "../contracts/domain.js";
import type { BriefBlock, ExecutionResult } from "../contracts/execution-result.js";
import type { AgentMessageRecord, ControlPlaneRepository, ConversationContextRefs } from "../control-plane/repository.js";
import { redactEventPayload } from "../events/contracts.js";
import { ExecutionDispatchResolver } from "../interaction/dispatch.js";
import { DefaultPolicyEngine } from "../policy/engine.js";
import { ExecutionProfileRegistry } from "../profiles/registry.js";
import {
  CRM_GET_LEAD_CONTEXT_TOOL_ID, createCrmGetLeadContextTool, type CrmGetLeadContextOutput, type LeadContextPort,
} from "../product-tools/crm/get-lead-context.js";
import {
  PROPERTY_GET_PROPERTY_TOOL_ID, createPropertyGetPropertyTool, type PropertyDetailPort, type PropertyGetPropertyOutput,
} from "../product-tools/property/get-property.js";
import {
  VISITS_GET_VISIT_TOOL_ID, createGetVisitTool, type GetVisitOutput, type VisitDetailPort,
} from "../product-tools/visits/get-visit.js";
import { ProductToolRegistry } from "../tools/registry.js";
import { SkillRegistry } from "./registry.js";

const SKILL_ID = "prepare-visit-brief";
const EXACT_TOOL_IDS = [VISITS_GET_VISIT_TOOL_ID, CRM_GET_LEAD_CONTEXT_TOOL_ID, PROPERTY_GET_PROPERTY_TOOL_ID] as const;

export type PrepareVisitBriefData = Readonly<{
  visit: GetVisitOutput;
  lead?: CrmGetLeadContextOutput;
  property?: PropertyGetPropertyOutput;
  missing: readonly ("lead" | "property")[];
}>;

function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
function redactedObjective(value: string) { return value.replace(/\s+/g, " ").trim().slice(0, 160); }
function visitRef(ref?: EntityRef): ref is EntityRef { return ref?.type === "visits.visit" || ref?.type === "visits.group_visit"; }
function authorityFailure(error: unknown) { return /PERMISSION|POLICY|FORBIDDEN|STALE/.test(error instanceof Error ? `${error.name}:${error.message}` : String(error)); }

function latestContext(messages: readonly AgentMessageRecord[]): ConversationContextRefs {
  return [...messages].reverse().find((message) => message.contextRefs)?.contextRefs ?? { selected: {}, referenced: [] };
}

function fields(input: ReadonlyArray<readonly [string, string | number | null | undefined, string?]>) {
  return input.flatMap(([label, value, suffix]) => value == null || value === "" ? [] : [{ label, value: `${value}${suffix ?? ""}` }]);
}

function dateTime(value: string, timezone: string) {
  return new Intl.DateTimeFormat("es-ES", { dateStyle: "medium", timeStyle: "short", timeZone: timezone }).format(new Date(value));
}

function money(value: number | null | undefined) {
  return value == null ? undefined : new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(value);
}

export function buildVisitBrief(data: PrepareVisitBriefData): BriefBlock {
  const visitFields = fields([
    ["Fecha", dateTime(data.visit.at, data.visit.timezone)], ["Estado", data.visit.status], ["Tipo", data.visit.visitType],
    ["Duración", data.visit.durationMinutes, " min"], ["Comercial", data.visit.assignedAgent?.name],
    ["Confirmación", data.visit.kind === "individual" ? data.visit.clientConfirmation : data.visit.registration.status],
  ]);
  const leadFields = data.lead ? fields([
    ["Nombre", data.lead.lead.name], ["Estado", data.lead.lead.status], ["Origen", data.lead.lead.source],
    ["Teléfono", data.lead.lead.phone], ["Email", data.lead.lead.email], ["Calificación", data.lead.lead.qualification?.grade],
    ["Demanda", [data.lead.activeDemand?.operationType, data.lead.activeDemand?.propertySubtype, data.lead.activeDemand?.city, data.lead.activeDemand?.zone].filter(Boolean).join(" · ")],
    ["Presupuesto máximo", money(data.lead.activeDemand?.priceMax)], ["Tareas pendientes", data.lead.pendingTasks.length],
  ]) : [];
  const propertyLocation = data.property ? [data.property.location.neighborhood, data.property.location.city, data.property.location.province].filter(Boolean).join(" · ") : "";
  const propertyFields = data.property ? fields([
    ["Referencia", data.property.reference], ["Título", data.property.title], ["Operación", data.property.operation], ["Tipo", data.property.propertyType],
    ["Estado", data.property.status], ["Precio", money(data.property.price)], ["Ubicación", propertyLocation],
    ["Habitaciones", data.property.specifications.rooms], ["Baños", data.property.specifications.bathrooms],
    ["Superficie", data.property.specifications.areaBuilt, " m²"], ["Equipamiento", data.property.features.join(", ")],
  ]) : [];
  const preparationNotes = [
    `Verificar el estado operativo de la visita: ${data.visit.status}.`,
    ...(data.visit.assignedAgent?.name ? [`Comercial asignado: ${data.visit.assignedAgent.name}.`] : []),
    ...(data.lead?.pendingTasks.length ? [`Revisar ${data.lead.pendingTasks.length} tarea${data.lead.pendingTasks.length === 1 ? "" : "s"} pendiente${data.lead.pendingTasks.length === 1 ? "" : "s"} del lead.`] : []),
    ...(data.property?.features.length ? [`Equipamiento registrado: ${data.property.features.join(", ")}.`] : []),
    ...data.missing.map((section) => `El bloque de ${section === "lead" ? "lead" : "inmueble"} no está disponible; no se ha sustituido por otra entidad.`),
  ];
  return {
    type: "brief", title: "Preparación de visita", status: data.missing.length ? "partial" : "complete",
    sections: [
      { key: "visit", title: "Visita", availability: "available", fields: visitFields },
      { key: "lead", title: "Lead", availability: data.lead ? "available" : "unavailable", fields: leadFields },
      { key: "property", title: "Inmueble", availability: data.property ? "available" : "unavailable", fields: propertyFields, ...(data.property?.description ? { notes: [data.property.description] } : {}) },
      { key: "preparation", title: "Preparación", availability: "available", fields: [], notes: preparationNotes },
    ],
  };
}

function failure(error: unknown): ExecutionResult<PrepareVisitBriefData> {
  const message = error instanceof Error ? error.message : String(error);
  const denied = /PERMISSION|POLICY|FORBIDDEN|STALE/.test(message);
  return {
    status: denied ? "permission_denied" : "failed",
    summary: denied ? "No puedes preparar esta visita dentro del scope actual." : "No se pudo preparar la visita.",
    entities: [], errors: [{ code: denied ? "PERMISSION_DENIED" : "INTERNAL", message, retryable: false }],
  };
}

export class PrepareVisitBriefVerticalSlice {
  constructor(
    private readonly repository: ControlPlaneRepository,
    private readonly visitDetail: VisitDetailPort,
    private readonly leadContext: LeadContextPort,
    private readonly propertyDetail: PropertyDetailPort,
    private readonly skillEnabled: boolean,
  ) {}

  async execute(actor: ActorContext, input: { conversationId: string; message: string; selectedEntityRef?: EntityRef }): Promise<{ conversationId: string; interactionRunId: string; executionRunId?: string; result: ExecutionResult<PrepareVisitBriefData> }> {
    const objective = input.message.trim();
    const interactionRunId = randomUUID();
    let prior: readonly AgentMessageRecord[];
    try { prior = await this.repository.listMessages(actor, { conversationId: input.conversationId, limit: 200 }); }
    catch { await this.repository.createConversation(actor, { conversationId: input.conversationId, title: "AI Chat" }); prior = []; }
    const previousContext = latestContext(prior);
    const selectedVisit = visitRef(input.selectedEntityRef) ? input.selectedEntityRef : visitRef(previousContext.selected.visit) ? previousContext.selected.visit : undefined;
    const context: ConversationContextRefs = { selected: { ...previousContext.selected, ...(selectedVisit ? { visit: selectedVisit } : {}) }, referenced: previousContext.referenced };
    let sequence = (prior.at(-1)?.sequence ?? 0) + 1;
    await this.repository.appendMessage(actor, { messageId: randomUUID(), conversationId: input.conversationId, role: "user", contentRedacted: objective, contextRefs: context, sequence: sequence++, createdAt: Date.now() });
    await this.repository.createRun(actor, { runId: interactionRunId, conversationId: input.conversationId, kind: "interaction", objectiveHash: hash(objective), objectiveRedacted: redactedObjective(objective), dependencyRunIds: [], registryHash: "interaction-dispatch-skills-v1", skillVersions: {}, toolScope: [], visibility: "user" });
    await this.repository.updateRun(actor, interactionRunId, { status: "running" }, "queued");

    let eventSequence = 0;
    let executionRunId: string | undefined;
    let attemptId: string | undefined;
    const event = async (type: string, payload: unknown) => this.repository.appendEvent(actor, {
      eventId: randomUUID(), conversationId: input.conversationId, interactionRunId, executionRunId, attemptId,
      sequence: ++eventSequence, type, visibility: "user", payload: redactEventPayload(payload), occurredAt: Date.now(),
    });
    await event("interaction.started", { objectiveClass: "visit.prepare_brief", selectedVisit });

    if (!selectedVisit) {
      const result: ExecutionResult<PrepareVisitBriefData> = { status: "needs_input", summary: "Selecciona una visita y vuelve a pedirme que la prepare.", entities: [], errors: [], suggestedNext: ["Selecciona una visita desde una card de resultados."] };
      await event("interaction.needs_input", { reason: "selected.visit_missing", arbitrarySearchAllowed: false });
      await this.repository.updateRun(actor, interactionRunId, { status: "completed", resultSummary: result.summary, completedAt: Date.now() }, "running");
      await this.persist(actor, input.conversationId, sequence, undefined, result, context);
      return { conversationId: input.conversationId, interactionRunId, result };
    }

    let visit: GetVisitOutput | undefined;
    let lead: CrmGetLeadContextOutput | undefined;
    let property: PropertyGetPropertyOutput | undefined;
    const registry = new ProductToolRegistry([
      createGetVisitTool({ port: this.visitDetail, onResult: (output) => { visit = output; } }),
      createCrmGetLeadContextTool({ port: this.leadContext, onResult: (output) => { lead = output; } }),
      createPropertyGetPropertyTool({ port: this.propertyDetail, onResult: (output) => { property = output; } }),
    ]);
    const dispatch = new ExecutionDispatchResolver(new ExecutionProfileRegistry(), registry, new SkillRegistry()).resolve({
      actor, allowedToolIds: EXACT_TOOL_IDS, featureEnabled: (toolId) => EXACT_TOOL_IDS.includes(toolId as typeof EXACT_TOOL_IDS[number]),
      skillFeatureEnabled: () => this.skillEnabled,
      request: {
        profileId: "visits", objective, objectiveClasses: ["visit.prepare_brief"],
        objectiveCapabilities: ["visits.visit.detail", "crm.lead.context", "property.property.read"], inputRefs: [selectedVisit],
        dependencyRunIds: [], internalSkillHints: [SKILL_ID], constraints: { readOnly: true, maxResults: 1 },
      },
    });
    const selectedSkill = dispatch.skills.length === 1 && dispatch.skills[0]?.id === SKILL_ID ? dispatch.skills[0] : undefined;
    const toolScope = dispatch.toolResolution.tools.map((tool) => `${tool.toolId}@${tool.version}`);
    const skillRefs = selectedSkill ? [{ id: selectedSkill.id, version: selectedSkill.version, hash: selectedSkill.hash, sourcePath: selectedSkill.sourcePath }] : [];
    await event("interaction.dispatch.resolved", { profile: "visits", profileVersion: dispatch.profile.version, objectiveClass: "visit.prepare_brief", toolScope, skillRefs, selectedVisit });
    await this.repository.updateRun(actor, interactionRunId, { status: "completed", resultSummary: selectedSkill ? `Dispatched ${SKILL_ID}` : "Skill unavailable", completedAt: Date.now() }, "running");

    executionRunId = randomUUID();
    attemptId = randomUUID();
    await this.repository.createRun(actor, {
      runId: executionRunId, conversationId: input.conversationId, kind: "execution", profileId: "visits", profileVersion: dispatch.profile.version,
      parentRunId: interactionRunId, objectiveHash: dispatch.objectiveHash, objectiveRedacted: redactedObjective(objective), dependencyRunIds: [],
      registryHash: dispatch.toolResolution.registryHash, skillVersions: selectedSkill ? { [selectedSkill.id]: selectedSkill.version } : {}, skillRefs,
      toolScope, visibility: "user",
    });
    if (!selectedSkill || dispatch.toolResolution.tools.length !== EXACT_TOOL_IDS.length) {
      const result: ExecutionResult<PrepareVisitBriefData> = { status: "permission_denied", summary: "La preparación de visitas no está disponible dentro de tu scope actual.", entities: [], errors: [{ code: "PERMISSION_DENIED", message: dispatch.toolResolution.rejected[0]?.reason ?? "skill_disabled", retryable: false }] };
      await this.repository.updateRun(actor, executionRunId, { status: "failed", errorCode: "PERMISSION_DENIED", resultSummary: result.summary, completedAt: Date.now() }, "queued");
      await event("execution.permission_denied", { rejected: dispatch.toolResolution.rejected, skillResolved: Boolean(selectedSkill) });
      await this.persist(actor, input.conversationId, sequence, executionRunId, result, context);
      return { conversationId: input.conversationId, interactionRunId, executionRunId, result };
    }

    await this.repository.createAttempt(actor, { attemptId, runId: executionRunId, attemptNumber: 1, status: "queued", fencingToken: 0 });
    await this.repository.updateAttempt(actor, { attemptId, expectedStatus: "queued", patch: { status: "running", startedAt: Date.now() } });
    await this.repository.updateRun(actor, executionRunId, { status: "running" }, "queued");
    const runtimeTools = registry.compileRuntimeTools({ resolved: dispatch.toolResolution, actor, policy: new DefaultPolicyEngine(), profileId: "visits", decisionId: () => randomUUID(), hasRequiredPreconditions: () => true });
    const byName = new Map(runtimeTools.map((tool) => [tool.name, tool]));
    const startedAt = performance.now();
    await event("skill.started", { skill: skillRefs[0], profile: "visits", sourceTrusted: true });
    try {
      const visitTool = byName.get("get_visit")!;
      const visitStarted = performance.now();
      await event("tool.started", { toolId: VISITS_GET_VISIT_TOOL_ID, inputRef: selectedVisit });
      const visitResult = await visitTool.handle({ visit: selectedVisit });
      if (visitResult.success === false || !visit) throw new Error("VISIT_DETAIL_FAILED");
      await event("tool.completed", { toolId: VISITS_GET_VISIT_TOOL_ID, latencyMs: performance.now() - visitStarted, services: visit.telemetry?.services });

      const missing: Array<"lead" | "property"> = [];
      const independent: Promise<void>[] = [];
      if (visit.lead?.ref) independent.push((async () => {
        const began = performance.now();
        await event("tool.started", { toolId: CRM_GET_LEAD_CONTEXT_TOOL_ID, inputRef: visit!.lead!.ref });
        try {
          const result = await byName.get("get_lead_context")!.handle({ lead: visit!.lead!.ref });
          if (result.success === false || !lead) throw new Error("LEAD_CONTEXT_UNAVAILABLE");
          await event("tool.completed", { toolId: CRM_GET_LEAD_CONTEXT_TOOL_ID, latencyMs: performance.now() - began, services: lead.telemetry?.services });
        } catch (error) { if (authorityFailure(error)) throw error; missing.push("lead"); await event("tool.partial", { toolId: CRM_GET_LEAD_CONTEXT_TOOL_ID, reason: error instanceof Error ? error.name : "unavailable" }); }
      })()); else missing.push("lead");
      if (visit.property?.ref) independent.push((async () => {
        const began = performance.now();
        await event("tool.started", { toolId: PROPERTY_GET_PROPERTY_TOOL_ID, inputRef: visit!.property!.ref });
        try {
          const result = await byName.get("get_property")!.handle({ property: visit!.property!.ref });
          if (result.success === false || !property) throw new Error("PROPERTY_DETAIL_UNAVAILABLE");
          await event("tool.completed", { toolId: PROPERTY_GET_PROPERTY_TOOL_ID, latencyMs: performance.now() - began, services: property.telemetry.services });
        } catch (error) { if (authorityFailure(error)) throw error; missing.push("property"); await event("tool.partial", { toolId: PROPERTY_GET_PROPERTY_TOOL_ID, reason: error instanceof Error ? error.name : "unavailable" }); }
      })()); else missing.push("property");
      const settled = await Promise.allSettled(independent);
      const rejected = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
      if (rejected) throw rejected.reason;

      const data: PrepareVisitBriefData = { visit, lead, property, missing: [...new Set(missing)] };
      const block = buildVisitBrief(data);
      const result: ExecutionResult<PrepareVisitBriefData> = {
        status: data.missing.length ? "partial" : "completed",
        summary: data.missing.length ? "He preparado la visita con la información disponible; faltan bloques que no he sustituido por otras entidades." : "Visita preparada con contexto del lead y del inmueble.",
        entities: [visit.ref, ...(visit.lead ? [visit.lead.ref] : []), ...(visit.property?.ref ? [visit.property.ref] : [])], data, blocks: [block], errors: [],
      };
      const finalStatus = result.status === "partial" ? "partial" : "completed";
      await this.repository.updateAttempt(actor, { attemptId, expectedStatus: "running", patch: { status: "succeeded", completedAt: Date.now() } });
      await this.repository.updateRun(actor, executionRunId, { status: finalStatus, resultSummary: result.summary, completedAt: Date.now() }, "running");
      await event("skill.completed", { skill: skillRefs[0], status: result.status, missing: data.missing, totalLatencyMs: performance.now() - startedAt, inferenceCount: 0, costUsd: 0 });
      await this.persist(actor, input.conversationId, sequence, executionRunId, result, { selected: { ...context.selected, visit: visit.ref, lead: visit.lead?.ref, property: visit.property?.ref }, referenced: result.entities });
      return { conversationId: input.conversationId, interactionRunId, executionRunId, result };
    } catch (error) {
      const result = failure(error);
      const code = result.errors[0]?.code ?? "INTERNAL";
      await this.repository.updateAttempt(actor, { attemptId, expectedStatus: "running", patch: { status: "failed", errorCode: code, completedAt: Date.now() } });
      await this.repository.updateRun(actor, executionRunId, { status: "failed", errorCode: code, resultSummary: result.summary, completedAt: Date.now() }, "running");
      await event("skill.failed", { skill: skillRefs[0], errorCode: code, totalLatencyMs: performance.now() - startedAt });
      await this.persist(actor, input.conversationId, sequence, executionRunId, result, context);
      return { conversationId: input.conversationId, interactionRunId, executionRunId, result };
    }
  }

  private async persist(actor: ActorContext, conversationId: string, sequence: number, runId: string | undefined, result: ExecutionResult<PrepareVisitBriefData>, context: ConversationContextRefs) {
    await this.repository.appendMessage(actor, { messageId: randomUUID(), conversationId, role: "assistant", contentRedacted: result.summary, blocks: result.blocks, contextRefs: context, runId, sequence, createdAt: Date.now() });
  }
}
