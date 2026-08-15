import { z } from "zod";
import type { ActorContext } from "../../contracts/actor-context.js";
import type { EntityRef, NormalizedAgentErrorCode } from "../../contracts/domain.js";
import { entityRefSchema, type AgentContentBlock, type ExecutionResult } from "../../contracts/execution-result.js";
import type { ProductToolDefinition } from "../../tools/registry.js";

export const VISITS_LIST_LEAD_VISITS_TOOL_ID = "visits.list_lead_visits.v1";
export const VISITS_LIST_LEAD_VISITS_TOOL_VERSION = 1;
export const VISITS_LIST_LEAD_VISITS_PERMISSION = "crm.read";

export const VISIT_STATUSES = [
  "pending", "confirmed", "cancelled", "completed", "floating", "cancelled_by_agent",
  "no_agents_available", "cancelled_by_client", "no_show", "rejected",
] as const;

const crmLeadRefSchema = entityRefSchema.extend({
  type: z.literal("crm.lead"),
  id: z.string().regex(/^[1-9]\d*$/).max(20),
}).strict();

export const listLeadVisitsInputShape = {
  lead: crmLeadRefSchema.describe("Referencia crm.lead ya resuelta. No busques de nuevo por nombre."),
  scope: z.enum(["upcoming", "past", "all"]).default("all"),
  status: z.enum(VISIT_STATUSES).optional(),
} satisfies z.ZodRawShape;

export const listLeadVisitsInputSchema = z.object(listLeadVisitsInputShape).strict();
export type ListLeadVisitsInput = z.infer<typeof listLeadVisitsInputSchema>;

export type LeadVisitsServiceResult = Readonly<{
  lead: Readonly<{ id: string; name: string }>;
  visits: readonly Readonly<{
    id: string;
    kind: "individual" | "group";
    at: string;
    status: string;
    property?: Readonly<{ id?: string; title?: string | null; reference?: string | null; address?: string | null }> | null;
    assignedAgent?: Readonly<{ name?: string | null }> | null;
    visitType?: string | null;
    durationMinutes?: number | null;
    clientConfirmation?: string | null;
    isGroup: boolean;
    groupVisitStatus?: string | null;
    registrationStatus?: string | null;
  }>[];
  metadata: Readonly<{
    scope: "upcoming" | "past" | "all";
    status?: string;
    total: number;
    returned: number;
    hasMore: boolean;
    limit: number;
  }>;
  telemetry?: Readonly<{ services: readonly string[]; latencyMs: number; visitServiceLatencyMs?: number }>;
}>;

export interface LeadVisitsPort {
  listLeadVisits(actor: ActorContext, input: ListLeadVisitsInput): Promise<LeadVisitsServiceResult>;
}

export class LeadVisitsPortError extends Error {
  constructor(
    public readonly code: Extract<NormalizedAgentErrorCode, "NOT_FOUND" | "PERMISSION_DENIED" | "STALE_REFERENCE">,
    message: string,
  ) {
    super(message);
    this.name = "LeadVisitsPortError";
  }
}

const visitRefSchema = entityRefSchema.extend({
  type: z.enum(["visits.visit", "visits.group_visit"]),
}).strict();

const visitOutputSchema = z.object({
  ref: visitRefSchema,
  at: z.string().datetime(),
  status: z.enum(VISIT_STATUSES),
  property: z.object({ title: z.string().max(240).optional(), reference: z.string().max(100).optional(), address: z.string().max(300).optional() }).strict().optional(),
  assignedAgent: z.string().max(160).optional(),
  visitType: z.string().max(80).optional(),
  durationMinutes: z.number().int().nonnegative().max(1440).optional(),
  clientConfirmation: z.string().max(80).optional(),
  isGroup: z.boolean(),
  groupVisitStatus: z.string().max(80).optional(),
  registrationStatus: z.string().max(80).optional(),
}).strict();

export const listLeadVisitsOutputSchema = z.object({
  lead: z.object({ ref: crmLeadRefSchema, name: z.string().min(1).max(160) }).strict(),
  visits: z.array(visitOutputSchema).max(10),
  timezone: z.string().min(1).max(100),
  metadata: z.object({
    scope: z.enum(["upcoming", "past", "all"]), status: z.enum(VISIT_STATUSES).optional(),
    total: z.number().int().nonnegative(), returned: z.number().int().nonnegative().max(10),
    hasMore: z.boolean(), limit: z.number().int().positive().max(10),
  }).strict(),
  telemetry: z.object({
    services: z.array(z.string().max(100)).max(8), latencyMs: z.number().nonnegative(),
    visitServiceLatencyMs: z.number().nonnegative().optional(),
  }).strict().optional(),
}).strict();

export type ListLeadVisitsOutput = z.infer<typeof listLeadVisitsOutputSchema>;

