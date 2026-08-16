import { z } from "zod";
import type { ActorContext } from "../../contracts/actor-context.js";
import { entityRefSchema } from "../../contracts/execution-result.js";
import type { SafeWriteCommitResult } from "../../drafts/safe-write-commit-registry.js";
import type { ProductToolDefinition } from "../../tools/registry.js";

export const TASKS_CREATE_TASK_TOOL_ID = "tasks.create_task.v1";
export const TASKS_CREATE_TASK_TOOL_VERSION = 1;
export const TASKS_CREATE_TASK_PERMISSION = "crm.write";
export const TASKS_CREATE_TASK_TIMEZONE = "Europe/Madrid";

const leadRefSchema = entityRefSchema.extend({
  type: z.literal("crm.lead"), id: z.string().regex(/^[1-9]\d*$/).max(20),
}).strict();

export const taskCandidateSchema = z.object({
  title: z.string().trim().min(1).max(255).refine((value) => !/<\/?[a-z][^>]*>/i.test(value)),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dueTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).optional(),
  dueAtUtc: z.string().datetime({ offset: true }).optional(),
  timezone: z.literal(TASKS_CREATE_TASK_TIMEZONE),
  temporalPhrase: z.string().trim().min(1).max(120),
  referenceTime: z.string().datetime({ offset: true }),
  inference: z.literal(0),
}).strict().superRefine((value, context) => {
  if ((value.dueTime === undefined) !== (value.dueAtUtc === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "dueTime and dueAtUtc must be supplied together" });
  }
});
export type TaskCandidate = z.infer<typeof taskCandidateSchema>;

export const tasksCreateTaskInputShape = {
  lead: leadRefSchema.describe("EntityRef crm.lead seleccionada y autorizada; nunca aceptes un ID escrito por el usuario."),
  candidate: taskCandidateSchema.describe("Candidato temporal ya resuelto; no contiene assignee ni autoridad."),
} satisfies z.ZodRawShape;
export const tasksCreateTaskInputSchema = z.object(tasksCreateTaskInputShape).strict();
export type TasksCreateTaskInput = z.infer<typeof tasksCreateTaskInputSchema>;

export type TaskPreparation = Readonly<{
  lead: Readonly<{ id: string; name: string; assignedAgentId?: string }>;
  candidate: TaskCandidate;
  assignee: Readonly<{ userId: string; name: string }>;
  defaults: Readonly<{ status: "pending"; priority: "medium"; description: null }>;
  telemetry?: Readonly<{ service: string; latencyMs: number }>;
}>;

export interface TaskWritePort {
  prepare(actor: ActorContext, input: TasksCreateTaskInput): Promise<TaskPreparation>;
  commit(actor: ActorContext, input: { signedIntent: unknown }): Promise<SafeWriteCommitResult>;
}

export const tasksCreateTaskOutputSchema = z.object({
  lead: z.object({ id: z.string(), name: z.string().min(1).max(160), assignedAgentId: z.string().optional() }).strict(),
  candidate: taskCandidateSchema,
  assignee: z.object({ userId: z.string().regex(/^[1-9]\d*$/), name: z.string().min(1).max(160) }).strict(),
  defaults: z.object({ status: z.literal("pending"), priority: z.literal("medium"), description: z.null() }).strict(),
  telemetry: z.object({ service: z.string(), latencyMs: z.number().nonnegative() }).strict().optional(),
}).strict();

export function createTasksCreateTaskTool(input: { port: TaskWritePort }): ProductToolDefinition<typeof tasksCreateTaskInputShape> {
  return {
    toolId: TASKS_CREATE_TASK_TOOL_ID, namespace: "tasks", name: "create_task", version: 1,
    description: "Prepara un borrador firmado para crear una tarea estructurada vinculada al lead seleccionado. Nunca confirma ni escribe Product Data.",
    ownerDomain: "tasks", compatibleProfiles: ["crm"], capabilities: ["tasks.task.prepare"],
    mode: "draft", risk: "R1", requiredPermission: TASKS_CREATE_TASK_PERMISSION,
    inputSchema: tasksCreateTaskInputShape, outputSchema: tasksCreateTaskOutputSchema,
    availability: "active", idempotency: "required",
    handler: async (raw, actor) => {
      const parsed = tasksCreateTaskInputSchema.parse(raw);
      const prepared = await input.port.prepare(actor, parsed);
      if (prepared.lead.id !== parsed.lead.id || prepared.assignee.userId !== actor.userId
        || JSON.stringify(prepared.candidate) !== JSON.stringify(parsed.candidate)) {
        throw new Error("TASK_PREPARATION_MISMATCH");
      }
      return tasksCreateTaskOutputSchema.parse(prepared);
    },
  };
}

