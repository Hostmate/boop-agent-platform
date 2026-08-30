import "../../env-setup.js";
import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { isTrustedLocalRequest } from "../../local-access.js";
import { createInteractionLabRouter } from "./interaction-lab-route.js";
import { InteractionLabHostmateConnection } from "./interaction-lab-hostmate.js";

const app = express();

app.use((req, res, next) => {
  if (isTrustedLocalRequest(req)) {
    next();
    return;
  }
  res.status(404).json({ error: "not found" });
});
app.use(express.json({ limit: "128kb" }));

const connection = process.env.INTERACTION_LAB_HOSTMATE_TENANT_ID
  ? new InteractionLabHostmateConnection()
  : undefined;
let tenantStatus = connection?.status();
if (connection) {
  try { tenantStatus = await connection.connect(); }
  catch (error) { console.error("Interaction Lab tenant connection failed", error instanceof Error ? error.message : "unknown"); }
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "hostmate-interaction-lab",
    proposalOnly: !tenantStatus?.connected,
    tenant: tenantStatus,
  });
});
app.use("/interaction-lab", createInteractionLabRouter(connection));

const server = createServer(app);
const webSocketServer = new WebSocketServer({ server, path: "/ws" });
webSocketServer.on("connection", (socket, request) => {
  if (!isTrustedLocalRequest(request)) {
    socket.close(1008, "local connections only");
    return;
  }
  socket.send(JSON.stringify({ event: "hello", data: { proposalOnly: !tenantStatus?.connected, tenant: tenantStatus }, at: Date.now() }));
});
const port = Number(process.env.INTERACTION_LAB_PORT ?? process.env.PORT ?? 3456);

server.listen(port, "127.0.0.1", () => {
  console.log(`Hostmate Interaction Lab listening on http://127.0.0.1:${port}`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
