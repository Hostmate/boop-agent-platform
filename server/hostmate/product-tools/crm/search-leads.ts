import { z } from "zod";
import type { ActorContext } from "../../contracts/actor-context.js";
import type { AgentContentBlock, ExecutionResult } from "../../contracts/execution-result.js";
import type { EntityRef } from "../../contracts/domain.js";
import type { ProductToolDefinition } from "../../tools/registry.js";

export const CRM_SEARCH_LEADS_TOOL_ID = "crm.search_leads.v1";
export const CRM_SEARCH_LEADS_TOOL_VERSION = 1;
export const CRM_SEARCH_LEADS_PERMISSION = "crm.read";

const LEAD_STATUSES = ["new", "contacted", "qualified", "visit_scheduled"] as const;

export const crmSearchLeadsInputShape = {
  query: z.string().trim().max(120).optional().describe("Nombre, teléfono o email del lead. Omite el campo si no aplica; no incluyas IDs ni tenant."),
  city: z.string().trim().max(80).optional().describe("Ciudad del inmueble o demanda vinculada. Omite el campo si no se indicó."),
  status: z.enum(LEAD_STATUSES).optional().describe("Estado CRM real."),
} satisfies z.ZodRawShape;

export const crmSearchLeadsInputSchema = z.object(crmSearchLeadsInputShape).strict().superRefine((value, context) => {
  if (value.query && value.query.length < 2) context.addIssue({ code: z.ZodIssueCode.custom, path: ["query"], message: "Query must contain at least 2 characters" });
  if (value.city && value.city.length < 2) context.addIssue({ code: z.ZodIssueCode.custom, path: ["city"], message: "City must contain at least 2 characters" });
  if (!value.query && !value.city && !value.status) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "At least one search criterion is required" });
  }
});

export type CrmSearchLeadsFilters = z.infer<typeof crmSearchLeadsInputSchema>;
export type CrmSearchLeadsInput = CrmSearchLeadsFilters & Readonly<{ page: number; limit: number }>;

export type LeadServiceListItem = Readonly<{
  id: number | string;
  client_name?: string | null;
  client_phone?: string | null;
  client_email?: string | null;
  status?: string | null;
  property_title?: string | null;
  property_ref?: string | null;
  agent_name?: string | null;
  created_at?: string | Date | null;
}>;

export type LeadSearchServiceResult = Readonly<{
  items: readonly LeadServiceListItem[];
  total: number;
  page: number;
  limit: number;
  telemetry?: Readonly<{ service: "lead.service.list"; latencyMs: number; llmLogId?: string }>;
}>;

/** Domain port. The production Hostmate adapter is the only place that knows lead.service.ts. */
export interface LeadSearchPort {
  search(actor: ActorContext, input: CrmSearchLeadsInput): Promise<LeadSearchServiceResult>;
}

export type SanitizedLead = Readonly<{
  id: string;
  name: string;
  phone?: string;
  email?: string;
  status?: string;
  property?: string;
  assignedAgent?: string;
  createdAt?: string;
  ref: EntityRef;
}>;

export const sanitizedLeadSchema = z.object({
  id: z.string(), name: z.string(), phone: z.string().optional(), email: z.string().optional(),
  status: z.string().optional(), property: z.string().optional(), assignedAgent: z.string().optional(),
  createdAt: z.string().optional(), ref: z.object({ type: z.string(), id: z.string(), label: z.string().optional(), deepLink: z.string().optional() }).strict(),
}).strict();

export const crmSearchLeadsOutputSchema = z.object({
  total: z.number().int().nonnegative(), page: z.number().int().positive(), limit: z.number().int().positive(),
  matches: z.array(sanitizedLeadSchema).max(10),
  telemetry: z.object({ service: z.literal("lead.service.list"), latencyMs: z.number().nonnegative(), llmLogId: z.string().optional() }).strict().optional(),
}).strict();

export type CrmSearchLeadsOutput = z.infer<typeof crmSearchLeadsOutputSchema>;

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

