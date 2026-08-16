import { z } from "zod";
import type { ActorContext } from "../../contracts/actor-context.js";
import { entityRefSchema } from "../../contracts/execution-result.js";
import type { SafeWriteCommitResult } from "../../drafts/safe-write-commit-registry.js";
import { classifyTaskWriteIntent } from "../tasks/create-task.js";
import type { ProductToolDefinition } from "../../tools/registry.js";

export const VISITS_CREATE_VISIT_TOOL_ID = "visits.create_visit.v1";
export const VISITS_CREATE_VISIT_TOOL_VERSION = 1;
export const VISITS_CREATE_VISIT_PERMISSION = "visits.read";
export const VISITS_CREATE_VISIT_TIMEZONE = "Europe/Madrid";

const leadRefSchema = entityRefSchema.extend({ type: z.literal("crm.lead"), id: z.string().regex(/^[1-9]\d*$/).max(20) }).strict();
const propertyRefSchema = entityRefSchema.extend({ type: z.literal("property.property"), id: z.string().regex(/^[1-9]\d*$/).max(20) }).strict();

export const visitCandidateSchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  startAtUtc: z.string().datetime({ offset: true }),
  timezone: z.literal(VISITS_CREATE_VISIT_TIMEZONE),
  temporalPhrase: z.string().trim().min(1).max(120),
  referenceTime: z.string().datetime({ offset: true }),
  inference: z.literal(0),
}).strict();
export type VisitCandidate = z.infer<typeof visitCandidateSchema>;

export const visitsCreateVisitInputShape = {
  lead: leadRefSchema.describe("Lead EntityRef seleccionada con provenance autorizada."),
  property: propertyRefSchema.describe("Property EntityRef seleccionada con provenance autorizada."),
  candidate: visitCandidateSchema.describe("Únicamente fecha y hora exactas ya resueltas; nunca autoridad o reglas de negocio."),
} satisfies z.ZodRawShape;
export const visitsCreateVisitInputSchema = z.object(visitsCreateVisitInputShape).strict();
export type VisitsCreateVisitInput = z.infer<typeof visitsCreateVisitInputSchema>;

const hardConflictSchema = z.object({ code: z.string(), propertyId: z.number().int().optional(), status: z.string().nullable().optional(), visitType: z.string().optional(), agentId: z.number().int().optional(), conflictingVisitId: z.number().int().optional() }).passthrough();
const warningSchema = z.object({ code: z.string(), reason: z.string().optional(), externalBlockId: z.number().int().optional() }).passthrough();
const effectSchema = z.enum(["google_calendar", "client_whatsapp", "reminder"]);

export const visitPreparationSchema = z.object({
  lead: z.object({ id: z.string().regex(/^[1-9]\d*$/), name: z.string().min(1).max(160) }).strict(),
  property: z.object({ id: z.string().regex(/^[1-9]\d*$/), reference: z.string().min(1).max(160), title: z.string().nullable(), status: z.string().nullable() }).strict(),
  opportunity: z.object({ id: z.string().regex(/^[1-9]\d*$/) }).strict(),
  agent: z.object({ id: z.string().regex(/^[1-9]\d*$/), name: z.string().min(1).max(160) }).strict(),
  candidate: visitCandidateSchema,
  duration: z.object({ minutes: z.number().int().positive(), source: z.string().min(1), durationClass: z.string().min(1) }).strict(),
  initialStatus: z.enum(["pending", "confirmed"]),
  constraints: z.object({ allowed: z.boolean(), hardConflicts: z.array(hardConflictSchema), warnings: z.array(warningSchema) }).strict(),
  sideEffectPlan: z.object({ requiredAtomic: z.array(z.string()), postCommitInternal: z.array(z.string()), external: z.array(effectSchema) }).strict(),
  telemetry: z.object({ service: z.string(), latencyMs: z.number().nonnegative() }).strict().optional(),
}).strict();
export type VisitPreparation = z.infer<typeof visitPreparationSchema>;

export interface VisitWritePort {
  prepare(actor: ActorContext, input: VisitsCreateVisitInput): Promise<VisitPreparation>;
  commit(actor: ActorContext, input: { signedIntent: unknown }): Promise<SafeWriteCommitResult>;
}

