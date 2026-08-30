export const HOSTMATE_INTERACTION_DEFINITIONS = [
  { id: "crm.search_leads.v1", kind: "tool", domain: "crm", label: "buscar leads" },
  { id: "crm.get_lead_context.v1", kind: "tool", domain: "crm", label: "consultar el contexto de un lead" },
  { id: "visits.search_visits.v1", kind: "tool", domain: "visits", label: "consultar la agenda de visitas" },
  { id: "visits.list_lead_visits.v1", kind: "tool", domain: "visits", label: "consultar las visitas de un lead" },
  { id: "visits.get_visit.v1", kind: "tool", domain: "visits", label: "consultar una visita" },
  { id: "property.search_properties.v1", kind: "tool", domain: "property", label: "buscar inmuebles" },
  { id: "property.get_property.v1", kind: "tool", domain: "property", label: "consultar un inmueble" },
  { id: "skill.prepare-visit-brief.v1", kind: "skill", domain: "visits", label: "preparar el resumen de una visita" },
  { id: "skill.prepare-lead-brief.v1", kind: "skill", domain: "crm", label: "preparar el resumen de un lead" },
  { id: "crm.update_lead_status.v1", kind: "write", domain: "crm", label: "preparar un cambio de estado del lead" },
  { id: "crm.add_lead_note.v1", kind: "write", domain: "crm", label: "preparar una nota para el lead" },
  { id: "tasks.create_task.v1", kind: "write", domain: "tasks", label: "preparar una tarea" },
  { id: "visits.create_visit.v1", kind: "write", domain: "visits", label: "preparar una visita" },
  { id: "visits.cancel_visit.v1", kind: "write", domain: "visits", label: "preparar la cancelación de una visita" },
  { id: "visits.reschedule_visit.v1", kind: "write", domain: "visits", label: "preparar la reprogramación de una visita" },
  { id: "multi-agent.lead-opportunity-analysis.v1", kind: "workflow", domain: "crm", label: "analizar un lead y sus oportunidades" },
] as const;

export type HostmateInteractionDefinition = typeof HOSTMATE_INTERACTION_DEFINITIONS[number];
export type HostmateInteractionAction = HostmateInteractionDefinition["id"];
export type HostmateInteractionKind = HostmateInteractionDefinition["kind"];

export const HOSTMATE_INTERACTION_CAPABILITIES = [
  "crm.search_leads.v1",
  "crm.get_lead_context.v1",
  "visits.search_visits.v1",
  "visits.list_lead_visits.v1",
  "visits.get_visit.v1",
  "property.search_properties.v1",
  "property.get_property.v1",
  "skill.prepare-visit-brief.v1",
  "skill.prepare-lead-brief.v1",
  "crm.update_lead_status.v1",
  "crm.add_lead_note.v1",
  "tasks.create_task.v1",
  "visits.create_visit.v1",
  "visits.cancel_visit.v1",
  "visits.reschedule_visit.v1",
] as const satisfies readonly HostmateInteractionAction[];

export const HOSTMATE_INTERACTION_ORCHESTRATION_TARGETS = [
  "multi-agent.lead-opportunity-analysis.v1",
] as const satisfies readonly HostmateInteractionAction[];

const BY_ID = new Map<HostmateInteractionAction, HostmateInteractionDefinition>(
  HOSTMATE_INTERACTION_DEFINITIONS.map((definition) => [definition.id, definition]),
);

export function interactionDefinition(action: HostmateInteractionAction): HostmateInteractionDefinition {
  const definition = BY_ID.get(action);
  if (!definition) throw new Error(`Unknown Interaction action: ${action}`);
  return definition;
}

export function interactionActionLabel(action: string): string {
  return BY_ID.get(action as HostmateInteractionAction)?.label ?? action;
}

export function expectedDelegationFor(action: HostmateInteractionAction): Readonly<{
  kind: "none" | "skill" | "multi_agent";
  target: "" | HostmateInteractionAction;
}> {
  const definition = interactionDefinition(action);
  if (definition.kind === "skill") return { kind: "skill", target: action };
  if (definition.kind === "workflow") return { kind: "multi_agent", target: action };
  return { kind: "none", target: "" };
}
