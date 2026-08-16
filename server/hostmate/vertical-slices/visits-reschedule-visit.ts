import type { ActorContext } from "../contracts/actor-context.js";
import type { EntityRef } from "../contracts/domain.js";
import type { ControlPlaneRepository } from "../control-plane/repository.js";
import { SafeWritePreparationEngine, type SafeWriteConfig, type SafeWriteTurnResult } from "../drafts/safe-write-preparation-engine.js";
import { createVisitsRescheduleVisitTool, VISITS_RESCHEDULE_VISIT_PERMISSION, VISITS_RESCHEDULE_VISIT_TOOL_ID, VISITS_RESCHEDULE_VISIT_TOOL_VERSION, visitReschedulePreparationSchema, type VisitRescheduleInputIssue, type VisitReschedulePreparation, type VisitRescheduleWritePort } from "../product-tools/visits/reschedule-visit.js";
import type { VisitCandidate } from "../product-tools/visits/create-visit.js";

const REASON_MESSAGE: Record<VisitRescheduleInputIssue, string> = {
  missing_visit: "Selecciona primero una visita individual autorizada desde una card.", manual_target: "Selecciona la visita desde una card; no acepto IDs manuales.",
  multiple_visits: "Esta versión reprograma una sola visita por confirmación.", group_visit: "Las visitas grupales no están soportadas.",
  change_property: "Reprogramar no cambia el inmueble.", change_agent: "Reprogramar no reasigna el comercial.", mixed_actions: "Pide únicamente la reprogramación.",
  missing_time: "Indica fecha y hora exactas.", ambiguous_time: "La hora es ambigua; indica una hora exacta, por ejemplo 19:00.",
  ambiguous_date: "La fecha es ambigua; indica un día concreto.", past_start: "El nuevo horario debe estar en el futuro.", unsupported_temporal: "Indica una fecha y hora exactas compatibles.",
};
const EFFECT_LABEL: Record<string, string> = { google_calendar_reschedule: "Actualizar Google Calendar", client_whatsapp_rescheduled: "Enviar WhatsApp de reprogramación" };
const ATOMIC_EFFECT_LABEL: Record<string, string> = { "visit.update": "Actualizar la visita", "reminder.replace": "Sustituir el reminder" };

