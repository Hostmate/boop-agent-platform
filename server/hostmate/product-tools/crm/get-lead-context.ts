import { z } from "zod";
import type { ActorContext } from "../../contracts/actor-context.js";
import { entityRefSchema, type AgentContentBlock, type ExecutionResult } from "../../contracts/execution-result.js";
import type { EntityRef, NormalizedAgentErrorCode } from "../../contracts/domain.js";
import type { ProductToolDefinition } from "../../tools/registry.js";

export const CRM_GET_LEAD_CONTEXT_TOOL_ID = "crm.get_lead_context.v1";
export const CRM_GET_LEAD_CONTEXT_TOOL_VERSION = 1;
export const CRM_GET_LEAD_CONTEXT_PERMISSION = "crm.read";

const crmLeadRefSchema = entityRefSchema.extend({
  type: z.literal("crm.lead"),
  id: z.string().regex(/^[1-9]\d*$/).max(20),
}).strict();

export const crmGetLeadContextInputShape = {
  lead: crmLeadRefSchema.describe("Referencia crm.lead ya resuelta. No busques de nuevo por nombre."),
} satisfies z.ZodRawShape;

export const crmGetLeadContextInputSchema = z.object(crmGetLeadContextInputShape).strict();
export type CrmGetLeadContextInput = z.infer<typeof crmGetLeadContextInputSchema>;

export type LeadContextServiceResult = Readonly<{
  lead: Readonly<{
    id: string; name: string; phone?: string | null; email?: string | null; status?: string | null;
    source?: string | null; createdAt?: string | null; lastActivityAt?: string | null;
    qualification?: Readonly<{ grade?: string | null; score?: number | null }> | null;
  }>;
  assignedAgent?: Readonly<{ id: string; name?: string | null }> | null;
  property?: Readonly<{ id: string; title?: string | null; reference?: string | null; address?: string | null; price?: number | null; status?: string | null }> | null;
  opportunity?: Readonly<{ id: string; status?: string | null; property?: Readonly<{ id: string; title?: string | null; reference?: string | null; price?: number | null }> | null; createdAt?: string | null }> | null;
  activeDemand?: Readonly<{ id: string; operationType?: string | null; propertySubtype?: string | null; city?: string | null; zone?: string | null; priceMax?: number | null; roomsMin?: number | null; bathroomsMin?: number | null; areaMin?: number | null }> | null;
  nextVisit?: Readonly<{ id: string; at: string; status: string; propertyReference?: string | null; assignedAgent?: string | null }> | null;
  pendingTasks: readonly Readonly<{ id: string; title: string; dueAt?: string | null; priority?: string | null; assignedAgent?: string | null }>[];
  telemetry?: Readonly<{ services: readonly string[]; latencyMs: number }>;
}>;

export interface LeadContextPort {
  getContext(actor: ActorContext, input: CrmGetLeadContextInput): Promise<LeadContextServiceResult>;
}

export class LeadContextPortError extends Error {
  constructor(
    public readonly code: Extract<NormalizedAgentErrorCode, "NOT_FOUND" | "PERMISSION_DENIED" | "STALE_REFERENCE">,
    message: string,
  ) {
    super(message);
    this.name = "LeadContextPortError";
  }
}

