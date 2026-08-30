/**
 * Only a genuinely absent conversation is treated as the browser's
 * pre-allocation state. Authorization, tenancy and infrastructure errors must
 * remain visible to the caller instead of being retried as createConversation.
 */
export function isMissingConversationError(error: unknown): boolean {
  const value = error && typeof error === "object" && "data" in error
    ? `${String((error as { data?: unknown }).data ?? "")} ${error instanceof Error ? error.message : ""}`
    : error instanceof Error ? error.message : String(error);
  return /CONVERSATION_NOT_FOUND|CONVERSATION_MISSING|^missing$/i.test(value.trim());
}
