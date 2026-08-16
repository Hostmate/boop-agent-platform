import type { ActorContext } from "../contracts/actor-context.js";
import type { EntityRef } from "../contracts/domain.js";
import type { ControlPlaneRepository } from "../control-plane/repository.js";
import { SafeWritePreparationEngine, type SafeWriteConfig, type SafeWriteTurnResult } from "../drafts/safe-write-preparation-engine.js";
import {
  createVisitsCreateVisitTool, VISITS_CREATE_VISIT_PERMISSION, VISITS_CREATE_VISIT_TOOL_ID, VISITS_CREATE_VISIT_TOOL_VERSION,
  type VisitCandidate, type VisitInputIssue, type VisitPreparation, type VisitWritePort, visitPreparationSchema,
} from "../product-tools/visits/create-visit.js";

const REASON_MESSAGE: Record<VisitInputIssue, string> = {
  missing_lead: "Selecciona primero un lead autorizado desde una card.",
  missing_property: "Selecciona también un inmueble autorizado desde una card.",
  missing_time: "Indica una fecha y una hora exactas para la visita.",
  ambiguous_time: "La hora es ambigua. Indica una hora exacta en formato de 24 horas, por ejemplo 20:00.",
  ambiguous_date: "La fecha es ambigua o no existe. Indica una fecha inequívoca.",
  past_start: "La visita quedaría en el pasado. Indica otra fecha y hora.",
  manual_target: "Selecciona Lead e inmueble desde resultados autorizados; no acepto IDs manuales.",
  multiple_visits: "Esta versión prepara una sola visita individual por confirmación.",
  group_visit: "Las visitas grupales no están soportadas en esta versión y no se convertirán en individuales.",
  unsupported_operation: "Reprogramar, cancelar o actualizar una visita no está soportado en esta fase.",
  unsupported_temporal: "Esta versión solo resuelve fechas en Europe/Madrid.",
};

const EFFECT_LABEL: Record<string, string> = {
  google_calendar: "Añadir invitación al calendario",
  client_whatsapp: "Enviar confirmación por WhatsApp",
  reminder: "Programar recordatorio",
};
const WARNING_LABEL: Record<string, string> = {
  TRAVEL_BUFFER: "El tiempo de desplazamiento entre visitas es ajustado.",
  EXTERNAL_CALENDAR_BUSY: "El calendario externo del comercial muestra una ocupación.",
};

