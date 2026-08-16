import { createHash } from "node:crypto";
import { z } from "zod";
import type { ActorContext } from "../../contracts/actor-context.js";
import { entityRefSchema } from "../../contracts/execution-result.js";
import type { ProductToolDefinition } from "../../tools/registry.js";
import type { SafeWriteCommitResult } from "../../drafts/safe-write-commit-registry.js";

export const CRM_ADD_LEAD_NOTE_TOOL_ID = "crm.add_lead_note.v1";
export const CRM_ADD_LEAD_NOTE_TOOL_VERSION = 1;
export const CRM_ADD_LEAD_NOTE_PERMISSION = "crm.write";
export const LEAD_NOTE_MAX_LENGTH = 10_000;

const leadRefSchema = entityRefSchema.extend({
  type: z.literal("crm.lead"), id: z.string().regex(/^[1-9]\d*$/).max(20),
}).strict();

const noteContentSchema = z.string().min(1).max(LEAD_NOTE_MAX_LENGTH)
  .refine((value) => value.trim().length > 0, "Note content cannot be blank")
  .refine((value) => !/<\/?[a-z][^>]*>/i.test(value), "Raw HTML is not supported");

export const crmAddLeadNoteInputShape = {
  lead: leadRefSchema.describe("EntityRef crm.lead seleccionada y autorizada; nunca escribas un ID manual."),
  content: noteContentSchema.describe("Texto plano exacto que verá el usuario antes de confirmar."),
} satisfies z.ZodRawShape;

export const crmAddLeadNoteInputSchema = z.object(crmAddLeadNoteInputShape).strict();
export type CrmAddLeadNoteInput = z.infer<typeof crmAddLeadNoteInputSchema>;

export type LeadNotePreparation = Readonly<{
  lead: Readonly<{ id: string; name: string; assignedAgentId?: string }>;
  content: string;
  visibility: "internal";
  isPinned: false;
  telemetry?: Readonly<{ service: string; latencyMs: number }>;
}>;

export interface LeadNoteWritePort {
  prepare(actor: ActorContext, input: CrmAddLeadNoteInput): Promise<LeadNotePreparation>;
  commit(actor: ActorContext, input: { signedIntent: unknown }): Promise<SafeWriteCommitResult>;
}

export const crmAddLeadNoteOutputSchema = z.object({
  lead: z.object({ id: z.string(), name: z.string().min(1).max(160), assignedAgentId: z.string().optional() }).strict(),
  content: noteContentSchema,
  visibility: z.literal("internal"),
  isPinned: z.literal(false),
  telemetry: z.object({ service: z.string(), latencyMs: z.number().nonnegative() }).strict().optional(),
}).strict();

export function createCrmAddLeadNoteTool(input: { port: LeadNoteWritePort }): ProductToolDefinition<typeof crmAddLeadNoteInputShape> {
  return {
    toolId: CRM_ADD_LEAD_NOTE_TOOL_ID,
    namespace: "crm",
    name: "add_lead_note",
    version: CRM_ADD_LEAD_NOTE_TOOL_VERSION,
    description: "Prepara un borrador firmado para añadir una nota interna al lead seleccionado. Nunca confirma ni escribe Product Data.",
    ownerDomain: "crm",
    compatibleProfiles: ["crm"],
    capabilities: ["crm.lead.note.prepare"],
    mode: "draft",
    risk: "R1",
    requiredPermission: CRM_ADD_LEAD_NOTE_PERMISSION,
    inputSchema: crmAddLeadNoteInputShape,
    outputSchema: crmAddLeadNoteOutputSchema,
    availability: "active",
    idempotency: "required",
    handler: async (raw, actor) => {
      const parsed = crmAddLeadNoteInputSchema.parse(raw);
      const prepared = await input.port.prepare(actor, parsed);
      if (prepared.lead.id !== parsed.lead.id || prepared.content !== parsed.content) throw new Error("LEAD_NOTE_PREPARATION_MISMATCH");
      return crmAddLeadNoteOutputSchema.parse(prepared);
    },
  };
}