export const crmGetLeadContextOutputSchema = z.object({
  lead: z.object({
    ref: crmLeadRefSchema, name: z.string().min(1).max(160), phone: z.string().max(40).optional(), email: z.string().max(160).optional(),
    status: z.string().max(80).optional(), source: z.string().max(80).optional(), createdAt: z.string().datetime().optional(), lastActivityAt: z.string().datetime().optional(),
    qualification: z.object({ grade: z.string().max(40).optional(), score: z.number().finite().optional() }).strict().optional(),
  }).strict(),
  assignedAgent: z.object({ name: z.string().max(160).optional() }).strict().optional(),
  property: z.object({ title: z.string().max(240).optional(), reference: z.string().max(100).optional(), address: z.string().max(300).optional(), price: z.number().finite().optional(), status: z.string().max(80).optional() }).strict().optional(),
  opportunity: z.object({ status: z.string().max(80).optional(), propertyTitle: z.string().max(240).optional(), propertyReference: z.string().max(100).optional(), price: z.number().finite().optional(), createdAt: z.string().datetime().optional() }).strict().optional(),
  activeDemand: z.object({ operationType: z.string().max(80).optional(), propertySubtype: z.string().max(80).optional(), city: z.string().max(100).optional(), zone: z.string().max(160).optional(), priceMax: z.number().finite().optional(), roomsMin: z.number().finite().optional(), bathroomsMin: z.number().finite().optional(), areaMin: z.number().finite().optional() }).strict().optional(),
  nextVisit: z.object({ at: z.string().datetime(), status: z.string().max(80), propertyReference: z.string().max(100).optional(), assignedAgent: z.string().max(160).optional() }).strict().optional(),
  pendingTasks: z.array(z.object({ title: z.string().max(200), dueAt: z.string().datetime().optional(), priority: z.string().max(40).optional(), assignedAgent: z.string().max(160).optional() }).strict()).max(5),
  telemetry: z.object({ services: z.array(z.string().max(100)).max(8), latencyMs: z.number().nonnegative() }).strict().optional(),
}).strict();

export type CrmGetLeadContextOutput = z.infer<typeof crmGetLeadContextOutputSchema>;

