import type { EntityRef } from "../contracts/domain.js";
import type { AgentMessageRecord } from "../control-plane/repository.js";
import { groundInteractionDomain, normalizeGroundingText } from "./domain-grounding.js";

function normalized(value: string): string {
  return normalizeGroundingText(value);
}

export type BriefSkillIntent = "prepare-visit-brief" | "prepare-lead-brief";

export function classifyBriefSkillIntent(message: string): BriefSkillIntent | undefined {
  const value = normalized(message);
  // Skill IDs and imperative prompt-injection language are not a user-facing
  // selection API. Activation requires an ordinary visit-preparation intent.
  if (/\bprepare (visit|lead) brief\b/.test(value) && !/\b(prepara|preparame|preparar|resume|resumeme|resumen|briefing|dossier)\b/.test(value)) return undefined;
  if (/\b(automatizacion|automatitzacio|automation|campana|workflow)\b/.test(value)) return undefined;
  const preparation = /\b(prepara|preparame|prepararme|preparala|preparalo|preparar|preparacio|preparacion|briefing|dossier|resume|resumeme|resumen operativo|ficha de preparacion)\b/.test(value);
  const visit = /\b(visita|visites)\b/.test(value);
  const lead = /\b(lead|leads|cliente|clientes)\b/.test(value);
  const property = /\b(inmueble|inmuebles|propiedad|propiedades|piso|pisos|casa|casas)\b/.test(value);
  if (!preparation || property || visit === lead) return undefined;
  return visit ? "prepare-visit-brief" : "prepare-lead-brief";
}

export function isPrepareVisitBriefIntent(message: string): boolean {
  return classifyBriefSkillIntent(message) === "prepare-visit-brief";
}

export function isPrepareLeadBriefIntent(message: string): boolean {
  return classifyBriefSkillIntent(message) === "prepare-lead-brief";
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
  const grounding = groundInteractionDomain(input.message);
  if (grounding.domain === "crm") return "crm";
  if (grounding.domain === "property") return "property";
  const value = normalized(input.message);
  const propertySelected = latestSelectedProperty(input.priorMessages ?? []);
  if (propertySelected && /\b(cuentame mas|mas detalle|mas detalles|detalle|informacion|selecciona|seleccionar|anterior|otro|primero|segundo|tercero|cuarto|quinto)\b/.test(value)) return "property";
  return "crm";
}