function present(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function isoDate(value: string): string | undefined {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function sanitize(result: LeadVisitsServiceResult, requestedRef: EntityRef, timezone: string): ListLeadVisitsOutput {
  const leadId = String(result.lead.id);
  if (leadId !== requestedRef.id) throw new Error("LEAD_VISITS_REFERENCE_MISMATCH");
  const leadName = present(result.lead.name) ?? `Lead ${leadId}`;
  return listLeadVisitsOutputSchema.parse({
    lead: { ref: { type: "crm.lead", id: leadId, label: leadName, deepLink: `/leads?lead=${encodeURIComponent(leadId)}` }, name: leadName },
    visits: result.visits.slice(0, 10).map((visit) => {
      const at = isoDate(visit.at);
      if (!at) throw new Error("INVALID_VISIT_DATE");
      const propertyTitle = present(visit.property?.title);
      const propertyReference = present(visit.property?.reference);
      const label = propertyTitle ?? propertyReference ?? (visit.kind === "group" ? "Visita grupal" : "Visita");
      return {
        ref: {
          type: visit.kind === "group" ? "visits.group_visit" : "visits.visit",
          id: String(visit.id), label,
          deepLink: visit.kind === "group" ? "/visits" : `/visits?visitId=${encodeURIComponent(String(visit.id))}`,
        },
        at, status: visit.status,
        property: visit.property ? { title: propertyTitle, reference: propertyReference, address: present(visit.property.address) } : undefined,
        assignedAgent: present(visit.assignedAgent?.name), visitType: present(visit.visitType),
        durationMinutes: visit.durationMinutes ?? undefined, clientConfirmation: present(visit.clientConfirmation),
        isGroup: visit.isGroup, groupVisitStatus: present(visit.groupVisitStatus), registrationStatus: present(visit.registrationStatus),
      };
    }),
    timezone,
    metadata: { ...result.metadata, returned: Math.min(result.metadata.returned, 10), limit: Math.min(result.metadata.limit, 10) },
    telemetry: result.telemetry ? {
      services: [...result.telemetry.services].slice(0, 8), latencyMs: result.telemetry.latencyMs,
      visitServiceLatencyMs: result.telemetry.visitServiceLatencyMs,
    } : undefined,
  });
}

export function createListLeadVisitsTool(input: {
  port: LeadVisitsPort;
  onResult?: (output: ListLeadVisitsOutput) => void | Promise<void>;
}): ProductToolDefinition<typeof listLeadVisitsInputShape> {
  return {
    toolId: VISITS_LIST_LEAD_VISITS_TOOL_ID,
    namespace: "visits",
    name: "list_lead_visits",
    version: VISITS_LIST_LEAD_VISITS_TOOL_VERSION,
    description: "Lista las visitas reales de un lead ya resuelto. Solo lectura; admite alcance temporal y estados reales.",
    ownerDomain: "visits",
    compatibleProfiles: ["crm", "visits"],
    capabilities: ["visits.lead.list"],
    mode: "read",
    risk: "R0",
    requiredPermission: VISITS_LIST_LEAD_VISITS_PERMISSION,
    inputSchema: listLeadVisitsInputShape,
    outputSchema: listLeadVisitsOutputSchema,
    availability: "active",
    idempotency: "none",
    handler: async (raw, actor) => {
      const parsed = listLeadVisitsInputSchema.parse(raw);
      const output = sanitize(await input.port.listLeadVisits(actor, parsed), parsed.lead, actor.timezone);
      await input.onResult?.(output);
      return output;
    },
  };
}

function formatDateTime(value: string, timezone: string): string {
  return new Intl.DateTimeFormat("es-ES", {
    dateStyle: "medium", timeStyle: "short", timeZone: timezone,
  }).format(new Date(value));
}

function visitBlocks(output: ListLeadVisitsOutput): AgentContentBlock[] | undefined {
  if (!output.visits.length) return undefined;
  return [{
    type: "entity_list",
    title: output.metadata.scope === "upcoming" ? "Próximas visitas" : output.metadata.scope === "past" ? "Visitas anteriores" : "Visitas del lead",
    items: output.visits.map((visit) => ({
      ref: visit.ref,
      title: visit.property?.title ?? visit.property?.reference ?? (visit.isGroup ? "Visita grupal" : "Visita"),
      subtitle: formatDateTime(visit.at, output.timezone),
      fields: [
        { label: "Estado", value: visit.status },
        ...(visit.property?.reference ? [{ label: "Referencia", value: visit.property.reference }] : []),
        ...(visit.property?.address ? [{ label: "Dirección", value: visit.property.address }] : []),
        ...(visit.assignedAgent ? [{ label: "Comercial", value: visit.assignedAgent }] : []),
        ...(visit.visitType ? [{ label: "Tipo", value: visit.visitType }] : []),
        ...(visit.durationMinutes !== undefined ? [{ label: "Duración", value: `${visit.durationMinutes} min` }] : []),
        ...(visit.isGroup ? [{ label: "Modalidad", value: "Grupal" }] : []),
      ],
    })),
  }];
}

export function toLeadVisitsExecutionResult(output: ListLeadVisitsOutput): ExecutionResult<ListLeadVisitsOutput> {
  if (!output.visits.length) {
    const temporal = output.metadata.scope === "upcoming" ? "próximas" : output.metadata.scope === "past" ? "anteriores" : "";
    const status = output.metadata.status ? ` con estado ${output.metadata.status}` : "";
    return {
      status: "completed", summary: `${output.lead.name} no tiene visitas ${temporal}${status}.`.replace(/\s+/g, " ").trim(),
      entities: [], data: output, errors: [],
    };
  }
  const first = output.visits[0];
  const when = formatDateTime(first.at, output.timezone);
  const headline = output.metadata.scope === "upcoming" ? `La próxima visita de ${output.lead.name} es el ${when}`
    : output.metadata.scope === "past" ? `La última visita de ${output.lead.name} fue el ${when}`
      : `${output.lead.name} tiene ${output.metadata.total} visita${output.metadata.total === 1 ? "" : "s"}`;
  return {
    status: "completed",
    summary: `${headline}.${output.metadata.hasMore ? ` Muestro las primeras ${output.visits.length}.` : ""}`,
    entities: output.visits.map((visit) => visit.ref), data: output, blocks: visitBlocks(output), errors: [],
  };
}
