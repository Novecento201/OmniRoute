import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { VeniceAuthBroker, VeniceTransportError, type AuthSubmission } from "./authBroker.ts";

export async function startAuthBrokerServer(
  broker: VeniceAuthBroker,
  options: {
    port: number;
    pairingKey: string;
    extensionId: string;
  }
): Promise<Server> {
  if (!/^[a-p]{32}$/.test(options.extensionId) || options.pairingKey.length < 43)
    throw new Error("Invalid Venice companion pairing configuration");
  const origin = "chrome-extension://" + options.extensionId;
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");
    const reply = (status: number, body: unknown) => {
      res.writeHead(status);
      res.end(JSON.stringify(body));
    };
    const expectedHost = "127.0.0.1:" + (server.address() as { port: number }).port;
    if (
      req.socket.remoteAddress !== "127.0.0.1" ||
      req.headers.host !== expectedHost ||
      (req.headers.origin && req.headers.origin !== origin)
    ) {
      reply(403, { error: "broker_forbidden" });
      return;
    }
    if (req.headers.origin === origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-OmniRoute-Broker-Key");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST");
      reply(204, null);
      return;
    }
    const supplied = req.headers["x-omniroute-broker-key"];
    const key = Buffer.from(typeof supplied === "string" ? supplied : "");
    const expected = Buffer.from(options.pairingKey);
    if (key.length !== expected.length || !timingSafeEqual(key, expected)) {
      reply(403, { error: "broker_forbidden" });
      return;
    }
    try {
      if (req.method === "GET" && req.url === "/poll") {
        reply(200, broker.poll());
        return;
      }
      if (req.method === "GET" && req.url === "/status") {
        reply(200, broker.status());
        return;
      }
      if (req.method !== "POST" || !["/state", "/refresh-failed"].includes(req.url ?? "")) {
        reply(404, { error: "not_found" });
        return;
      }
      if (!req.headers["content-type"]?.startsWith("application/json")) {
        reply(415, { error: "json_required" });
        return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 48 * 1024) {
          reply(413, { error: "body_too_large" });
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid");
      if (req.url === "/state") {
        for (const key of ["bearerToken", "clientAttestation", "userId"]) {
          if (typeof body[key] !== "string") throw new Error("invalid");
        }
        for (const key of ["attestationExpiresAt", "bearerExpiresAt"]) {
          if (body[key] !== undefined && typeof body[key] !== "number") throw new Error("invalid");
        }
        broker.submit(body as AuthSubmission);
      } else {
        if (typeof body.refreshId !== "number") throw new Error("invalid");
        broker.failRefresh(body.refreshId);
      }
      reply(204, null);
    } catch (error) {
      reply(error instanceof VeniceTransportError ? error.status : 400, {
        error: error instanceof VeniceTransportError ? error.category : "invalid_submission",
      });
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}
