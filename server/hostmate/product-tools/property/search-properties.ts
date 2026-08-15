import { z } from "zod";
import type { ActorContext } from "../../contracts/actor-context.js";
import type { EntityRef } from "../../contracts/domain.js";
import type { AgentContentBlock, ExecutionResult } from "../../contracts/execution-result.js";
import type { ProductToolDefinition } from "../../tools/registry.js";

export const PROPERTY_SEARCH_PROPERTIES_TOOL_ID = "property.search_properties.v1";
export const PROPERTY_SEARCH_PROPERTIES_TOOL_VERSION = 1;
export const PROPERTY_SEARCH_PROPERTIES_PERMISSION = "property.read";

export const PROPERTY_FEATURES = [
  "exterior", "ascensor", "garaje", "piscina", "jardin", "terraza",
  "aire_acondicionado", "trastero", "a_reformar", "reformado", "amueblado", "balcon",
] as const;

export const propertySearchPropertiesInputShape = {
  query: z.string().trim().max(120).optional().describe("Texto explícito del usuario para título o referencia comercial. Omite si no se indicó."),
  city: z.string().trim().max(100).optional().describe("Ciudad mencionada explícitamente."),
  neighborhood: z.string().trim().max(150).optional().describe("Barrio o zona mencionados explícitamente."),
  operation: z.enum(["comprar", "alquilar"]).optional().describe("Operación real del catálogo; solo si el usuario la pidió."),
  propertyType: z.string().trim().max(50).optional().describe("Subtipo real, por ejemplo piso, casa, ático, local u oficina; solo si aparece en la petición."),
  status: z.enum(["activo", "reservado", "vendido", "alquilado", "desactivado"]).optional().describe("Estado real; omite si no se pidió."),
  minPrice: z.number().nonnegative().max(1_000_000_000).optional().describe("Precio mínimo explícito en EUR."),
  maxPrice: z.number().nonnegative().max(1_000_000_000).optional().describe("Precio máximo explícito en EUR."),
  rooms: z.number().int().nonnegative().max(100).optional().describe("Número exacto de habitaciones; el backend V1 no soporta mínimo/máximo."),
  bathrooms: z.number().int().nonnegative().max(100).optional().describe("Número exacto de baños."),
  minArea: z.number().nonnegative().max(1_000_000_000).optional().describe("Superficie construida mínima explícita en m²."),
  maxArea: z.number().nonnegative().max(1_000_000_000).optional().describe("Superficie construida máxima explícita en m²."),
  features: z.array(z.enum(PROPERTY_FEATURES)).max(PROPERTY_FEATURES.length).optional().describe("Solo características estructuradas mencionadas explícitamente."),
  order: z.enum(["price_asc", "price_desc", "newest"]).optional().describe("Solo cuando el usuario pide más baratos, más caros o más recientes."),
} satisfies z.ZodRawShape;

export const propertySearchPropertiesInputSchema = z.object(propertySearchPropertiesInputShape).strict().superRefine((value, context) => {
  if (value.query && value.query.length < 2) context.addIssue({ code: z.ZodIssueCode.custom, path: ["query"], message: "Query must contain at least 2 characters" });
  if (value.city && value.city.length < 2) context.addIssue({ code: z.ZodIssueCode.custom, path: ["city"], message: "City must contain at least 2 characters" });
  if (value.neighborhood && value.neighborhood.length < 2) context.addIssue({ code: z.ZodIssueCode.custom, path: ["neighborhood"], message: "Neighborhood must contain at least 2 characters" });
  if (value.propertyType && value.propertyType.length < 2) context.addIssue({ code: z.ZodIssueCode.custom, path: ["propertyType"], message: "Property type must contain at least 2 characters" });
  if (value.minPrice != null && value.maxPrice != null && value.minPrice > value.maxPrice) context.addIssue({ code: z.ZodIssueCode.custom, path: ["maxPrice"], message: "Invalid price range" });
  if (value.minArea != null && value.maxArea != null && value.minArea > value.maxArea) context.addIssue({ code: z.ZodIssueCode.custom, path: ["maxArea"], message: "Invalid area range" });
});

