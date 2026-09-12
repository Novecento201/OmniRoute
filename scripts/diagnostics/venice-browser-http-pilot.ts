/**
 * Live acceptance over loopback HTTP through the actual chat-completions POST route.
 * Usage (Node 24, from the worktree, after the component pilot exits):
 * node --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts scripts/diagnostics/venice-browser-http-pilot.ts <neutral-fixture-directory>
 * Add --check-fixtures to validate the four allowlisted files without starting services or calling Venice.
 *
 * This hosts the real route/handler in an isolated process/DB. It does not exercise
 * Next's network server, rewrites, dashboard authentication, or production migrations.
 * Browser authentication remains real and memory-only. No synthetic validation is inserted.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const args = process.argv.slice(2);
const checkOnly = args.includes("--check-fixtures");
const fixtureDirectory = args.find((arg) => !arg.startsWith("--"));
if (!fixtureDirectory || args.some((arg) => arg.startsWith("--") && arg !== "--check-fixtures")) {
  throw new Error(
    "Usage: venice-browser-http-pilot.ts <neutral-fixture-directory> [--check-fixtures]"
  );
}
const fixtures = [
  [
    "red-square.png",
    "image/png",
    "242b0afc4d24b158de074fa6774289ca6431439cd3f43760b1723ef5a206d4c6",
  ],
  [
    "blue-square.png",
    "image/png",
    "9f7ea611eb3b6c9d558c3cd746bab7558a2c6f2b4d2f9a7a9864a1db370cb6de",
  ],
  [
    "fixture-01.jpg",
    "image/jpeg",
    "b8f5762325768c5fc813301832f9322d5e7c075ce4ef5f929eda4640a64f0b61",
  ],
  [
    "fixture-02.webp",
    "image/webp",
    "33fa534341c27751f0ab5436095537c0677182f9714584bef63bfea6edba1a0d",
  ],
] as const;
const images = await Promise.all(
  fixtures.map(async ([name, mime, hash]) => {
    const bytes = await readFile(path.join(fixtureDirectory, name));
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      hash,
      "Audit fixture hash mismatch"
    );
    return {
      hash,
      part: {
        type: "image_url",
        image_url: { url: `data:${mime};base64,${bytes.toString("base64")}` },
      },
    };
  })
);
if (checkOnly) {
  console.log(
    "All four allowlisted neutral fixture hashes verified; no service or live request started."
  );
  process.exit(0);
}

const model = "venice-uncensored-1-2";
const routedModel = "venice-web/" + model;
const reportFile = path.resolve(".venice-browser/http-pilot-results.json");
const report: {
  scope: string;
  status: string;
  model: string;
  stage: string;
  steps: unknown[];
  updatedAt?: string;
  failure?: string;
} = {
  scope:
    "real POST route and handler over loopback HTTP; isolated test DB; not Next network server or production management registration",
  status: "initializing",
  model,
  stage: "initialization",
  steps: [],
};
class PilotFailure extends Error {
  constructor(readonly category: string) {
    super("HTTP pilot: " + category);
  }
}
const knownStatuses = new Set([
  "pending",
  "success",
  "auth_missing",
  "auth_expired",
  "auth_rejected",
  "permission_denied",
  "companion_unavailable",
  "timeout",
  "cancelled",
  "rate_limit",
  "billing",
  "invalid_response",
  "transport_failure",
  "unsupported_content",
]);
function safeDiagnostics(value: unknown) {
  const d = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    provider: d.provider === "venice-web" ? "venice-web" : "unexpected",
    transport: d.transport === "classic" ? "classic" : "unexpected",
    model: d.model === model ? model : "unexpected",
    requestId:
      typeof d.requestId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(d.requestId)
        ? d.requestId
        : null,
    visionPath: ["native", "bridge", "none"].includes(String(d.visionPath))
      ? d.visionPath
      : "unexpected",
    imageCount: Number.isSafeInteger(d.imageCount) ? d.imageCount : null,
    imageHashes: Array.isArray(d.imageHashes)
      ? d.imageHashes.filter(
          (hash): hash is string => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash)
        )
      : [],
    stream: d.stream === true,
    status: knownStatuses.has(String(d.status)) ? String(d.status) : "unknown",
    fallbackUsed: typeof d.fallbackUsed === "boolean" ? d.fallbackUsed : null,
    authRefreshed: d.authRefreshed === true,
    latencyMs: typeof d.latencyMs === "number" && Number.isFinite(d.latencyMs) ? d.latencyMs : null,
    retryAfterSeconds:
      typeof d.retryAfterSeconds === "number" &&
      Number.isFinite(d.retryAfterSeconds) &&
      d.retryAfterSeconds >= 0
        ? d.retryAfterSeconds
        : null,
  };
}
async function save() {
  report.updatedAt = new Date().toISOString();
  await writeFile(reportFile, JSON.stringify(report, null, 2), { mode: 0o600 });
}
try {
  await copyFile(reportFile, path.resolve(`.venice-browser/http-pilot-results-${Date.now()}.json`));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT")
    throw new PilotFailure("report_backup_failed");
}

const isolatedDirectory = await mkdtemp(path.join(os.tmpdir(), "venice-http-pilot-"));
Object.assign(process.env, {
  DATA_DIR: isolatedDirectory,
  NODE_ENV: "test",
  APP_LOG_TO_FILE: "false",
  OMNIROUTE_VENICE_BROWSER: "1",
  OMNIROUTE_EMERGENCY_FALLBACK: "false",
  STREAM_RECOVERY_ENABLED: "false",
});
let brokerServer: Server | null = null;
let httpServer: Server | null = null;
let closeBroker: (() => void) | undefined;
let resetDb: (() => void) | undefined;
let restoreExecutor: (() => void) | undefined;
let nextRequestAt = 0;
async function paced() {
  while (Date.now() < nextRequestAt) await sleep(Math.min(1000, nextRequestAt - Date.now()));
}
function retryDelay(header: string | null, diagnosticDelay: number | null) {
  let seconds = diagnosticDelay ?? 60;
  if (header) {
    const numeric = Number(header);
    const parsed =
      Number.isFinite(numeric) && numeric >= 0 ? numeric : (Date.parse(header) - Date.now()) / 1000;
    if (Number.isFinite(parsed) && parsed >= 0) seconds = Math.max(seconds, Math.ceil(parsed));
  }
  return Math.max(60, seconds);
}
function bodyFor(selected: typeof images, stream: boolean, routed = true) {
  return {
    model: routed ? routedModel : model,
    temperature: 0,
    stream,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: selected.length
              ? `There are exactly ${selected.length} attached images. Return a JSON array of exactly ${selected.length} dominant color names, one per image in order, without any other text.`
              : "Reply with OK only.",
          },
          ...selected.map((image) => image.part),
        ],
      },
    ],
  };
}
function completionContent(text: string, stream: boolean) {
  if (!stream) {
    const response = JSON.parse(text);
    assert.equal(response.error, undefined, "JSON error response");
    assert.equal(
      typeof response.choices?.[0]?.message?.content,
      "string",
      "Missing completion content"
    );
    return response.choices[0].message.content as string;
  }
  assert.equal(
    (text.match(/^data: \[DONE\]\r?$/gm) ?? []).length,
    1,
    "Expected one SSE terminal frame"
  );
  let content = "";
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    const event = JSON.parse(line.slice(6));
    assert.equal(event.error, undefined, "SSE error response");
    content += event.choices?.[0]?.delta?.content ?? "";
  }
  assert.ok(content.length > 0, "Missing SSE completion content");
  return content;
}
async function closeServer(server: Server | null) {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

try {
  await save();
  const { ensureDbInitialized, resetDbInstance } = await import("../../src/lib/db/core.ts");
  resetDb = resetDbInstance;
  await ensureDbInitialized();
  const { updateSettings } = await import("../../src/lib/db/settings.ts");
  await updateSettings({
    requestRetry: 0,
    semanticCacheEnabled: false,
    modalityBridgeVisionEnabled: true,
    modalityBridgeVisionMode: "describe",
    resilienceSettings: {
      waitForCooldown: { enabled: false, maxRetries: 0 },
      streamRecovery: { enabled: false },
      credentialHealthCheck: { enabled: false },
    },
  });
  const { createProviderConnection, getProviderConnectionById } =
    await import("../../src/lib/db/providers.ts");
  const connection = await createProviderConnection({
    provider: "venice-web",
    authType: "none",
    name: "Isolated Venice browser HTTP acceptance",
    isActive: true,
    defaultModel: model,
    providerSpecificData: { authMode: "browser" },
  });
  async function assertNoStoredCredentials() {
    const stored = await getProviderConnectionById(String(connection.id));
    assert.ok(stored, "Missing isolated connection");
    for (const field of ["apiKey", "accessToken", "refreshToken", "idToken"])
      assert.ok(!stored[field], "Unexpected persisted credential");
  }
  await assertNoStoredCredentials();
  const { getVeniceBroker } = await import("../../open-sse/executors/venice-web/runtimeState.ts");
  const { startVeniceBrowserRuntime } =
    await import("../../open-sse/executors/venice-web/runtime.ts");
  const { VeniceWebExecutor } = await import("../../open-sse/executors/venice-web.ts");
  const { getResolvedModelCapabilities } = await import("../../src/lib/modelCapabilities.ts");
  const { getBridgeStats } = await import("../../src/lib/guardrails/modalityBridge/bridgeStats.ts");
  const broker = getVeniceBroker();
  closeBroker = () => broker.close();
  brokerServer = await startVeniceBrowserRuntime();
  // Observe the real executor result only. Never inject capabilities or mock a response.
  // Keep references to diagnostics until stream completion updates their final status.
  const observations: unknown[] = [];
  const originalExecute = VeniceWebExecutor.prototype.execute;
  VeniceWebExecutor.prototype.execute = async function (input) {
    const result = await originalExecute.call(this, input);
    if ("diagnostics" in result) observations.push(result.diagnostics);
    return result;
  };
  restoreExecutor = () => {
    VeniceWebExecutor.prototype.execute = originalExecute;
  };
  const { POST } = await import("../../src/app/api/v1/chat/completions/route.ts");
  const nonce = randomUUID();
  httpServer = createServer(async (incoming, outgoing) => {
    if (
      incoming.method !== "POST" ||
      incoming.url !== "/v1/chat/completions" ||
      incoming.headers["x-venice-pilot-request"] !== nonce
    ) {
      outgoing.writeHead(404).end();
      return;
    }
    const abort = new AbortController();
    let complete = false;
    incoming.on("aborted", () => abort.abort());
    outgoing.on("close", () => {
      if (!complete) abort.abort();
    });
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of incoming) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > 65536) throw new PilotFailure("request_body_too_large");
        chunks.push(buffer);
      }
      const address = httpServer!.address();
      assert.ok(address && typeof address === "object");
      const request = new Request(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
        method: "POST",
        signal: abort.signal,
        body: Buffer.concat(chunks).toString("utf8"),
        headers: {
          "content-type": "application/json",
          "x-omniroute-connection": String(connection.id),
          "x-correlation-id": String(incoming.headers["x-correlation-id"] ?? ""),
        },
      });
      const response = await POST(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      const reader = response.body?.getReader();
      try {
        if (reader)
          while (!abort.signal.aborted) {
            const chunk = await reader.read();
            if (chunk.done) break;
            if (!outgoing.write(chunk.value))
              await once(outgoing, "drain", { signal: abort.signal });
          }
      } finally {
        if (abort.signal.aborted) await reader?.cancel().catch(() => {});
        reader?.releaseLock();
      }
      complete = true;
      outgoing.end();
    } catch {
      abort.abort();
      if (!outgoing.headersSent) outgoing.writeHead(500, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ error: { code: "http_pilot_handler_failure" } }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    httpServer!.once("error", reject);
    httpServer!.listen(0, "127.0.0.1", () => {
      httpServer!.off("error", reject);
      resolve();
    });
  });
  const address = httpServer.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  report.status = "waiting_for_companion";
  await save();
  console.log(
    "HTTP pilot ready; waiting for the paired companion. No credentials are printed or saved."
  );
  const companionDeadline = Date.now() + 120_000;
  while (!broker.status().companionAvailable) {
    if (Date.now() >= companionDeadline) throw new PilotFailure("companion_unavailable");
    await sleep(1000);
  }
  report.status = "running";
  async function runStep(name: string, selected: typeof images, stream = false, bootstrap = false) {
    report.stage = name;
    await save();
    for (let attempt = 0; attempt < 2; attempt++) {
      await paced();
      const observationStart = observations.length;
      const bridgeStart = getBridgeStats().vision.attempts;
      const correlationId = randomUUID();
      const response = bootstrap
        ? (
            await new VeniceWebExecutor().execute({
              model,
              body: bodyFor(selected, stream, false),
              stream,
              credentials: {},
              correlationId,
            })
          ).response
        : await fetch(baseUrl + "/v1/chat/completions", {
            method: "POST",
            signal: AbortSignal.timeout(120_000),
            headers: {
              "content-type": "application/json",
              "x-venice-pilot-request": nonce,
              "x-correlation-id": correlationId,
            },
            body: JSON.stringify(bodyFor(selected, stream)),
          });
      const text = await response.text();
      nextRequestAt = Date.now() + 20_000;
      const observed = observations.slice(observationStart).map(safeDiagnostics);
      const diagnostic = observed.at(-1);
      if (response.status === 429 || diagnostic?.status === "rate_limit") {
        const delay = retryDelay(
          response.headers.get("retry-after"),
          diagnostic?.retryAfterSeconds ?? null
        );
        report.steps.push({
          name,
          attempt: attempt + 1,
          httpStatus: response.status,
          diagnostics: observed,
          retryDelaySeconds: delay,
        });
        await save();
        if (attempt === 0 && delay <= 120) {
          nextRequestAt = Date.now() + delay * 1000;
          continue;
        }
        throw new PilotFailure("rate_limit");
      }
      const responseVisionPath = response.headers.get("x-omniroute-vision-path");
      const responseTransport = response.headers.get("x-omniroute-venice-transport");
      const responseImageCount = response.headers.get("x-omniroute-image-count");
      const responseMetadata = {
        visionPath:
          responseVisionPath === null || ["native", "bridge", "none"].includes(responseVisionPath)
            ? responseVisionPath
            : "unexpected",
        veniceTransport:
          responseTransport === null || responseTransport === "classic"
            ? responseTransport
            : "unexpected",
        imageCount:
          responseImageCount === null || /^(?:[0-9]|10)$/.test(responseImageCount)
            ? responseImageCount
            : "unexpected",
        modalityBridgePresent: response.headers.has("x-omniroute-modality-bridge"),
      };
      const bridgeAttempts = getBridgeStats().vision.attempts - bridgeStart;
      report.steps.push({
        name,
        kind: bootstrap ? "direct-native-bootstrap" : "real-route-http",
        httpStatus: response.status,
        diagnostics: observed,
        responseMetadata,
        bridgeAttempts,
      });
      await save();
      if (!response.ok) throw new PilotFailure(diagnostic?.status ?? "http_request_failed");
      assert.equal(observed.length, 1, "Expected exactly one executor invocation");
      assert.ok(diagnostic, "Missing actual executor diagnostics");
      assert.equal(diagnostic.status, "success", "Transport not successful");
      assert.equal(diagnostic.provider, "venice-web");
      assert.equal(diagnostic.model, model);
      assert.equal(diagnostic.visionPath, selected.length ? "native" : "none");
      assert.equal(diagnostic.fallbackUsed, false);
      assert.equal(diagnostic.imageCount, selected.length);
      assert.deepEqual(
        diagnostic.imageHashes,
        selected.map((image) => image.hash),
        "Original image pixels changed"
      );
      assert.equal(bridgeAttempts, 0, "Vision Bridge was invoked");
      assert.equal(responseMetadata.modalityBridgePresent, false);
      assert.equal(
        responseMetadata.visionPath,
        selected.length ? "native" : "none",
        "HTTP vision diagnostic missing"
      );
      assert.equal(
        responseMetadata.veniceTransport,
        "classic",
        "HTTP transport diagnostic missing"
      );
      // Bootstrap predates the public-route projection and asserts its original
      // imageCount diagnostics above; the route must expose the added public field.
      if (!bootstrap)
        assert.equal(
          responseMetadata.imageCount,
          String(selected.length),
          "HTTP image count missing"
        );
      const content = completionContent(text, stream);
      const expectedColors = selected.map((image) =>
        image.hash === images[0].hash
          ? /red/i
          : image.hash === images[1].hash
            ? /blue/i
            : image.hash === images[2].hash
              ? /green/i
              : /amber|yellow|orange|gold/i
      );
      for (const color of expectedColors)
        assert.match(content, color, "Neutral fixture color not recognized");
      if (!selected.length) assert.match(content, /OK/i);
      report.steps.push({ name: name + "-content", content: content.slice(0, 4000) });
      await assertNoStoredCredentials();
      await save();
      console.log("Completed:", name);
      return;
    }
  }
  await runStep("native-bootstrap", images.slice(0, 1), false, true);
  assert.equal(
    getResolvedModelCapabilities(routedModel).supportsVision,
    true,
    "Live native capability was not registered"
  );
  await runStep("http-text", []);
  for (const count of [1, 2, 3]) await runStep(`http-native-${count}`, images.slice(0, count));
  await runStep("http-webp-stream", images.slice(3), true);
  // Force only this process's memory state to expire. The companion must obtain
  // fresh state through the real logged-in browser; no credential is manufactured.
  broker.invalidate();
  assert.equal(broker.status().connected, false);
  await runStep("http-browser-renewal", []);
  assert.equal(broker.status().connected, true, "Browser authentication was not renewed");
  report.stage = "http-stream-cancellation";
  await save();
  await paced();
  const cancellationObservations = observations.length;
  const cancellationController = new AbortController();
  const cancellationResponse = await fetch(baseUrl + "/v1/chat/completions", {
    method: "POST",
    signal: AbortSignal.any([cancellationController.signal, AbortSignal.timeout(120_000)]),
    headers: {
      "content-type": "application/json",
      "x-venice-pilot-request": nonce,
      "x-correlation-id": randomUUID(),
    },
    body: JSON.stringify({
      model: routedModel,
      stream: true,
      messages: [
        {
          role: "user",
          content: "Count slowly from one to one hundred, spelling every number on its own line.",
        },
      ],
    }),
  });
  if (!cancellationResponse.ok) {
    await cancellationResponse.body?.cancel();
    report.steps.push({
      name: "http-stream-cancellation",
      httpStatus: cancellationResponse.status,
      diagnostics: observations.slice(cancellationObservations).map(safeDiagnostics),
    });
    throw new PilotFailure("cancellation_request_failed");
  }
  const cancellationReader = cancellationResponse.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let usefulContent = false;
  while (!usefulContent) {
    const chunk = await cancellationReader.read();
    if (chunk.done) throw new PilotFailure("stream_completed_before_cancellation");
    buffered += decoder.decode(chunk.value, { stream: true });
    if (buffered.length > 65536) throw new PilotFailure("cancellation_startup_too_large");
    usefulContent = buffered.split(/\r?\n/).some((line) => {
      if (!line.startsWith("data: {") || !line.endsWith("}")) return false;
      try {
        const event = JSON.parse(line.slice(6));
        return (
          typeof event.choices?.[0]?.delta?.content === "string" &&
          event.choices[0].delta.content.length > 0
        );
      } catch {
        return false;
      }
    });
  }
  cancellationController.abort();
  await cancellationReader.cancel().catch(() => {});
  const cancellationDeadline = Date.now() + 5000;
  let cancelled = false;
  while (Date.now() < cancellationDeadline) {
    cancelled = observations
      .slice(cancellationObservations)
      .some((entry) => safeDiagnostics(entry).status === "cancelled");
    if (cancelled) break;
    await sleep(50);
  }
  report.steps.push({
    name: "http-stream-cancellation",
    cancelled,
    diagnostics: observations.slice(cancellationObservations).map(safeDiagnostics),
  });
  assert.equal(cancelled, true, "HTTP cancellation did not reach the actual Venice transport");
  await assertNoStoredCredentials();
  report.steps.push({ name: "persisted-credential-check", storedCredentialFields: 0 });
  report.status = "passed";
  report.stage = "complete";
} catch (error) {
  report.status = "failed";
  report.failure =
    error instanceof PilotFailure
      ? error.category
      : error instanceof assert.AssertionError
        ? "acceptance_assertion_failed"
        : "initialization_or_transport_failure";
  console.error(
    "HTTP pilot stopped at",
    report.stage,
    "with",
    report.failure,
    "; inspect the sanitized report."
  );
  process.exitCode = 1;
} finally {
  await save();
  await closeServer(httpServer);
  closeBroker?.();
  await closeServer(brokerServer);
  restoreExecutor?.();
  resetDb?.();
  // Keep this isolated credential-free DB for inspection; never remove production state.
}
// Route imports may own unrelated periodic timers. This is a dedicated probe
// process; exit only after this harness has closed its servers and database.
process.exit(process.exitCode ?? 0);
