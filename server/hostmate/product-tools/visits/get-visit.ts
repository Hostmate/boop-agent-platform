import { z } from "zod";
import type { ActorContext } from "../../contracts/actor-context.js";
import type { EntityRef, NormalizedAgentErrorCode } from "../../contracts/domain.js";
import { entityRefSchema, type AgentContentBlock, type ExecutionResult } from "../../contracts/execution-result.js";
import type { ProductToolDefinition } from "../../tools/registry.js";
import { VISIT_STATUSES } from "./list-lead-visits.js";

export const VISITS_GET_VISIT_TOOL_ID = "visits.get_visit.v1";
export const VISITS_GET_VISIT_TOOL_VERSION = 1;
export const VISITS_GET_VISIT_PERMISSION = "visits.read";

export const GROUP_VISIT_STATUSES = ["active", "completed", "cancelled"] as const;
export const GROUP_REGISTRATION_STATUSES = ["pending", "confirmed", "cancelled"] as const;

const visitRefSchema = entityRefSchema.extend({
  type: z.enum(["visits.visit", "visits.group_visit"]),
  id: z.string().regex(/^[1-9]\d*$/).max(20),
}).strict();

export const getVisitInputShape = {
  visit: visitRefSchema.describe("Referencia de visita ya resuelta; nunca es evidencia de autorización."),
} satisfies z.ZodRawShape;
export const getVisitInputSchema = z.object(getVisitInputShape).strict();
export type GetVisitInput = z.infer<typeof getVisitInputSchema>;

type ServiceProperty = Readonly<{
  id?: string | null;
  reference?: string | null;
  title?: string | null;
  address?: string | null;
}>;

type ServiceLead = Readonly<{ id: string; name: string }>;
type ServiceAgent = Readonly<{ id: string; name?: string | null }>;
type ServiceTelemetry = Readonly<{
  services: readonly string[];
  latencyMs: number;
  attributionLatencyMs?: number;
  detailServiceLatencyMs?: number;
  eventServiceLatencyMs?: number;
}>;

type ServiceReschedule = Readonly<{
  eventType: "client_rescheduled" | "agent_rescheduled";
  actor: "client" | "agent" | "system";
  oldVisitDatetime?: string | null;
  newVisitDatetime: string;
  oldStatus?: string | null;
  newStatus?: string | null;
  createdAt?: string | null;
}>;

export type VisitDetailServiceResult =
  | Readonly<{
      kind: "individual";
      id: string;
      at: string;
      status: string;
      visitType?: string | null;
      durationMinutes?: number | null;
      clientConfirmation?: string | null;
      property?: ServiceProperty | null;
      lead?: ServiceLead | null;
      assignedAgent?: ServiceAgent | null;
      state: Readonly<{ isGroupSlot: boolean; capacity?: number | null; registeredCount?: number | null }>;
      lastReschedule?: ServiceReschedule | null;
      telemetry?: ServiceTelemetry;
    }>
  | Readonly<{
      kind: "group";
      id: string;
      at: string;
      status: string;
      visitType?: string | null;
      durationMinutes?: number | null;
      property?: ServiceProperty | null;
      lead?: ServiceLead | null;
      assignedAgent?: ServiceAgent | null;
      registration: Readonly<{ status?: string | null; capacity: number; registeredCount: number; availableCapacity: number }>;
      telemetry?: ServiceTelemetry;
    }>;

export interface VisitDetailPort {
  getVisit(actor: ActorContext, input: GetVisitInput): Promise<VisitDetailServiceResult>;
}

export class VisitDetailPortError extends Error {
  constructor(
    public readonly code: Extract<NormalizedAgentErrorCode, "NOT_FOUND" | "PERMISSION_DENIED" | "STALE_REFERENCE">,
    message: string,
  ) {
    super(message);
    this.name = "VisitDetailPortError";
  }
}