function sanitize(item: LeadServiceListItem): SanitizedLead {
  const id = String(item.id);
  const name = item.client_name?.trim() || `Lead ${id}`;
  const property = item.property_title?.trim()
    ? `${item.property_title.trim()}${item.property_ref ? ` · ${item.property_ref}` : ""}`
    : item.property_ref?.trim() || undefined;
  return {
    id,
    name,
    phone: maskPhone(item.client_phone),
    email: maskEmail(item.client_email),
    status: item.status || undefined,
    property,
    assignedAgent: item.agent_name || undefined,
    createdAt: item.created_at ? new Date(item.created_at).toISOString() : undefined,
    ref: { type: "crm.lead", id, label: name, deepLink: `/conversations?leadId=${encodeURIComponent(id)}` },
  };
}

export function createCrmSearchLeadsTool(input: {
  port: LeadSearchPort;
  onResult?: (output: CrmSearchLeadsOutput) => void | Promise<void>;
}): ProductToolDefinition<typeof crmSearchLeadsInputShape> {
  return {
    toolId: CRM_SEARCH_LEADS_TOOL_ID,
    namespace: "crm",
    name: "search_leads",
    version: CRM_SEARCH_LEADS_TOOL_VERSION,
    description: "Busca leads visibles del tenant efectivo por nombre/teléfono/email, ciudad vinculada o estado. Solo lectura.",
    ownerDomain: "crm",
    compatibleProfiles: ["crm"],
    capabilities: ["crm.lead.search"],
    mode: "read",
    risk: "R0",
    requiredPermission: CRM_SEARCH_LEADS_PERMISSION,
    inputSchema: crmSearchLeadsInputShape,
    outputSchema: crmSearchLeadsOutputSchema,
    availability: "active",
    idempotency: "none",
    handler: async (raw, actor) => {
      const filters = crmSearchLeadsInputSchema.parse({
        ...raw,
        query: raw.query?.trim() || undefined,
        city: raw.city?.trim() || undefined,
      });
      const parsed: CrmSearchLeadsInput = { ...filters, page: 1, limit: 5 };
      const result = await input.port.search(actor, parsed);
      const output = crmSearchLeadsOutputSchema.parse({
        total: Math.max(0, Number(result.total)), page: result.page, limit: result.limit,
        matches: result.items.slice(0, parsed.limit).map(sanitize), telemetry: result.telemetry,
      });
      await input.onResult?.(output);
      return output;
    },
  };
}

function entityList(matches: readonly SanitizedLead[]): AgentContentBlock[] {
  return [{
    type: "entity_list",
    title: matches.length === 1 ? "Lead encontrado" : `${matches.length} candidatos`,
    items: matches.map((lead) => ({
      ref: lead.ref,
      title: lead.name,
      subtitle: lead.property,
      fields: [
        ...(lead.phone ? [{ label: "Teléfono", value: lead.phone }] : []),
        ...(lead.email ? [{ label: "Email", value: lead.email }] : []),
        ...(lead.status ? [{ label: "Estado", value: lead.status }] : []),
        ...(lead.assignedAgent ? [{ label: "Comercial", value: lead.assignedAgent }] : []),
      ],
    })),
  }];
}

export function toCrmSearchExecutionResult(output: CrmSearchLeadsOutput): ExecutionResult<CrmSearchLeadsOutput> {
  if (output.matches.length === 0) {
    return { status: "completed", summary: "No he encontrado leads con esos criterios.", entities: [], data: output, errors: [], suggestedNext: ["Prueba con menos criterios o revisa la ortografía."] };
  }
  if (output.matches.length === 1 && output.total === 1) {
    const lead = output.matches[0];
    return { status: "completed", summary: `He encontrado a ${lead.name}.`, entities: [lead.ref], data: output, blocks: entityList(output.matches), errors: [] };
  }
  return {
    status: "needs_input",
    summary: `He encontrado ${output.total} coincidencias. Elige el lead correcto.`,
    entities: output.matches.map((lead) => lead.ref), data: output, blocks: entityList(output.matches), errors: [],
    suggestedNext: output.total > output.matches.length ? ["Afina por teléfono, email, estado o ciudad."] : ["Selecciona uno de los candidatos."],
  };
}
