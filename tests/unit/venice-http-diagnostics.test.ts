import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readVeniceResponseDiagnostics,
  type VeniceResponseDiagnostics,
} from "../../open-sse/handlers/chatCore/executorDiagnostics.ts";
import { normalizeExecutorResult } from "../../open-sse/handlers/chatCore/upstreamTimeouts.ts";
import { buildNonStreamingResponseHeaders } from "../../open-sse/handlers/chatCore/nonStreamingResponseHeaders.ts";
import { assembleStreamingResponseHeaders } from "../../open-sse/handlers/chatCore/streamingResponseHeaders.ts";
import { runNonStreamingProviderLeg } from "../../open-sse/handlers/chatCore/nonStreamingProviderLeg.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";

test.after(() => resetDbInstance());

const diagnostics: VeniceResponseDiagnostics = {
  provider: "venice-web",
  transport: "classic",
  visionPath: "native",
  imageCount: 2,
};
const providerHeaders = new Headers({
  "x-omniroute-vision-path": "forged",
  "x-omniroute-venice-transport": "forged",
  "x-omniroute-image-count": "999",
  "x-omniroute-private": "upstream-private",
  "set-cookie": "upstream-private",
  authorization: "upstream-private",
  "x-request-id": "upstream-request",
});

function streaming(provider = "venice-web", value?: VeniceResponseDiagnostics) {
  return assembleStreamingResponseHeaders({
    providerHeaders,
    provider,
    model: "venice-uncensored-1-2",
    pendingRequestId: "public-request",
    diagnostics: value,
  });
}

function json(provider = "venice-web", value?: VeniceResponseDiagnostics) {
  return buildNonStreamingResponseHeaders({
    provider,
    model: "venice-uncensored-1-2",
    requestId: "public-request",
    startTime: Date.now(),
    responseUsage: null,
    estimatedCost: 0,
    diagnostics: value,
  });
}

test("normalizer retains only allowlisted diagnostics from the selected Venice executor", () => {
  const normalized = normalizeExecutorResult(
    {
      response: new Response("{}", { headers: providerHeaders }),
      diagnostics: { ...diagnostics, authorization: "fixture-secret", userId: "private-id" },
    },
    "venice-web"
  );
  assert.deepEqual(normalized.diagnostics, diagnostics);
  assert.equal(JSON.stringify(normalized.diagnostics).includes("private"), false);
  assert.equal(JSON.stringify(normalized.diagnostics).includes("fixture-secret"), false);
});

test("response and request headers alone cannot forge internal diagnostics", () => {
  for (const provider of ["venice-web", "openai"]) {
    const normalized = normalizeExecutorResult(
      {
        response: new Response("{}", { headers: providerHeaders }),
        headers: Object.fromEntries(providerHeaders),
        transformedBody: { diagnostics },
      },
      provider
    );
    assert.equal(normalized.diagnostics, undefined);
    for (const headers of [streaming(provider), json(provider)]) {
      assert.equal(headers["x-omniroute-vision-path"], undefined);
      assert.equal(headers["x-omniroute-venice-transport"], undefined);
      assert.equal(headers["x-omniroute-image-count"], undefined);
      assert.equal(headers["x-omniroute-private"], undefined);
      assert.equal(headers.authorization, undefined);
      assert.equal(headers["set-cookie"], undefined);
    }
  }
});

test("trusted diagnostics reach JSON and SSE without trusting same-named upstream headers", () => {
  for (const visionPath of ["native", "bridge", "none"] as const) {
    for (const headers of [
      streaming("venice-web", { ...diagnostics, visionPath }),
      json("ven", { ...diagnostics, visionPath }),
    ]) {
      assert.equal(headers["x-omniroute-vision-path"], visionPath);
      assert.equal(headers["x-omniroute-venice-transport"], "classic");
      assert.equal(headers["x-omniroute-image-count"], "2");
      assert.equal(headers["x-omniroute-private"], undefined);
    }
  }
  assert.equal(streaming("venice-web", diagnostics)["x-request-id"], "upstream-request");
});

test("non-Venice providers cannot publish Venice diagnostics", () => {
  assert.equal(
    normalizeExecutorResult({ response: new Response("{}"), diagnostics }, "openai").diagnostics,
    undefined
  );
  for (const headers of [streaming("openai", diagnostics), json("openai", diagnostics)]) {
    assert.equal(headers["x-omniroute-vision-path"], undefined);
    assert.equal(headers["x-omniroute-venice-transport"], undefined);
  }
});

test("diagnostic values are validated rather than copied to public headers", () => {
  for (const invalid of [
    { ...diagnostics, provider: "openai" },
    { ...diagnostics, transport: "agentic" },
    { ...diagnostics, visionPath: "native\r\nCookie: bad" },
    { ...diagnostics, visionPath: { toString: () => "native" } },
    { ...diagnostics, imageCount: -1 },
    { ...diagnostics, imageCount: 1.5 },
    { ...diagnostics, imageCount: 11 },
    { ...diagnostics, imageCount: "2" },
  ]) {
    assert.equal(readVeniceResponseDiagnostics("venice-web", invalid), undefined);
  }
});

test("non-streaming leg preserves diagnostics across the shared execution pipeline seam", async () => {
  const sourceBody = {
    model: "venice-uncensored-1-2",
    messages: [{ role: "user", content: "neutral fixture" }],
  };
  const leg = await runNonStreamingProviderLeg({
    phase: "initial",
    sourceBody,
    provider: "venice-web",
    model: sourceBody.model,
    connectionId: "fixture-connection",
    allowAccountRotation: false,
    allowModelFallback: false,
    setRequestWireState: () => {},
    executeProviderRequest: async () => {
      throw new Error("must use pipeline");
    },
    runProviderExecution: async () => ({
      kind: "response",
      response: Response.json({
        choices: [
          { message: { role: "assistant", content: "fixture result" }, finish_reason: "stop" },
        ],
      }),
      url: "https://upstream.invalid",
      headers: {},
      transformedBody: sourceBody,
      model: sourceBody.model,
      connectionId: "fixture-connection",
      diagnostics,
    }),
  });
  assert.equal(leg.kind, "ok");
  if (leg.kind !== "ok") return;
  assert.deepEqual(leg.diagnostics, diagnostics);
  assert.equal(json("venice-web", leg.diagnostics)["x-omniroute-vision-path"], "native");
});
