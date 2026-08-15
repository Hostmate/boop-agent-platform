export type AgentEventVisibility = "user" | "tenant_admin" | "platform_admin";

export type AgentEventInput = Readonly<{
  eventId: string;
  conversationId?: string;
  interactionRunId?: string;
  executionRunId?: string;
  attemptId?: string;
  sequence: number;
  type: string;
  visibility: AgentEventVisibility;
  payload: unknown;
  occurredAt: number;
}>;

export type AgentEvent = Readonly<{
  eventId: string;
  tenantId: string;
  actorUserId: string;
  conversationId?: string;
  interactionRunId?: string;
  executionRunId?: string;
  attemptId?: string;
  sequence: number;
  type: string;
  visibility: AgentEventVisibility;
  payloadRedacted: unknown;
  occurredAt: number;
}>;

const SECRET_KEY = /(authorization|api[-_]?key|password|secret|token|cookie|private[-_]?key)/i;
const PII_KEY = /(phone|email|raw[_-]?html)/i;

export function redactEventPayload(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactEventPayload(item, depth + 1));
  if (!value || typeof value !== "object") {
    return typeof value === "string" && value.length > 4_000 ? `${value.slice(0, 4_000)}…` : value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      SECRET_KEY.test(key) ? "[redacted]" : PII_KEY.test(key) ? "[masked]" : redactEventPayload(child, depth + 1),
    ]),
  );
}
