import { z } from "zod";
import type { ActorContext } from "../../contracts/actor-context.js";
import { entityRefSchema } from "../../contracts/execution-result.js";
import type { SafeWriteCommitResult } from "../../drafts/safe-write-commit-registry.js";
import type { ProductToolDefinition } from "../../tools/registry.js";

export const VISITS_CANCEL_VISIT_TOOL_ID = "visits.cancel_visit.v1";
export const VISITS_CANCEL_VISIT_TOOL_VERSION = 1;
export const VISITS_CANCEL_VISIT_PERMISSION = "visits.read";

const visitRefSchema = entityRefSchema.extend({ type: z.literal("visits.visit"), id: z.string().regex(/^[1-9]\d*$/).max(20) }).strict();
export const visitsCancelVisitInputShape = { visit: visitRefSchema.describe("Visit EntityRef individual seleccionada con provenance autorizada.") } satisfies z.ZodRawShape;
export const visitsCancelVisitInputSchema = z.object(visitsCancelVisitInputShape).strict();
export type VisitsCancelVisitInput = z.infer<typeof visitsCancelVisitInputSchema>;

const effectSchema = z.enum(["google_calendar_cancel", "client_whatsapp_cancelled"]);
export const visitCancelPreparationSchema = z.object({
  visit: z.object({ id: z.number().int().positive(), status: z.string().min(1), datetime: z.string().datetime({ offset: true }).nullable(), durationMinutes: z.number().int().positive(), generation: z.string().regex(/^\d+$/) }).strict(),
  lead: z.object({ id: z.number().int().positive().nullable(), name: z.string().min(1).max(160) }).strict(),
  property: z.object({ id: z.number().int().positive().nullable(), reference: z.string().min(1), title: z.string().nullable() }).strict(),
  opportunity: z.object({ id: z.number().int().positive().nullable() }).strict(), agent: z.object({ id: z.number().int().positive().nullable() }).strict(),
  targetStatus: z.literal("cancelled_by_agent"), reasonCode: z.null(), noOp: z.boolean(),
  materialFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  sideEffectPlan: z.object({ requiredAtomic: z.array(z.string()), postCommitInternal: z.array(z.string()), external: z.array(effectSchema) }).strict(),
  telemetry: z.object({ service: z.string(), latencyMs: z.number().nonnegative() }).strict().optional(),
}).strict();
export type VisitCancelPreparation = z.infer<typeof visitCancelPreparationSchema>;

export interface VisitCancelWritePort {
  prepare(actor: ActorContext, input: VisitsCancelVisitInput): Promise<VisitCancelPreparation>;
  commit(actor: ActorContext, input: { signedIntent: unknown }): Promise<SafeWriteCommitResult>;
}

export function createVisitsCancelVisitTool(input: { port: VisitCancelWritePort }): ProductToolDefinition<typeof visitsCancelVisitInputShape> {
  return {
    toolId: VISITS_CANCEL_VISIT_TOOL_ID, namespace: "visits", name: "cancel_visit", version: 1,
    description: "Prepara un borrador firmado R2 para cancelar la visita individual seleccionada. Nunca cancela, confirma ni ejecuta efectos.",
    ownerDomain: "visits", compatibleProfiles: ["visits"], capabilities: ["visits.visit.cancel.prepare"],
    mode: "draft", risk: "R2", requiredPermission: VISITS_CANCEL_VISIT_PERMISSION,
    inputSchema: visitsCancelVisitInputShape, outputSchema: visitCancelPreparationSchema,
    availability: "active", idempotency: "required",
    handler: async (raw, actor) => {
      const parsed = visitsCancelVisitInputSchema.parse(raw);
      const prepared = await input.port.prepare(actor, parsed);
      if (String(prepared.visit.id) !== parsed.visit.id) throw new Error("VISIT_CANCEL_PREPARATION_MISMATCH");
      return visitCancelPreparationSchema.parse(prepared);
    },
  };
}

export type VisitCancelInputIssue = "missing_visit" | "manual_target" | "multiple_visits" | "mixed_actions" | "group_visit" | "unsupported_reschedule";
export type VisitCancelIntentClassification = Readonly<{ kind: "none" }> | Readonly<{ kind: "needs_input"; reason: VisitCancelInputIssue }> | Readonly<{ kind: "cancel" }>;

export function classifyVisitCancelIntent(message: string): VisitCancelIntentClassification {
  const value = message.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  const cancelVerb = /\b(cancela|cancelar|cancel.?la|anul.?la|anula|anular|cancel)\b/.test(value);
  const visitNoun = /\b(visita|visitas|visit|visits|cita|citas|appointment|appointments)\b/.test(value);
  if (!cancelVerb || !visitNoun) return { kind: "none" };
  if (/\b(reprograma|reprogramar|reschedule|mueve|moure|move|cambia.*hora|canvia.*hora)\b/.test(value)) return { kind: "needs_input", reason: "unsupported_reschedule" };
  if (/\b(grupal|group|open house)\b/.test(value)) return { kind: "needs_input", reason: "group_visit" };
  if (/\b(visitas|visits|citas)\b/.test(value) || /\b(dos|tres|varias|multiples|several|all|todas|totes)\b/.test(value)) return { kind: "needs_input", reason: "multiple_visits" };
  if (/\b(visita|visit|cita)\s*#?\s*\d+\b/.test(value)) return { kind: "needs_input", reason: "manual_target" };
  if (/\b(crea|crear|agenda|programa|confirma|completa|create|schedule|confirm|complete)\b/.test(value.replace(/\b(y confirma|and confirm|i confirma)\b/g, ""))) return { kind: "needs_input", reason: "mixed_actions" };
  return { kind: "cancel" };
}
