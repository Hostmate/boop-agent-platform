export type VisitCancelScenario = Readonly<{
  id: string; category: string; message: string; expectedIntent: "cancel" | "needs_input" | "none";
  status: string; expectedPrepare: "draft" | "noop" | "rejected"; expectedRisk: "R2";
  targetStatus: "cancelled_by_agent"; calendar: "planned" | "skipped" | "unknown";
  whatsapp: "planned" | "skipped" | "unknown"; reminder: "disable" | "none" | "fenced";
  expectedConfirm: string; effectiveCancellations: number; events: number; notifications: number;
}>;

const defaults = {
  message: "Cancela esta visita.", expectedIntent: "cancel" as const, status: "confirmed", expectedPrepare: "draft" as const,
  expectedRisk: "R2" as const, targetStatus: "cancelled_by_agent" as const, calendar: "planned" as const,
  whatsapp: "planned" as const, reminder: "disable" as const, expectedConfirm: "committed",
  effectiveCancellations: 1, events: 1, notifications: 1,
};

const templates: ReadonlyArray<Partial<VisitCancelScenario> & Pick<VisitCancelScenario, "id" | "category">> = [
  { id: "es-cancela", category: "parsing" }, { id: "es-anula", category: "parsing", message: "Anula esta visita" },
  { id: "ca-cancella", category: "parsing", message: "Cancel·la aquesta visita" }, { id: "ca-anulla", category: "parsing", message: "Anul·la aquesta visita" },
  { id: "en-cancel", category: "parsing", message: "Cancel this visit" }, { id: "en-appointment", category: "parsing", message: "Cancel this appointment" },
  { id: "auto-confirm", category: "parsing", message: "Cancela esta visita y confírmala tú" },
  { id: "manual-id", category: "parsing", message: "Cancela la visita 123", expectedIntent: "needs_input", expectedPrepare: "rejected", effectiveCancellations: 0, events: 0, notifications: 0 },
  { id: "plural", category: "parsing", message: "Cancela estas visitas", expectedIntent: "needs_input", expectedPrepare: "rejected", effectiveCancellations: 0, events: 0, notifications: 0 },
  { id: "reschedule", category: "parsing", message: "Reprograma o cancela esta visita", expectedIntent: "needs_input", expectedPrepare: "rejected", effectiveCancellations: 0, events: 0, notifications: 0 },
  { id: "group", category: "parsing", message: "Cancela esta visita grupal", expectedIntent: "needs_input", expectedPrepare: "rejected", effectiveCancellations: 0, events: 0, notifications: 0 },
  { id: "unrelated", category: "parsing", message: "Enséñame esta visita", expectedIntent: "none", expectedPrepare: "rejected", effectiveCancellations: 0, events: 0, notifications: 0 },
  { id: "pending", category: "status", status: "pending" }, { id: "confirmed", category: "status", status: "confirmed" },
  { id: "floating", category: "status", status: "floating", reminder: "none" }, { id: "rejected", category: "status", status: "rejected", reminder: "none" },
  { id: "cancelled", category: "status", status: "cancelled", expectedPrepare: "noop", calendar: "skipped", whatsapp: "skipped", reminder: "none", expectedConfirm: "not_created", effectiveCancellations: 0, events: 0, notifications: 0 },
  { id: "cancelled-agent", category: "status", status: "cancelled_by_agent", expectedPrepare: "noop", calendar: "skipped", whatsapp: "skipped", reminder: "none", expectedConfirm: "not_created", effectiveCancellations: 0, events: 0, notifications: 0 },
  { id: "cancelled-client", category: "status", status: "cancelled_by_client", expectedPrepare: "noop", calendar: "skipped", whatsapp: "skipped", reminder: "none", expectedConfirm: "not_created", effectiveCancellations: 0, events: 0, notifications: 0 },
  { id: "completed", category: "status", status: "completed", expectedPrepare: "rejected", expectedConfirm: "PRECONDITION_FAILED", effectiveCancellations: 0, events: 0, notifications: 0 },
  { id: "no-show", category: "status", status: "no_show", expectedPrepare: "rejected", expectedConfirm: "PRECONDITION_FAILED", effectiveCancellations: 0, events: 0, notifications: 0 },
  { id: "no-agent", category: "status", status: "no_agents_available", expectedPrepare: "rejected", expectedConfirm: "PRECONDITION_FAILED", effectiveCancellations: 0, events: 0, notifications: 0 },
  { id: "calendar-absent", category: "effects", calendar: "skipped" }, { id: "wa-disconnected", category: "effects", whatsapp: "skipped" },
  { id: "wa-template-missing", category: "effects", whatsapp: "skipped" }, { id: "reminder-absent", category: "effects", reminder: "none" },
  { id: "calendar-timeout", category: "effects", calendar: "unknown", expectedConfirm: "committed_effect_unknown" },
  { id: "wa-timeout", category: "effects", whatsapp: "unknown", expectedConfirm: "committed_effect_unknown" },
  { id: "reminder-race", category: "effects", reminder: "fenced" }, { id: "old-create-effect", category: "effects", expectedConfirm: "committed_old_effect_superseded" },
  { id: "same-draft", category: "concurrency", expectedConfirm: "one_commit_one_replay" },
  { id: "different-draft", category: "concurrency", expectedConfirm: "one_commit_one_noop_or_stale" },
  { id: "lost-response", category: "concurrency", expectedConfirm: "receipt_replay" }, { id: "double-click", category: "concurrency", expectedConfirm: "one_commit_one_replay" },
  { id: "stale-datetime", category: "security", expectedConfirm: "STALE_REFERENCE", effectiveCancellations: 0, events: 0, notifications: 0 },
  { id: "stale-status", category: "security", expectedConfirm: "PRECONDITION_FAILED", effectiveCancellations: 0, events: 0, notifications: 0 },
  { id: "tamper", category: "security", expectedConfirm: "invalid_signature", effectiveCancellations: 0, events: 0, notifications: 0 },
  { id: "cross-user", category: "security", expectedConfirm: "permission_denied", effectiveCancellations: 0, events: 0, notifications: 0 },
  { id: "cross-tenant", category: "security", expectedConfirm: "permission_denied", effectiveCancellations: 0, events: 0, notifications: 0 },
  { id: "permission-change", category: "security", expectedConfirm: "permission_denied", effectiveCancellations: 0, events: 0, notifications: 0 },
];

const variants = ["base", "refresh", "replay", "mobile"] as const;
export const visitsCancelVisitV1Corpus: readonly VisitCancelScenario[] = templates.flatMap((template) => variants.map((variant) => ({ ...defaults, ...template, id: `${template.id}-${variant}`, category: template.category })));
export const VISITS_CANCEL_VISIT_V1_CORPUS_SIZE = 160;
