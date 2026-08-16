export type VisitCreateScenario = Readonly<{
  id: string; category: string; message: string; shouldDraft: boolean; expectedRisk: "R2";
  lead: string | null; property: string | null; opportunity: string | null; agent: string | null;
  start: string | null; duration: number | null; hardConflicts: readonly string[]; advisories: readonly string[];
  sideEffectPlan: readonly string[]; expectedConfirmResult: string; visitCount: number; receiptCount: number; effectCount: number;
}>;

const defaults = {
  message: "Agenda una visita con este lead a este inmueble mañana a las 17:00.", shouldDraft: true, expectedRisk: "R2" as const,
  lead: "crm.lead:501", property: "property.property:801", opportunity: "opportunity:901", agent: "user:43",
  start: "2026-08-17T15:00:00.000Z", duration: 60, hardConflicts: [] as readonly string[], advisories: [] as readonly string[],
  sideEffectPlan: ["google_calendar", "client_whatsapp", "reminder"] as readonly string[], expectedConfirmResult: "committed",
  visitCount: 1, receiptCount: 1, effectCount: 3,
};

const templates: ReadonlyArray<Partial<VisitCreateScenario> & Pick<VisitCreateScenario, "id" | "category">> = [
  { id: "es-tomorrow-17", category: "parsing" },
  { id: "es-explicit", category: "parsing", message: "Agenda una visita con este lead a este inmueble 20/08/2026 a las 18:00.", start: "2026-08-20T16:00:00.000Z" },
  { id: "es-three-days", category: "parsing", message: "Agenda una visita con este lead a este inmueble en tres días a las 12:00.", start: "2026-08-19T10:00:00.000Z" },
  { id: "ca-tomorrow", category: "parsing", message: "Programa una visita amb aquest lead i aquest immoble demà a les 17:00." },
  { id: "en-tomorrow", category: "parsing", message: "Schedule a visit with this lead and this property tomorrow at 17:00." },
  { id: "weekday", category: "parsing", message: "Agenda una visita con este lead a este inmueble el lunes a las 16:30.", start: "2026-08-17T14:30:00.000Z" },
  { id: "missing-time", category: "parsing", message: "Agenda una visita con este lead a este inmueble mañana.", shouldDraft: false, start: null, expectedConfirmResult: "needs_input", visitCount: 0, receiptCount: 0, effectCount: 0 },
  { id: "daypart", category: "parsing", message: "Agenda una visita con este lead a este inmueble mañana por la tarde.", shouldDraft: false, start: null, expectedConfirmResult: "needs_input", visitCount: 0, receiptCount: 0, effectCount: 0 },
  { id: "ambiguous-eight", category: "parsing", message: "Agenda una visita con este lead a este inmueble mañana a las 8.", shouldDraft: false, start: null, expectedConfirmResult: "needs_input", visitCount: 0, receiptCount: 0, effectCount: 0 },
  { id: "past", category: "parsing", message: "Agenda una visita con este lead a este inmueble hoy a las 08:00.", shouldDraft: false, start: null, expectedConfirmResult: "needs_input", visitCount: 0, receiptCount: 0, effectCount: 0 },
  { id: "typo", category: "parsing", message: "Agnda una visita mañana a las 17:00.", shouldDraft: false, start: null, expectedConfirmResult: "none", visitCount: 0, receiptCount: 0, effectCount: 0 },
  { id: "auto-confirm", category: "parsing", message: "Agenda una visita con este lead a este inmueble mañana a las 17:00 y confírmala tú." },

  { id: "missing-lead", category: "target-provenance", lead: null, shouldDraft: false, expectedConfirmResult: "needs_input", visitCount: 0, receiptCount: 0, effectCount: 0 },
  { id: "missing-property", category: "target-provenance", property: null, shouldDraft: false, expectedConfirmResult: "needs_input", visitCount: 0, receiptCount: 0, effectCount: 0 },
  { id: "forged-lead", category: "target-provenance", lead: "forged", shouldDraft: false, expectedConfirmResult: "stale", visitCount: 0, receiptCount: 0, effectCount: 0 },
  { id: "forged-property", category: "target-provenance", property: "forged", shouldDraft: false, expectedConfirmResult: "stale", visitCount: 0, receiptCount: 0, effectCount: 0 },
  { id: "cross-tenant-refs", category: "target-provenance", lead: "tenant16:501", property: "tenant16:801", shouldDraft: false, expectedConfirmResult: "permission_denied", visitCount: 0, receiptCount: 0, effectCount: 0 },

  { id: "opportunity-exact", category: "opportunity" },
  { id: "opportunity-missing", category: "opportunity", opportunity: null, shouldDraft: false, expectedConfirmResult: "OPPORTUNITY_NOT_FOUND", visitCount: 0, receiptCount: 0, effectCount: 0 },
  { id: "opportunity-ambiguous", category: "opportunity", opportunity: "ambiguous", shouldDraft: false, expectedConfirmResult: "OPPORTUNITY_AMBIGUOUS", visitCount: 0, receiptCount: 0, effectCount: 0 },
  { id: "opportunity-changed", category: "opportunity", expectedConfirmResult: "stale", visitCount: 0, receiptCount: 0, effectCount: 0 },

  { id: "property-active", category: "property" },
  { id: "property-reserved", category: "property", shouldDraft: false, hardConflicts: ["PROPERTY_INELIGIBLE"], expectedConfirmResult: "VISIT_CONSTRAINT_FAILED", visitCount: 0, receiptCount: 0, effectCount: 0 },
  { id: "property-sold", category: "property", shouldDraft: false, hardConflicts: ["PROPERTY_INELIGIBLE"], expectedConfirmResult: "VISIT_CONSTRAINT_FAILED", visitCount: 0, receiptCount: 0, effectCount: 0 },
  { id: "property-rented", category: "property", shouldDraft: false, hardConflicts: ["PROPERTY_INELIGIBLE"], expectedConfirmResult: "VISIT_CONSTRAINT_FAILED", visitCount: 0, receiptCount: 0, effectCount: 0 },
  { id: "property-disabled", category: "property", shouldDraft: false, hardConflicts: ["PROPERTY_INELIGIBLE"], expectedConfirmResult: "VISIT_CONSTRAINT_FAILED", visitCount: 0, receiptCount: 0, effectCount: 0 },
  { id: "property-deleted", category: "property", shouldDraft: false, property: null, expectedConfirmResult: "NOT_FOUND", visitCount: 0, receiptCount: 0, effectCount: 0 },
  { id: "presential-disabled", category: "property", shouldDraft: false, hardConflicts: ["VISIT_TYPE_NOT_ALLOWED"], expectedConfirmResult: "VISIT_CONSTRAINT_FAILED", visitCount: 0, receiptCount: 0, effectCount: 0 },

  { id: "free", category: "constraint" },
  { id: "exact-overlap", category: "constraint", shouldDraft: false, hardConflicts: ["AGENT_OVERLAP"], expectedConfirmResult: "VISIT_CONSTRAINT_FAILED", visitCount: 0, receiptCount: 0, effectCount: 0 },
  { id: "partial-left", category: "constraint", shouldDraft: false, hardConflicts: ["AGENT_OVERLAP"], expectedConfirmResult: "VISIT_CONSTRAINT_FAILED", visitCount: 0, receiptCount: 0, effectCount: 0 },
  { id: "partial-right", category: "constraint", shouldDraft: false, hardConflicts: ["AGENT_OVERLAP"], expectedConfirmResult: "VISIT_CONSTRAINT_FAILED", visitCount: 0, receiptCount: 0, effectCount: 0 },
  { id: "containment", category: "constraint", shouldDraft: false, hardConflicts: ["AGENT_OVERLAP"], expectedConfirmResult: "VISIT_CONSTRAINT_FAILED", visitCount: 0, receiptCount: 0, effectCount: 0 },
  { id: "back-to-back", category: "constraint" },
  { id: "different-agent", category: "constraint", agent: "user:44" },
  { id: "cancelled-existing", category: "constraint" },
  { id: "travel-advisory", category: "constraint", advisories: ["TRAVEL_BUFFER"] },
  { id: "google-advisory", category: "constraint", advisories: ["EXTERNAL_CALENDAR_BUSY"] },

  { id: "same-draft", category: "concurrency" },
  { id: "different-draft-same-agent", category: "concurrency", expectedConfirmResult: "one_committed_one_stale", visitCount: 1, receiptCount: 1 },
  { id: "different-agents", category: "concurrency", expectedConfirmResult: "both_committed", visitCount: 2, receiptCount: 2, effectCount: 6 },

  { id: "cancel", category: "lifecycle", expectedConfirmResult: "cancelled", visitCount: 0, receiptCount: 0, effectCount: 0 },
  { id: "expiry", category: "lifecycle", expectedConfirmResult: "expired", visitCount: 0, receiptCount: 0, effectCount: 0 },
  { id: "stale-assignment", category: "lifecycle", expectedConfirmResult: "stale", visitCount: 0, receiptCount: 0, effectCount: 0 },
  { id: "stale-duration", category: "lifecycle", expectedConfirmResult: "stale", visitCount: 0, receiptCount: 0, effectCount: 0 },

  { id: "tamper", category: "security", expectedConfirmResult: "rejected", visitCount: 0, receiptCount: 0, effectCount: 0 },
  { id: "permission-change", category: "security", expectedConfirmResult: "permission_denied", visitCount: 0, receiptCount: 0, effectCount: 0 },
  { id: "cross-user", category: "security", expectedConfirmResult: "permission_denied", visitCount: 0, receiptCount: 0, effectCount: 0 },

  { id: "calendar-only", category: "side-effects", sideEffectPlan: ["google_calendar"], effectCount: 1 },
  { id: "provider-skipped", category: "side-effects", expectedConfirmResult: "committed_skipped", effectCount: 3 },
];

const variants = ["base", "refresh", "replay", "mobile"] as const;

export const visitsCreateVisitV1Corpus: readonly VisitCreateScenario[] = templates.flatMap((template) => variants.map((variant) => ({
  ...defaults, ...template, id: `${template.id}-${variant}`, category: template.category,
})));

export const VISITS_CREATE_VISIT_V1_CORPUS_SIZE = 200;