export class VisitsRescheduleVisitVerticalSlice {
  private readonly engine: SafeWritePreparationEngine<VisitCandidate, VisitReschedulePreparation>;
  constructor(repository: ControlPlaneRepository, port: VisitRescheduleWritePort, config: SafeWriteConfig) {
    this.engine = new SafeWritePreparationEngine(repository, config, {
      profileId: "visits", toolId: VISITS_RESCHEDULE_VISIT_TOOL_ID, toolVersion: VISITS_RESCHEDULE_VISIT_TOOL_VERSION,
      capability: "visits.visit.reschedule.prepare", objectiveClass: "visit.update", requiredPermission: VISITS_RESCHEDULE_VISIT_PERMISSION,
      selectedContextKey: "visit", selectedEntityType: "visits.visit", risk: "R2", requireConversationProvenance: true,
      actorAllowed: (actor) => actor.role === "admin" || (actor.role === "superadmin" && actor.effectiveTenantOverride),
      tool: createVisitsRescheduleVisitTool({ port }),
      missingInputMessage: (input, selected) => input.inputError ?? (!selected ? REASON_MESSAGE.missing_visit : undefined),
      toolInput: (candidate, selected) => ({ visit: selected, candidate }), parsePrepared: (value) => visitReschedulePreparationSchema.parse(value),
      project: (candidate, selected, prepared) => {
        const externalEffects = prepared.sideEffectPlan.external.join(",") || "none";
        const hardConstraints = JSON.stringify(prepared.constraints.hardConflicts);
        const advisories = JSON.stringify(prepared.constraints.warnings);
        return {
          target: { type: "visits.visit", id: selected.id, label: selected.label, deepLink: selected.deepLink },
          operationType: "update", operation: "visit.reschedule", requestedValue: `${candidate.startDate} ${candidate.startTime}`,
          structuredPayload: {
            visitId: String(prepared.visit.id), currentStatus: prepared.visit.status, oldDatetime: prepared.visit.oldDatetime,
            newDatetime: candidate.startAtUtc, oldDurationMinutes: prepared.visit.oldDurationMinutes, durationMinutes: prepared.duration.durationMinutes,
            durationSource: prepared.duration.source, durationClass: prepared.duration.durationClass,
            agentId: String(prepared.agent.id), agentName: prepared.agent.name, propertyId: String(prepared.property.id), propertyReference: prepared.property.reference,
            opportunityId: String(prepared.opportunity.id), leadId: String(prepared.lead.id),
            oldSlotId: prepared.slots.oldSlotId == null ? null : String(prepared.slots.oldSlotId), newSlotId: prepared.slots.newSlotId == null ? null : String(prepared.slots.newSlotId),
            scheduleLocks: prepared.scheduleLocks.join(","), hardConstraints, advisories,
            reminderGeneration: prepared.reminder.generation, reminderScheduledAt: prepared.reminder.scheduledAt,
            calendarEventId: prepared.calendar.eventId, calendarConnected: prepared.calendar.connected,
            externalEffects, lifecycleGeneration: prepared.visit.generation, nextGeneration: prepared.nextGeneration,
            materialFingerprint: prepared.materialFingerprint,
            startDate: candidate.startDate, startTime: candidate.startTime, startAtUtc: candidate.startAtUtc, timezone: candidate.timezone,
            temporalPhrase: candidate.temporalPhrase, referenceTime: candidate.referenceTime, inference: candidate.inference,
          },
          preconditions: [
            { kind: "visit.material_fingerprint", expected: prepared.materialFingerprint }, { kind: "visit.status", expected: prepared.visit.status },
            { kind: "visit.datetime", expected: prepared.visit.oldDatetime },
            { kind: "visit.duration", expected: `${prepared.visit.oldDurationMinutes}:${prepared.duration.durationMinutes}:${prepared.duration.source}:${prepared.duration.durationClass}` },
            { kind: "visit.agent_id", expected: String(prepared.agent.id) }, { kind: "visit.property_id", expected: String(prepared.property.id) },
            { kind: "visit.opportunity_id", expected: String(prepared.opportunity.id) }, { kind: "visit.slots", expected: `${prepared.slots.oldSlotId ?? "none"}:${prepared.slots.newSlotId ?? "none"}` },
            { kind: "visit.reminder_generation", expected: prepared.reminder.generation }, { kind: "visit.calendar", expected: `${prepared.calendar.eventId ?? "none"}:${prepared.calendar.connected}` },
            { kind: "visit.lifecycle_generation", expected: prepared.visit.generation }, { kind: "visit.side_effect_plan", expected: externalEffects },
          ],
          args: { visit: { type: "visits.visit", id: selected.id }, candidate },
          block: {
            title: "Reprogramar visita", description: "La misma visita se actualizará solo si el nuevo horario sigue siendo válido al confirmar.",
            changes: [
              { field: "Lead", to: prepared.lead.name }, { field: "Inmueble", to: `${prepared.property.reference} · ${prepared.property.title ?? "Sin título"}` },
              { field: "Horario actual", to: prepared.visit.oldDatetime }, { field: "Nuevo horario", to: `${candidate.startDate} · ${candidate.startTime}` },
              { field: "Duración", to: `${prepared.duration.durationMinutes} min` }, { field: "Comercial", to: prepared.agent.name },
              { field: "Riesgo", to: "R2 · confirmación humana obligatoria" },
            ], warnings: prepared.constraints.warnings.map((warning) => warning.code),
            sideEffects: [
              ...prepared.sideEffectPlan.requiredAtomic.flatMap((effect) => ATOMIC_EFFECT_LABEL[effect] ? [ATOMIC_EFFECT_LABEL[effect]] : []),
              ...prepared.sideEffectPlan.external.map((effect) => EFFECT_LABEL[effect] ?? effect),
            ], successMessage: "Visita reprogramada correctamente.",
          },
        };
      },
      toolStartedPayload: (candidate, selected) => ({ visit: selected, candidate, inference: 0 }),
      toolCompletedPayload: (prepared) => ({
        service: "visit-reschedule-domain.prepareVisitReschedule", telemetry: prepared.telemetry,
        visit: prepared.visit, lead: prepared.lead, property: prepared.property, opportunity: prepared.opportunity,
        agent: prepared.agent, duration: prepared.duration, slots: prepared.slots, reminder: prepared.reminder,
        calendar: prepared.calendar, oldDatetime: prepared.visit.oldDatetime, newDatetime: prepared.visit.newDatetime,
        constraints: prepared.constraints, locks: prepared.scheduleLocks, generation: prepared.nextGeneration,
        sideEffectPlan: prepared.sideEffectPlan, inference: 0,
      }),
      preparedSummary: "He preparado la reprogramación. Revisa el horario anterior, el nuevo, los avisos y los efectos antes de confirmar.",
    });
  }
  execute(actor: ActorContext, input: { conversationId: string; message: string; selectedEntityRef?: EntityRef; candidate?: VisitCandidate; issue?: VisitRescheduleInputIssue }): Promise<SafeWriteTurnResult> {
    return this.engine.execute(actor, { ...input, value: input.candidate, inputError: input.issue ? REASON_MESSAGE[input.issue] : undefined });
  }
}