export type PropertySearchFilters = z.infer<typeof propertySearchPropertiesInputSchema>;

export type PropertySearchServiceItem = Readonly<{
  id: string;
  reference: string;
  title: string;
  operation: string | null;
  propertyType: string | null;
  price: number | null;
  currency: "EUR";
  city: string | null;
  neighborhood: string | null;
  rooms: number | null;
  bathrooms: number | null;
  areaBuilt: number | null;
  status: string | null;
  imageUrl?: string;
  features: readonly string[];
  associatedAgent: string | null;
}>;

export type PropertySearchServiceResult = Readonly<{
  items: readonly PropertySearchServiceItem[];
  total: number;
  returned: number;
  hasMore: boolean;
  telemetry?: Readonly<{ service: "property.service.list"; latencyMs: number }>;
}>;

export interface PropertySearchPort {
  search(actor: ActorContext, input: PropertySearchFilters): Promise<PropertySearchServiceResult>;
}

const propertyRefSchema = z.object({
  type: z.literal("property.property"), id: z.string().regex(/^[1-9]\d*$/),
  label: z.string().min(1).max(160), deepLink: z.string().min(1).max(512),
}).strict();

export const propertyCardSchema = z.object({
  id: z.string().regex(/^[1-9]\d*$/), reference: z.string().min(1).max(100), title: z.string().min(1).max(255),
  operation: z.string().nullable(), propertyType: z.string().nullable(), price: z.number().nullable(), currency: z.literal("EUR"),
  city: z.string().nullable(), neighborhood: z.string().nullable(), rooms: z.number().int().nullable(),
  bathrooms: z.number().int().nullable(), areaBuilt: z.number().nullable(), status: z.string().nullable(),
  imageUrl: z.string().optional(), features: z.array(z.string()).max(PROPERTY_FEATURES.length),
  associatedAgent: z.string().nullable(), ref: propertyRefSchema,
}).strict();

export const propertySearchPropertiesOutputSchema = z.object({
  total: z.number().int().nonnegative(), returned: z.number().int().nonnegative().max(6), hasMore: z.boolean(),
  matches: z.array(propertyCardSchema).max(6), appliedFilters: propertySearchPropertiesInputSchema,
  telemetry: z.object({ service: z.literal("property.service.list"), latencyMs: z.number().nonnegative() }).strict().optional(),
}).strict();

export type PropertySearchPropertiesOutput = z.infer<typeof propertySearchPropertiesOutputSchema>;

function sanitize(item: PropertySearchServiceItem) {
  const id = String(item.id);
  const title = item.title.trim() || item.reference.trim() || `Inmueble ${id}`;
  const label = item.reference.trim() ? `${item.reference.trim()} · ${title}` : title;
  return {
    id,
    reference: item.reference.trim(),
    title,
    operation: item.operation,
    propertyType: item.propertyType,
    price: item.price,
    currency: item.currency,
    city: item.city,
    neighborhood: item.neighborhood,
    rooms: item.rooms,
    bathrooms: item.bathrooms,
    areaBuilt: item.areaBuilt,
    status: item.status,
    imageUrl: item.imageUrl?.trim() || undefined,
    features: [...new Set(item.features)].slice(0, PROPERTY_FEATURES.length),
    associatedAgent: item.associatedAgent,
    ref: { type: "property.property" as const, id, label: label.slice(0, 160), deepLink: `/properties?highlight=${encodeURIComponent(id)}` },
  };
}

