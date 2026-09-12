import { after, afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "venice-executor-baseline-"));
process.env.DATA_DIR = temp;
process.env.APP_LOG_TO_FILE = "false";
const { VeniceWebExecutor } = await import("../../open-sse/executors/venice-web.ts");
const { createRequestLogger } = await import("../../open-sse/utils/requestLogger.ts");
const { resetDbInstance } = await import("../../src/lib/db/core.ts");
after(() => {
  resetDbInstance();
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const input = () => ({
  model: "venice-default",
  body: { model: "fixture-model", messages: [{ role: "user", content: "Hello" }], max_tokens: 123 },
  stream: false,
  credentials: { apiKey: "Cookie: fixture=not-a-real-session-0123456789" },
  signal: null,
});
const executor = new VeniceWebExecutor();
// This file covers legacy behavior; browser-mode integration is tested separately.
process.env.OMNIROUTE_VENICE_BROWSER = "0";
afterEach(() => mock.restoreAll());

describe("Venice web deterministic baseline (mock upstream, not live compatibility)", () => {
  it("redacts complete authorization, cookie and attestation values at every header boundary", async () => {
    const logger = await createRequestLogger("openai", "openai", "fixture-model");
    const headers = {
      Authorization: "Bearer synthetic-bearer-secret-value",
      Cookie: "session=synthetic-cookie-secret-value",
      "x-venice-client-attestation": "synthetic-attestation-secret-value",
    };
    logger.logTargetRequest("https://venice.ai/", headers, {});
    logger.logClientRawRequest("/v1/chat/completions", {}, headers);
    logger.logProviderResponse(401, "Unauthorized", headers, {});
    const payload = JSON.stringify(logger.getPipelinePayloads());
    for (const value of Object.values(headers)) assert.equal(payload.includes(value), false);
    assert.equal(payload.includes("synthetic"), false);
    assert.equal(
      logger.getPipelinePayloads()?.providerRequest?.headers?.Authorization,
      "[REDACTED]"
    );
  });
  it("forwards text, body model, token limit and normalized cookie", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () =>
      Response.json({ content: "Hello back" })
    );
    const result = await executor.execute(input());
    const [url, init] = fetchMock.mock.calls[0].arguments as [string, RequestInit];
    assert.equal(url, "https://venice.ai/api/chat");
    assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(String(init.body)), { ...input().body, stream: false });
    assert.equal(new Headers(init.headers).get("Cookie"), "fixture=not-a-real-session-0123456789");
    const response = await result.response.json();
    assert.equal(response.model, "fixture-model");
    assert.equal(response.object, "chat.completion");
    assert.deepEqual(response.choices, [
      { index: 0, message: { role: "assistant", content: "Hello back" }, finish_reason: "stop" },
    ]);
  });

  it("normalizes OpenAI choices and characterizes body-only model/default token selection", async () => {
    mock.method(globalThis, "fetch", async () =>
      Response.json({ choices: [{ message: { content: "Choice" } }] })
    );
    const result = await executor.execute({
      ...input(),
      model: "ignored-input-model",
      body: { messages: [] },
      credentials: {},
    });
    assert.deepEqual(result.transformedBody, {
      messages: [],
      model: "venice-default",
      stream: false,
      max_tokens: 4096,
    });
    assert.equal((await result.response.json()).choices[0].message.content, "Choice");
    assert.equal(new Headers(result.headers).has("cookie"), false);
  });

  it("normalizes SSE across byte boundaries; characterizes inherited duplicate DONE", async () => {
    const bytes = new TextEncoder().encode(
      'data: {"choices":[{"delta":{"content":"Caffè"}}]}\n\ndata: malformed\n\ndata: [DONE]\n\n'
    );
    mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
              controller.close();
            },
          })
        )
    );
    const result = await executor.execute({ ...input(), stream: true });
    assert.match(result.response.headers.get("content-type")!, /text\/event-stream/);
    const events = (await result.response.text())
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6));
    assert.equal(JSON.parse(events[0]).choices[0].delta.content, "Caffè");
    assert.equal(JSON.parse(events[0]).model, "fixture-model");
    assert.deepEqual(events.slice(1), ["[DONE]", "[DONE]"]);
  });

  it("passes caller signal to fetch and currently maps cancellation to 502", async () => {
    const controller = new AbortController();
    let observed: AbortSignal | null | undefined;
    mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
      observed = init?.signal;
      controller.abort();
      throw new DOMException("Fixture cancellation", "AbortError");
    });
    const result = await executor.execute({ ...input(), signal: controller.signal });
    assert.equal(observed, controller.signal);
    assert.equal(observed?.aborted, true);
    assert.equal(result.response.status, 502);
    assert.match((await result.response.json()).error.message, /Venice fetch failed/);
  });

  for (const status of [401, 403, 429, 500]) {
    it(`propagates upstream HTTP ${status}`, async () => {
      mock.method(
        globalThis,
        "fetch",
        async () => new Response("Fixture upstream failure", { status })
      );
      const result = await executor.execute(input());
      assert.equal(result.response.status, status);
      assert.match((await result.response.json()).error.message, /Venice upstream request failed/);
      assert.deepEqual(result.headers, {});
    });
  }

  it("maps transport failures to deterministic 502", async () => {
    mock.method(globalThis, "fetch", async () => {
      throw new Error("Fixture offline");
    });
    assert.equal((await executor.execute(input())).response.status, 502);
  });

  it("fully redacts cookie metadata while forwarding the real cookie only upstream", async () => {
    mock.method(globalThis, "fetch", async () => Response.json({ content: "ok" }));
    const result = await executor.execute(input());
    const logger = await createRequestLogger("openai", "openai", "fixture-model");
    logger.logTargetRequest(result.url, result.headers, result.transformedBody);
    const logged = logger.getPipelinePayloads();
    assert.equal(logged?.providerRequest?.headers?.Cookie, "[REDACTED]");
    assert.equal(JSON.stringify(logged).includes("fixture=not-a-real-session-0123456789"), false);
    assert.equal(result.headers.Cookie, "[REDACTED]");
  });

  it("sanitizes invalid legacy JSON and stream exceptions instead of echoing upstream secrets", async () => {
    const secret = "synthetic-upstream-secret-NEVER-LOG";
    const fetched = mock.method(globalThis, "fetch", async () => new Response(secret));
    const invalid = await executor.execute(input());
    assert.equal(invalid.response.status, 502);
    assert.equal((await invalid.response.text()).includes(secret), false);
    fetched.mock.restore();
    mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(
          new ReadableStream({
            pull() {
              throw new Error(secret);
            },
          })
        )
    );
    const streaming = await executor.execute({ ...input(), stream: true });
    await assert.rejects(streaming.response.text(), { message: "Venice stream failed" });
  });
});