const crmLeadRefSchema = entityRefSchema.extend({
  type: z.literal("crm.lead"), id: z.string().regex(/^[1-9]\d*$/).max(20),
}).strict();
const propertyRefSchema = entityRefSchema.extend({
  type: z.literal("property.property"), id: z.string().regex(/^[1-9]\d*$/).max(20),
}).strict();
const propertySchema = z.object({
  ref: propertyRefSchema.optional(), reference: z.string().max(100).optional(),
  title: z.string().max(255).optional(), address: z.string().max(300).optional(),
}).strict();
const assignedAgentSchema = z.object({ id: z.string().regex(/^[1-9]\d*$/).max(20), name: z.string().max(160).optional() }).strict();
const rescheduleSchema = z.object({
  eventType: z.enum(["client_rescheduled", "agent_rescheduled"]), actor: z.enum(["client", "agent", "system"]),
  oldAt: z.string().datetime().optional(), newAt: z.string().datetime(), oldStatus: z.string().max(80).optional(),
  newStatus: z.string().max(80).optional(), recordedAt: z.string().datetime().optional(),
}).strict();
const telemetrySchema = z.object({
  services: z.array(z.string().max(120)).max(8), latencyMs: z.number().nonnegative(),
  attributionLatencyMs: z.number().nonnegative().optional(), detailServiceLatencyMs: z.number().nonnegative().optional(),
  eventServiceLatencyMs: z.number().nonnegative().optional(),
}).strict();
const common = {
  ref: visitRefSchema,
  at: z.string().datetime(),
  timezone: z.string().min(1).max(100),
  visitType: z.string().max(80).optional(),
  durationMinutes: z.number().int().nonnegative().max(1440).optional(),
  property: propertySchema.optional(),
  lead: z.object({ ref: crmLeadRefSchema, name: z.string().min(1).max(160) }).strict().optional(),
  assignedAgent: assignedAgentSchema.optional(),
  telemetry: telemetrySchema.optional(),
};

export const getVisitOutputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("individual"), ...common, status: z.enum(VISIT_STATUSES),
    clientConfirmation: z.string().max(80).optional(),
    state: z.object({
      isGroupSlot: z.boolean(), capacity: z.number().int().nonnegative().optional(),
      registeredCount: z.number().int().nonnegative().optional(),
    }).strict(),
    lastReschedule: rescheduleSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("group"), ...common, status: z.enum(GROUP_VISIT_STATUSES),
    registration: z.object({
      status: z.enum(GROUP_REGISTRATION_STATUSES).optional(), capacity: z.number().int().nonnegative(),
      registeredCount: z.number().int().nonnegative(), availableCapacity: z.number().int().nonnegative(),
    }).strict(),
  }).strict(),
]);
export type GetVisitOutput = z.infer<typeof getVisitOutputSchema>;