function normalizeForMatching(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

export function normalizeLeadNoteContent(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim();
}

export function leadNoteContentHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export type LeadNotePolicyReason = "secret" | "raw_html" | "too_long" | "blank";

export function leadNotePolicyReason(content: string): LeadNotePolicyReason | undefined {
  if (!content.trim()) return "blank";
  if (content.length > LEAD_NOTE_MAX_LENGTH) return "too_long";
  if (/<\/?[a-z][^>]*>/i.test(content)) return "raw_html";
  const normalized = normalizeForMatching(content);
  const labelledSecret = /\b(password|contrasena|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|credential|credencial(?:es)?)\s*[:=]/i.test(normalized);
  const tokenShape = /\b(?:sk|re)_[A-Za-z0-9_-]{16,}\b/.test(content) || /\bBearer\s+[A-Za-z0-9._~-]{20,}\b/i.test(content);
  return labelledSecret || tokenShape ? "secret" : undefined;
}

export type LeadNoteIntentClassification =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "needs_input"; reason: "missing_content" | "mixed_actions" | "manual_target" | "auto_confirm" | LeadNotePolicyReason }>
  | Readonly<{ kind: "note"; content: string; inference: 0 }>;

const NOTE_VERB = "(?:anade|anadir|ande|agrega|agregar|crea|crear|apunta|apuntar|escribe|escribir|pon|poner|afegeix|afegir|escriu|escriure|add|create|write)";
const NOTE_NOUN = "(?:(?:una|a)\\s+)?(?:nota|note)";
const PREFIX = new RegExp(`^\\s*${NOTE_VERB}\\s+${NOTE_NOUN}(?:\\s+(?:al|en\\s+el|para\\s+el)\\s+(?:lead|cliente))?`, "i");
const MIXED_ACTION = /\s+(?:y|and|i)\s+(?:pon(?:lo|la)?|cambia|actualiza|marca|mueve|set|update|change)\b[\s\S]*\b(?:nuevo|contactado|cualificado|visita programada|new|contacted|qualified)\b/i;
const AUTO_CONFIRM = /\s+(?:y|and|i)\s+(?:confirma|confirmalo|confírmalo|aprobar?|apruebalo|apruébalo|auto[ -]?confirma|confirm)\b/i;

export function classifyLeadNoteWriteIntent(message: string): LeadNoteIntentClassification {
  const normalizedMessage = normalizeForMatching(message);
  if (!PREFIX.test(normalizedMessage)) return { kind: "none" };
  if (/\blead\s*#?\s*\d+\b/i.test(normalizedMessage)) return { kind: "needs_input", reason: "manual_target" };

  const prefixMatch = PREFIX.exec(normalizedMessage);
  const prefixEnd = prefixMatch?.[0].length ?? 0;
  const originalTail = message.slice(prefixEnd);
  // Batch/auto-confirm language is authority-bearing even when the note uses
  // the preferred colon form. Reject it before extracting literal content.
  if (MIXED_ACTION.test(originalTail)) return { kind: "needs_input", reason: "mixed_actions" };
  if (AUTO_CONFIRM.test(originalTail)) return { kind: "needs_input", reason: "auto_confirm" };
  const explicitColon = /^\s*:/.test(originalTail);
  let candidate = "";
  if (explicitColon) {
    candidate = originalTail.replace(/^\s*:\s*/, "");
  } else {
    if (/^\s*(?:diciendo|que\s+diga|indicando|con(?:\s+el)?\s+texto|dient|que\s+digui|saying|that\s+says)\s*$/i.test(originalTail)) {
      return { kind: "needs_input", reason: "missing_content" };
    }
    const quoted = originalTail.match(/^\s*(?:con(?:\s+el)?\s+texto\s*)?[“\"«']([\s\S]+)[”\"»']\s*[.!]?\s*$/);
    if (quoted) candidate = quoted[1] ?? "";
    else candidate = originalTail.replace(/^\s*(?:diciendo|que\s+diga|indicando|con(?:\s+el)?\s+texto|dient|que\s+digui|saying|that\s+says)\s+(?:que\s+)?/i, "");
  }
  candidate = normalizeLeadNoteContent(candidate);
  if (!candidate || candidate === normalizeLeadNoteContent(originalTail)) {
    const hadContentMarker = explicitColon || /^\s*(?:diciendo|que\s+diga|indicando|con(?:\s+el)?\s+texto|dient|que\s+digui|saying|that\s+says|[“\"«'])/i.test(originalTail);
    if (!candidate || !hadContentMarker) return { kind: "needs_input", reason: "missing_content" };
  }
  const policyReason = leadNotePolicyReason(candidate);
  return policyReason ? { kind: "needs_input", reason: policyReason } : { kind: "note", content: candidate, inference: 0 };
}