export function createVisitsCreateVisitTool(input: { port: VisitWritePort }): ProductToolDefinition<typeof visitsCreateVisitInputShape> {
  return {
    toolId: VISITS_CREATE_VISIT_TOOL_ID, namespace: "visits", name: "create_visit", version: 1,
    description: "Prepara un borrador firmado para crear una visita individual usando Lead y Property autorizados. Nunca confirma ni escribe Product Data.",
    ownerDomain: "visits", compatibleProfiles: ["visits"], capabilities: ["visits.visit.prepare"],
    mode: "draft", risk: "R2", requiredPermission: VISITS_CREATE_VISIT_PERMISSION,
    inputSchema: visitsCreateVisitInputShape, outputSchema: visitPreparationSchema,
    availability: "active", idempotency: "required",
    handler: async (raw, actor) => {
      const parsed = visitsCreateVisitInputSchema.parse(raw);
      const prepared = await input.port.prepare(actor, parsed);
      if (prepared.lead.id !== parsed.lead.id || prepared.property.id !== parsed.property.id
        || JSON.stringify(prepared.candidate) !== JSON.stringify(parsed.candidate)) throw new Error("VISIT_PREPARATION_MISMATCH");
      return visitPreparationSchema.parse(prepared);
    },
  };
}

export type VisitInputIssue = "missing_lead" | "missing_property" | "missing_time" | "ambiguous_time" | "ambiguous_date" | "past_start" | "manual_target" | "multiple_visits" | "group_visit" | "unsupported_operation" | "unsupported_temporal";
export type VisitIntentClassification =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "needs_input"; reason: VisitInputIssue }>
  | Readonly<{ kind: "visit"; candidate: VisitCandidate }>;

const CREATE_VISIT_PREFIX = /^\s*(?:agenda|agendar|programa|programar|reserva|reservar|crea|crear|schedule|book)\s+(?:(?:una|a)\s+)?(?:visita|visit)\b/iu;
const OTHER_VISIT_OPERATION = /^\s*(?:mueve|reprograma|cancela|actualiza|modifica|reschedule|cancel|move|update)\b.*\b(?:visita|visit)\b/iu;

export function classifyVisitWriteIntent(input: { message: string; now?: Date; timezone?: string }): VisitIntentClassification {
  if (OTHER_VISIT_OPERATION.test(input.message)) return { kind: "needs_input", reason: "unsupported_operation" };
  const prefix = CREATE_VISIT_PREFIX.exec(input.message);
  if (!prefix) return { kind: "none" };
  const normalized = input.message.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (/\b(?:grupal|grupo|group|open house)\b/.test(normalized)) return { kind: "needs_input", reason: "group_visit" };
  if (/\b(?:dos|tres|cuatro|varias|multiples|multiple|several|2|3|4)\s+(?:visitas|visits)\b/.test(normalized) || /\bvisitas\b/.test(normalized)) return { kind: "needs_input", reason: "multiple_visits" };
  if (/\b(?:lead|cliente|inmueble|property|propiedad)\s*#?\s*\d+\b(?![-/])/.test(normalized)) return { kind: "needs_input", reason: "manual_target" };
  let tail = input.message.slice(prefix[0].length).trim();
  // Auto-confirm language never reaches a commit path; it is ignored for
  // parsing so the user still receives a mandatory pending Draft.
  tail = tail.replace(/\s+(?:y|and|i)\s+(?:conf[ií]rmala|conf[ií]rmalo|confirma|confirm it)(?:\s+(?:t[uú]|you))?[.!]?\s*$/iu, "");
  const temporal = classifyTaskWriteIntent({
    message: `Crea una tarea para visita ${tail}`,
    now: input.now,
    timezone: input.timezone ?? VISITS_CREATE_VISIT_TIMEZONE,
  });
  if (temporal.kind === "needs_input") {
    const reason = temporal.reason === "ambiguous_time" ? "ambiguous_time"
      : temporal.reason === "ambiguous_date" ? "ambiguous_date"
      : temporal.reason === "past_due" ? "past_start"
      : temporal.reason === "unsupported_temporal" ? "unsupported_temporal"
      : "missing_time";
    return { kind: "needs_input", reason };
  }
  if (temporal.kind !== "task" || !temporal.candidate.dueTime || !temporal.candidate.dueAtUtc) return { kind: "needs_input", reason: "missing_time" };
  if (/(?:a\s+las|a\s+les|at)\s*8(?:\s|[.!]|$)/iu.test(temporal.candidate.temporalPhrase)) return { kind: "needs_input", reason: "ambiguous_time" };
  return { kind: "visit", candidate: {
    startDate: temporal.candidate.dueDate, startTime: temporal.candidate.dueTime,
    startAtUtc: temporal.candidate.dueAtUtc, timezone: temporal.candidate.timezone,
    temporalPhrase: temporal.candidate.temporalPhrase, referenceTime: temporal.candidate.referenceTime, inference: 0,
  } };
}
