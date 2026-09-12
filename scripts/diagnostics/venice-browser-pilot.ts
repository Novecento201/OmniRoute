/** Live, neutral-fixture acceptance probe. Never writes credentials or production assets. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

const fixtureDirectory = process.argv[2];
if (!fixtureDirectory) throw new Error("Pass the existing neutral protocol-audit directory");
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
];
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

// All DB-backed normalizers/guardrails use a new isolated DB, never the user's router DB.
process.env.DATA_DIR = await mkdtemp(path.join(os.tmpdir(), "venice-live-pilot-"));
// This is an integration-test harness. Use the existing test DB initialization path;
// production migrations and background jobs are outside this transport acceptance probe.
Object.assign(process.env, { NODE_ENV: "test", APP_LOG_TO_FILE: "false" });
process.env.OMNIROUTE_VENICE_BROWSER = "1";
const { ensureDbInitialized, resetDbInstance } = await import("../../src/lib/db/core.ts");
await ensureDbInitialized();
const { getVeniceBroker } = await import("../../open-sse/executors/venice-web/runtimeState.ts");
const { startVeniceBrowserRuntime } =
  await import("../../open-sse/executors/venice-web/runtime.ts");
const { VeniceWebExecutor } = await import("../../open-sse/executors/venice-web.ts");
const { discoverVeniceModels } = await import("../../open-sse/executors/venice-web/models.ts");
const { getResolvedModelCapabilities } = await import("../../src/lib/modelCapabilities.ts");
const { VisionBridgeGuardrail } = await import("../../src/lib/guardrails/visionBridge.ts");
const { resolveChatRequestBody } = await import("../../src/sse/handlers/requestBody.ts");
const { normalizeReasoningRequest } =
  await import("../../src/shared/reasoning/effortStandardization.ts");
const { applyLiteCompression } = await import("../../open-sse/services/compression/lite.ts");
const { translateRequest } = await import("../../open-sse/translator/index.ts");
const { FORMATS } = await import("../../open-sse/translator/formats.ts");
const { prepareUpstreamBody } = await import("../../open-sse/handlers/chatCore/upstreamBody.ts");
const broker = getVeniceBroker();
const server = await startVeniceBrowserRuntime();
const executor = new VeniceWebExecutor();
const model = "venice-uncensored-1-2";
const report: {
  scope: string;
  status: string;
  model: string;
  steps: unknown[];
  updatedAt?: string;
} = {
  scope: "live executor plus real pre-executor components; not the full Next HTTP route",
  status: "waiting_for_companion",
  model,
  steps: [],
};
const reportFile = path.resolve(".venice-browser/pilot-results.json");
async function save() {
  report.updatedAt = new Date().toISOString();
  await writeFile(reportFile, JSON.stringify(report, null, 2), { mode: 0o600 });
}
const bodyFor = (selected: typeof images) => ({
  model,
  messages: [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: selected.length
            ? "List the dominant color of each attached image, in order. Be brief."
            : "Reply with OK only.",
        },
        ...selected.map((image) => image.part),
      ],
    },
  ],
});
async function execute(name: string, body: unknown, selected: typeof images, stream = false) {
  const result = await executor.execute({ model, body, stream, credentials: {} });
  if (!("diagnostics" in result)) throw new Error("Classic transport unavailable");
  const diagnostic = result.diagnostics;
  if (!result.response.ok) {
    report.steps.push({ name, diagnostics: diagnostic });
    await save();
    throw new Error("Classic request failed");
  }
  const text = await result.response.text();
  assert.equal(diagnostic.status, "success");
  assert.deepEqual(
    diagnostic.imageHashes,
    selected.map((image) => image.hash)
  );
  assert.equal(diagnostic.visionPath, selected.length ? "native" : "none");
  let content: string;
  if (stream) {
    assert.equal((text.match(/data: \[DONE\]/g) ?? []).length, 1);
    content = text
      .split("\n")
      .filter((line) => line.startsWith("data: {"))
      .map((line) => {
        const event = JSON.parse(line.slice(6));
        assert.equal(event.error, undefined);
        return event.choices?.[0]?.delta?.content ?? "";
      })
      .join("");
  } else content = JSON.parse(text).choices[0].message.content;
  // Persist only neutral text and the transport's allowlisted diagnostics.
  report.steps.push({ name, diagnostics: diagnostic, content: content.slice(0, 4000) });
  await save();
  console.log("Completed:", name);
  return content;
}
try {
  await save();
  console.log(
    "Ready. Waiting for the paired Chrome companion; no credentials are printed or saved."
  );
  const until = Date.now() + 30 * 60_000;
  while (!broker.status().companionAvailable) {
    if (Date.now() >= until) throw new Error("Companion did not connect");
    await sleep(1000);
  }
  report.status = "running";
  await save();
  await execute("text", bodyFor([]), []);
  const catalog = await discoverVeniceModels(broker);
  const selectedModel = catalog.find((row) => row.id === model);
  assert.ok(selectedModel, "Audited model missing from current catalog");
  report.steps.push({ name: "catalog", model: selectedModel });
  const bootstrap = await execute(
    "native-bootstrap",
    bodyFor(images.slice(0, 1)),
    images.slice(0, 1)
  );
  assert.match(bootstrap.toLowerCase(), /red/);
  for (const count of [1, 2, 3]) {
    const selected = images.slice(0, count);
    const payload = { ...bodyFor(selected), model: "venice-web/" + model };
    const incoming = await resolveChatRequestBody(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
      null
    );
    const normalized = normalizeReasoningRequest(incoming);
    const caps = getResolvedModelCapabilities(payload.model);
    assert.equal(caps.supportsVision, true);
    let bridgeCalls = 0;
    const bridge = new VisionBridgeGuardrail({
      deps: {
        getSettings: async () => ({ visionBridgeEnabled: true }),
        callVisionModel: async () => {
          bridgeCalls++;
          throw new Error("Bridge must stay unused");
        },
      },
    });
    const bridged = await bridge.preCall(normalized, { model: payload.model });
    assert.equal(bridgeCalls, 0);
    assert.equal(bridged.modifiedPayload, undefined);
    const compressed = applyLiteCompression(normalized as Record<string, unknown>, {
      model: payload.model,
      supportsVision: caps.supportsVision,
    }).body;
    const translated = translateRequest(
      FORMATS.OPENAI,
      FORMATS.OPENAI,
      model,
      compressed,
      false,
      null,
      "venice-web"
    );
    const outbound = await prepareUpstreamBody({
      translatedBody: translated,
      modelToCall: model,
      provider: "venice-web",
      targetFormat: FORMATS.OPENAI,
      credentials: null,
    });
    const content = await execute(`native-path-${count}`, outbound, selected);
    for (const color of ["red", "blue", "green"].slice(0, count))
      assert.match(content.toLowerCase(), new RegExp(color));
    report.steps.push({ name: `bridge-path-${count}`, bridgeCalls });
  }
  await execute("webp-stream", bodyFor(images.slice(3)), images.slice(3), true);
  // Invalidate only local in-memory state. The browser must supply genuinely fresh state.
  broker.invalidate();
  await execute("browser-renewal", bodyFor([]), []);
  const cancel = new AbortController();
  const pending = executor.execute({
    model,
    stream: true,
    credentials: {},
    signal: cancel.signal,
    body: { model, messages: [{ role: "user", content: "Count slowly from one to one hundred." }] },
  });
  const result = await pending;
  assert.equal(result.response.ok, true);
  const reader = result.response.body!.getReader();
  await reader.read();
  cancel.abort();
  await reader.cancel();
  assert.ok("diagnostics" in result && result.diagnostics.status === "cancelled");
  report.steps.push({ name: "stream-cancellation", status: "passed" });
  report.status = "passed";
} catch {
  report.status = "failed";
  console.error(
    "Pilot stopped. Inspect the sanitized step report; live acceptance is not complete."
  );
  process.exitCode = 1;
} finally {
  await save();
  broker.close();
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  resetDbInstance();
  // Keep the isolated, credential-free DB for inspection; never remove production state.
}
