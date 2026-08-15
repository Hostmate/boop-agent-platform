import { z } from "zod";
import type { ActorContext } from "../../contracts/actor-context.js";
import { entityRefSchema, type AgentContentBlock, type ExecutionResult } from "../../contracts/execution-result.js";
import type { ProductToolDefinition } from "../../tools/registry.js";

export const PROPERTY_GET_PROPERTY_TOOL_ID = "property.get_property.v1";
export const PROPERTY_GET_PROPERTY_TOOL_VERSION = 1;
export const PROPERTY_GET_PROPERTY_PERMISSION = "property.read";

export const propertyEntityRefSchema = entityRefSchema.extend({
  type: z.literal("property.property"),
  id: z.string().regex(/^[1-9]\d*$/).max(20),
}).strict();

export const propertyGetPropertyInputShape = {
  property: propertyEntityRefSchema.describe("Referencia canónica a un inmueble ya autorizada por Hostmate."),
} satisfies z.ZodRawShape;

export const propertyGetPropertyInputSchema = z.object(propertyGetPropertyInputShape).strict();
export type PropertyGetPropertyInput = z.infer<typeof propertyGetPropertyInputSchema>;

const nullableText = z.string().nullable();
const nullableNumber = z.number().nullable();
const propertyImageSchema = z.object({
  url: z.string().min(1).max(1_024),
  thumbnailUrl: z.string().min(1).max(1_024).nullable(),
  caption: z.string().min(1).max(120).nullable(),
}).strict();

export const propertyDetailServiceResultSchema = z.object({
  id: z.string().regex(/^[1-9]\d*$/), reference: z.string().min(1).max(100), title: z.string().min(1).max(255),
  operation: nullableText, propertyType: nullableText, status: nullableText, price: nullableNumber, currency: z.literal("EUR"),
  location: z.object({ city: nullableText, neighborhood: nullableText, province: nullableText }).strict(),
  specifications: z.object({
    rooms: nullableNumber, bathrooms: nullableNumber, areaBuilt: nullableNumber, areaUseful: nullableNumber,
    plotArea: nullableNumber, floor: nullableText, yearBuilt: nullableNumber, ceilingHeight: nullableNumber,
    loadingDocks: nullableNumber, powerSupplyKw: nullableNumber, officeArea: nullableNumber,
    storefrontCount: nullableNumber, grossYieldPct: nullableNumber,
  }).strict(),
  features: z.array(z.string().min(1).max(80)).max(24),
  description: z.string().max(3_000).nullable(), publicNotes: z.string().max(1_500).nullable(),
  images: z.array(propertyImageSchema).max(8),
  associatedAgents: z.array(z.object({ id: z.string().regex(/^[1-9]\d*$/), name: z.string().min(1).max(120), priority: z.number().int().positive() }).strict()).max(10),
  telemetry: z.object({ services: z.array(z.string().min(1).max(120)).min(1).max(4), latencyMs: z.number().nonnegative() }).strict(),
}).strict();
export type PropertyDetailServiceResult = z.infer<typeof propertyDetailServiceResultSchema>;

export interface PropertyDetailPort {
  get(actor: ActorContext, input: PropertyGetPropertyInput): Promise<PropertyDetailServiceResult>;
}

export const propertyGetPropertyOutputSchema = propertyDetailServiceResultSchema.extend({
  ref: propertyEntityRefSchema,
}).strict();
export type PropertyGetPropertyOutput = z.infer<typeof propertyGetPropertyOutputSchema>;

function canonicalRef(detail: PropertyDetailServiceResult) {
  const label = `${detail.reference} · ${detail.title}`.slice(0, 160);
  return { type: "property.property" as const, id: detail.id, label, deepLink: `/properties?highlight=${encodeURIComponent(detail.id)}` };
}

