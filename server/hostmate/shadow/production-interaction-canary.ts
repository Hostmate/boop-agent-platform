import "../../env-setup.js";
import express from "express";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isInteractionCanaryAuthorized } from "./interaction-canary-auth.js";
import { createInteractionLabRouter } from "./interaction-lab-route.js";
import { InteractionLabHostmateConnection } from "./interaction-lab-hostmate.js";

function required(name: string): string {
  const path = process.env[`${name}_FILE`]?.trim();
  const value = path ? readFileSync(path, "utf8").trim() : process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

process.env.OPENROUTER_API_KEY = required("OPENROUTER_API_KEY");
const internalToken = Buffer.from(required("INTERACTION_RUNTIME_INTERNAL_TOKEN"));
const readOnlyActions = new Set([
  "crm.search_leads.v1",
  "crm.get_lead_context.v1",
  "property.search_properties.v1",
  "property.get_property.v1",
  "visits.search_visits.v1",
  "visits.list_lead_visits.v1",
  "visits.get_visit.v1",
  "visits.create_visit.v1",
]);
const app = express();
const requestConnections = new WeakMap<express.Request, InteractionLabHostmateConnection>();

app.disable("x-powered-by");
app.use(express.json({ limit: "128kb" }));
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "hostmate-interaction-runtime", mode: "safe_write_prepare" });
});
app.use((req, res, next) => {
  if (!isInteractionCanaryAuthorized(req.headers.authorization, internalToken)) {
    res.status(404).json({ error: "not found" });
    return;
  }
  next();
});
app.use((req, res, next) => {
  const accessToken = req.header("x-hostmate-access-token")?.trim();
  const tenantId = req.header("x-hostmate-tenant-id")?.trim();
  const userId = req.header("x-hostmate-user-id")?.trim();
  const role = req.header("x-hostmate-role")?.trim();
  if (!accessToken || !tenantId || !/^\d+$/.test(tenantId) || !userId || !/^\d+$/.test(userId)
    || !role || !["agent", "admin", "superadmin"].includes(role)) {
    res.status(401).json({ error: "INVALID_ACTOR_CONTEXT", message: "La sesión autenticada no es válida." });
    return;
  }
  const tokenFingerprint = createHash("sha256").update(accessToken).digest("hex").slice(0, 24);
  requestConnections.set(req, new InteractionLabHostmateConnection({
    accessToken,
    tenantId,
    userId,
    role: role as "agent" | "admin" | "superadmin",
    sessionId: `hostmate-session-${tokenFingerprint}`,
    effectiveTenantOverride: req.header("x-hostmate-effective-tenant-override") === "true",
  }));
  next();
});
app.use("/interaction", createInteractionLabRouter(undefined, {
  allowedActions: readOnlyActions,
  resolveConnection: (req) => {
    const connection = requestConnections.get(req);
    if (!connection) throw new Error("Authenticated Interaction connection is unavailable");
    return connection;
  },
}));

const port = Number(process.env.INTERACTION_RUNTIME_PORT ?? 4311);
const server = createServer(app);
server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`Hostmate Interaction Runtime listening on ${port} with human-confirmed visit drafts\n`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
