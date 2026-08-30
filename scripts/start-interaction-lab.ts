import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";

if (!process.env.OPENROUTER_API_KEY?.trim()) {
  const platformEnvPath = resolve(
    process.env.HOSTMATE_PLATFORM_ENV_PATH
      ?? "../Plataforma-Real-Estate/v2/.env",
  );
  if (existsSync(platformEnvPath)) {
    const isolatedEnvironment: Record<string, string> = {};
    config({ path: platformEnvPath, processEnv: isolatedEnvironment });
    if (isolatedEnvironment.OPENROUTER_API_KEY) {
      process.env.OPENROUTER_API_KEY = isolatedEnvironment.OPENROUTER_API_KEY;
    }
  }
}

await import("../server/hostmate/shadow/interaction-lab-server.js");