function present(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function iso(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function sanitizeCommon(result: VisitDetailServiceResult, requested: EntityRef, timezone: string) {
  if (String(result.id) !== requested.id) throw new Error("VISIT_REFERENCE_MISMATCH");
  const expectedType = result.kind === "group" ? "visits.group_visit" : "visits.visit";
  if (requested.type !== expectedType) throw new Error("VISIT_REFERENCE_KIND_MISMATCH");
  const at = iso(result.at);
  if (!at) throw new Error("INVALID_VISIT_DATE");
  const propertyId = result.property?.id && /^[1-9]\d*$/.test(result.property.id) ? result.property.id : undefined;
  const propertyTitle = present(result.property?.title);
  const propertyReference = present(result.property?.reference);
  const visitLabel = propertyTitle ?? propertyReference ?? (result.kind === "group" ? "Visita grupal" : "Visita");
  const property = result.property ? {
    ref: propertyId ? { type: "property.property" as const, id: propertyId, label: propertyTitle ?? propertyReference, deepLink: "/properties" } : undefined,
    reference: propertyReference, title: propertyTitle, address: present(result.property.address),
  } : undefined;
  const leadName = present(result.lead?.name);
  return {
    ref: {
      type: expectedType, id: result.id, label: visitLabel,
      deepLink: result.kind === "group" ? "/visits" : `/visits?visitId=${encodeURIComponent(result.id)}`,
    },
    at, timezone, visitType: present(result.visitType), durationMinutes: result.durationMinutes ?? undefined,
    property,
    lead: result.lead && leadName ? {
      ref: { type: "crm.lead" as const, id: result.lead.id, label: leadName, deepLink: `/conversations?leadId=${encodeURIComponent(result.lead.id)}` },
      name: leadName,
    } : undefined,
    assignedAgent: result.assignedAgent ? { id: result.assignedAgent.id, name: present(result.assignedAgent.name) } : undefined,
    telemetry: result.telemetry ? {
      services: [...result.telemetry.services].slice(0, 8), latencyMs: result.telemetry.latencyMs,
      attributionLatencyMs: result.telemetry.attributionLatencyMs,
      detailServiceLatencyMs: result.telemetry.detailServiceLatencyMs,
      eventServiceLatencyMs: result.telemetry.eventServiceLatencyMs,
    } : undefined,
  };
}

export function sanitizeVisitDetail(result: VisitDetailServiceResult, requested: EntityRef, timezone: string): GetVisitOutput {
  const commonOutput = sanitizeCommon(result, requested, timezone);
  if (result.kind === "group") {
    return getVisitOutputSchema.parse({
      kind: "group", ...commonOutput, status: result.status,
      registration: {
        status: present(result.registration.status), capacity: result.registration.capacity,
        registeredCount: result.registration.registeredCount, availableCapacity: result.registration.availableCapacity,
      },
    });
  }
  const last = result.lastReschedule;
  return getVisitOutputSchema.parse({
    kind: "individual", ...commonOutput, status: result.status,
    clientConfirmation: present(result.clientConfirmation),
    state: {
      isGroupSlot: result.state.isGroupSlot, capacity: result.state.capacity ?? undefined,
      registeredCount: result.state.registeredCount ?? undefined,
    },
    lastReschedule: last ? {
      eventType: last.eventType, actor: last.actor, oldAt: iso(last.oldVisitDatetime), newAt: iso(last.newVisitDatetime),
      oldStatus: present(last.oldStatus), newStatus: present(last.newStatus), recordedAt: iso(last.createdAt),
    } : undefined,
  });
}

export function createGetVisitTool(input: {
  port: VisitDetailPort;
  onResult?: (output: GetVisitOutput) => void | Promise<void>;
}): ProductToolDefinition<typeof getVisitInputShape> {
  return {
    toolId: VISITS_GET_VISIT_TOOL_ID,
    namespace: "visits",
    name: "get_visit",
    version: VISITS_GET_VISIT_TOOL_VERSION,
    description: "Obtiene el detalle acotado de una visita ya resuelta. Sólo lectura; no busca ni modifica visitas.",
    ownerDomain: "visits",
    compatibleProfiles: ["visits", "crm"],
    capabilities: ["visits.visit.detail"],
    mode: "read",
    risk: "R0",
    requiredPermission: VISITS_GET_VISIT_PERMISSION,
    inputSchema: getVisitInputShape,
    outputSchema: getVisitOutputSchema,
    availability: "active",
    idempotency: "none",
    handler: async (raw, actor) => {
      const parsed = getVisitInputSchema.parse(raw);
      const output = sanitizeVisitDetail(await input.port.getVisit(actor, parsed), parsed.visit, actor.timezone);
      await input.onResult?.(output);
      return output;
    },
  };
}

function dateTime(value: string, timezone: string): string {
  return new Intl.DateTimeFormat("es-ES", {
    dateStyle: "medium", timeStyle: "short", timeZone: timezone,
  }).format(new Date(value));
}

export function visitDetailBlocks(output: GetVisitOutput): readonly AgentContentBlock[] {
  const fields = [
    { label: "Fecha", value: dateTime(output.at, output.timezone) },
    { label: "Estado", value: output.status },
    ...(output.visitType ? [{ label: "Tipo", value: output.visitType }] : []),
    ...(output.durationMinutes != null ? [{ label: "Duración", value: `${output.durationMinutes} min` }] : []),
    ...(output.property?.reference ? [{ label: "Referencia", value: output.property.reference }] : []),
    ...(output.property?.address ? [{ label: "Dirección", value: output.property.address }] : []),
    ...(output.lead?.name ? [{ label: "Lead", value: output.lead.name }] : []),
    ...(output.assignedAgent?.name ? [{ label: "Comercial", value: output.assignedAgent.name }] : []),
    ...(output.kind === "group" ? [
      { label: "Plazas", value: `${output.registration.registeredCount}/${output.registration.capacity}` },
      ...(output.registration.status ? [{ label: "Inscripción", value: output.registration.status }] : []),
    ] : [
      ...(output.clientConfirmation ? [{ label: "Confirmación", value: output.clientConfirmation }] : []),
      ...(output.lastReschedule ? [{ label: "Última reprogramación", value: dateTime(output.lastReschedule.newAt, output.timezone) }] : []),
    ]),
  ];
  return [{
    type: "entity_list", title: output.kind === "group" ? "Detalle de visita grupal" : "Detalle de visita",
    items: [{ ref: output.ref, title: output.ref.label ?? "Visita", subtitle: output.property?.title, fields }],
  }];
}

export function toVisitDetailExecutionResult(output: GetVisitOutput): ExecutionResult<GetVisitOutput> {
  const propertyLabel = output.property?.title ?? output.property?.reference;
  const summary = `${output.kind === "group" ? "Visita grupal" : "Visita"} ${dateTime(output.at, output.timezone)}${propertyLabel ? ` · ${propertyLabel}` : ""}${output.lead?.name ? ` · Lead: ${output.lead.name}` : ""} · ${output.status}.`;
  const entities = [output.ref, ...(output.lead ? [output.lead.ref] : []), ...(output.property?.ref ? [output.property.ref] : [])];
  return { status: "completed", summary, entities, blocks: visitDetailBlocks(output), data: output, errors: [] };
}
