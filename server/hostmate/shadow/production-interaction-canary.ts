import "../../env-setup.js";
import express from "express";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
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
const internalToken = Buffer.from(required("INTERACTION_CANARY_INTERNAL_TOKEN"));
const connection = new InteractionLabHostmateConnection();
let tenantStatus = await connection.connect();
const readOnlyActions = new Set([
  "crm.search_leads.v1",
  "crm.get_lead_context.v1",
  "property.search_properties.v1",
  "property.get_property.v1",
  "visits.search_visits.v1",
  "visits.list_lead_visits.v1",
  "visits.get_visit.v1",
]);
const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "128kb" }));
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "hostmate-interaction-canary", mode: "read_only" });
});
app.use((req, res, next) => {
  if (!isInteractionCanaryAuthorized(req.headers.authorization, internalToken)) {
    res.status(404).json({ error: "not found" });
    return;
  }
  next();
});
app.use("/interaction", createInteractionLabRouter(connection, { allowedActions: readOnlyActions }));

const port = Number(process.env.INTERACTION_CANARY_PORT ?? 4311);
const server = createServer(app);
server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`Hostmate Interaction Canary listening on ${port} for tenant ${tenantStatus.tenantId ?? "unknown"}\n`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