export function createPropertySearchPropertiesTool(input: {
  port: PropertySearchPort;
  onResult?: (output: PropertySearchPropertiesOutput) => void | Promise<void>;
}): ProductToolDefinition<typeof propertySearchPropertiesInputShape> {
  return {
    toolId: PROPERTY_SEARCH_PROPERTIES_TOOL_ID,
    namespace: "property",
    name: "search_properties",
    version: PROPERTY_SEARCH_PROPERTIES_TOOL_VERSION,
    description: "Busca inmuebles visibles del tenant efectivo mediante filtros deterministas del catálogo Hostmate. Solo lectura.",
    ownerDomain: "property",
    compatibleProfiles: ["property"],
    capabilities: ["property.property.search"],
    mode: "read",
    risk: "R0",
    requiredPermission: PROPERTY_SEARCH_PROPERTIES_PERMISSION,
    inputSchema: propertySearchPropertiesInputShape,
    outputSchema: propertySearchPropertiesOutputSchema,
    availability: "active",
    idempotency: "none",
    handler: async (raw, actor) => {
      const filters = propertySearchPropertiesInputSchema.parse({
        ...raw,
        query: raw.query?.trim() || undefined,
        city: raw.city?.trim() || undefined,
        neighborhood: raw.neighborhood?.trim() || undefined,
        propertyType: raw.propertyType?.trim() || undefined,
        features: raw.features?.length ? [...new Set(raw.features)] : undefined,
      });
      const result = await input.port.search(actor, filters);
      const output = propertySearchPropertiesOutputSchema.parse({
        total: Math.max(0, Number(result.total)), returned: Math.min(6, result.items.length),
        hasMore: Boolean(result.hasMore || result.total > result.items.length),
        matches: result.items.slice(0, 6).map(sanitize), appliedFilters: filters, telemetry: result.telemetry,
      });
      await input.onResult?.(output);
      return output;
    },
  };
}

function formatPrice(price: number | null, currency: string): string | undefined {
  return price == null ? undefined : new Intl.NumberFormat("es-ES", { style: "currency", currency, maximumFractionDigits: 0 }).format(price);
}

function entityList(matches: readonly z.infer<typeof propertyCardSchema>[]): AgentContentBlock[] {
  return [{
    type: "entity_list",
    title: matches.length === 1 ? "Inmueble encontrado" : `${matches.length} inmuebles`,
    items: matches.map((property) => ({
      ref: property.ref, title: property.title,
      subtitle: [property.reference, property.city, property.neighborhood].filter(Boolean).join(" · "),
      imageUrl: property.imageUrl,
      fields: [
        ...(formatPrice(property.price, property.currency) ? [{ label: "Precio", value: formatPrice(property.price, property.currency)! }] : []),
        ...(property.operation ? [{ label: "Operación", value: property.operation }] : []),
        ...(property.propertyType ? [{ label: "Tipo", value: property.propertyType }] : []),
        ...(property.rooms != null ? [{ label: "Habitaciones", value: String(property.rooms) }] : []),
        ...(property.bathrooms != null ? [{ label: "Baños", value: String(property.bathrooms) }] : []),
        ...(property.areaBuilt != null ? [{ label: "Superficie", value: `${property.areaBuilt} m²` }] : []),
        ...(property.features.length ? [{ label: "Características", value: property.features.join(", ") }] : []),
        ...(property.status ? [{ label: "Estado", value: property.status }] : []),
        ...(property.associatedAgent ? [{ label: "Comercial", value: property.associatedAgent }] : []),
      ],
    })),
  }];
}

export function toPropertySearchExecutionResult(output: PropertySearchPropertiesOutput): ExecutionResult<PropertySearchPropertiesOutput> {
  if (output.matches.length === 0) {
    return { status: "completed", summary: "No he encontrado inmuebles con esos criterios.", entities: [], data: output, errors: [], suggestedNext: ["Prueba con menos criterios o revisa la ubicación y la referencia."] };
  }
  return {
    status: "completed",
    summary: output.total === 1 ? "He encontrado un inmueble." : `He encontrado ${output.total} inmuebles.`,
    entities: output.matches.map((property) => property.ref), data: output, blocks: entityList(output.matches), errors: [],
    suggestedNext: output.hasMore ? ["Afina los criterios para reducir los resultados."] : undefined,
  };
}
