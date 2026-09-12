import { after, before, test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "venice-image-path-"));
process.env.DATA_DIR = temp;
const { ensureDbInitialized, resetDbInstance } = await import("../../src/lib/db/core.ts");
const { addCustomModel } = await import("../../src/lib/db/models.ts");
const { getResolvedModelCapabilities } = await import("../../src/lib/modelCapabilities.ts");
const { VisionBridgeGuardrail } = await import("../../src/lib/guardrails/visionBridge.ts");
const { resolveChatRequestBody } = await import("../../src/sse/handlers/requestBody.ts");
const { normalizeReasoningRequest } =
  await import("../../src/shared/reasoning/effortStandardization.ts");
const { applyLiteCompression } = await import("../../open-sse/services/compression/lite.ts");
const { translateRequest } = await import("../../open-sse/translator/index.ts");
const { FORMATS } = await import("../../open-sse/translator/formats.ts");
const { prepareUpstreamBody } = await import("../../open-sse/handlers/chatCore/upstreamBody.ts");
const { VeniceWebExecutor } = await import("../../open-sse/executors/venice-web.ts");

// Valid neutral 1x1 PNG; no account, project, or user data.
const image =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=";
const fixture = (id: string) => ({
  model: "venice-web/" + id,
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "Describe this image." },
        { type: "image_url", image_url: { url: image } },
      ],
    },
  ],
});
function inspect(body: Record<string, unknown>) {
  const content = (body.messages as Array<{ content: unknown }>)[0].content;
  return { array: Array.isArray(content), originalImage: JSON.stringify(content).includes(image) };
}

before(async () => {
  await ensureDbInitialized();
  // Only this isolated temporary DB is modified. No production capability is enabled.
  for (const [id, vision] of [
    ["fixture-native", true],
    ["fixture-text", false],
  ] as const) {
    await addCustomModel(
      "venice-web",
      id,
      id,
      "manual",
      "chat-completions",
      ["chat"],
      undefined,
      {},
      vision
    );
  }
});
after(() => {
  mock.restoreAll();
  resetDbInstance();
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

for (const [id, vision] of [
  ["fixture-native", true],
  ["fixture-text", false],
] as const) {
  test(`component path: capability ${vision} controls bridge and original bytes`, async () => {
    let calls = 0;
    const payload = fixture(id);
    const request = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
    });
    const incoming = await resolveChatRequestBody(request, null);
    assert.deepEqual(inspect(incoming), { array: true, originalImage: true });
    const normalized = normalizeReasoningRequest(incoming);
    assert.deepEqual(normalized, payload);
    const caps = getResolvedModelCapabilities(payload.model);
    assert.equal(caps.supportsVision, vision);
    const bridge = new VisionBridgeGuardrail({
      deps: {
        getSettings: async () => ({
          visionBridgeEnabled: true,
          visionBridgeRerouteTextOnly: false,
          visionBridgeModel: "openai/gpt-4o-mini",
          visionBridgeMaxImages: 10,
        }),
        hasUsableCredentials: async () => true,
        callVisionModel: async (uri: string) => {
          calls++;
          assert.equal(uri, image);
          return "Neutral fixture image.";
        },
      },
    });
    // Real combo resolver uses empty temp DB. Do not fake the combo skip branch.
    const bridged = await bridge.preCall(normalized, { model: payload.model });
    assert.equal(bridged.block, false);
    const afterBridge = (bridged.modifiedPayload ?? normalized) as Record<string, unknown>;
    assert.equal(calls, vision ? 0 : 1);
    assert.deepEqual(inspect(afterBridge), { array: true, originalImage: vision });
    const compressed = applyLiteCompression(afterBridge, {
      model: payload.model,
      supportsVision: caps.supportsVision,
    }).body;
    assert.deepEqual(inspect(compressed), { array: true, originalImage: vision });
    const translated = translateRequest(
      FORMATS.OPENAI,
      FORMATS.OPENAI,
      id,
      compressed,
      false,
      {},
      "venice-web"
    ) as Record<string, unknown>;
    assert.deepEqual(inspect(translated), { array: true, originalImage: vision });
    const outbound = await prepareUpstreamBody({
      translatedBody: translated,
      modelToCall: id,
      provider: "venice-web",
      targetFormat: FORMATS.OPENAI,
      credentials: null,
    });
    assert.deepEqual(inspect(outbound), { array: true, originalImage: vision });
    const upstream = mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
      assert.deepEqual(inspect(JSON.parse(String(init?.body))), {
        array: true,
        originalImage: vision,
      });
      return Response.json({ content: "Fixture response; no live Venice claim." });
    });
    try {
      const result = await new VeniceWebExecutor().execute({
        model: id,
        body: outbound,
        stream: false,
        credentials: {},
        signal: null,
      });
      assert.equal(result.response.status, 200);
      assert.equal(upstream.mock.callCount(), 1);
      assert.deepEqual(inspect(result.transformedBody), { array: true, originalImage: vision });
    } finally {
      upstream.mock.restore();
    }
  });
}

test("lite alone strips base64 only for explicitly false vision, and preserves unknown", () => {
  for (const capability of [true, false, null]) {
    const out = applyLiteCompression(fixture("fixture-text"), { supportsVision: capability });
    assert.deepEqual(inspect(out.body), { array: true, originalImage: capability !== false });
    if (capability === false) assert.match(JSON.stringify(out.body), /\[image: png\]/);
  }
});
