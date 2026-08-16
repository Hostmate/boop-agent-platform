import { createAgentPlatformRuntimeApp } from "./runtime-app.js";
import type { OpenRouterReasoningEffort } from "../runtime/openrouter-adapter.js";
import { readFileSync } from "node:fs";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalReasoningEffort(name: string): OpenRouterReasoningEffort | undefined {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  const allowed: readonly string[] = ["max", "xhigh", "high", "medium", "low", "minimal", "none"];
  if (!allowed.includes(value)) throw new Error(`${name} must be one of ${allowed.join(", ")}`);
  return value as OpenRouterReasoningEffort;
}

function idList(name: string): string[] {
  return (process.env[name] ?? "").split(",").map((value) => value.trim()).filter((value) => /^[1-9]\d*$/.test(value));
}

function memoryConfig(): NonNullable<Parameters<typeof createAgentPlatformRuntimeApp>[0]["memory"]> {
  const enabled = process.env.AGENT_PLATFORM_MEMORY_ENABLED === "true";
  if (!enabled) return { enabled: false, allowedTenantIds: [], allowedUserIds: [], automaticExtractionEnabled: false, tenantScopeEnabled: false, consolidationEnabled: false };
  const allowedTenantIds = idList("AGENT_PLATFORM_MEMORY_ALLOWED_TENANT_IDS");
  const allowedUserIds = idList("AGENT_PLATFORM_MEMORY_ALLOWED_USER_IDS");
  if (!allowedTenantIds.length || !allowedUserIds.length) throw new Error("Memory canary requires explicit tenant and user allowlists");
  const automaticExtractionEnabled = process.env.AGENT_PLATFORM_MEMORY_AUTOMATIC_EXTRACTION_ENABLED === "true";
  const tenantScopeEnabled = process.env.AGENT_PLATFORM_MEMORY_TENANT_SCOPE_ENABLED === "true";
  const consolidationEnabled = process.env.AGENT_PLATFORM_MEMORY_CONSOLIDATION_ENABLED === "true";
  if (automaticExtractionEnabled || tenantScopeEnabled || consolidationEnabled) {
    throw new Error("Memory V1 requires automatic extraction, tenant scope and consolidation to remain disabled");
  }
  return { enabled, allowedTenantIds, allowedUserIds, automaticExtractionEnabled, tenantScopeEnabled, consolidationEnabled };
}

function skillsConfig(): NonNullable<Parameters<typeof createAgentPlatformRuntimeApp>[0]["skills"]> {
  const prepareVisitBriefEnabled = process.env.AGENT_PLATFORM_SKILLS_PREPARE_VISIT_BRIEF_ENABLED === "true";
  const prepareLeadBriefEnabled = process.env.AGENT_PLATFORM_SKILLS_PREPARE_LEAD_BRIEF_ENABLED === "true";
  const enabledSkillIds = [
    ...(prepareVisitBriefEnabled ? ["prepare-visit-brief" as const] : []),
    ...(prepareLeadBriefEnabled ? ["prepare-lead-brief" as const] : []),
  ];
  if (!prepareVisitBriefEnabled && !prepareLeadBriefEnabled) {
    return { enabledSkillIds, allowedTenantIds: [], allowedUserIds: [] };
  }
  const allowedTenantIds = idList("AGENT_PLATFORM_SKILLS_ALLOWED_TENANT_IDS");
  const allowedUserIds = idList("AGENT_PLATFORM_SKILLS_ALLOWED_USER_IDS");
  if (!allowedTenantIds.length || !allowedUserIds.length) throw new Error("Skills canary requires explicit tenant and user allowlists");
  return { enabledSkillIds, allowedTenantIds, allowedUserIds };
}

function multiAgentConfig(): NonNullable<Parameters<typeof createAgentPlatformRuntimeApp>[0]["multiAgent"]> {
  const enabled = process.env.AGENT_PLATFORM_MULTI_AGENT_ENABLED === "true";
  if (!enabled) return { enabled: false, allowedTenantIds: [], allowedUserIds: [] };
  const allowedTenantIds = idList("AGENT_PLATFORM_MULTI_AGENT_ALLOWED_TENANT_IDS");
  const allowedUserIds = idList("AGENT_PLATFORM_MULTI_AGENT_ALLOWED_USER_IDS");
  if (!allowedTenantIds.length || !allowedUserIds.length) throw new Error("Multi-agent canary requires explicit tenant and user allowlists");
  return { enabled, allowedTenantIds, allowedUserIds };
}

