import { z } from "zod";
import type { ActorContext } from "../../contracts/actor-context.js";
import { entityRefSchema } from "../../contracts/execution-result.js";
import type { SafeWriteCommitResult } from "../../drafts/safe-write-commit-registry.js";
import type { ProductToolDefinition } from "../../tools/registry.js";
import { classifyVisitWriteIntent, visitCandidateSchema, type VisitCandidate } from "./create-visit.js";

export const VISITS_RESCHEDULE_VISIT_TOOL_ID = "visits.reschedule_visit.v1";
export const VISITS_RESCHEDULE_VISIT_TOOL_VERSION = 1;
export const VISITS_RESCHEDULE_VISIT_PERMISSION = "visits.read";

const visitRefSchema = entityRefSchema.extend({ type: z.literal("visits.visit"), id: z.string().regex(/^[1-9]\d*$/).max(20) }).strict();
export const visitsRescheduleVisitInputShape = {
  visit: visitRefSchema.describe("Visit EntityRef individual seleccionada con provenance autorizada."),
  candidate: visitCandidateSchema.describe("Solo intención temporal exacta; autoridad y dominio se resuelven en servidor."),
} satisfies z.ZodRawShape;
export const visitsRescheduleVisitInputSchema = z.object(visitsRescheduleVisitInputShape).strict();
export type VisitsRescheduleVisitInput = z.infer<typeof visitsRescheduleVisitInputSchema>;

const hardConflictSchema = z.object({ code: z.string() }).passthrough();
const warningSchema = z.object({ code: z.string() }).passthrough();
const effectSchema = z.enum(["google_calendar_reschedule", "client_whatsapp_rescheduled"]);
export const visitReschedulePreparationSchema = z.object({
  visit: z.object({ id: z.number().int().positive(), status: z.enum(["pending", "confirmed", "floating"]), generation: z.string().regex(/^\d+$/), oldDatetime: z.string().datetime({ offset: true }), newDatetime: z.string().datetime({ offset: true }), oldDurationMinutes: z.number().int().positive() }).strict(),
  lead: z.object({ id: z.number().int().positive(), name: z.string().min(1).max(160), phone: z.string().min(1) }).strict(),
  property: z.object({ id: z.number().int().positive(), reference: z.string().min(1), title: z.string().nullable() }).strict(),
  opportunity: z.object({ id: z.number().int().positive() }).strict(),
  agent: z.object({ id: z.number().int().positive(), name: z.string().min(1).max(160) }).strict(),
  candidate: visitCandidateSchema,
  duration: z.object({ durationMinutes: z.number().int().positive(), source: z.string().min(1), durationClass: z.string().min(1) }).strict(),
  slots: z.object({ oldSlotId: z.number().int().positive().nullable(), newSlotId: z.number().int().positive().nullable() }).strict(),
  scheduleLocks: z.array(z.string()),
  constraints: z.object({ allowed: z.boolean(), hardConflicts: z.array(hardConflictSchema), warnings: z.array(warningSchema) }).strict(),
  reminder: z.object({ present: z.boolean(), generation: z.string().regex(/^\d+$/), scheduledAt: z.string().datetime({ offset: true }).nullable(), tokenPresent: z.boolean() }).strict(),
  calendar: z.object({ eventId: z.string().nullable(), connected: z.boolean() }).strict(),
  sideEffectPlan: z.object({ requiredAtomic: z.array(z.string()), external: z.array(effectSchema) }).strict(),
  nextGeneration: z.string().regex(/^\d+$/), materialFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  telemetry: z.object({ service: z.string(), latencyMs: z.number().nonnegative() }).strict().optional(),
}).strict();
export type VisitReschedulePreparation = z.infer<typeof visitReschedulePreparationSchema>;

export interface VisitRescheduleWritePort {
  prepare(actor: ActorContext, input: VisitsRescheduleVisitInput): Promise<VisitReschedulePreparation>;
  commit(actor: ActorContext, input: { signedIntent: unknown }): Promise<SafeWriteCommitResult>;
}

