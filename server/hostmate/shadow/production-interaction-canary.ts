import "../../env-setup.js";
import express from "express";
import { createServer } from "node:http";
import { isInteractionCanaryAuthorized } from "./interaction-canary-auth.js";
import { createInteractionLabRouter } from "./interaction-lab-route.js";
import { InteractionLabHostmateConnection } from "./interaction-lab-hostmate.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const internalToken = Buffer.from(required("INTERACTION_CANARY_INTERNAL_TOKEN"));
const connection = new InteractionLabHostmateConnection();
let tenantStatus = await connection.connect();
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
app.use("/interaction", createInteractionLabRouter(connection));

const port = Number(process.env.INTERACTION_CANARY_PORT ?? 4311);
const server = createServer(app);
server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`Hostmate Interaction Canary listening on ${port} for tenant ${tenantStatus.tenantId ?? "unknown"}\n`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