export type TaskInputIssue = "missing_title" | "missing_date" | "ambiguous_time" | "ambiguous_date" | "past_due" | "mixed_actions" | "multiple_tasks" | "manual_target" | "auto_confirm" | "raw_html" | "secret" | "too_long" | "unsupported_temporal";
export type TaskIntentClassification =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "needs_input"; reason: TaskInputIssue }>
  | Readonly<{ kind: "task"; candidate: TaskCandidate }>;

function normalized(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function partsInZone(date: Date, timezone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
}

function localDate(now: Date, timezone: string): Date {
  const parts = partsInZone(now, timezone);
  return new Date(Date.UTC(parts.year!, parts.month! - 1, parts.day!));
}

function isoDate(date: Date): string { return date.toISOString().slice(0, 10); }
function addDays(date: Date, count: number): Date { const next = new Date(date); next.setUTCDate(next.getUTCDate() + count); return next; }

export function zonedDateTimeToUtc(dueDate: string, dueTime: string, timezone = TASKS_CREATE_TASK_TIMEZONE): string | undefined {
  const [year, month, day] = dueDate.split("-").map(Number);
  const [hour, minute] = dueTime.split(":").map(Number);
  if (![year, month, day, hour, minute].every(Number.isFinite)) return undefined;
  const desired = Date.UTC(year!, month! - 1, day!, hour!, minute!, 0);
  let instant = desired;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = partsInZone(new Date(instant), timezone);
    const rendered = Date.UTC(actual.year!, actual.month! - 1, actual.day!, actual.hour!, actual.minute!, actual.second!);
    instant += desired - rendered;
  }
  const verify = partsInZone(new Date(instant), timezone);
  if (verify.year !== year || verify.month !== month || verify.day !== day || verify.hour !== hour || verify.minute !== minute) return undefined;
  return new Date(instant).toISOString();
}

