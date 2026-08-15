import { createSign, generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { config as loadEnv } from "dotenv";
import { createActorContext, type ActorContext } from "../server/hostmate/contracts/actor-context.js";
import { ConvexControlPlaneRepository } from "../server/hostmate/control-plane/convex-control-plane-repository.js";
import { AuthenticatedConvexHttpClient } from "../server/hostmate/control-plane/convex-http-client.js";
import type { LeadContextPort } from "../server/hostmate/product-tools/crm/get-lead-context.js";
import type { CrmSearchLeadsInput, LeadSearchPort } from "../server/hostmate/product-tools/crm/search-leads.js";
import type { LeadVisitsPort } from "../server/hostmate/product-tools/visits/list-lead-visits.js";
import type { VisitDetailPort } from "../server/hostmate/product-tools/visits/get-visit.js";
import { OpenRouterAdapter } from "../server/hostmate/runtime/openrouter-adapter.js";
import { CrmSearchLeadsVerticalSlice } from "../server/hostmate/vertical-slices/crm-search-leads.js";

loadEnv({ path: ".env.local" });
const hostmateRepo = resolve(process.env.HOSTMATE_REPO_PATH?.trim() || "../Plataforma-Real-Estate-agent-platform-integration");
loadEnv({ path: resolve(process.env.HOSTMATE_ENV_PATH?.trim() || resolve(hostmateRepo, "v2/.env")) });

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the live E2E`);
  return value;
}

function encode(value: unknown) { return Buffer.from(JSON.stringify(value)).toString("base64url"); }

function signActorToken(input: {
  privateKey: KeyObject; kid: string; issuer: string; audience: string; tenantId: number; userId: number; role: "agent" | "admin";
}) {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: "RS256", typ: "JWT", kid: input.kid })}.${encode({
    iss: input.issuer, aud: input.audience, sub: String(input.userId), iat: now, exp: now + 300,
    tenant_id: String(input.tenantId), user_id: String(input.userId), role: input.role,
    permissions: ["crm.read", "visits.read"], locale: "es-ES", timezone: "Europe/Madrid",
    session_id: `e2e-${input.role}-${randomUUID()}`, permissions_version: "e2e-v1", effective_tenant_override: false,
  })}`;
  const signer = createSign("RSA-SHA256"); signer.update(unsigned); signer.end();
  return `${unsigned}.${signer.sign(input.privateKey).toString("base64url")}`;
}

type HostmateActor = { tenantId: number; userId: number; role: "agent" | "admin" | "superadmin" };

async function importHostmate<T>(path: string): Promise<T> {
  return await import(pathToFileURL(resolve(hostmateRepo, "v2/apps/api/src/services", path)).href) as T;
}

