import type { ActorContext } from "../contracts/actor-context.js";
import type { EntityRef } from "../contracts/domain.js";
import type { BriefBlock, ExecutionResult } from "../contracts/execution-result.js";
import type { ControlPlaneRepository } from "../control-plane/repository.js";
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
import { applyContextTransition } from "../interaction/context-transition.js";
import {
  briefFields, executeDeterministicReadSkill, formatDateTime, formatMoney, isAuthorityFailure,
  type DeterministicSkillInput, type DeterministicSkillTurn,
} from "./execution-helpers.js";

const SKILL_ID = "prepare-visit-brief";
const EXACT_TOOL_IDS = [VISITS_GET_VISIT_TOOL_ID, CRM_GET_LEAD_CONTEXT_TOOL_ID, PROPERTY_GET_PROPERTY_TOOL_ID] as const;

export type PrepareVisitBriefData = Readonly<{
  visit: GetVisitOutput;
  lead?: CrmGetLeadContextOutput;
  property?: PropertyGetPropertyOutput;
  missing: readonly ("lead" | "property")[];
}>;

function visitRef(ref?: EntityRef): ref is EntityRef {
  return ref?.type === "visits.visit" || ref?.type === "visits.group_visit";
}

export function buildVisitBrief(data: PrepareVisitBriefData): BriefBlock {
  const visitFields = briefFields([
    ["Fecha", formatDateTime(data.visit.at, data.visit.timezone)], ["Estado", data.visit.status], ["Tipo", data.visit.visitType],
    ["Duración", data.visit.durationMinutes, " min"], ["Comercial", data.visit.assignedAgent?.name],
    ["Confirmación", data.visit.kind === "individual" ? data.visit.clientConfirmation : data.visit.registration.status],
  ]);
  const leadFields = data.lead ? briefFields([
    ["Nombre", data.lead.lead.name], ["Estado", data.lead.lead.status], ["Origen", data.lead.lead.source],
    ["Teléfono", data.lead.lead.phone], ["Email", data.lead.lead.email], ["Calificación", data.lead.lead.qualification?.grade],
    ["Demanda", [data.lead.activeDemand?.operationType, data.lead.activeDemand?.propertySubtype, data.lead.activeDemand?.city, data.lead.activeDemand?.zone].filter(Boolean).join(" · ")],
    ["Presupuesto máximo", formatMoney(data.lead.activeDemand?.priceMax)], ["Tareas pendientes", data.lead.pendingTasks.length],
  ]) : [];
  const propertyLocation = data.property
    ? [data.property.location.neighborhood, data.property.location.city, data.property.location.province].filter(Boolean).join(" · ")
    : "";
  const propertyFields = data.property ? briefFields([
    ["Referencia", data.property.reference], ["Título", data.property.title], ["Operación", data.property.operation], ["Tipo", data.property.propertyType],
    ["Estado", data.property.status], ["Precio", formatMoney(data.property.price)], ["Ubicación", propertyLocation],
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

export class PrepareVisitBriefVerticalSlice {
  constructor(
    private readonly repository: ControlPlaneRepository,
    private readonly visitDetail: VisitDetailPort,
    private readonly leadContext: LeadContextPort,
    private readonly propertyDetail: PropertyDetailPort,
    private readonly skillEnabled: boolean,
  ) {}

  execute(actor: ActorContext, input: DeterministicSkillInput): Promise<DeterministicSkillTurn<PrepareVisitBriefData>> {
    const registry = new ProductToolRegistry([
      createGetVisitTool({ port: this.visitDetail }),
      createCrmGetLeadContextTool({ port: this.leadContext }),
      createPropertyGetPropertyTool({ port: this.propertyDetail }),
    ]);
    return executeDeterministicReadSkill(this.repository, actor, input, {
      id: SKILL_ID,
      profileId: "visits",
      objectiveClass: "visit.prepare_brief",
      objectiveCapabilities: ["visits.visit.detail", "crm.lead.context", "property.property.read"],
      exactToolIds: EXACT_TOOL_IDS,
      contextRole: "visit",
      acceptsRef: visitRef,
      skillEnabled: this.skillEnabled,
      registry,
      missingInputSummary: "Selecciona una visita y vuelve a pedirme que la prepare.",
      missingInputSuggestion: "Selecciona una visita desde una card de resultados.",
      deniedSummary: "No puedes preparar esta visita dentro del scope actual.",
      failedSummary: "No se pudo preparar la visita.",
      procedure: async ({ selectedRef, contextRefs, callTool, event }) => {
        const visit = await callTool<GetVisitOutput>("get_visit", VISITS_GET_VISIT_TOOL_ID, { visit: selectedRef });
        let lead: CrmGetLeadContextOutput | undefined;
        let property: PropertyGetPropertyOutput | undefined;
        const missing: Array<"lead" | "property"> = [];
        const reads: Promise<void>[] = [];
        if (visit.lead?.ref) reads.push((async () => {
          try { lead = await callTool("get_lead_context", CRM_GET_LEAD_CONTEXT_TOOL_ID, { lead: visit.lead!.ref }); }
          catch (error) {
            if (isAuthorityFailure(error)) throw error;
            missing.push("lead");
            await event("tool.partial", { toolId: CRM_GET_LEAD_CONTEXT_TOOL_ID, reason: error instanceof Error ? error.name : "unavailable" });
          }
        })()); else missing.push("lead");
        if (visit.property?.ref) reads.push((async () => {
          try { property = await callTool("get_property", PROPERTY_GET_PROPERTY_TOOL_ID, { property: visit.property!.ref }); }
          catch (error) {
            if (isAuthorityFailure(error)) throw error;
            missing.push("property");
            await event("tool.partial", { toolId: PROPERTY_GET_PROPERTY_TOOL_ID, reason: error instanceof Error ? error.name : "unavailable" });
          }
        })()); else missing.push("property");
        const settled = await Promise.allSettled(reads);
        const rejected = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
        if (rejected) throw rejected.reason;

        const data: PrepareVisitBriefData = { visit, lead, property, missing: [...new Set(missing)] };
        const result: ExecutionResult<PrepareVisitBriefData> = {
          status: data.missing.length ? "partial" : "completed",
          summary: data.missing.length
            ? "He preparado la visita con la información disponible; faltan bloques que no he sustituido por otras entidades."
            : "Visita preparada con contexto del lead y del inmueble.",
          entities: [visit.ref, ...(visit.lead ? [visit.lead.ref] : []), ...(visit.property?.ref ? [visit.property.ref] : [])],
          data, blocks: [buildVisitBrief(data)], errors: [],
        };
        return {
          result,
          contextRefs: applyContextTransition({
            context: contextRefs,
            selected: visit.ref,
            relations: {
              visit: {
                ...(visit.lead?.ref ? { lead: visit.lead.ref } : {}),
                ...(visit.property?.ref ? { property: visit.property.ref } : {}),
              },
            },
          }).context,
          completionEvent: { missing: data.missing },
        };
      },
    });
  }
}
