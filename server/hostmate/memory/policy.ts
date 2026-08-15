import type { MemorySegment, MemoryTier } from "../../memory/types.js";

export type HostmateMemoryCategory = "preference" | "communication_style" | "formatting" | "workflow_preference" | "correction";
export type HostmatePreferenceKey = "property_order" | "response_length" | "time_format" | "visit_workflow";
export type HostmatePreferenceValue = "price_asc" | "price_desc" | "newest" | "brief" | "detailed" | "24h" | "12h" | "lead_then_property";

export type MemoryCandidate = Readonly<{
  category: HostmateMemoryCategory;
  preferenceKey: HostmatePreferenceKey;
  preferenceValue: HostmatePreferenceValue;
  content: string;
  confidence: number;
  tier: MemoryTier;
  segment: MemorySegment;
  importance: number;
  decayRate: number;
  sourceType: "explicit_user" | "retrieved_product_data" | "provider_payload";
}>;

export type ExplicitMemoryCommand =
  | Readonly<{ kind: "remember"; rawContent: string }>
  | Readonly<{ kind: "forget"; rawContent: string }>;

export type MemoryPolicyDecision =
  | Readonly<{ decision: "allow"; candidate: MemoryCandidate }>
  | Readonly<{ decision: "reject"; code: string; explanation: string }>;

