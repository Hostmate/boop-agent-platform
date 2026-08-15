import type { EntityRef } from "../contracts/domain.js";
import type { AgentMessageRecord } from "../control-plane/repository.js";

function normalized(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function latestSelectedProperty(messages: readonly AgentMessageRecord[]): EntityRef | undefined {
  for (const message of [...messages].reverse()) {
    const ref = message.contextRefs?.selected.property;
    if (ref?.type === "property.property") return ref;
  }
  return undefined;
}

export function classifyInteractionTurn(input: {
  message: string;
  selectedEntityRef?: EntityRef;
  priorMessages?: readonly AgentMessageRecord[];
}): "crm" | "property" {
  if (input.selectedEntityRef) return input.selectedEntityRef.type === "property.property" ? "property" : "crm";
  const value = normalized(input.message);
  const searchIntent = /\b(busca|buscar|encuentra|encontrar|ensename|muestra|muestrame|dame|lista|listar|localiza|localizar)\b/.test(value);
  const propertyNoun = /\b(inmueble|inmuebles|propiedad|propiedades|piso|pisos|casa|casas|chalet|chalets|atico|aticos|apartamento|apartamentos|local|locales|oficina|oficinas|nave|naves|garaje|garajes|referencia)\b/.test(value);
  if (searchIntent && propertyNoun) return "property";
  if (propertyNoun && /\b(cuentame mas|mas detalle|mas detalles|detalle|detalles|informacion completa|ficha completa)\b/.test(value)) return "property";
  if (/\b(visita|visitas|lead|leads|cliente|clientes)\b/.test(value)) return "crm";
  const propertySelected = latestSelectedProperty(input.priorMessages ?? []);
  if (propertySelected && /\b(cuentame mas|mas detalle|mas detalles|detalle|informacion|selecciona|seleccionar)\b/.test(value)) return "property";
  return "crm";
}
