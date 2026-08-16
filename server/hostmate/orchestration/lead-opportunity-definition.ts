import type { CrmGetLeadContextOutput } from "../product-tools/crm/get-lead-context.js";
import { CRM_GET_LEAD_CONTEXT_TOOL_ID } from "../product-tools/crm/get-lead-context.js";
import { PROPERTY_SEARCH_PROPERTIES_TOOL_ID, propertySearchPropertiesInputSchema, type PropertySearchFilters } from "../product-tools/property/search-properties.js";
import { VISITS_LIST_LEAD_VISITS_TOOL_ID } from "../product-tools/visits/list-lead-visits.js";
import type { OrchestrationDefinition } from "./contracts.js";

export const LEAD_OPPORTUNITY_OBJECTIVE = "lead.analyze_opportunities";

export const LEAD_OPPORTUNITY_ORCHESTRATION: OrchestrationDefinition = Object.freeze({
  id: "hostmate.lead-opportunity-analysis",
  version: 1,
  objectiveClass: LEAD_OPPORTUNITY_OBJECTIVE,
  rootProfile: "crm",
  branches: Object.freeze([
    Object.freeze({ key: "crm", profile: "crm", dependsOn: Object.freeze([]), toolIds: Object.freeze([CRM_GET_LEAD_CONTEXT_TOOL_ID]) }),
    Object.freeze({ key: "visits", profile: "visits", dependsOn: Object.freeze(["crm"]), toolIds: Object.freeze([VISITS_LIST_LEAD_VISITS_TOOL_ID]) }),
    Object.freeze({ key: "property", profile: "property", dependsOn: Object.freeze(["crm"]), toolIds: Object.freeze([PROPERTY_SEARCH_PROPERTIES_TOOL_ID]) }),
  ]),
  limits: Object.freeze({ maxChildren: 3, maxDepth: 1 }),
});

function normalized(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function isLeadOpportunityAnalysisIntent(message: string): boolean {
  const value = normalized(message);
  if (/\b(admin|permisos?|spawn|subagent|agente hijo|toolscope|skill id)\b/.test(value)) return false;
  const analyzeLead = /\b(analiza|analizar|revisa|revisar|evalua|evaluar)\b/.test(value) && /\b(lead|cliente)\b/.test(value);
  const visits = /\b(visita|visitas)\b/.test(value);
  const matching = /\b(encaj|compatib|matching|demanda)\b/.test(value) && /\b(inmueble|inmuebles|propiedad|propiedades|piso|pisos)\b/.test(value);
  return analyzeLead && visits && matching;
}

/**
 * Lossless, allowlisted mapper. `roomsMin` and `bathroomsMin` are intentionally
 * omitted because the current property API only supports exact equality.
 */
export function activeDemandToPropertyFilters(
  demand: CrmGetLeadContextOutput["activeDemand"],
): PropertySearchFilters | undefined {
  if (!demand) return undefined;
  const operation = demand.operationType === "comprar" || demand.operationType === "alquilar" ? demand.operationType : undefined;
  const raw = {
    city: demand.city,
    neighborhood: demand.zone,
    operation,
    propertyType: demand.propertySubtype,
    maxPrice: demand.priceMax,
    minArea: demand.areaMin,
  };
  const compact = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== undefined));
  return propertySearchPropertiesInputSchema.parse(compact);
}