function safeWritesConfig(): NonNullable<Parameters<typeof createAgentPlatformRuntimeApp>[0]["safeWrites"]> {
  const enabled = process.env.AGENT_PLATFORM_SAFE_WRITES_ENABLED === "true";
  if (!enabled) return { enabled: false, allowedTenantIds: [], allowedUserIds: [], signingSecret: "disabled-disabled-disabled-disabled" };
  const allowedTenantIds = idList("AGENT_PLATFORM_SAFE_WRITES_ALLOWED_TENANT_IDS");
  const allowedUserIds = idList("AGENT_PLATFORM_SAFE_WRITES_ALLOWED_USER_IDS");
  const signingSecret = process.env.AGENT_PLATFORM_WRITE_DRAFT_HMAC_SECRET?.trim()
    || (process.env.AGENT_PLATFORM_WRITE_DRAFT_HMAC_SECRET_PATH ? readFileSync(process.env.AGENT_PLATFORM_WRITE_DRAFT_HMAC_SECRET_PATH, "utf8").trim() : "");
  if (!allowedTenantIds.length || !allowedUserIds.length) throw new Error("Safe writes canary requires explicit tenant and user allowlists");
  if (signingSecret.length < 32) throw new Error("Agent Platform write draft HMAC secret must contain at least 32 characters");
  return { enabled, allowedTenantIds, allowedUserIds, signingSecret, ttlMs: 10 * 60_000 };
}

const port = Number(process.env.AGENT_PLATFORM_RUNTIME_PORT ?? 4310);
const shutdownTimeoutMs = Number(process.env.AGENT_PLATFORM_SHUTDOWN_TIMEOUT_MS ?? 55_000);
const convexUrl = process.env.CONVEX_URL?.trim() || required("VITE_CONVEX_URL");
const hostmateApiBaseUrl = required("HOSTMATE_API_BASE_URL");
const jwksUrl = required('AGENT_PLATFORM_JWKS_URL');
let accepting = true;
let dependenciesReady = false;
async function probeDependencies(): Promise<void> {
  try {
    const [jwks, convex, hostmate] = await Promise.all([
      fetch(jwksUrl, { signal: AbortSignal.timeout(5_000) }),
      fetch(convexUrl, { method: 'HEAD', signal: AbortSignal.timeout(5_000) }),
      fetch(`${hostmateApiBaseUrl.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(5_000) }),
    ]);
    dependenciesReady = jwks.ok && convex.status < 500 && hostmate.status < 500;
  } catch {
    dependenciesReady = false;
  }
}
await probeDependencies();
const probeTimer = setInterval(() => void probeDependencies(), 5_000);
probeTimer.unref();
const app = createAgentPlatformRuntimeApp({
  convexUrl,
  hostmateApiBaseUrl,
  openRouterApiKey: required("OPENROUTER_API_KEY"),
  model: required("AGENT_PLATFORM_CRM_MODEL"),
  reasoningEffort: optionalReasoningEffort("AGENT_PLATFORM_REASONING_EFFORT"),
  memory: memoryConfig(),
  skills: skillsConfig(),
  multiAgent: multiAgentConfig(),
  safeWrites: safeWritesConfig(),
  fallbackModels: process.env.AGENT_PLATFORM_CRM_FALLBACK_MODELS?.split(",").map((value) => value.trim()).filter(Boolean),
  maxConcurrentTurns: Number(process.env.AGENT_PLATFORM_MAX_CONCURRENT_TURNS ?? 8),
  issuer: required('AGENT_PLATFORM_JWT_ISSUER'),
  audience: required('AGENT_PLATFORM_JWT_AUDIENCE'),
  jwksUrl,
  isReady: () => accepting && dependenciesReady,
});
const server = app.listen(port, "0.0.0.0", () => process.stdout.write(`Hostmate Agent Platform runtime listening on ${port}\n`));

function shutdown(signal: NodeJS.Signals): void {
  if (!accepting) return;
  accepting = false;
  clearInterval(probeTimer);
  process.stdout.write(`${JSON.stringify({ component: "agent-platform-runtime", event: "shutdown_started", signal })}\n`);
  const timeout = setTimeout(() => {
    server.closeAllConnections();
    process.stderr.write(`${JSON.stringify({ component: "agent-platform-runtime", event: "shutdown_timeout" })}\n`);
    process.exitCode = 1;
  }, Math.max(1_000, shutdownTimeoutMs));
  timeout.unref();
  server.close((error) => {
    clearTimeout(timeout);
    if (error) {
      process.stderr.write(`${JSON.stringify({ component: "agent-platform-runtime", event: "shutdown_failed", kind: error.name })}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${JSON.stringify({ component: "agent-platform-runtime", event: "shutdown_complete" })}\n`);
  });
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