export function createPropertyGetPropertyTool(input: {
  port: PropertyDetailPort;
  onResult?: (output: PropertyGetPropertyOutput) => void | Promise<void>;
}): ProductToolDefinition<typeof propertyGetPropertyInputShape> {
  return {
    toolId: PROPERTY_GET_PROPERTY_TOOL_ID,
    namespace: "property",
    name: "get_property",
    version: PROPERTY_GET_PROPERTY_TOOL_VERSION,
    description: "Obtiene el detalle público y comercial permitido de un inmueble mediante un EntityRef autorizado. Solo lectura.",
    ownerDomain: "property",
    compatibleProfiles: ["property"],
    capabilities: ["property.property.read"],
    mode: "read",
    risk: "R0",
    requiredPermission: PROPERTY_GET_PROPERTY_PERMISSION,
    inputSchema: propertyGetPropertyInputShape,
    outputSchema: propertyGetPropertyOutputSchema,
    availability: "active",
    idempotency: "none",
    handler: async (raw, actor) => {
      const parsed = propertyGetPropertyInputSchema.parse(raw);
      const detail = propertyDetailServiceResultSchema.parse(await input.port.get(actor, parsed));
      if (detail.id !== parsed.property.id) throw new Error("STALE_REFERENCE: property service returned a different entity");
      const output = propertyGetPropertyOutputSchema.parse({ ...detail, ref: canonicalRef(detail) });
      await input.onResult?.(output);
      return output;
    },
  };
}

function formatPrice(value: number | null): string | undefined {
  return value == null ? undefined : new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(value);
}

function fields(values: ReadonlyArray<readonly [string, string | number | null | undefined, string?]>) {
  return values.flatMap(([label, value, suffix]) => value == null || value === "" ? [] : [{ label, value: `${value}${suffix ?? ""}` }]);
}

export function propertyDetailBlock(output: PropertyGetPropertyOutput): AgentContentBlock {
  const location = [output.location.neighborhood, output.location.city, output.location.province].filter(Boolean).join(" · ");
  const commercial = output.associatedAgents.sort((a, b) => a.priority - b.priority).map((agent) => agent.name).join(", ");
  return {
    type: "entity_detail",
    title: output.title,
    ref: output.ref,
    subtitle: [output.reference, location].filter(Boolean).join(" · "),
    imageUrl: output.images[0]?.url,
    gallery: output.images.map((image) => ({ url: image.url, ...(image.thumbnailUrl ? { thumbnailUrl: image.thumbnailUrl } : {}), ...(image.caption ? { caption: image.caption } : {}) })),
    badges: [output.operation, output.propertyType, output.status].filter((value): value is string => Boolean(value)),
    description: [output.description, output.publicNotes].filter(Boolean).join("\n\n") || undefined,
    sections: [
      { title: "Datos principales", fields: fields([
        ["Precio", formatPrice(output.price)], ["Operación", output.operation], ["Tipo", output.propertyType], ["Estado", output.status], ["Ubicación", location],
      ]) },
      { title: "Características", fields: fields([
        ["Habitaciones", output.specifications.rooms], ["Baños", output.specifications.bathrooms],
        ["Superficie construida", output.specifications.areaBuilt, " m²"], ["Superficie útil", output.specifications.areaUseful, " m²"],
        ["Parcela", output.specifications.plotArea, " m²"], ["Planta", output.specifications.floor], ["Año", output.specifications.yearBuilt],
        ["Altura libre", output.specifications.ceilingHeight, " m"], ["Muelles de carga", output.specifications.loadingDocks],
        ["Potencia", output.specifications.powerSupplyKw, " kW"], ["Zona de oficinas", output.specifications.officeArea, " m²"],
        ["Escaparates", output.specifications.storefrontCount], ["Rentabilidad bruta", output.specifications.grossYieldPct, "%"],
      ]) },
      ...(output.features.length ? [{ title: "Equipamiento", fields: [{ label: "Incluye", value: output.features.join(", ") }] }] : []),
      ...(commercial ? [{ title: "Comercial", fields: [{ label: "Asignado", value: commercial }] }] : []),
    ].filter((section) => section.fields.length > 0),
    actions: [{ label: "Abrir inmueble", href: output.ref.deepLink! }],
  };
}

export function toPropertyGetExecutionResult(output: PropertyGetPropertyOutput): ExecutionResult<PropertyGetPropertyOutput> {
  return {
    status: "completed",
    summary: `Detalle de ${output.title}.`,
    entities: [output.ref],
    data: output,
    blocks: [propertyDetailBlock(output)],
    errors: [],
  };
}
