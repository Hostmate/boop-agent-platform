import type { ActorContext } from "../contracts/actor-context.js";
import type { EntityRef } from "../contracts/domain.js";
import type { ControlPlaneRepository } from "../control-plane/repository.js";
import { SafeWritePreparationEngine, type SafeWriteConfig, type SafeWriteTurnResult } from "../drafts/safe-write-preparation-engine.js";
import {
  CRM_UPDATE_LEAD_STATUS_PERMISSION,
  CRM_UPDATE_LEAD_STATUS_TOOL_ID,
  CRM_UPDATE_LEAD_STATUS_TOOL_VERSION,
  createCrmUpdateLeadStatusTool,
  crmUpdateLeadStatusOutputSchema,
  type CanonicalLeadStatus,
  type LeadStatusPreparation,
  type LeadStatusWritePort,
} from "../product-tools/crm/update-lead-status.js";

const STATUS_LABEL: Record<CanonicalLeadStatus, string> = {
  new: "Nuevo", contacted: "Contactado", qualified: "Cualificado", visit_scheduled: "Visita programada",
};

export type CrmUpdateLeadStatusTurnResult = SafeWriteTurnResult;

export class CrmUpdateLeadStatusVerticalSlice {
  private readonly engine: SafeWritePreparationEngine<CanonicalLeadStatus, LeadStatusPreparation>;

  constructor(repository: ControlPlaneRepository, port: LeadStatusWritePort, config: SafeWriteConfig) {
    this.engine = new SafeWritePreparationEngine(repository, config, {
      profileId: "crm",
      toolId: CRM_UPDATE_LEAD_STATUS_TOOL_ID,
      toolVersion: CRM_UPDATE_LEAD_STATUS_TOOL_VERSION,
      capability: "crm.lead.status.prepare",
      objectiveClass: "lead.update",
      requiredPermission: CRM_UPDATE_LEAD_STATUS_PERMISSION,
      selectedContextKey: "lead",
      selectedEntityType: "crm.lead",
      tool: createCrmUpdateLeadStatusTool({ port }),
      missingInputMessage: (input, selected) => input.inputError
        ?? (!selected
          ? "Selecciona primero un lead autorizado; no puedo cambiar estados usando un ID escrito manualmente."
          : input.value === undefined ? "Indica uno de estos estados: Nuevo, Contactado, Cualificado o Visita programada." : undefined),
      toolInput: (requestedStatus, selected) => ({ lead: selected, requestedStatus }),
      parsePrepared: (value) => crmUpdateLeadStatusOutputSchema.parse(value),
      project: (requestedStatus, selected, prepared) => ({
        target: { type: "crm.lead", id: selected.id, label: prepared.lead.name, deepLink: selected.deepLink },
        operationType: "update",
        operation: "lead.status.set",
        requestedValue: requestedStatus,
        preconditions: [
          { kind: "lead.status", expected: prepared.lead.status },
          { kind: "lead.assigned_agent_id", expected: prepared.lead.assignedAgentId ?? "unassigned" },
        ],
        args: { lead: { type: "crm.lead", id: selected.id }, requestedStatus },
        block: {
          title: "Confirmar cambio de estado",
          description: `Se cambiará el estado de ${prepared.lead.name}.`,
          changes: [{ field: "Estado", from: STATUS_LABEL[prepared.lead.status], to: STATUS_LABEL[requestedStatus] }],
        },
      }),
      toolStartedPayload: (requestedStatus, selected) => ({ target: selected, requestedStatus }),
      toolCompletedPayload: (prepared) => ({ service: "lead.service.prepareStatusUpdate", telemetry: prepared.telemetry }),
      noOp: (requestedStatus, prepared) => prepared.noOp
        ? `${prepared.lead.name} ya está en estado ${STATUS_LABEL[requestedStatus]}; no se ha creado ningún borrador.`
        : undefined,
      preparedSummary: "He preparado el cambio. Revisa el borrador y confírmalo para aplicarlo.",
    });
  }

  execute(actor: ActorContext, input: { conversationId: string; message: string; selectedEntityRef?: EntityRef; requestedStatus?: CanonicalLeadStatus; inputError?: string }): Promise<CrmUpdateLeadStatusTurnResult> {
    return this.engine.execute(actor, { ...input, value: input.requestedStatus });
  }
}
