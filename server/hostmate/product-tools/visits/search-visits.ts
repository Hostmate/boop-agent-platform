import { z } from "zod";
import type { ActorContext } from "../../contracts/actor-context.js";
import type { AgentContentBlock, ExecutionResult } from "../../contracts/execution-result.js";
import { entityRefSchema } from "../../contracts/execution-result.js";
import type { ProductToolDefinition } from "../../tools/registry.js";
import { VISIT_STATUSES } from "./list-lead-visits.js";
import { formatVisitWallClock, normalizeVisitWallClock, visitWallClockSchema } from "./visit-wall-clock.js";

export const VISITS_SEARCH_VISITS_TOOL_ID = "visits.search_visits.v1";
export const VISITS_SEARCH_VISITS_TOOL_VERSION = 1;
export const VISITS_SEARCH_VISITS_PERMISSION = "visits.read";

const leadRefSchema = entityRefSchema.extend({
  type: z.literal("crm.lead"),
  id: z.string().regex(/^[1-9]\d*$/).max(20),
}).strict();

const propertyRefSchema = entityRefSchema.extend({
  type: z.literal("property.property"),
  id: z.string().regex(/^[1-9]\d*$/).max(20),
}).strict();

export const searchVisitsInputShape = {
  timeframe: z.enum(["today", "tomorrow", "this_week", "upcoming", "past", "all"])
    .default("upcoming")
    .describe("Periodo expresado por el usuario. El backend calcula fechas en la timezone del actor."),
  ownership: z.enum(["mine", "tenant"])
    .default("mine")
    .describe("mine para la agenda propia; tenant solo para Admin/Superadmin con tenant efectivo."),
  status: z.enum(VISIT_STATUSES).optional().describe("Estado explícito solicitado."),
  lead: leadRefSchema.optional().describe("Lead ya resuelto desde evidence autorizada."),
  property: propertyRefSchema.optional().describe("Inmueble ya resuelto desde evidence autorizada."),
  limit: z.number().int().positive().max(100).default(50),
} satisfies z.ZodRawShape;

export const searchVisitsInputSchema = z.object(searchVisitsInputShape).strict();
export type SearchVisitsInput = z.infer<typeof searchVisitsInputSchema>;

export type VisitSearchServiceItem = Readonly<{
  id: string;
  at: string;
  status: string;
  clientName?: string | null;
  property?: Readonly<{ id?: string | null; title?: string | null; reference?: string | null; address?: string | null }> | null;
  lead?: Readonly<{ id: string; name?: string | null }> | null;
  assignedAgent?: Readonly<{ id?: string | null; name?: string | null }> | null;
  visitType?: string | null;
  durationMinutes?: number | null;
  isGroup?: boolean;
}>;

export type VisitSearchServiceResult = Readonly<{
  visits: readonly VisitSearchServiceItem[];
  total: number;
  returned: number;
  hasMore: boolean;
  telemetry?: Readonly<{ service: "visit.service.list"; latencyMs: number }>;
}>;

export interface VisitSearchPort {
  searchVisits(actor: ActorContext, input: SearchVisitsInput): Promise<VisitSearchServiceResult>;
}

const visitRefSchema = entityRefSchema.extend({
  type: z.literal("visits.visit"),
  id: z.string().regex(/^[1-9]\d*$/).max(20),
}).strict();

const visitSearchItemSchema = z.object({
  ref: visitRefSchema,
  at: visitWallClockSchema,
  status: z.enum(VISIT_STATUSES),
  clientName: z.string().max(160).optional(),
  property: z.object({
    ref: propertyRefSchema.optional(),
    title: z.string().max(240).optional(),
    reference: z.string().max(100).optional(),
    address: z.string().max(300).optional(),
  }).strict().optional(),
  lead: z.object({ ref: leadRefSchema, name: z.string().max(160).optional() }).strict().optional(),
  assignedAgent: z.object({ id: z.string().max(20).optional(), name: z.string().max(160).optional() }).strict().optional(),
  visitType: z.string().max(80).optional(),
  durationMinutes: z.number().int().positive().max(1440).optional(),
  isGroup: z.boolean(),
}).strict();

export const searchVisitsOutputSchema = z.object({
  visits: z.array(visitSearchItemSchema).max(100),
  timezone: z.string().min(1).max(100),
  appliedFilters: searchVisitsInputSchema,
  metadata: z.object({
    total: z.number().int().nonnegative(),
    returned: z.number().int().nonnegative().max(100),
    hasMore: z.boolean(),
    limit: z.number().int().positive().max(100),
  }).strict(),
  telemetry: z.object({ service: z.literal("visit.service.list"), latencyMs: z.number().nonnegative() }).strict().optional(),
}).strict();

export type SearchVisitsOutput = z.infer<typeof searchVisitsOutputSchema>;