export class VisitsCreateVisitVerticalSlice {
  private readonly engine: SafeWritePreparationEngine<VisitCandidate, VisitPreparation>;
  constructor(repository: ControlPlaneRepository, port: VisitWritePort, config: SafeWriteConfig) {
    this.engine = new SafeWritePreparationEngine(repository, config, {
      profileId: "visits", toolId: VISITS_CREATE_VISIT_TOOL_ID, toolVersion: VISITS_CREATE_VISIT_TOOL_VERSION,
      capability: "visits.visit.prepare", objectiveClass: "visit.create", requiredPermission: VISITS_CREATE_VISIT_PERMISSION,
      selectedContextKey: "lead", selectedEntityType: "crm.lead", risk: "R2", requireConversationProvenance: true,
      requiredContextRefs: [{ contextKey: "property", entityType: "property.property", missingMessage: REASON_MESSAGE.missing_property }],
      actorAllowed: (actor) => actor.role === "admin" || actor.role === "superadmin",
      tool: createVisitsCreateVisitTool({ port }),
      missingInputMessage: (input, selected) => input.inputError ?? (!selected ? REASON_MESSAGE.missing_lead : input.value === undefined ? REASON_MESSAGE.missing_time : undefined),
      toolInput: (candidate, selected, context) => ({ lead: selected, property: context.selected.property, candidate }),
      parsePrepared: (value) => visitPreparationSchema.parse(value),
      project: (_candidate, selected, prepared, context) => {
        const property = context.selected.property!;
        const hardSnapshot = prepared.constraints.hardConflicts.map((conflict) => conflict.code).join(",") || "none";
        const warningSnapshot = prepared.constraints.warnings.map((warning) => warning.code).join(",") || "none";
        const externalEffects = prepared.sideEffectPlan.external.join(",") || "none";
        return {
          target: { type: "crm.lead", id: selected.id, label: prepared.lead.name, deepLink: selected.deepLink },
          relatedEntities: [{ type: "property.property", id: property.id, label: prepared.property.title ?? prepared.property.reference, deepLink: property.deepLink }],
          operationType: "create", operation: "visit.create", requestedValue: `${prepared.candidate.startDate} ${prepared.candidate.startTime}`,
          structuredPayload: {
            leadId: prepared.lead.id, propertyId: prepared.property.id, opportunityId: prepared.opportunity.id,
            agentId: prepared.agent.id, agentName: prepared.agent.name,
            startDate: prepared.candidate.startDate, startTime: prepared.candidate.startTime, startAtUtc: prepared.candidate.startAtUtc,
            timezone: prepared.candidate.timezone, temporalPhrase: prepared.candidate.temporalPhrase,
            referenceTime: prepared.candidate.referenceTime, inference: 0,
            durationMinutes: prepared.duration.minutes, durationSource: prepared.duration.source, durationClass: prepared.duration.durationClass,
            initialStatus: prepared.initialStatus, hardConstraints: hardSnapshot, advisories: warningSnapshot,
            externalEffects, requiredAtomicEffects: prepared.sideEffectPlan.requiredAtomic.join(","),
            postCommitInternalEffects: prepared.sideEffectPlan.postCommitInternal.join(","),
          },
          preconditions: [
            { kind: "visit.opportunity_id", expected: prepared.opportunity.id },
            { kind: "visit.agent_id", expected: prepared.agent.id },
            { kind: "visit.duration", expected: `${prepared.duration.minutes}:${prepared.duration.source}:${prepared.duration.durationClass}` },
            { kind: "visit.initial_status", expected: prepared.initialStatus },
            { kind: "visit.datetime", expected: prepared.candidate.startAtUtc },
            { kind: "visit.hard_constraints", expected: hardSnapshot },
            { kind: "visit.side_effect_plan", expected: externalEffects },
          ],
          args: { lead: { type: "crm.lead", id: selected.id }, property: { type: "property.property", id: property.id }, candidate: prepared.candidate },
          block: {
            title: "Programar visita", description: "Se creará una visita individual después de una revalidación completa del dominio Visits.",
            changes: [
              { field: "Lead", to: prepared.lead.name },
              { field: "Inmueble", to: `${prepared.property.reference} · ${prepared.property.title ?? "Sin título"}` },
              { field: "Fecha", to: prepared.candidate.startDate },
              { field: "Hora", to: `${prepared.candidate.startTime} (${prepared.candidate.timezone})` },
              { field: "Duración", to: `${prepared.duration.minutes} minutos` },
              { field: "Comercial", to: prepared.agent.name },
              { field: "Estado inicial", to: prepared.initialStatus },
            ],
            warnings: prepared.constraints.warnings.map((warning) => WARNING_LABEL[warning.code] ?? warning.code),
            sideEffects: ["Crear la visita y sus efectos internos", ...prepared.sideEffectPlan.external.map((effect) => EFFECT_LABEL[effect] ?? effect)],
            successMessage: "Visita creada correctamente.",
          },
        };
      },
      toolStartedPayload: (candidate, selected, context) => ({ lead: selected, property: context.selected.property, startAtUtc: candidate.startAtUtc, inference: 0 }),
      toolCompletedPayload: (prepared) => ({
        service: "visit-create-domain.prepareVisitCreate", telemetry: prepared.telemetry,
        opportunityId: prepared.opportunity.id, agentId: prepared.agent.id, duration: prepared.duration,
        constraints: prepared.constraints, sideEffectPlan: prepared.sideEffectPlan, inference: 0,
      }),
      noOp: (_candidate, prepared) => prepared.constraints.allowed ? undefined : "Ese horario no está disponible según las restricciones HARD de Visits. No he creado un borrador confirmable.",
      preparedSummary: "He preparado la visita. Revisa Lead, inmueble, horario, comercial, duración, avisos y efectos antes de confirmarla.",
    });
  }

  execute(actor: ActorContext, input: { conversationId: string; message: string; selectedEntityRef?: EntityRef; candidate?: VisitCandidate; issue?: VisitInputIssue }): Promise<SafeWriteTurnResult> {
    return this.engine.execute(actor, { ...input, value: input.candidate, inputError: input.issue ? REASON_MESSAGE[input.issue] : undefined });
  }
}
