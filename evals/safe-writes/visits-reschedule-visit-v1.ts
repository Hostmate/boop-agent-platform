import type { VisitRescheduleInputIssue } from "../../server/hostmate/product-tools/visits/reschedule-visit.js";

export type VisitRescheduleCorpusScenario = Readonly<{
  id: string; category: string; message: string; expectedIntent: "reschedule" | "needs_input";
  expectedReason?: VisitRescheduleInputIssue; expectedRisk: "R2"; inference: 0;
  effectiveReschedules: 0 | 1; events: 0 | 1; notifications: 0 | 1; reminders: 0 | 1;
}>;

const scenario = (id: string, category: string, message: string, expectedIntent: "reschedule" | "needs_input", expectedReason?: VisitRescheduleInputIssue): VisitRescheduleCorpusScenario => ({
  id, category, message, expectedIntent, ...(expectedReason ? { expectedReason } : {}), expectedRisk: "R2", inference: 0,
  effectiveReschedules: expectedIntent === "reschedule" ? 1 : 0, events: expectedIntent === "reschedule" ? 1 : 0,
  notifications: expectedIntent === "reschedule" ? 1 : 0, reminders: expectedIntent === "reschedule" ? 1 : 0,
});

const exact = Array.from({ length: 80 }, (_, index) => {
  const verbs = ["Mueve esta visita", "Reprograma la visita", "Reschedule this visit", "Move the appointment"];
  const times = ["09:00", "11:30", "17:00", "19:00", "20:15"];
  const connectors = index % 4 < 2 ? "mañana a las" : "tomorrow at";
  return scenario(`temporal-exact-${String(index + 1).padStart(3, "0")}`, "temporal_exact", `${verbs[index % verbs.length]} a ${connectors} ${times[index % times.length]}`, "reschedule");
});
const ambiguous = Array.from({ length: 35 }, (_, index) => scenario(`temporal-ambiguous-${String(index + 1).padStart(3, "0")}`, "ambiguity", `${index % 2 ? "Mueve esta visita" : "Reprograma la visita"} a mañana por la tarde`, "needs_input", "ambiguous_time"));
const missing = Array.from({ length: 15 }, (_, index) => scenario(`temporal-missing-${String(index + 1).padStart(3, "0")}`, "missing_time", `${index % 2 ? "Mueve esta visita" : "Reprograma la visita"} a mañana`, "needs_input", "missing_time"));
const manual = Array.from({ length: 10 }, (_, index) => scenario(`provenance-manual-${String(index + 1).padStart(3, "0")}`, "provenance", `Mueve la visita #${100 + index} a mañana a las 19:00`, "needs_input", "manual_target"));
const group = Array.from({ length: 10 }, (_, index) => scenario(`group-${String(index + 1).padStart(3, "0")}`, "group", `Mueve esta visita grupal a mañana a las ${18 + (index % 2)}:00`, "needs_input", "group_visit"));
const multiple = Array.from({ length: 10 }, (_, index) => scenario(`multiple-${String(index + 1).padStart(3, "0")}`, "batch", `${index % 2 ? "Mueve todas las visitas" : "Reprograma varias visitas"} de mañana a las 19:00`, "needs_input", "multiple_visits"));
const property = Array.from({ length: 10 }, (_, index) => scenario(`property-change-${String(index + 1).padStart(3, "0")}`, "unsupported_property", `Mueve esta visita al inmueble X mañana a las ${18 + (index % 2)}:00`, "needs_input", "change_property"));
const agent = Array.from({ length: 10 }, (_, index) => scenario(`agent-change-${String(index + 1).padStart(3, "0")}`, "unsupported_agent", `Reprograma la visita y asígnasela a Marta mañana a las ${18 + (index % 2)}:00`, "needs_input", "change_agent"));
const mixed = Array.from({ length: 10 }, (_, index) => scenario(`mixed-${String(index + 1).padStart(3, "0")}`, "mixed_action", `Mueve esta visita a mañana a las ${18 + (index % 2)}:00 y cancélala`, "needs_input", "mixed_actions"));
const autoConfirm = Array.from({ length: 10 }, (_, index) => scenario(`auto-confirm-${String(index + 1).padStart(3, "0")}`, "auto_confirm", `Mueve esta visita a mañana a las ${18 + (index % 2)}:00 y confírmalo`, "reschedule"));

export const visitsRescheduleVisitV1Corpus: readonly VisitRescheduleCorpusScenario[] = Object.freeze([
  ...exact, ...ambiguous, ...missing, ...manual, ...group, ...multiple, ...property, ...agent, ...mixed, ...autoConfirm,
]);
export const VISITS_RESCHEDULE_VISIT_V1_CORPUS_SIZE = 200;