async function main() {
  const startedAt = Date.now();
  const convexUrl = process.env.CONVEX_URL?.trim() || required("VITE_CONVEX_URL");
  const tenantId = Number(process.env.E2E_TENANT_ID ?? 13);
  const userId = Number(process.env.E2E_USER_ID ?? 35);
  const model = required("AGENT_PLATFORM_CRM_MODEL");
  const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = `test-only-e2e-${Date.now()}`;
  const jwk = keyPair.publicKey.export({ format: "jwk" });
  const jwks = JSON.stringify({ keys: [{ ...jwk, kid, use: "sig", alg: "RS256" }] });
  const server = createServer((request, response) => {
    if (request.url === "/.well-known/jwks.json") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); response.end(jwks); return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not bind test-only E2E JWKS server");
  const issuer = `http://127.0.0.1:${address.port}`;
  const audience = "hostmate-agent-platform-e2e";
  let convexProcess: ChildProcess | undefined;
  const previousConvexEnv = new Map<string, string | undefined>();

  try {
    for (const [name, value] of [
      ["HOSTMATE_CONVEX_JWT_ISSUER", issuer], ["HOSTMATE_CONVEX_JWT_AUDIENCE", audience],
      ["HOSTMATE_CONVEX_JWKS_URL", `${issuer}/.well-known/jwks.json`],
    ]) {
      try {
        previousConvexEnv.set(name, execFileSync("npx", ["convex", "env", "get", name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
      } catch { previousConvexEnv.set(name, undefined); }
      execFileSync("npx", ["convex", "env", "set", name, value], { stdio: "ignore" });
    }
    convexProcess = spawn("npx", ["convex", "dev"], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out starting local Convex")), 30_000);
      const inspect = (chunk: Buffer) => {
        if (/Convex functions ready/i.test(chunk.toString())) { clearTimeout(timer); done(); }
      };
      convexProcess!.stdout?.on("data", inspect); convexProcess!.stderr?.on("data", inspect);
      convexProcess!.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Convex exited before E2E (${code})`)); });
    });

    const leadService = await importHostmate<{ list: (tenantId: number, filters: any, isSuperAdmin?: boolean, userId?: number) => Promise<any> }>("lead.service.ts");
    const contextService = await importHostmate<{ getLeadContext: (actor: HostmateActor, leadId: number) => Promise<any> }>("agent-platform-lead-context.service.ts");
    const visitsService = await importHostmate<{ listLeadVisits: (actor: HostmateActor, leadId: number, filters: any) => Promise<any> }>("agent-platform-lead-visits.service.ts");
    const detailService = await importHostmate<{ getVisitDetail: (actor: HostmateActor, visit: { id: number; kind: "individual" | "group" }) => Promise<any> }>("agent-platform-visit-detail.service.ts");

    const seed = await leadService.list(tenantId, { page: 1, limit: 50, assigned_agent_id: userId }, false, userId);
    let target: any;
    let targetQuery = "";
    for (const lead of seed.items as any[]) {
      for (const candidate of [lead.client_phone, lead.client_email, lead.client_name].filter((value): value is string => typeof value === "string" && value.trim().length >= 2)) {
        const probe = await leadService.list(tenantId, { page: 1, limit: 2, search: candidate.trim(), assigned_agent_id: userId }, false, userId);
        if (probe.total !== 1) continue;
        const visits = await visitsService.listLeadVisits({ tenantId, userId, role: "agent" }, Number(lead.id), { scope: "all" });
        if (visits.metadata.total > 0) { target = lead; targetQuery = candidate.trim(); break; }
      }
      if (target) break;
    }
    if (!target) throw new Error(`Tenant ${tenantId} has no unique assigned lead with a visit for user ${userId}`);

    const results = [];
    for (const role of ["agent", "admin"] as const) {
      const token = signActorToken({ privateKey: keyPair.privateKey, kid, issuer, audience, tenantId, userId, role });
      const makeRepository = () => new ConvexControlPlaneRepository(new AuthenticatedConvexHttpClient(convexUrl, token));
      const trusted = await new AuthenticatedConvexHttpClient(convexUrl, token).currentActor();
      const actor = createActorContext({ ...trusted, isSuperAdmin: false });
      let searchCalls = 0;
      const searchPort: LeadSearchPort = { search: async (seenActor, input: CrmSearchLeadsInput) => {
        searchCalls += 1;
        const result = await leadService.list(tenantId, {
          page: input.page, limit: input.limit, search: input.query, prop_city: input.city, status: input.status,
          assigned_agent_id: seenActor.role === "agent" ? Number(seenActor.userId) : undefined,
        }, false, Number(seenActor.userId));
        return result;
      } };
      const contextPort: LeadContextPort = { getContext: async (seenActor, input) => {
        const started = performance.now();
        const result = await contextService.getLeadContext({ tenantId: Number(seenActor.tenantId), userId: Number(seenActor.userId), role: seenActor.role }, Number(input.lead.id));
        return { ...result, telemetry: { ...result.telemetry, latencyMs: Math.round((performance.now() - started) * 100) / 100 } };
      } };
      const visitsPort: LeadVisitsPort = { listLeadVisits: async (seenActor, input) => {
        const started = performance.now();
        const result = await visitsService.listLeadVisits({ tenantId: Number(seenActor.tenantId), userId: Number(seenActor.userId), role: seenActor.role }, Number(input.lead.id), { scope: input.scope, status: input.status });
        return { ...result, telemetry: { ...result.telemetry, latencyMs: Math.round((performance.now() - started) * 100) / 100 } };
      } };
      const detailPort: VisitDetailPort = { getVisit: async (seenActor, input) => {
        const started = performance.now();
        const result = await detailService.getVisitDetail({ tenantId: Number(seenActor.tenantId), userId: Number(seenActor.userId), role: seenActor.role }, { id: Number(input.visit.id), kind: input.visit.type === "visits.group_visit" ? "group" : "individual" });
        return { ...result, telemetry: { ...result.telemetry, latencyMs: Math.round((performance.now() - started) * 100) / 100 } };
      } };
      const makeSlice = (repository: ConvexControlPlaneRepository) => new CrmSearchLeadsVerticalSlice(
        repository, searchPort, contextPort, visitsPort, detailPort,
        new OpenRouterAdapter({ apiKey: required("OPENROUTER_API_KEY"), appName: `Hostmate four-capability ${role} E2E` }),
        { model, timeoutMs: 45_000, maxCostUsd: 0.05 },
      );
      const conversationId = randomUUID();
      const steps: Array<{ name: string; turn: Awaited<ReturnType<CrmSearchLeadsVerticalSlice["execute"]>>; usage: number; scope: readonly string[] }> = [];

      const executeFresh = async (name: string, message: string, selectedEntityRef?: { type: string; id: string; label?: string; deepLink?: string }) => {
        const repository = makeRepository();
        const turn = await makeSlice(repository).execute(actor as ActorContext, { conversationId, message, selectedEntityRef });
        if (!turn.executionRunId) throw new Error(`${role}/${name} did not create an Execution Run`);
        const [run, usage] = await Promise.all([
          repository.getRun(actor, turn.executionRunId), repository.listUsage(actor, { runId: turn.executionRunId, limit: 50 }),
        ]);
        if (!run) throw new Error(`${role}/${name} run was not durable after reconnect`);
        steps.push({ name, turn, usage: usage.length, scope: run.toolScope });
        return turn;
      };

      const search = await executeFresh("search", `Busca el lead ${targetQuery}`);
      const context = await executeFresh("context", "¿Qué sabemos de él?");
      const visits = await executeFresh("visits", "¿Qué visitas tiene?");
      const selectedVisit = visits.result.data?.visits?.visits[0];
      if (!selectedVisit) throw new Error(`${role}/visits returned no selectable real visit: ${JSON.stringify({ status: visits.result.status, errors: visits.result.errors, data: visits.result.data })}`);
      const detail = await executeFresh("detail", "Cuéntame más", selectedVisit.ref);
      const finalRepository = makeRepository();
      const messages = await finalRepository.listMessages(actor, { conversationId, limit: 200 });
      const finalMessage = [...messages].reverse().find((message) => message.role === "assistant");
      const expectedScopes = [
        ["crm.search_leads.v1@1"], ["crm.get_lead_context.v1@1"],
        ["visits.list_lead_visits.v1@1"], ["visits.get_visit.v1@1"],
      ];
      const pass = steps.every((step, index) => JSON.stringify(step.scope) === JSON.stringify(expectedScopes[index]))
        && JSON.stringify(steps.map((step) => step.usage)) === JSON.stringify([1, 0, 0, 0])
        && search.result.data?.search?.matches[0]?.ref.id === String(target.id)
        && context.result.data?.context?.lead.ref.id === String(target.id)
        && visits.result.data?.visits?.lead.ref.id === String(target.id)
        && detail.result.data?.visitDetail?.ref.id === selectedVisit.ref.id
        && finalMessage?.contextRefs?.selected.lead?.id === String(target.id)
        && finalMessage?.contextRefs?.selected.visit?.id === selectedVisit.ref.id
        && searchCalls === 1;
      results.push({ role, verdict: pass ? "PASS" : "FAIL", targetLeadId: String(target.id), selectedVisit: selectedVisit.ref, searchCalls, durableMessages: messages.length, steps: steps.map(({ name, usage, scope, turn }) => ({ name, status: turn.result.status, inferenceCount: usage, toolScope: scope })) });
    }

    const verdict = results.every((result) => result.verdict === "PASS") ? "PASS" : "FAIL";
    process.stdout.write(`${JSON.stringify({ verdict, harness: "TEST-ONLY ephemeral JWKS", hostmateRepo, results, mysqlBusinessWrites: 0, totalE2eLatencyMs: Date.now() - startedAt }, null, 2)}\n`);
    if (verdict !== "PASS") process.exitCode = 1;
  } finally {
    if (convexProcess?.pid) {
      try { process.kill(-convexProcess.pid, "SIGTERM"); } catch { convexProcess.kill("SIGTERM"); }
    }
    for (const [name, value] of previousConvexEnv) {
      try {
        execFileSync("npx", ["convex", "env", value ? "set" : "remove", name, ...(value ? [value] : [])], { stdio: "ignore" });
      } catch {
        process.stderr.write(`${JSON.stringify({ component: "agent-platform-e2e", event: "convex_env_restore_failed", name })}\n`);
      }
    }
    await new Promise<void>((done) => server.close(() => done()));
  }
}

await main();