function resolveDate(token: string, now: Date, timezone: string): string | undefined {
  const value = normalized(token).trim();
  const today = localDate(now, timezone);
  if (/^(hoy|today|avui)$/.test(value)) return isoDate(today);
  if (/^(manana|tomorrow|dema)$/.test(value)) return isoDate(addDays(today, 1));
  const offset = value.match(/^(?:en|dentro de|in|within|d'aqui)\s+(\d{1,3}|un|uno|dos|tres|one|two|three)\s+(?:dias?|days?|dies)$/);
  if (offset) {
    const words: Record<string, number> = { un: 1, uno: 1, one: 1, dos: 2, two: 2, tres: 3, three: 3 };
    return isoDate(addDays(today, words[offset[1]!] ?? Number(offset[1])));
  }
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const slash = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (iso || slash) {
    const year = Number(iso?.[1] ?? slash?.[3]); const month = Number(iso?.[2] ?? slash?.[2]); const day = Number(iso?.[3] ?? slash?.[1]);
    const candidate = new Date(Date.UTC(year, month - 1, day));
    return candidate.getUTCFullYear() === year && candidate.getUTCMonth() === month - 1 && candidate.getUTCDate() === day ? isoDate(candidate) : undefined;
  }
  const weekdays: Record<string, number> = { domingo: 0, sunday: 0, diumenge: 0, lunes: 1, monday: 1, dilluns: 1, martes: 2, tuesday: 2, dimarts: 2, miercoles: 3, wednesday: 3, dimecres: 3, jueves: 4, thursday: 4, dijous: 4, viernes: 5, friday: 5, divendres: 5, sabado: 6, saturday: 6, dissabte: 6 };
  if (weekdays[value] !== undefined) {
    const delta = (weekdays[value]! - today.getUTCDay() + 7) % 7 || 7;
    return isoDate(addDays(today, delta));
  }
  return undefined;
}

const DATE_TOKEN = String.raw`(?:hoy|mañana|manana|avui|today|tomorrow|demà|dema|(?:en|dentro de|in|within|d'aquí|d'aqui)\s+(?:\d{1,3}|un|uno|dos|tres|one|two|three)\s+(?:días?|dias?|days?|dies)|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4}|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo|monday|tuesday|wednesday|thursday|friday|saturday|sunday|dilluns|dimarts|dimecres|dijous|divendres|dissabte|diumenge)`;
const TEMPORAL = new RegExp(`\\b(${DATE_TOKEN})(?:\\s*(?:,|\\s)*(?:a\\s+las|a\\s+les|at)\\s*(\\d{1,2})(?::(\\d{2}))?)?\\s*[.!]?\\s*$`, "iu");
const TASK_PREFIX = /^\s*(?:crea(?:me)?|crear|añade|anade|programa|apunta|recuérdame|recuerdame|afegeix|crea(?:'m)?|create|add|schedule|remind me)\s+(?:(?:una|a)\s+)?(?:tarea|task|recordatorio|reminder)\b\s*/iu;

export function classifyTaskWriteIntent(input: { message: string; now?: Date; timezone?: string }): TaskIntentClassification {
  const now = input.now ?? new Date();
  const timezone = input.timezone ?? TASKS_CREATE_TASK_TIMEZONE;
  if (timezone !== TASKS_CREATE_TASK_TIMEZONE) return { kind: "needs_input", reason: "unsupported_temporal" };
  const prefix = TASK_PREFIX.exec(normalized(input.message));
  if (!prefix) return { kind: "none" };
  const value = normalized(input.message);
  if (/\blead\s*#?\s*\d+\b(?![-/])/.test(value)) return { kind: "needs_input", reason: "manual_target" };
  if ((value.match(/\b(tarea|task|recordatorio|reminder)\b/g) ?? []).length > 1) return { kind: "needs_input", reason: "multiple_tasks" };
  if (/\s+(?:y|and|i)\s+(?:cambia|actualiza|marca|mueve|pon|set|update|change|anade una nota|añade una nota|add a note)\b/.test(value)) return { kind: "needs_input", reason: "mixed_actions" };
  if (/\s+(?:y|and|i)\s+(?:confirma|confirmalo|aprueba|auto[ -]?confirma|confirm)\b/.test(value)) return { kind: "needs_input", reason: "auto_confirm" };
  if (/\b(?:por la manana|por la tarde|por la noche|esta noche|tonight|morning|afternoon|evening|mati|tarda|vespre)\b/.test(value)) return { kind: "needs_input", reason: "ambiguous_time" };
  const tail = input.message.slice(prefix[0].length);
  const temporal = TEMPORAL.exec(tail);
  if (!temporal) {
    if (/(?:a\s+las|a\s+les|at)\s*\d{1,2}(?::\d{2})?\s*$/iu.test(tail)) return { kind: "needs_input", reason: "missing_date" };
    return { kind: "needs_input", reason: "missing_date" };
  }
  const dueDate = resolveDate(temporal[1]!, now, timezone);
  if (!dueDate) return { kind: "needs_input", reason: "ambiguous_date" };
  let dueTime: string | undefined;
  let dueAtUtc: string | undefined;
  if (temporal[2] !== undefined) {
    const hour = Number(temporal[2]); const minute = Number(temporal[3] ?? "0");
    if (hour > 23 || minute > 59) return { kind: "needs_input", reason: "ambiguous_time" };
    dueTime = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    dueAtUtc = zonedDateTimeToUtc(dueDate, dueTime, timezone);
    if (!dueAtUtc) return { kind: "needs_input", reason: "ambiguous_time" };
  }
  const currentDate = isoDate(localDate(now, timezone));
  if (dueDate < currentDate || (dueAtUtc && Date.parse(dueAtUtc) <= now.getTime())) return { kind: "needs_input", reason: "past_due" };
  let title = tail.slice(0, temporal.index).trim().replace(/^(?:para|to|per)\b\s*/iu, "").replace(/[,:;.!]+\s*$/u, "").trim();
  title = title.replace(/\b(?:a este|al|a aquest)\s+(?:lead|cliente)\b/iu, "al lead");
  if (!title) return { kind: "needs_input", reason: "missing_title" };
  title = title.charAt(0).toLocaleUpperCase("es-ES") + title.slice(1);
  if (title.length > 255) return { kind: "needs_input", reason: "too_long" };
  if (/<\/?[a-z][^>]*>/i.test(title)) return { kind: "needs_input", reason: "raw_html" };
  if (/\b(password|contraseña|contrasena|api[ _-]?key|access[ _-]?token|credential|credencial)\s*[:=]/i.test(title)) return { kind: "needs_input", reason: "secret" };
  return { kind: "task", candidate: {
    title, dueDate, ...(dueTime ? { dueTime, dueAtUtc } : {}), timezone,
    temporalPhrase: temporal[0].trim().replace(/[.!]+$/u, ""), referenceTime: now.toISOString(), inference: 0,
  } };
}
