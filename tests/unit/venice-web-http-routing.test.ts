/** Deterministic real-route wiring only. No browser, authentication, or live model evidence. */
import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";

const temp = mkdtempSync(path.join(os.tmpdir(), "venice-http-routing-test-"));
Object.assign(process.env, {
  DATA_DIR: temp,
  NODE_ENV: "test",
  APP_LOG_TO_FILE: "false",
  REQUIRE_API_KEY: "false",
  OMNIROUTE_VENICE_BROWSER: "1",
  OMNIROUTE_EMERGENCY_FALLBACK: "false",
  STREAM_RECOVERY_ENABLED: "false",
});
// Fail closed for both global fetch and undici-based helpers. The executor is
// mocked below; an accidental real outbound request must never reach a network.
const originalDispatcher = getGlobalDispatcher();
const network = new MockAgent();
network.disableNetConnect();
setGlobalDispatcher(network);
let networkAttempts = 0;
mock.method(globalThis, "fetch", async () => {
  networkAttempts++;
  throw new Error("Network is forbidden in this route regression");
});

const { ensureDbInitialized, resetDbInstance } = await import("../../src/lib/db/core.ts");
const { createProviderConnection, getProviderConnectionById } =
  await import("../../src/lib/db/providers.ts");
const { updateSettings } = await import("../../src/lib/db/settings.ts");
const { VeniceWebExecutor } = await import("../../open-sse/executors/venice-web.ts");
const { getVeniceBroker } = await import("../../open-sse/executors/venice-web/runtimeState.ts");
const { getBridgeStats } = await import("../../src/lib/guardrails/modalityBridge/bridgeStats.ts");
const { POST } = await import("../../src/app/api/v1/chat/completions/route.ts");
const { closeCallLogSaves } = await import("../../src/lib/usage/callLogs.ts");
const { flushProxyLogsSync } = await import("../../src/lib/proxyLogger.ts");
const { stopRateLimitWatchdog, __resetRateLimitManagerForTests } =
  await import("../../open-sse/services/rateLimitManager.ts");
// proxyFetch initializes its dispatcher during route import. Reapply the
// closed network boundary after those imports, as existing route fixtures do.
setGlobalDispatcher(network);
const model = "fixture-venice-native";
const image =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=";

after(async () => {
  await new Promise((resolve) => setTimeout(resolve, 30));
  await closeCallLogSaves(2000);
  flushProxyLogsSync();
  stopRateLimitWatchdog();
  await __resetRateLimitManagerForTests();
  getVeniceBroker().close();
  mock.restoreAll();
  setGlobalDispatcher(originalDispatcher);
  await network.close();
  resetDbInstance();
  const resolved = path.resolve(temp);
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
  rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test(
  "real POST route selects a keyless browser row and forwards trusted native diagnostics in JSON and SSE",
  { timeout: 20_000 },
  async () => {
    await ensureDbInitialized();
    await updateSettings({
      requestRetry: 0,
      semanticCacheEnabled: false,
      modalityBridgeVisionEnabled: true,
      modalityBridgeVisionMode: "describe",
      resilienceSettings: {
        waitForCooldown: { enabled: false, maxRetries: 0 },
        streamRecovery: { enabled: false },
      },
    });
    const connection = await createProviderConnection({
      provider: "venice-web",
      authType: "none",
      name: "Mocked browser route regression",
      isActive: true,
      providerSpecificData: { authMode: "browser" },
    });
    // Mock native evidence is scoped to this process and deliberately uses a
    // fixture model ID. No bearer, cookie, attestation, or fake API key is created.
    getVeniceBroker().recordNativeSuccess(model, 1);
    let executorCalls = 0;
    mock.method(VeniceWebExecutor.prototype, "execute", async (input) => {
      executorCalls++;
      assert.equal(input.credentials?.connectionId, connection.id);
      assert.equal(input.credentials?.authType, "none");
      for (const field of ["apiKey", "accessToken", "refreshToken", "idToken"])
        assert.ok(!input.credentials?.[field]);
      assert.ok(
        JSON.stringify(input.body).includes(image),
        "Native image payload was changed before the executor"
      );
      const message = "MOCK neutral image response";
      const response = input.stream
        ? new Response(
            [
              `data: ${JSON.stringify({ id: "fixture-stream", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { role: "assistant", content: message }, finish_reason: null }] })}`,
              "",
              `data: ${JSON.stringify({ id: "fixture-stream", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
              "",
              "data: [DONE]",
              "",
              "",
            ].join("\n"),
            { headers: { "content-type": "text/event-stream" } }
          )
        : Response.json({
            id: "fixture-json",
            object: "chat.completion",
            model,
            choices: [
              { index: 0, message: { role: "assistant", content: message }, finish_reason: "stop" },
            ],
          });
      return {
        response,
        url: "https://outerface.venice.ai/api/inference/chat",
        headers: {},
        transformedBody: input.body,
        diagnostics: {
          provider: "venice-web",
          transport: "classic",
          visionPath: "native",
          imageCount: 1,
        },
      };
    });
    const bridgeBefore = getBridgeStats().vision.attempts;
    for (const stream of [false, true]) {
      const response = await POST(
        new Request("http://127.0.0.1/v1/chat/completions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-omniroute-connection": String(connection.id),
          },
          body: JSON.stringify({
            model: "venice-web/" + model,
            stream,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: "Describe the neutral test image." },
                  { type: "image_url", image_url: { url: image } },
                ],
              },
            ],
          }),
        })
      );
      const text = await response.text();
      assert.equal(response.status, 200, text);
      assert.equal(response.headers.get("x-omniroute-vision-path"), "native");
      assert.equal(response.headers.get("x-omniroute-venice-transport"), "classic");
      assert.equal(response.headers.get("x-omniroute-image-count"), "1");
      assert.equal(response.headers.has("x-omniroute-modality-bridge"), false);
      if (stream) {
        assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
        assert.equal((text.match(/data: \[DONE\]/g) ?? []).length, 1);
        assert.match(text, /MOCK neutral image response/);
      } else
        assert.equal(JSON.parse(text).choices[0].message.content, "MOCK neutral image response");
    }
    assert.equal(executorCalls, 2);
    assert.equal(getBridgeStats().vision.attempts - bridgeBefore, 0);
    assert.equal(networkAttempts, 0);
    const stored = await getProviderConnectionById(String(connection.id));
    assert.ok(stored);
    assert.equal(stored.authType, "none");
    for (const field of ["apiKey", "accessToken", "refreshToken", "idToken"])
      assert.ok(!stored[field]);
  }
);
