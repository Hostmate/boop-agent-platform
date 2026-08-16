import type { ActorContext } from "../contracts/actor-context.js";
import type { EntityRef } from "../contracts/domain.js";
import type { ControlPlaneRepository } from "../control-plane/repository.js";
import { SafeWritePreparationEngine, type SafeWriteConfig, type SafeWriteTurnResult } from "../drafts/safe-write-preparation-engine.js";
import { createVisitsCancelVisitTool, VISITS_CANCEL_VISIT_PERMISSION, VISITS_CANCEL_VISIT_TOOL_ID, VISITS_CANCEL_VISIT_TOOL_VERSION, visitCancelPreparationSchema, type VisitCancelInputIssue, type VisitCancelPreparation, type VisitCancelWritePort } from "../product-tools/visits/cancel-visit.js";

const REASON_MESSAGE: Record<VisitCancelInputIssue, string> = {
  missing_visit: "Selecciona primero una visita individual autorizada desde una card.",
  manual_target: "Selecciona la visita desde una card autorizada; no acepto IDs manuales.",
  multiple_visits: "Esta versión cancela una sola visita por confirmación.", mixed_actions: "Pide únicamente la cancelación de la visita.",
  group_visit: "Las visitas grupales no están soportadas por esta capability.", unsupported_reschedule: "Reprogramar no está soportado y no se convertirá en cancelación.",
};
const EFFECT_LABEL: Record<string, string> = { google_calendar_cancel: "Eliminar el evento de Google Calendar", client_whatsapp_cancelled: "Notificar la cancelación por WhatsApp" };

export class VisitsCancelVisitVerticalSlice {
  private readonly engine: SafeWritePreparationEngine<{ intent: "cancel"; inference: 0 }, VisitCancelPreparation>;
  constructor(repository: ControlPlaneRepository, port: VisitCancelWritePort, config: SafeWriteConfig) {
    this.engine = new SafeWritePreparationEngine(repository, config, {
      profileId: "visits", toolId: VISITS_CANCEL_VISIT_TOOL_ID, toolVersion: VISITS_CANCEL_VISIT_TOOL_VERSION,
      capability: "visits.visit.cancel.prepare", objectiveClass: "visit.update", requiredPermission: VISITS_CANCEL_VISIT_PERMISSION,
      selectedContextKey: "visit", selectedEntityType: "visits.visit", risk: "R2", requireConversationProvenance: true,
      actorAllowed: (actor) => actor.role === "admin" || actor.role === "superadmin", tool: createVisitsCancelVisitTool({ port }),
      missingInputMessage: (input, selected) => input.inputError ?? (!selected ? REASON_MESSAGE.missing_visit : undefined),
      toolInput: (_candidate, selected) => ({ visit: selected }), parsePrepared: (value) => visitCancelPreparationSchema.parse(value),
      project: (_candidate, selected, prepared) => {
        const externalEffects = prepared.sideEffectPlan.external.join(",") || "none";
        return {
          target: { type: "visits.visit", id: selected.id, label: selected.label, deepLink: selected.deepLink },
          operationType: "update", operation: "visit.cancel", requestedValue: "cancelled_by_agent",
          structuredPayload: {
            visitId: String(prepared.visit.id), leadId: prepared.lead.id == null ? null : String(prepared.lead.id),
            propertyId: prepared.property.id == null ? null : String(prepared.property.id),
            opportunityId: prepared.opportunity.id == null ? null : String(prepared.opportunity.id),
            agentId: prepared.agent.id == null ? null : String(prepared.agent.id), currentStatus: prepared.visit.status,
            targetStatus: prepared.targetStatus, visitDatetime: prepared.visit.datetime, durationMinutes: prepared.visit.durationMinutes,
            lifecycleGeneration: prepared.visit.generation, materialFingerprint: prepared.materialFingerprint, reasonCode: null,
            externalEffects, requiredAtomicEffects: prepared.sideEffectPlan.requiredAtomic.join(","), postCommitInternalEffects: prepared.sideEffectPlan.postCommitInternal.join(","),
          },
          preconditions: [
            { kind: "visit.status", expected: prepared.visit.status }, { kind: "visit.datetime", expected: prepared.visit.datetime ?? "none" },
            { kind: "visit.lifecycle_generation", expected: prepared.visit.generation }, { kind: "visit.material_fingerprint", expected: prepared.materialFingerprint },
            { kind: "visit.side_effect_plan", expected: externalEffects },
          ],
          args: { visit: { type: "visits.visit", id: selected.id } },
          block: {
            title: "Cancelar visita", description: "La visita pasará a cancelada por el comercial tras una revalidación transaccional.",
            changes: [
              { field: "Visita", to: selected.label ?? `Visita ${selected.id}` }, { field: "Lead", to: prepared.lead.name },
              { field: "Inmueble", to: `${prepared.property.reference} · ${prepared.property.title ?? "Sin título"}` },
              { field: "Fecha y hora", to: prepared.visit.datetime ?? "Sin fecha" }, { field: "Estado actual", to: prepared.visit.status },
              { field: "Estado final", to: prepared.targetStatus }, { field: "Riesgo", to: "R2 · confirmación humana obligatoria" },
            ], warnings: [],
            sideEffects: [...prepared.sideEffectPlan.postCommitInternal.map(() => "Desactivar el recordatorio"), ...prepared.sideEffectPlan.external.map((effect) => EFFECT_LABEL[effect] ?? effect)],
            successMessage: "Visita cancelada correctamente.",
          },
        };
      },
      toolStartedPayload: (_candidate, selected) => ({ visit: selected, inference: 0 }),
      toolCompletedPayload: (prepared) => ({ service: "visit-cancel-domain.prepareVisitCancel", telemetry: prepared.telemetry, status: prepared.visit.status, targetStatus: prepared.targetStatus, sideEffectPlan: prepared.sideEffectPlan, inference: 0 }),
      noOp: (_candidate, prepared) => prepared.noOp ? "La visita ya estaba cancelada. No he creado ningún borrador ni efecto." : undefined,
      preparedSummary: "He preparado la cancelación. Revisa visita, relaciones, estado y efectos antes de confirmarla.",
    });
  }
  execute(actor: ActorContext, input: { conversationId: string; message: string; selectedEntityRef?: EntityRef; issue?: VisitCancelInputIssue }): Promise<SafeWriteTurnResult> {
    return this.engine.execute(actor, { ...input, value: input.issue ? undefined : { intent: "cancel", inference: 0 }, inputError: input.issue ? REASON_MESSAGE[input.issue] : undefined });
  }
}