function present(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function maskPhone(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const digits = value.replace(/\D/g, "");
  return digits.length >= 4 ? `••• •• ${digits.slice(-4)}` : "••••";
}

function maskEmail(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const [local, domain] = value.split("@");
  if (!domain) return "•••";
  return `${local.slice(0, 1)}•••@${domain}`;
}

function date(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function num(value: number | null | undefined): number | undefined {
  return value === null || value === undefined || !Number.isFinite(value) ? undefined : value;
}

function sanitize(input: LeadContextServiceResult, requestedRef: EntityRef): CrmGetLeadContextOutput {
  const id = String(input.lead.id);
  if (id !== requestedRef.id) throw new Error("LEAD_CONTEXT_REFERENCE_MISMATCH");
  const name = present(input.lead.name) ?? `Lead ${id}`;
  return crmGetLeadContextOutputSchema.parse({
    lead: {
      ref: { type: "crm.lead", id, label: name, deepLink: `/conversations?leadId=${encodeURIComponent(id)}` },
      name, phone: maskPhone(input.lead.phone), email: maskEmail(input.lead.email),
      status: present(input.lead.status), source: present(input.lead.source),
      createdAt: date(input.lead.createdAt), lastActivityAt: date(input.lead.lastActivityAt),
      qualification: input.lead.qualification ? { grade: present(input.lead.qualification.grade), score: num(input.lead.qualification.score) } : undefined,
    },
    assignedAgent: input.assignedAgent ? { name: present(input.assignedAgent.name) } : undefined,
    property: input.property ? {
      title: present(input.property.title), reference: present(input.property.reference), address: present(input.property.address),
      price: num(input.property.price), status: present(input.property.status),
    } : undefined,
    opportunity: input.opportunity ? {
      status: present(input.opportunity.status), propertyTitle: present(input.opportunity.property?.title),
      propertyReference: present(input.opportunity.property?.reference), price: num(input.opportunity.property?.price),
      createdAt: date(input.opportunity.createdAt),
    } : undefined,
    activeDemand: input.activeDemand ? {
      operationType: present(input.activeDemand.operationType), propertySubtype: present(input.activeDemand.propertySubtype),
      city: present(input.activeDemand.city), zone: present(input.activeDemand.zone), priceMax: num(input.activeDemand.priceMax),
      roomsMin: num(input.activeDemand.roomsMin), bathroomsMin: num(input.activeDemand.bathroomsMin), areaMin: num(input.activeDemand.areaMin),
    } : undefined,
    nextVisit: input.nextVisit ? {
      at: date(input.nextVisit.at), status: input.nextVisit.status,
      propertyReference: present(input.nextVisit.propertyReference), assignedAgent: present(input.nextVisit.assignedAgent),
    } : undefined,
    pendingTasks: input.pendingTasks.slice(0, 5).map((task) => ({
      title: task.title.slice(0, 200), dueAt: date(task.dueAt), priority: present(task.priority), assignedAgent: present(task.assignedAgent),
    })),
    telemetry: input.telemetry ? { services: [...input.telemetry.services].slice(0, 8), latencyMs: input.telemetry.latencyMs } : undefined,
  });
}

export function createCrmGetLeadContextTool(input: {
  port: LeadContextPort;
  onResult?: (output: CrmGetLeadContextOutput) => void | Promise<void>;
}): ProductToolDefinition<typeof crmGetLeadContextInputShape> {
  return {
    toolId: CRM_GET_LEAD_CONTEXT_TOOL_ID,
    namespace: "crm",
    name: "get_lead_context",
    version: CRM_GET_LEAD_CONTEXT_TOOL_VERSION,
    description: "Obtiene un resumen CRM acotado de un lead ya resuelto mediante EntityRef. Solo lectura.",
    ownerDomain: "crm",
    compatibleProfiles: ["crm"],
    capabilities: ["crm.lead.context"],
    mode: "read",
    risk: "R0",
    requiredPermission: CRM_GET_LEAD_CONTEXT_PERMISSION,
    inputSchema: crmGetLeadContextInputShape,
    outputSchema: crmGetLeadContextOutputSchema,
    availability: "active",
    idempotency: "none",
    handler: async (raw, actor) => {
      const parsed = crmGetLeadContextInputSchema.parse(raw);
      const output = sanitize(await input.port.getContext(actor, parsed), parsed.lead);
      await input.onResult?.(output);
      return output;
    },
  };
}

function money(value: number | undefined): string | undefined {
  return value === undefined ? undefined : new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(value);
}

function contextBlock(output: CrmGetLeadContextOutput): AgentContentBlock[] {
  const fields = [
    ...(output.lead.status ? [{ label: "Estado", value: output.lead.status }] : []),
    ...(output.assignedAgent?.name ? [{ label: "Comercial", value: output.assignedAgent.name }] : []),
    ...(output.lead.phone ? [{ label: "Teléfono", value: output.lead.phone }] : []),
    ...(output.lead.email ? [{ label: "Email", value: output.lead.email }] : []),
    ...(output.property?.reference ? [{ label: "Inmueble", value: `${output.property.title ?? "Inmueble"} · ${output.property.reference}` }] : []),
    ...(output.activeDemand?.city ? [{ label: "Demanda", value: `${output.activeDemand.city}${money(output.activeDemand.priceMax) ? ` · hasta ${money(output.activeDemand.priceMax)}` : ""}` }] : []),
    ...(output.nextVisit ? [{ label: "Próxima visita", value: new Date(output.nextVisit.at).toLocaleString("es-ES") }] : []),
    ...(output.pendingTasks.length ? [{ label: "Tareas pendientes", value: String(output.pendingTasks.length) }] : []),
  ];
  return [{ type: "entity_list", title: "Contexto del lead", items: [{ ref: output.lead.ref, title: output.lead.name, subtitle: output.property?.title, fields }] }];
}

export function toCrmLeadContextExecutionResult(output: CrmGetLeadContextOutput): ExecutionResult<CrmGetLeadContextOutput> {
  const parts = [
    output.lead.status ? `estado ${output.lead.status}` : undefined,
    output.assignedAgent?.name ? `asignado a ${output.assignedAgent.name}` : undefined,
    output.property?.title ? `interesado en ${output.property.title}` : undefined,
    output.activeDemand?.city ? `demanda activa en ${output.activeDemand.city}` : undefined,
    output.nextVisit ? `próxima visita ${new Date(output.nextVisit.at).toLocaleString("es-ES")}` : undefined,
    output.pendingTasks.length ? `${output.pendingTasks.length} tarea${output.pendingTasks.length === 1 ? "" : "s"} pendiente${output.pendingTasks.length === 1 ? "" : "s"}` : undefined,
  ].filter(Boolean);
  return {
    status: "completed",
    summary: parts.length ? `${output.lead.name}: ${parts.join("; ")}.` : `${output.lead.name}: no hay más contexto operativo resumido.`,
    entities: [output.lead.ref], data: output, blocks: contextBlock(output), errors: [],
  };
}
