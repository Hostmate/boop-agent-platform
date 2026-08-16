import { z } from "zod";
import type { ActorContext } from "../../contracts/actor-context.js";
import { entityRefSchema } from "../../contracts/execution-result.js";
import type { ProductToolDefinition } from "../../tools/registry.js";
import { SafeWriteCommitError, type SafeWriteCommitResult } from "../../drafts/safe-write-commit-registry.js";

export const CRM_UPDATE_LEAD_STATUS_TOOL_ID = "crm.update_lead_status.v1";
export const CRM_UPDATE_LEAD_STATUS_TOOL_VERSION = 1;
export const CRM_UPDATE_LEAD_STATUS_PERMISSION = "crm.write";
export const CANONICAL_LEAD_STATUSES = ["new", "contacted", "qualified", "visit_scheduled"] as const;
export type CanonicalLeadStatus = typeof CANONICAL_LEAD_STATUSES[number];

const leadRefSchema = entityRefSchema.extend({
  type: z.literal("crm.lead"), id: z.string().regex(/^[1-9]\d*$/).max(20),
}).strict();

export const crmUpdateLeadStatusInputShape = {
  lead: leadRefSchema.describe("EntityRef crm.lead seleccionada y autorizada; nunca escribas un ID manual."),
  requestedStatus: z.enum(CANONICAL_LEAD_STATUSES).describe("Estado canónico solicitado."),
} satisfies z.ZodRawShape;

export const crmUpdateLeadStatusInputSchema = z.object(crmUpdateLeadStatusInputShape).strict();
export type CrmUpdateLeadStatusInput = z.infer<typeof crmUpdateLeadStatusInputSchema>;

export type LeadStatusPreparation = Readonly<{
  lead: Readonly<{ id: string; name: string; status: CanonicalLeadStatus; assignedAgentId?: string }>;
  requestedStatus: CanonicalLeadStatus;
  noOp: boolean;
  telemetry?: Readonly<{ service: string; latencyMs: number }>;
}>;

export interface LeadStatusWritePort {
  prepare(actor: ActorContext, input: CrmUpdateLeadStatusInput): Promise<LeadStatusPreparation>;
  commit(actor: ActorContext, input: { signedIntent: unknown }): Promise<SafeWriteCommitResult>;
}

export class LeadStatusWritePortError extends SafeWriteCommitError {
  constructor(
    public readonly code: "NOT_FOUND" | "PERMISSION_DENIED" | "STALE_REFERENCE" | "PRECONDITION_FAILED" | "CONFLICT",
    message: string,
  ) {
    super(code, message);
    this.name = "LeadStatusWritePortError";
  }
}

export const crmUpdateLeadStatusOutputSchema = z.object({
  lead: z.object({ id: z.string(), name: z.string().min(1).max(160), status: z.enum(CANONICAL_LEAD_STATUSES), assignedAgentId: z.string().optional() }).strict(),
  requestedStatus: z.enum(CANONICAL_LEAD_STATUSES), noOp: z.boolean(),
  telemetry: z.object({ service: z.string(), latencyMs: z.number().nonnegative() }).strict().optional(),
}).strict();

export function createCrmUpdateLeadStatusTool(input: { port: LeadStatusWritePort }): ProductToolDefinition<typeof crmUpdateLeadStatusInputShape> {
  return {
    toolId: CRM_UPDATE_LEAD_STATUS_TOOL_ID,
    namespace: "crm",
    name: "update_lead_status",
    version: CRM_UPDATE_LEAD_STATUS_TOOL_VERSION,
    description: "Prepara un borrador firmado para cambiar el estado del lead seleccionado. Nunca confirma ni escribe Product Data.",
    ownerDomain: "crm",
    compatibleProfiles: ["crm"],
    capabilities: ["crm.lead.status.prepare"],
    mode: "draft",
    risk: "R1",
    requiredPermission: CRM_UPDATE_LEAD_STATUS_PERMISSION,
    inputSchema: crmUpdateLeadStatusInputShape,
    outputSchema: crmUpdateLeadStatusOutputSchema,
    availability: "active",
    idempotency: "required",
    handler: async (raw, actor) => {
      const parsed = crmUpdateLeadStatusInputSchema.parse(raw);
      const prepared = await input.port.prepare(actor, parsed);
      if (prepared.lead.id !== parsed.lead.id || prepared.requestedStatus !== parsed.requestedStatus) {
        throw new Error("LEAD_STATUS_PREPARATION_MISMATCH");
      }
      return crmUpdateLeadStatusOutputSchema.parse(prepared);
    },
  };
}

function normalize(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[_-]+/g, " ").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

const WRITE_VERB = /\b(cambia|cambiar|actualiza|actualizar|pon|ponlo|ponla|poner|marca|marcar|mueve|mover|establece|establecer|pasa|pasar|set|update|change|move)\b/;

export type LeadStatusWriteIntentClassification =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "unknown" }>
  | Readonly<{ kind: "status"; status: CanonicalLeadStatus }>;

export function classifyLeadStatusWriteIntent(message: string): LeadStatusWriteIntentClassification {
  const value = normalize(message);
  if (!WRITE_VERB.test(value)) return { kind: "none" };
  const aliases: ReadonlyArray<readonly [CanonicalLeadStatus, readonly RegExp[]]> = [
    ["visit_scheduled", [/\bvisit scheduled\b/, /\bvisita (programada|agendada|concertada)\b/, /\bcon visita\b/]],
    ["qualified", [/\bqualified\b/, /\bcualificad[oa]\b/, /\bqualificat\b/]],
    ["contacted", [/\bcontacted\b/, /\bcontactad[oa]\b/, /\bcontactat\b/, /\ben contacto\b/]],
    ["new", [/\bnew\b/, /\bnuev[oa]\b/, /\bnou\b/]],
  ];
  const matches = aliases.filter(([, patterns]) => patterns.some((pattern) => pattern.test(value))).map(([status]) => status);
  if (matches.length === 1) return { kind: "status", status: matches[0]! };
  return { kind: "unknown" };
}