function normalized(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function classifyExplicitMemoryCommand(message: string): ExplicitMemoryCommand | null {
  const trimmed = message.trim();
  const remember = trimmed.match(/^(?:recuerda|memoriza)(?:\s+que)?\s+(.+)$/iu);
  if (remember?.[1]) return { kind: "remember", rawContent: remember[1].trim() };
  const forget = trimmed.match(/^(?:olvida|borra\s+(?:esto\s+)?de\s+(?:tu\s+)?memoria)(?:\s+que)?\s+(.+)$/iu);
  if (forget?.[1]) return { kind: "forget", rawContent: forget[1].trim() };
  return null;
}

const AUTHORITY_OR_SECRET = /\b(?:password|contrasena|clave|secret[oa]?|token|api[ _-]?key|credencial(?:es)?|permiso(?:s)?|rol(?:es)?|superadmin|admin|tenant|tenants|agencia activa|tool access|herramienta(?:s)? habilitad|todos los tenants|todas las agencias|access all tenants)\b/i;
const DIRECT_PII = /(?:\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|(?:\+|00)?\d[\d\s().-]{7,}\d|\b(?:dni|nie|pasaporte|iban)\b)/i;
const PRODUCT_FACT = /\b(?:telefono|email|correo|direccion privada|estado crm|oportunidad|demanda|match|visita|tarea|asignacion|nota privada|documento legal|mensaje de whatsapp|mensaje de instagram|lead|cliente)\s+(?:de|del|para|#|id\b)/i;
const CONCRETE_PROPERTY = /\b(?:property|propiedad|inmueble)\s*(?:#|id\s*)?\d+\b/i;
const OPERATIONAL_PRICE = /\b(?:cuesta|precio (?:del|de la)|vale)\s+\d[\d.,]*\s*(?:€|euros?)?/i;
const SCHEDULED_PRODUCT_FACT = /\b(?:visita|tarea)\b.*\b(?:hoy|manana|lunes|martes|miercoles|jueves|viernes|sabado|domingo|\d{1,2}(?::\d{2}|[/-]\d{1,2}))\b/i;

function candidateFor(rawContent: string, sourceType: MemoryCandidate["sourceType"]): MemoryCandidate | null {
  const value = normalized(rawContent);
  const base = { confidence: 1, tier: "long" as const, segment: "preference" as const, importance: 0.8, decayRate: 0.02, sourceType };
  if (/\b(?:de\s+)?mas caro(?:s)?\s+(?:al?|a los?)\s+mas barato(?:s)?\b/.test(value)) {
    return { ...base, category: "preference", preferenceKey: "property_order", preferenceValue: "price_desc", content: "Prefiere que los inmuebles se ordenen por precio descendente." };
  }
  if (/\b(?:de\s+)?mas barato(?:s)?\s+(?:al?|a los?)\s+mas caro(?:s)?\b/.test(value)) {
    return { ...base, category: "preference", preferenceKey: "property_order", preferenceValue: "price_asc", content: "Prefiere que los inmuebles se ordenen por precio ascendente." };
  }
  if (/\b(?:mas barato|mas baratos|menor precio|precio ascendente|de barato a caro)\b/.test(value)) {
    return { ...base, category: "preference", preferenceKey: "property_order", preferenceValue: "price_asc", content: "Prefiere que los inmuebles se ordenen por precio ascendente." };
  }
  if (/\b(?:mas caro|mas caros|mayor precio|precio descendente|de caro a barato)\b/.test(value)) {
    return { ...base, category: "preference", preferenceKey: "property_order", preferenceValue: "price_desc", content: "Prefiere que los inmuebles se ordenen por precio descendente." };
  }
  if (/\b(?:mas reciente|mas recientes|primero los nuevos|novedades primero)\b/.test(value)) {
    return { ...base, category: "preference", preferenceKey: "property_order", preferenceValue: "newest", content: "Prefiere que los inmuebles más recientes aparezcan primero." };
  }
  if (/\b(?:resumenes?|respuestas?|resultados?)\b.*\b(?:breves?|cortos?|concisos?)\b|\b(?:breves?|cortos?|concisos?)\b.*\b(?:resumenes?|respuestas?|resultados?)\b/.test(value)) {
    return { ...base, category: "communication_style", preferenceKey: "response_length", preferenceValue: "brief", content: "Prefiere respuestas y resúmenes breves." };
  }
  if (/\b(?:resumenes?|respuestas?|resultados?)\b.*\b(?:detallados?|largos?|completos?)\b|\b(?:detallados?|largos?|completos?)\b.*\b(?:resumenes?|respuestas?|resultados?)\b/.test(value)) {
    return { ...base, category: "communication_style", preferenceKey: "response_length", preferenceValue: "detailed", content: "Prefiere respuestas y resúmenes detallados." };
  }
  if (/\b(?:formato\s+)?24\s*(?:h|horas?)\b/.test(value)) {
    return { ...base, category: "formatting", preferenceKey: "time_format", preferenceValue: "24h", content: "Prefiere que los horarios se muestren en formato de 24 horas." };
  }
  if (/\b(?:formato\s+)?12\s*(?:h|horas?)\b/.test(value)) {
    return { ...base, category: "formatting", preferenceKey: "time_format", preferenceValue: "12h", content: "Prefiere que los horarios se muestren en formato de 12 horas." };
  }
  if (/\b(?:primero|antes)\b.*\blead\b.*\b(?:despues|luego)\b.*\binmueble\b/.test(value)) {
    return { ...base, category: "workflow_preference", preferenceKey: "visit_workflow", preferenceValue: "lead_then_property", content: "Prefiere revisar primero el lead y después el inmueble al preparar una visita." };
  }
  return null;
}

export function evaluateExplicitMemory(rawContent: string, sourceType: MemoryCandidate["sourceType"] = "explicit_user"): MemoryPolicyDecision {
  const content = rawContent.trim();
  if (sourceType !== "explicit_user") return { decision: "reject", code: "UNTRUSTED_MEMORY_SOURCE", explanation: "Solo una petición explícita del usuario autenticado puede crear memoria." };
  if (!content || content.length > 500) return { decision: "reject", code: "MEMORY_CONTENT_INVALID", explanation: "La preferencia debe ser breve y concreta." };
  if (AUTHORITY_OR_SECRET.test(content)) return { decision: "reject", code: "AUTHORITY_OR_SECRET_DENIED", explanation: "Memory nunca puede guardar secretos, permisos, roles, tools ni selección de tenant." };
  if (DIRECT_PII.test(content)) return { decision: "reject", code: "PII_DENIED", explanation: "Los datos personales de clientes pertenecen al CRM y no a Memory." };
  if (PRODUCT_FACT.test(content) || CONCRETE_PROPERTY.test(content) || OPERATIONAL_PRICE.test(content) || SCHEDULED_PRODUCT_FACT.test(content)) return { decision: "reject", code: "PRODUCT_DATA_DENIED", explanation: "Ese dato es Product Data y debe consultarse mediante las tools del dominio." };
  const candidate = candidateFor(content, sourceType);
  if (!candidate) return { decision: "reject", code: "CATEGORY_NOT_ALLOWLISTED", explanation: "En esta fase solo puedo recordar preferencias estables de orden, estilo de respuesta, formato horario o workflow de visita." };
  return { decision: "allow", candidate };
}

export function preferenceKeyForForget(rawContent: string): HostmatePreferenceKey | null {
  return candidateFor(rawContent, "explicit_user")?.preferenceKey ?? null;
}

export function explicitPropertyOrder(message: string): "price_asc" | "price_desc" | "newest" | undefined {
  const value = normalized(message);
  if (/\b(?:de\s+)?mas caro(?:s)?\s+(?:al?|a los?)\s+mas barato(?:s)?\b/.test(value)) return "price_desc";
  if (/\b(?:de\s+)?mas barato(?:s)?\s+(?:al?|a los?)\s+mas caro(?:s)?\b/.test(value)) return "price_asc";
  if (/\b(?:mas barato|mas baratos|menor precio|precio ascendente|de barato a caro)\b/.test(value)) return "price_asc";
  if (/\b(?:mas caro|mas caros|mayor precio|precio descendente|de caro a barato)\b/.test(value)) return "price_desc";
  if (/\b(?:mas reciente|mas recientes|primero los nuevos|novedades primero)\b/.test(value)) return "newest";
  return undefined;
}
