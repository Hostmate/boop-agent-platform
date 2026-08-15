export type ExecutionProfileId =
  | "crm"
  | "demand-matching"
  | "property"
  | "visits"
  | "communications"
  | "marketing"
  | "insights"
  | "workspace-admin";

export type RiskLevel = "R0" | "R1" | "R2" | "R3";
export type ToolMode = "read" | "write" | "draft" | "external";

export type EntityRef = Readonly<{
  type: string;
  id: string;
  label?: string;
  deepLink?: string;
}>;

export type NormalizedAgentErrorCode =
  | "INVALID_TOOL_CALL"
  | "AMBIGUOUS"
  | "MISSING_REQUIRED_FIELD"
  | "NOT_FOUND"
  | "PERMISSION_DENIED"
  | "POLICY_DENIED"
  | "PRECONDITION_FAILED"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "BUDGET_EXCEEDED"
  | "TIMEOUT"
  | "CANCELLED"
  | "SIDE_EFFECT_UNKNOWN"
  | "INTERNAL";

export type AgentError = Readonly<{
  code: NormalizedAgentErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}>;
