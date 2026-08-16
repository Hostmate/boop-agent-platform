import type { ActorContext } from "../contracts/actor-context.js";
import type { EntityRef } from "../contracts/domain.js";
import type { BriefBlock, ExecutionResult } from "../contracts/execution-result.js";
import type { ControlPlaneRepository } from "../control-plane/repository.js";
import {
  CRM_GET_LEAD_CONTEXT_TOOL_ID, createCrmGetLeadContextTool,
  type CrmGetLeadContextOutput, type LeadContextPort,
} from "../product-tools/crm/get-lead-context.js";
import { ProductToolRegistry } from "../tools/registry.js";
import {
  briefFields, executeDeterministicReadSkill, formatDateTime, formatMoney,
  type DeterministicSkillInput, type DeterministicSkillTurn,
} from "./execution-helpers.js";

const SKILL_ID = "prepare-lead-brief";
const EXACT_TOOL_IDS = [CRM_GET_LEAD_CONTEXT_TOOL_ID] as const;

export type PrepareLeadBriefData = Readonly<{
  lead: CrmGetLeadContextOutput;
  missing: readonly ("commercial" | "property" | "visit")[];
}>;

function leadRef(ref?: EntityRef): ref is EntityRef { return ref?.type === "crm.lead"; }

function compactDemand(lead: CrmGetLeadContextOutput): string {
  return [
    lead.activeDemand?.operationType, lead.activeDemand?.propertySubtype,
    lead.activeDemand?.city, lead.activeDemand?.zone,
  ].filter(Boolean).join(" · ");
}

export function buildLeadBrief(data: PrepareLeadBriefData, timezone: string): BriefBlock {
  const lead = data.lead;
  const property = lead.property ?? (lead.opportunity ? {
    title: lead.opportunity.propertyTitle,
    reference: lead.opportunity.propertyReference,
    price: lead.opportunity.price,
  } : undefined);
  const commercialAvailable = Boolean(lead.opportunity || lead.activeDemand || lead.pendingTasks.length);
  const preparationNotes = [
    ...(lead.pendingTasks.length
      ? lead.pendingTasks.map((task) => [task.title, task.dueAt ? `vence ${formatDateTime(task.dueAt, timezone)}` : undefined, task.priority].filter(Boolean).join(" · "))
      : ["No hay tareas pendientes en el contexto CRM resumido."]),
    ...data.missing.map((section) => ({
      commercial: "No hay oportunidad, demanda activa ni tareas pendientes resumidas.",
      property: "No hay inmueble relacionado en el contexto actual; no se ha buscado otro.",
      visit: "No hay próxima visita en el contexto actual; no se ha buscado otra.",
    })[section]),
  ];
  return {
    type: "brief", title: "Preparación de lead", status: data.missing.length ? "partial" : "complete",
    sections: [
      { key: "lead", title: "Lead", availability: "available", fields: briefFields([
        ["Nombre", lead.lead.name], ["Estado", lead.lead.status], ["Origen", lead.lead.source],
        ["Teléfono", lead.lead.phone], ["Email", lead.lead.email], ["Comercial", lead.assignedAgent?.name],
        ["Calificación", lead.lead.qualification?.grade], ["Score", lead.lead.qualification?.score],
        ["Creado", lead.lead.createdAt ? formatDateTime(lead.lead.createdAt, timezone) : undefined],
        ["Última actividad", lead.lead.lastActivityAt ? formatDateTime(lead.lead.lastActivityAt, timezone) : undefined],
      ]) },
      { key: "commercial", title: "Situación comercial", availability: commercialAvailable ? "available" : "unavailable", fields: briefFields([
        ["Oportunidad", lead.opportunity?.status], ["Demanda", compactDemand(lead)],
        ["Presupuesto máximo", formatMoney(lead.activeDemand?.priceMax)], ["Habitaciones mínimas", lead.activeDemand?.roomsMin],
        ["Baños mínimos", lead.activeDemand?.bathroomsMin], ["Superficie mínima", lead.activeDemand?.areaMin, " m²"],
        ["Tareas pendientes", lead.pendingTasks.length],
      ]) },
      { key: "property", title: "Inmueble", availability: property ? "available" : "unavailable", fields: property ? briefFields([
        ["Referencia", property.reference], ["Título", property.title], ["Dirección", "address" in property ? property.address : undefined],
        ["Precio", formatMoney(property.price)], ["Estado", "status" in property ? property.status : undefined],
      ]) : [] },
      { key: "visit", title: "Próxima visita", availability: lead.nextVisit ? "available" : "unavailable", fields: lead.nextVisit ? briefFields([
        ["Fecha", formatDateTime(lead.nextVisit.at, timezone)], ["Estado", lead.nextVisit.status],
        ["Referencia inmueble", lead.nextVisit.propertyReference], ["Comercial", lead.nextVisit.assignedAgent],
      ]) : [] },
      { key: "preparation", title: "Preparación", availability: "available", fields: [], notes: preparationNotes },
    ],
  };
}

export class PrepareLeadBriefVerticalSlice {
  constructor(
    private readonly repository: ControlPlaneRepository,
    private readonly leadContext: LeadContextPort,
    private readonly skillEnabled: boolean,
  ) {}

  execute(actor: ActorContext, input: DeterministicSkillInput): Promise<DeterministicSkillTurn<PrepareLeadBriefData>> {
    const registry = new ProductToolRegistry([createCrmGetLeadContextTool({ port: this.leadContext })]);
    return executeDeterministicReadSkill(this.repository, actor, input, {
      id: SKILL_ID,
      profileId: "crm",
      objectiveClass: "lead.prepare_brief",
      objectiveCapabilities: ["crm.lead.context"],
      exactToolIds: EXACT_TOOL_IDS,
      contextRole: "lead",
      acceptsRef: leadRef,
      skillEnabled: this.skillEnabled,
      registry,
      missingInputSummary: "¿Qué lead quieres que prepare? Selecciona uno y vuelve a pedírmelo.",
      missingInputSuggestion: "Selecciona un lead desde una card de resultados.",
      deniedSummary: "No puedes preparar este lead dentro del scope actual.",
      failedSummary: "No se pudo preparar el lead.",
      procedure: async ({ selectedRef, contextRefs, callTool }) => {
        const lead = await callTool<CrmGetLeadContextOutput>("get_lead_context", CRM_GET_LEAD_CONTEXT_TOOL_ID, { lead: selectedRef });
        const commercialAvailable = Boolean(lead.opportunity || lead.activeDemand || lead.pendingTasks.length);
        const propertyAvailable = Boolean(lead.property || lead.opportunity?.propertyTitle || lead.opportunity?.propertyReference);
        const missing: PrepareLeadBriefData["missing"] = [
          ...(!commercialAvailable ? ["commercial" as const] : []),
          ...(!propertyAvailable ? ["property" as const] : []),
          ...(!lead.nextVisit ? ["visit" as const] : []),
        ];
        const data: PrepareLeadBriefData = { lead, missing };
        const result: ExecutionResult<PrepareLeadBriefData> = {
          status: missing.length ? "partial" : "completed",
          summary: missing.length
            ? "He preparado el lead con el contexto comercial disponible; los bloques ausentes no se han sustituido mediante búsquedas."
            : "Lead preparado con su contexto comercial, inmueble y próxima visita.",
          entities: [lead.lead.ref], data, blocks: [buildLeadBrief(data, actor.timezone)], errors: [],
        };
        return {
          result,
          contextRefs: { selected: { ...contextRefs.selected, lead: lead.lead.ref }, referenced: [lead.lead.ref] },
          completionEvent: { missing },
        };
      },
    });
  }
}
