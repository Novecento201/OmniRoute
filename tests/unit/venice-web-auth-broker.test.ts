import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { VeniceAuthBroker } from "../../open-sse/executors/venice-web/authBroker.ts";
import { startAuthBrokerServer } from "../../open-sse/executors/venice-web/brokerServer.ts";
const key = "x".repeat(43);
const extensionId = "a".repeat(32);
const secrets = {
  bearerToken: "synthetic-bearer-private",
  clientAttestation: "synthetic-attestation-private",
  userId: "fixture-user",
};

test("loopback broker pairs exact origin/key, accepts auth but never exposes it", async (t) => {
  const b = new VeniceAuthBroker();
  const server = await startAuthBrokerServer(b, { port: 0, pairingKey: key, extensionId });
  t.after(async () => {
    b.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const url = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  assert.equal((server.address() as { address: string }).address, "127.0.0.1");
  const headers = {
    "X-OmniRoute-Broker-Key": key,
    Origin: "chrome-extension://" + extensionId,
    "Content-Type": "application/json",
  };
  assert.equal((await fetch(url + "/status")).status, 403);
  assert.equal(
    (await fetch(url + "/status", { headers: { ...headers, Origin: "https://evil.invalid" } }))
      .status,
    403
  );
  assert.equal(
    (await fetch(url + "/status", { headers: { ...headers, "X-OmniRoute-Broker-Key": "bad" } }))
      .status,
    403
  );
  const submit = await fetch(url + "/state", {
    method: "POST",
    headers,
    body: JSON.stringify(secrets),
  });
  assert.equal(submit.status, 204);
  const response = await fetch(url + "/status", { headers });
  assert.equal(response.headers.get("access-control-allow-origin"), headers.Origin);
  const text = await response.text();
  assert.equal(JSON.parse(text).connected, true);
  for (const value of Object.values(secrets)) assert.equal(text.includes(value), false);
  assert.equal((await fetch(url + "/state", { headers })).status, 404);
  const reboundStatus = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(
      url + "/status",
      { headers: { ...headers, Host: "evil.invalid" } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      }
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(reboundStatus, 403);
});

test("broker bounds request body and returns only safe errors for malformed secret submissions", async (t) => {
  const b = new VeniceAuthBroker();
  const server = await startAuthBrokerServer(b, { port: 0, pairingKey: key, extensionId });
  t.after(async () => {
    b.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const url = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  const headers = { "X-OmniRoute-Broker-Key": key, "Content-Type": "application/json" };
  for (const body of [secrets.bearerToken, JSON.stringify({ ...secrets, bearerToken: 42 })]) {
    const response = await fetch(url + "/state", { method: "POST", headers, body });
    assert.equal(response.status, 400);
    assert.equal((await response.text()).includes(secrets.bearerToken), false);
  }
  assert.equal(
    (await fetch(url + "/state", { method: "POST", headers, body: "x".repeat(50000) })).status,
    413
  );
  assert.equal(b.valid(), false);
});

test("companion polling signals a single bounded refresh and accepts a fresh submission", async (t) => {
  const b = new VeniceAuthBroker();
  const server = await startAuthBrokerServer(b, { port: 0, pairingKey: key, extensionId });
  t.after(async () => {
    b.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const url = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  const headers = { "X-OmniRoute-Broker-Key": key, "Content-Type": "application/json" };
  const waiting = b.acquire();
  const poll = await (await fetch(url + "/poll", { headers })).json();
  assert.equal(typeof poll.refreshId, "number");
  await fetch(url + "/state", { method: "POST", headers, body: JSON.stringify(secrets) });
  assert.equal((await waiting).bearerToken.reveal(), secrets.bearerToken);
  assert.equal((await (await fetch(url + "/poll", { headers })).json()).refreshId, null);
});
