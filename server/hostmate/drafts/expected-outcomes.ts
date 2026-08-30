import type { NormalizedAgentErrorCode } from "../contracts/domain.js";

export type ExpectedExecutionOutcome = Readonly<{
  status: "needs_input" | "permission_denied" | "failed";
  code: NormalizedAgentErrorCode;
  summary: string;
  message: string;
  retryable: boolean;
}>;

function errorText(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) return `${String((error as { code?: unknown }).code ?? "")} ${error instanceof Error ? error.message : String(error)}`;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Converts only known policy/domain outcomes at the preparation boundary.
 * Unknown exceptions deliberately return undefined and still reach the real
 * error boundary as 500s; this is not a catch-all error suppressor.
 */
export function normalizeExpectedExecutionError(error: unknown): ExpectedExecutionOutcome | undefined {
  const raw = errorText(error);
  const value = raw.toUpperCase();
  if (/PERMISSION_DENIED|POLICY_DENIED|FORBIDDEN|MISSING_PERMISSION|CAPABILITY_DISABLED|CAPABILITY_UNAVAILABLE|TOOL_UNAVAILABLE|SKILL_DISABLED|SKILL_UNAVAILABLE/.test(value)) {
    return { status: "permission_denied", code: "PERMISSION_DENIED", summary: "Esta acción no está disponible para tu perfil o permisos actuales.", message: "Expected policy denial", retryable: false };
  }
  if (/AMBIGUOUS/.test(value)) {
    return { status: "needs_input", code: "AMBIGUOUS", summary: "Necesito una aclaración antes de preparar esta acción.", message: "Expected ambiguous domain input", retryable: false };
  }
  // A stale reference caused by tenant/scope authority is a denial, not an
  // invitation to retry the same potentially foreign reference.
  if (/STALE.*(?:TENANT|SCOPE|AUTH|CROSS)|(?:TENANT|SCOPE).*MISMATCH/.test(value)) {
    return { status: "permission_denied", code: "PERMISSION_DENIED", summary: "Esa referencia ya no está disponible dentro de tu scope actual.", message: "Expected authority denial", retryable: false };
  }
  if (/MISSING_REQUIRED|MISSING_VISIT|MANUAL_TARGET|MULTIPLE_VISITS|MIXED_ACTION|INVALID_INPUT|INVALID_CANDIDATE|UNSUPPORTED|GROUP_VISIT|CHANGE_PROPERTY|CHANGE_AGENT/.test(value)) {
    return { status: "needs_input", code: "MISSING_REQUIRED_FIELD", summary: "Necesito una referencia o una opción compatible antes de preparar esta acción.", message: "Expected unsupported or incomplete domain input", retryable: false };
  }
  if (/STALE|RELATIONSHIP|OPPORTUNITY|STATUS_CHANGED|ENTITY_CHANGED/.test(value)) {
    return { status: "needs_input", code: "STALE_REFERENCE", summary: "La información de la acción ha cambiado; vuelve a seleccionar la entidad y prepara de nuevo.", message: "Expected stale domain precondition", retryable: false };
  }
  if (/HARD_CONSTRAINT|SLOT_CONFLICT|SCHEDULE_CONFLICT|CAPACITY|\bCONFLICT\b/.test(value)) {
    return { status: "needs_input", code: "CONFLICT", summary: "El horario o los recursos solicitados ya no están disponibles.", message: "Expected domain constraint conflict", retryable: false };
  }
  if (/TEMPORAL|PAST_START|INVALID_DATETIME|DATETIME_MISMATCH|PRECONDITION_FAILED/.test(value)) {
    return { status: "needs_input", code: "PRECONDITION_FAILED", summary: "La fecha u otra condición de la acción ya no es válida.", message: "Expected domain precondition failure", retryable: false };
  }
  if (/\bNOT_FOUND\b/.test(value)) {
    return { status: "needs_input", code: "NOT_FOUND", summary: "No encuentro la entidad o recurso necesario para preparar esta acción.", message: "Expected domain not-found outcome", retryable: false };
  }
  if (/RATE_LIMITED|PROVIDER_UNAVAILABLE|NETWORK|TIMEOUT|BUDGET_EXCEEDED|CANCELLED/.test(value)) {
    const code: NormalizedAgentErrorCode = /TIMEOUT/.test(value) ? "TIMEOUT" : /NETWORK/.test(value) ? "NETWORK" : /PROVIDER_UNAVAILABLE/.test(value) ? "PROVIDER_UNAVAILABLE" : /RATE_LIMITED/.test(value) ? "RATE_LIMITED" : /BUDGET_EXCEEDED/.test(value) ? "BUDGET_EXCEEDED" : "CANCELLED";
    return { status: "failed", code, summary: "No se pudo preparar la acción por un problema temporal. Inténtalo de nuevo.", message: "Expected transient execution failure", retryable: true };
  }
  return undefined;
}
