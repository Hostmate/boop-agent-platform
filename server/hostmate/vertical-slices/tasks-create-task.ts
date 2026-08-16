import type { ActorContext } from "../contracts/actor-context.js";
import type { EntityRef } from "../contracts/domain.js";
import type { ControlPlaneRepository } from "../control-plane/repository.js";
import { SafeWritePreparationEngine, type SafeWriteConfig, type SafeWriteTurnResult } from "../drafts/safe-write-preparation-engine.js";
import { createTasksCreateTaskTool, TASKS_CREATE_TASK_PERMISSION, TASKS_CREATE_TASK_TOOL_ID, TASKS_CREATE_TASK_TOOL_VERSION, type TaskCandidate, type TaskInputIssue, type TaskPreparation, type TaskWritePort, tasksCreateTaskOutputSchema } from "../product-tools/tasks/create-task.js";

const REASON_MESSAGE: Record<TaskInputIssue, string> = {
  missing_title: "Indica qué hay que hacer en la tarea.", missing_date: "Indica una fecha concreta o relativa, por ejemplo: mañana.",
  ambiguous_time: "La hora es ambigua o no existe. Indica una hora de 24 h, por ejemplo: mañana a las 20:00.",
  ambiguous_date: "La fecha es ambigua o no existe. Indícala como AAAA-MM-DD.", past_due: "La tarea vencería en el pasado. Indica otra fecha u hora.",
  mixed_actions: "La petición contiene más de una acción. Pide solo la creación de la tarea.", multiple_tasks: "Preparo una sola tarea por confirmación; separa las tareas.",
  manual_target: "Selecciona primero un lead autorizado; no puedo crear tareas usando un ID escrito manualmente.",
  auto_confirm: "Puedo preparar el borrador, pero la confirmación siempre debe hacerla una persona desde la tarjeta.",
  raw_html: "El título de la tarea admite texto plano, no HTML raw.", secret: "No guardaré contraseñas, API keys, tokens ni credenciales en una tarea.",
  too_long: "El título supera el máximo de 255 caracteres.", unsupported_temporal: "Esta versión solo resuelve fechas en la zona Europe/Madrid.",
};

export class TasksCreateTaskVerticalSlice {
  private readonly engine: SafeWritePreparationEngine<TaskCandidate, TaskPreparation>;
  constructor(repository: ControlPlaneRepository, port: TaskWritePort, config: SafeWriteConfig) {
    this.engine = new SafeWritePreparationEngine(repository, config, {
      profileId: "crm", toolId: TASKS_CREATE_TASK_TOOL_ID, toolVersion: TASKS_CREATE_TASK_TOOL_VERSION,
      capability: "tasks.task.prepare", objectiveClass: "task.manage", requiredPermission: TASKS_CREATE_TASK_PERMISSION,
      selectedContextKey: "lead", selectedEntityType: "crm.lead", actorAllowed: (actor) => actor.role === "admin" || actor.role === "superadmin",
      tool: createTasksCreateTaskTool({ port }),
      missingInputMessage: (input, selected) => input.inputError ?? (!selected ? REASON_MESSAGE.manual_target : input.value === undefined ? REASON_MESSAGE.missing_title : undefined),
      toolInput: (candidate, selected) => ({ lead: selected, candidate }), parsePrepared: (value) => tasksCreateTaskOutputSchema.parse(value),
      project: (_candidate, selected, prepared) => ({
        target: { type: "crm.lead", id: selected.id, label: prepared.lead.name, deepLink: selected.deepLink },
        operationType: "create", operation: "task.create", requestedValue: prepared.candidate.title,
        structuredPayload: {
          title: prepared.candidate.title, dueDate: prepared.candidate.dueDate, dueTime: prepared.candidate.dueTime ?? null,
          dueAtUtc: prepared.candidate.dueAtUtc ?? null, timezone: prepared.candidate.timezone,
          temporalPhrase: prepared.candidate.temporalPhrase, referenceTime: prepared.candidate.referenceTime, inference: 0,
          assigneeUserId: prepared.assignee.userId, status: prepared.defaults.status, priority: prepared.defaults.priority,
        },
        preconditions: [
          { kind: "lead.assigned_agent_id", expected: prepared.lead.assignedAgentId ?? "unassigned" },
          { kind: "task.assignee_user_id", expected: prepared.assignee.userId },
          { kind: "task.due_at_utc", expected: prepared.candidate.dueAtUtc ?? prepared.candidate.dueDate },
        ],
        args: { lead: { type: "crm.lead", id: selected.id }, candidate: prepared.candidate },
        block: {
          title: "Crear tarea", description: `Se creará una tarea vinculada a ${prepared.lead.name}.`,
          changes: [
            { field: "Tarea", to: prepared.candidate.title }, { field: "Fecha", to: prepared.candidate.dueDate },
            ...(prepared.candidate.dueTime ? [{ field: "Hora", to: `${prepared.candidate.dueTime} (${prepared.candidate.timezone})` }] : []),
            { field: "Asignada a", to: prepared.assignee.name }, { field: "Estado", to: "Pendiente" }, { field: "Prioridad", to: "Media" },
          ], successMessage: "Tarea creada correctamente.",
        },
      }),
      toolStartedPayload: (candidate, selected) => ({ target: selected, dueDate: candidate.dueDate, hasTime: Boolean(candidate.dueTime), inference: 0 }),
      toolCompletedPayload: (prepared) => ({ service: "task.service.prepareAgentPlatformCreate", telemetry: prepared.telemetry, assignee: "current_actor", inference: 0 }),
      preparedSummary: "He preparado la tarea. Revisa la acción, fecha, hora y asignación antes de confirmarla.",
    });
  }
  execute(actor: ActorContext, input: { conversationId: string; message: string; selectedEntityRef?: EntityRef; candidate?: TaskCandidate; issue?: TaskInputIssue }): Promise<SafeWriteTurnResult> {
    return this.engine.execute(actor, { ...input, value: input.candidate, inputError: input.issue ? REASON_MESSAGE[input.issue] : undefined });
  }
}
