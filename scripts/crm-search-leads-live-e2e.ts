import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { config as loadEnv } from "dotenv";
import { createActorContext } from "../server/hostmate/contracts/actor-context.js";
import { ConvexControlPlaneRepository } from "../server/hostmate/control-plane/convex-control-plane-repository.js";
import { AuthenticatedConvexHttpClient } from "../server/hostmate/control-plane/convex-http-client.js";
import type { CrmSearchLeadsInput, LeadSearchPort } from "../server/hostmate/product-tools/crm/search-leads.js";
import { OpenRouterAdapter } from "../server/hostmate/runtime/openrouter-adapter.js";
import { CrmSearchLeadsVerticalSlice } from "../server/hostmate/vertical-slices/crm-search-leads.js";

loadEnv({ path: ".env.local" });

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the live E2E`);
  return value;
}

function encode(value: unknown) { return Buffer.from(JSON.stringify(value)).toString("base64url"); }

async function main() {
  const startedAt = Date.now();
  const convexUrl = process.env.CONVEX_URL?.trim() || required("VITE_CONVEX_URL");
  const tenantId = Number(process.env.E2E_TENANT_ID ?? 9);
  const userId = Number(process.env.E2E_USER_ID ?? 12);
  const model = required("AGENT_PLATFORM_CRM_MODEL");
  const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = `e2e-${Date.now()}`;
  const jwk = keyPair.publicKey.export({ format: "jwk" });
  const jwks = JSON.stringify({ keys: [{ ...jwk, kid, use: "sig", alg: "RS256" }] });
  const server = createServer((request, response) => {
    if (request.url === "/.well-known/jwks.json") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); response.end(jwks); return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not bind E2E JWKS server");
  const issuer = `http://127.0.0.1:${address.port}`;
  const audience = "hostmate-agent-platform-e2e";
  let convexProcess: ChildProcess | undefined;

  try {
    for (const [name, value] of [
      ["HOSTMATE_CONVEX_JWT_ISSUER", issuer],
      ["HOSTMATE_CONVEX_JWT_AUDIENCE", audience],
      ["HOSTMATE_CONVEX_JWKS_URL", `${issuer}/.well-known/jwks.json`],
    ]) execFileSync("npx", ["convex", "env", "set", name, value], { stdio: "ignore" });
    convexProcess = spawn("npx", ["convex", "dev"], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out starting local Convex")), 30_000);
      const inspect = (chunk: Buffer) => {
        if (/Convex functions ready/i.test(chunk.toString())) { clearTimeout(timer); resolve(); }
      };
      convexProcess!.stdout?.on("data", inspect);
      convexProcess!.stderr?.on("data", inspect);
      convexProcess!.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Convex exited before E2E (${code})`)); });
    });

    const nowSeconds = Math.floor(Date.now() / 1000);
    const header = encode({ alg: "RS256", typ: "JWT", kid });
    const payload = encode({
      iss: issuer, aud: audience, sub: String(userId), iat: nowSeconds, exp: nowSeconds + 300,
      tenant_id: String(tenantId), user_id: String(userId), role: "admin", permissions: ["crm.read"],
      locale: "es-ES", timezone: "Europe/Madrid", session_id: `e2e-${randomUUID()}`,
      permissions_version: "e2e-v1", effective_tenant_override: false,
    });
    const unsigned = `${header}.${payload}`;
    const signer = createSign("RSA-SHA256"); signer.update(unsigned); signer.end();
    const token = `${unsigned}.${signer.sign(keyPair.privateKey).toString("base64url")}`;

    const leadServicePath = "../../Plataforma-Real-Estate-boop-spike/v2/apps/api/src/services/lead.service.ts";
    const leadService = await import(leadServicePath) as { list: (tenantId: number, filters: any, isSuperAdmin?: boolean, userId?: number) => Promise<any> };
    const seed = await leadService.list(tenantId, { page: 1, limit: 10 }, false, userId);
    const target = seed.items.find((lead: any) => typeof lead.client_phone === "string" && lead.client_phone.replace(/\D/g, "").length >= 7)
      ?? seed.items.find((lead: any) => typeof lead.client_email === "string" && lead.client_email.includes("@"))
      ?? seed.items.find((lead: any) => typeof lead.client_name === "string" && lead.client_name.trim().length >= 2) as any;
    if (!target) throw new Error(`Tenant ${tenantId} has no searchable local/real lead for E2E`);

    let executedInput: CrmSearchLeadsInput | undefined;
    const directPort: LeadSearchPort = {
      search: async (actor, input: CrmSearchLeadsInput) => {
        executedInput = input;
        if (actor.tenantId !== String(tenantId)) throw new Error("E2E_ACTOR_TENANT_MISMATCH");
        const serviceStarted = performance.now();
        const result = await leadService.list(tenantId, { page: input.page, limit: input.limit, search: input.query, prop_city: input.city, status: input.status }, false, userId);
        return { ...result, telemetry: { service: "lead.service.list", latencyMs: Math.round((performance.now() - serviceStarted) * 100) / 100 } };
      },
    };

    const client = new AuthenticatedConvexHttpClient(convexUrl, token);
    const trusted = await client.currentActor();
    const actor = createActorContext({ ...trusted, isSuperAdmin: false });
    const repository = new ConvexControlPlaneRepository(client);
    const slice = new CrmSearchLeadsVerticalSlice(
      repository, directPort,
      new OpenRouterAdapter({ apiKey: required("OPENROUTER_API_KEY"), appName: "Hostmate CRM Search Leads E2E" }),
      { model, timeoutMs: 45_000, maxCostUsd: 0.05 },
    );
    const conversationId = randomUUID();
    const searchMessage = target.client_phone
      ? `Busca el lead con teléfono ${String(target.client_phone).trim()}`
      : target.client_email ? `Busca el lead con email ${String(target.client_email).trim()}` : `Busca a ${String(target.client_name).trim()}`;
    const turn = await slice.execute(actor, { conversationId, message: searchMessage });

    // A fresh authenticated client simulates frontend refresh/reconnect.
    const reconnected = new AuthenticatedConvexHttpClient(convexUrl, token);
    const reconnectedRepository = new ConvexControlPlaneRepository(reconnected);
    const [runs, messages, events, usage] = await Promise.all([
      reconnectedRepository.listRuns(actor, { limit: 100, ownOnly: true }),
      reconnectedRepository.listMessages(actor, { conversationId, limit: 200 }),
      reconnectedRepository.listEvents(actor, { executionRunId: turn.executionRunId, limit: 500 }),
      reconnectedRepository.listUsage(actor, { runId: turn.executionRunId, limit: 50 }),
    ]);
    const interaction = runs.find((run) => run.runId === turn.interactionRunId)!;
    const execution = runs.find((run) => run.runId === turn.executionRunId)!;
    process.stdout.write(`${JSON.stringify({
      verdict: turn.result.status === "failed" || turn.result.status === "permission_denied" || (turn.result.data?.matches.length ?? 0) < 1 ? "FAIL" : "PASS",
      resultStatus: turn.result.status, resultCount: turn.result.data?.matches.length ?? 0,
      errorCode: turn.result.errors[0]?.code, errorMessage: turn.result.errors[0]?.message,
      errorDetails: turn.result.errors[0]?.details,
      interactionLatencyMs: interaction.completedAt! - interaction.createdAt,
      executionLatencyMs: execution.completedAt! - execution.createdAt,
      openRouterLatencyMs: turn.runtime?.latencyMs,
      leadServiceLatencyMs: turn.result.data?.telemetry?.latencyMs,
      llmCalls: 1, convexEventCount: events.length, durableMessageCountAfterReconnect: messages.length,
      requestedModel: usage[0]?.requestedModel, resolvedModel: usage[0]?.resolvedModel, provider: usage[0]?.provider,
      inputTokens: usage[0]?.inputTokens, outputTokens: usage[0]?.outputTokens, costUsd: usage[0]?.costUsd,
      finishReason: usage[0]?.finishReason, totalE2eLatencyMs: Date.now() - startedAt,
      crmWrites: 0, toolScope: execution.toolScope,
      toolCriteria: executedInput ? {
        hasQuery: Boolean(executedInput.query), hasCity: Boolean(executedInput.city), status: executedInput.status,
        queryMatchesSourceExactly: executedInput.query === String(target.client_phone ?? target.client_email ?? target.client_name).trim(),
        page: executedInput.page, limit: executedInput.limit,
      } : undefined,
    }, null, 2)}\n`);
  } finally {
    if (convexProcess?.pid) {
      try { process.kill(-convexProcess.pid, "SIGTERM"); } catch { convexProcess.kill("SIGTERM"); }
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

await main();