export function createVisitsRescheduleVisitTool(input: { port: VisitRescheduleWritePort }): ProductToolDefinition<typeof visitsRescheduleVisitInputShape> {
  return {
    toolId: VISITS_RESCHEDULE_VISIT_TOOL_ID, namespace: "visits", name: "reschedule_visit", version: 1,
    description: "Prepara un borrador R2 para reprogramar la misma visita individual a una fecha y hora exactas. Nunca muta ni confirma.",
    ownerDomain: "visits", compatibleProfiles: ["visits"], capabilities: ["visits.visit.reschedule.prepare"],
    mode: "draft", risk: "R2", requiredPermission: VISITS_RESCHEDULE_VISIT_PERMISSION,
    inputSchema: visitsRescheduleVisitInputShape, outputSchema: visitReschedulePreparationSchema,
    availability: "active", idempotency: "required",
    handler: async (raw, actor) => {
      const parsed = visitsRescheduleVisitInputSchema.parse(raw);
      const prepared = await input.port.prepare(actor, parsed);
      if (String(prepared.visit.id) !== parsed.visit.id || JSON.stringify(prepared.candidate) !== JSON.stringify(parsed.candidate)) throw new Error("VISIT_RESCHEDULE_PREPARATION_MISMATCH");
      return visitReschedulePreparationSchema.parse(prepared);
    },
  };
}

export type VisitRescheduleInputIssue = "missing_visit" | "manual_target" | "multiple_visits" | "group_visit" | "change_property" | "change_agent" | "mixed_actions" | "missing_time" | "ambiguous_time" | "ambiguous_date" | "past_start" | "unsupported_temporal";
export type VisitRescheduleIntentClassification = Readonly<{ kind: "none" }> | Readonly<{ kind: "needs_input"; reason: VisitRescheduleInputIssue }> | Readonly<{ kind: "reschedule"; candidate: VisitCandidate }>;

const PREFIX = /^\s*(?:mueve|mover|reprograma|reprogramar|reschedule|move|cambia|cambiar)\s+(?:(?:esta|la|this|the)\s+)?(?:visita|cita|visit|appointment)\b/iu;

export function classifyVisitRescheduleIntent(input: { message: string; now?: Date; timezone?: string }): VisitRescheduleIntentClassification {
  const normalized = input.message.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const rescheduleVerb = /\b(?:mueve|mover|reprograma|reprogramar|reschedule|move|cambia|cambiar)\b/.test(normalized);
  if (!rescheduleVerb) return { kind: "none" };
  if (/\b(?:todas|varias|multiples|all|several)\s+(?:las\s+)?(?:visitas|citas|visits|appointments)\b/.test(normalized)) return { kind: "needs_input", reason: "multiple_visits" };
  if (/\b(?:asigna\w*|reasigna\w*|comercial|agente|agent)\b/.test(normalized) && !PREFIX.test(input.message)) return { kind: "needs_input", reason: "change_agent" };
  const prefix = PREFIX.exec(input.message);
  if (!prefix) return { kind: "none" };
  if (/\b(?:visita|cita|visit|appointment)\s*#?\s*\d+\b/.test(normalized)) return { kind: "needs_input", reason: "manual_target" };
  if (/\b(?:todas|varias|multiples|all|several|visitas|citas|visits|appointments)\b/.test(normalized)) return { kind: "needs_input", reason: "multiple_visits" };
  if (/\b(?:grupal|group|open house)\b/.test(normalized)) return { kind: "needs_input", reason: "group_visit" };
  if (/\b(?:inmueble|propiedad|property)\b/.test(normalized)) return { kind: "needs_input", reason: "change_property" };
  if (/\b(?:asigna\w*|reasigna\w*|comercial|agente|agent)\b/.test(normalized)) return { kind: "needs_input", reason: "change_agent" };
  if (/\b(?:cancela\w*|completa\w*|complete|crea otra|create another)\b/.test(normalized)) return { kind: "needs_input", reason: "mixed_actions" };
  const tail = input.message.slice(prefix[0].length).replace(/^\s*(?:a|para|to)\s+/iu, "").trim();
  const parsed = classifyVisitWriteIntent({ message: `Agenda una visita ${tail}`, now: input.now, timezone: input.timezone });
  if (parsed.kind === "visit") return { kind: "reschedule", candidate: parsed.candidate };
  if (parsed.kind === "needs_input") {
    const allowed: VisitRescheduleInputIssue[] = ["missing_time", "ambiguous_time", "ambiguous_date", "past_start", "unsupported_temporal"];
    return { kind: "needs_input", reason: allowed.includes(parsed.reason as VisitRescheduleInputIssue) ? parsed.reason as VisitRescheduleInputIssue : "missing_time" };
  }
  return { kind: "needs_input", reason: "missing_time" };
}
