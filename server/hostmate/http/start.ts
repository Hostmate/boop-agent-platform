import "dotenv/config";
import { createAgentPlatformRuntimeApp } from "./runtime-app.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const port = Number(process.env.AGENT_PLATFORM_RUNTIME_PORT ?? 4310);
const app = createAgentPlatformRuntimeApp({
  convexUrl: process.env.CONVEX_URL?.trim() || required("VITE_CONVEX_URL"),
  hostmateApiBaseUrl: required("HOSTMATE_API_BASE_URL"),
  openRouterApiKey: required("OPENROUTER_API_KEY"),
  model: required("AGENT_PLATFORM_CRM_MODEL"),
  fallbackModels: process.env.AGENT_PLATFORM_CRM_FALLBACK_MODELS?.split(",").map((value) => value.trim()).filter(Boolean),
});
app.listen(port, "0.0.0.0", () => process.stdout.write(`Hostmate Agent Platform runtime listening on ${port}\n`));
