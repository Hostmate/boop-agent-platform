import type { ActorContext } from "../contracts/actor-context.js";
import type { EntityRef } from "../contracts/domain.js";
import type { ControlPlaneRepository } from "../control-plane/repository.js";
import { SafeWritePreparationEngine, type SafeWriteConfig, type SafeWriteTurnResult } from "../drafts/safe-write-preparation-engine.js";
import {
  CRM_ADD_LEAD_NOTE_PERMISSION,
  CRM_ADD_LEAD_NOTE_TOOL_ID,
  CRM_ADD_LEAD_NOTE_TOOL_VERSION,
  createCrmAddLeadNoteTool,
  crmAddLeadNoteOutputSchema,
  leadNoteContentHash,
  type LeadNotePreparation,
  type LeadNoteWritePort,
} from "../product-tools/crm/add-lead-note.js";

const REASON_MESSAGE = {
  missing_content: "Indica el texto exacto de la nota, por ejemplo: “Añade una nota: Quiere volver a hablar en septiembre.”",
  mixed_actions: "La petición contiene más de una acción. Pide primero la nota o el cambio de estado; no preparo batches de escritura.",
  manual_target: "Selecciona primero un lead autorizado; no puedo añadir notas usando un ID escrito manualmente.",
  auto_confirm: "Puedo preparar el borrador, pero la confirmación siempre debe hacerla una persona desde la tarjeta.",
  blank: "La nota no puede estar vacía.",
  too_long: "La nota supera el máximo de 10.000 caracteres.",
  raw_html: "Las notas del agente admiten texto plano, no HTML raw.",
  secret: "No guardaré contraseñas, API keys, tokens ni credenciales en una nota creada por el agente.",
} as const;

export type LeadNoteInputIssue = keyof typeof REASON_MESSAGE;
export type CrmAddLeadNoteTurnResult = SafeWriteTurnResult;

export class CrmAddLeadNoteVerticalSlice {
  private readonly engine: SafeWritePreparationEngine<string, LeadNotePreparation>;

  constructor(repository: ControlPlaneRepository, port: LeadNoteWritePort, config: SafeWriteConfig) {
    this.engine = new SafeWritePreparationEngine(repository, config, {
      profileId: "crm",
      toolId: CRM_ADD_LEAD_NOTE_TOOL_ID,
      toolVersion: CRM_ADD_LEAD_NOTE_TOOL_VERSION,
      capability: "crm.lead.note.prepare",
      // Notes are an append-only mutation of the lead aggregate. Reuse the
      // CRM profile's existing lead.update objective class; operationType
      // remains "create" so commit semantics are still explicit.
      objectiveClass: "lead.update",
      requiredPermission: CRM_ADD_LEAD_NOTE_PERMISSION,
      selectedContextKey: "lead",
      selectedEntityType: "crm.lead",
      tool: createCrmAddLeadNoteTool({ port }),
      missingInputMessage: (input, selected) => input.inputError
        ?? (!selected
          ? REASON_MESSAGE.manual_target
          : input.value === undefined ? REASON_MESSAGE.missing_content : undefined),
      toolInput: (content, selected) => ({ lead: selected, content }),
      parsePrepared: (value) => crmAddLeadNoteOutputSchema.parse(value),
      project: (content, selected, prepared) => ({
        target: { type: "crm.lead", id: selected.id, label: prepared.lead.name, deepLink: selected.deepLink },
        operationType: "create",
        operation: "lead.note.append",
        requestedValue: content,
        preconditions: [{ kind: "lead.assigned_agent_id", expected: prepared.lead.assignedAgentId ?? "unassigned" }],
        args: { lead: { type: "crm.lead", id: selected.id }, content },
        block: {
          title: "Añadir nota al lead",
          description: `Se añadirá una nota interna a ${prepared.lead.name}.`,
          changes: [
            { field: "Nota", to: content },
            { field: "Visibilidad", to: "Interna" },
          ],
          successMessage: "Nota añadida correctamente.",
        },
      }),
      toolStartedPayload: (content, selected) => ({ target: selected, contentHash: leadNoteContentHash(content), contentLength: content.length }),
      toolCompletedPayload: (prepared) => ({ service: "lead.service.prepareNoteCreate", telemetry: prepared.telemetry, visibility: prepared.visibility, contentHash: leadNoteContentHash(prepared.content), contentLength: prepared.content.length }),
      preparedSummary: "He preparado la nota. Revisa el texto exacto y confírmala para añadirla.",
    });
  }

  execute(actor: ActorContext, input: { conversationId: string; message: string; selectedEntityRef?: EntityRef; content?: string; issue?: LeadNoteInputIssue }): Promise<CrmAddLeadNoteTurnResult> {
    return this.engine.execute(actor, { ...input, value: input.content, inputError: input.issue ? REASON_MESSAGE[input.issue] : undefined });
  }
}
