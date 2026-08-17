import type { EntityRef } from "../contracts/domain.js";

export type GroundedDomain = "property" | "crm" | "visits" | undefined;

export type DomainGrounding = Readonly<{
  domain: GroundedDomain;
  property: boolean;
  lead: boolean;
  visit: boolean;
  propertyReferenceSignal: boolean;
  propertyAnaphoraSignal: boolean;
}>;

export function normalizeGroundingText(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9€]+/g, " ").replace(/\s+/g, " ").trim();
}

const PROPERTY_NOUNS = [
  "inmueble", "inmuebles", "propiedad", "propiedades", "piso", "pisos", "casa", "casas",
  "chalet", "chalets", "atico", "aticos", "apartamento", "apartamentos", "local", "locales",
  "oficina", "oficinas", "nave", "naves", "garaje", "garajes", "referencia",
] as const;

const PROPERTY_LOOKUP_WORDS = [
  "cuanto", "costaba", "precio", "vale", "valia", "informacion", "detalle", "detalles",
  "caracteristicas", "habitaciones", "dormitorios", "superficie", "ubicacion", "direccion",
  "ficha", "cuentame", "selecciona", "seleccionar", "mueve", "agenda", "programa",
] as const;

const PROPERTY_ANAPHORA = [
  "este", "esta", "ese", "esa", "el anterior", "la anterior", "el otro", "la otra",
  "anterior", "otro", "primero", "primera", "segundo", "segunda", "tercero", "tercera", "cuarto", "cuarta", "quinto", "quinta",
  "el primero", "la primera", "el segundo", "la segunda", "el tercero", "la tercera",
  "el cuarto", "la cuarta", "el quinto", "la quinta", "el de", "la de", "al de", "a la de",
] as const;

function hasWord(text: string, word: string): boolean {
  return new RegExp(`\\b${word.replace(/ /g, "\\s+")}\\b`).test(text);
}

export function groundInteractionDomain(message: string, selectedEntityRef?: EntityRef): DomainGrounding {
  if (selectedEntityRef) {
    const selectedProperty = selectedEntityRef.type === "property.property";
    return { domain: selectedProperty ? "property" : "crm", property: selectedProperty, lead: !selectedProperty, visit: false, propertyReferenceSignal: selectedProperty, propertyAnaphoraSignal: selectedProperty };
  }
  const text = normalizeGroundingText(message);
  const property = PROPERTY_NOUNS.some((word) => hasWord(text, word));
  const lead = /\b(lead|leads|cliente|clientes)\b/.test(text);
  const visit = /\b(visita|visitas|visites)\b/.test(text);
  const search = /\b(busca|buscar|encuentra|encontrar|ensename|muestra|muestrame|dame|lista|listar|localiza|localizar)\b/.test(text);
  const lookup = PROPERTY_LOOKUP_WORDS.some((word) => hasWord(text, word));
  const anaphora = PROPERTY_ANAPHORA.some((phrase) => hasWord(text, phrase));
  const reference = /\b(ref(?:erencia)?|codigo|código)\b/.test(text);
  const propertySpecific = (property && (search || lookup || anaphora || reference)) || anaphora;
  const domain = propertySpecific && !lead && !visit ? "property" : lead || visit ? "crm" : undefined;
  return { domain, property: property || anaphora, lead, visit, propertyReferenceSignal: propertySpecific, propertyAnaphoraSignal: anaphora };
}