function present(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function toIso(value: string): string {
  const normalized = normalizeVisitWallClock(value);
  if (!normalized) throw new Error("INVALID_VISIT_DATE");
  return normalized;
}

export function createSearchVisitsTool(input: {
  port: VisitSearchPort;
  onResult?: (output: SearchVisitsOutput) => void | Promise<void>;
}): ProductToolDefinition<typeof searchVisitsInputShape> {
  return {
    toolId: VISITS_SEARCH_VISITS_TOOL_ID,
    namespace: "visits",
    name: "search_visits",
    version: VISITS_SEARCH_VISITS_TOOL_VERSION,
    description: "Consulta la agenda real de visitas por periodo, ámbito y relaciones ya autorizadas. Solo lectura.",
    ownerDomain: "visits",
    compatibleProfiles: ["visits"],
    capabilities: ["visits.visit.search"],
    mode: "read",
    risk: "R0",
    requiredPermission: VISITS_SEARCH_VISITS_PERMISSION,
    inputSchema: searchVisitsInputShape,
    outputSchema: searchVisitsOutputSchema,
    availability: "active",
    idempotency: "none",
    handler: async (raw, actor) => {
      const filters = searchVisitsInputSchema.parse(raw);
      if (actor.role === "agent" && filters.ownership === "tenant" && !filters.lead && !filters.property) {
        throw new Error("VISITS_TENANT_SCOPE_FORBIDDEN");
      }
      if (actor.role === "superadmin" && filters.ownership === "tenant" && !actor.effectiveTenantOverride) {
        throw new Error("VISITS_EFFECTIVE_TENANT_REQUIRED");
      }
      const result = await input.port.searchVisits(actor, filters);
      const visits = result.visits.slice(0, filters.limit).map((visit) => {
        const id = String(visit.id);
        const propertyId = visit.property?.id ? String(visit.property.id) : undefined;
        const leadId = visit.lead?.id ? String(visit.lead.id) : undefined;
        const title = present(visit.property?.title) ?? present(visit.property?.reference) ?? `Visita ${id}`;
        return {
          ref: { type: "visits.visit" as const, id, label: title, deepLink: `/visits?visitId=${encodeURIComponent(id)}` },
          at: toIso(visit.at),
          status: visit.status,
          clientName: present(visit.clientName),
          property: visit.property ? {
            ref: propertyId ? { type: "property.property" as const, id: propertyId, label: title, deepLink: `/properties?highlight=${encodeURIComponent(propertyId)}` } : undefined,
            title: present(visit.property.title),
            reference: present(visit.property.reference),
            address: present(visit.property.address),
          } : undefined,
          lead: leadId ? {
            ref: { type: "crm.lead" as const, id: leadId, label: present(visit.lead?.name) ?? `Lead ${leadId}`, deepLink: `/conversations?leadId=${encodeURIComponent(leadId)}` },
            name: present(visit.lead?.name),
          } : undefined,
          assignedAgent: visit.assignedAgent ? { id: present(visit.assignedAgent.id), name: present(visit.assignedAgent.name) } : undefined,
          visitType: present(visit.visitType),
          durationMinutes: visit.durationMinutes ?? undefined,
          isGroup: Boolean(visit.isGroup),
        };
      });
      const output = searchVisitsOutputSchema.parse({
        visits,
        timezone: actor.timezone,
        appliedFilters: filters,
        metadata: {
          total: Math.max(0, Number(result.total)),
          returned: visits.length,
          hasMore: Boolean(result.hasMore || result.total > visits.length),
          limit: filters.limit,
        },
        telemetry: result.telemetry,
      });
      await input.onResult?.(output);
      return output;
    },
  };
}

function formatDateTime(value: string, timezone: string): string {
  void timezone;
  return formatVisitWallClock(value);
}

function blocks(output: SearchVisitsOutput): AgentContentBlock[] | undefined {
  if (!output.visits.length) return undefined;
  return [{
    type: "entity_list",
    title: output.appliedFilters.timeframe === "today" ? "Visitas de hoy"
      : output.appliedFilters.timeframe === "tomorrow" ? "Visitas de mañana"
        : output.appliedFilters.timeframe === "this_week" ? "Visitas de esta semana"
          : "Visitas",
    items: output.visits.map((visit) => ({
      ref: visit.ref,
      title: visit.property?.title ?? visit.property?.reference ?? visit.clientName ?? visit.ref.label ?? "Visita",
      subtitle: formatDateTime(visit.at, output.timezone),
      fields: [
        { label: "Estado", value: visit.status },
        ...(visit.clientName ? [{ label: "Lead", value: visit.clientName }] : []),
        ...(visit.property?.reference ? [{ label: "Referencia", value: visit.property.reference }] : []),
        ...(visit.assignedAgent?.name ? [{ label: "Comercial", value: visit.assignedAgent.name }] : []),
        ...(visit.visitType ? [{ label: "Tipo", value: visit.visitType }] : []),
        ...(visit.durationMinutes ? [{ label: "Duración", value: `${visit.durationMinutes} min` }] : []),
      ],
    })),
  }];
}

export function toSearchVisitsExecutionResult(output: SearchVisitsOutput): ExecutionResult<SearchVisitsOutput> {
  if (!output.visits.length) {
    return { status: "completed", summary: "No he encontrado visitas con esos criterios.", entities: [], data: output, errors: [] };
  }
  return {
    status: "completed",
    summary: output.metadata.total === 1 ? "He encontrado una visita." : `He encontrado ${output.metadata.total} visitas.`,
    entities: output.visits.map((visit) => visit.ref),
    data: output,
    blocks: blocks(output),
    errors: [],
  };
}
