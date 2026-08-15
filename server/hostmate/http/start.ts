import "dotenv/config";
import { createAgentPlatformRuntimeApp } from "./runtime-app.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const port = Number(process.env.AGENT_PLATFORM_RUNTIME_PORT ?? 4310);
const shutdownTimeoutMs = Number(process.env.AGENT_PLATFORM_SHUTDOWN_TIMEOUT_MS ?? 55_000);
let ready = true;
const app = createAgentPlatformRuntimeApp({
  convexUrl: process.env.CONVEX_URL?.trim() || required("VITE_CONVEX_URL"),
  hostmateApiBaseUrl: required("HOSTMATE_API_BASE_URL"),
  openRouterApiKey: required("OPENROUTER_API_KEY"),
  model: required("AGENT_PLATFORM_CRM_MODEL"),
  fallbackModels: process.env.AGENT_PLATFORM_CRM_FALLBACK_MODELS?.split(",").map((value) => value.trim()).filter(Boolean),
  maxConcurrentTurns: Number(process.env.AGENT_PLATFORM_MAX_CONCURRENT_TURNS ?? 8),
  isReady: () => ready,
});
const server = app.listen(port, "0.0.0.0", () => process.stdout.write(`Hostmate Agent Platform runtime listening on ${port}\n`));

function shutdown(signal: NodeJS.Signals): void {
  if (!ready) return;
  ready = false;
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
