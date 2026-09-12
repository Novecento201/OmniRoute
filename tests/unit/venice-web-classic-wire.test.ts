import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildClassicRequest,
  ClassicStreamDecoder,
  prepareInlineImage,
  VeniceWireError,
  type ClassicContext,
  type VeniceMessage,
} from "../../open-sse/executors/venice-web/classicWire.ts";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=";
const image = { type: "image_url" as const, image_url: { url: "data:image/png;base64," + png } };
const limits = { maxImages: 10, maxBytesPerImage: 1024 };
const context: ClassicContext = {
  modelId: "venice-uncensored-1-2",
  userId: "fixture-user",
  requestId: "fixture",
  conversationType: "text",
  clientProcessingTime: 0,
  enableLargeContextChat: true,
  includeVeniceSystemPrompt: true,
  isCharacter: false,
  reasoning: false,
  simpleMode: false,
  systemPrompt: "",
  temperature: 0.7,
  topP: 0.9,
  webEnabled: true,
  webScrapeEnabled: false,
  xSearchEnabled: false,
};
const category = (name: VeniceWireError["category"]) => (error: unknown) =>
  error instanceof VeniceWireError && error.category === name;

test("JPEG neutral browser fixture preserves exact base64", () => {
  const base64 =
    "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCABAAEADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAYH/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AoAnmXAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/9k=";
  const part = {
    type: "image_url" as const,
    image_url: { url: "data:image/jpeg;base64," + base64 },
  };
  assert.equal(prepareInlineImage(part, limits), base64);
});

test("WebP neutral browser fixture preserves exact base64", () => {
  const base64 =
    "UklGRlAAAABXRUJQVlA4IEQAAAAQBACdASpAAEAAPm02mEkkIyKhIggAgA2JaQB2APwAACBupqAK8QtyAAD+8PGr//7dn9dn9dn/Xt//+B+XThiAAAAAAA==";
  const part = {
    type: "image_url" as const,
    image_url: { url: "data:image/webp;base64," + base64 },
  };
  assert.equal(prepareInlineImage(part, limits), base64);
});

test("Classic text compatibility has prompt/modelId, no OpenAI messages wrapper", () => {
  const out = buildClassicRequest([{ role: "user", content: "Hello" }], context, limits);
  assert.deepEqual(out, { ...context, prompt: [{ role: "user", content: "Hello" }] });
});

test("single PNG is exact raw base64 in imagePath, not a data URI", () => {
  const out = buildClassicRequest(
    [{ role: "user", content: [{ type: "text", text: "Inspect" }, image] }],
    context,
    limits
  );
  assert.deepEqual(out.prompt, [{ role: "user", content: "Inspect", imagePath: [png] }]);
});

test("multiple images and history preserve bytes, order and message ownership without mutation", () => {
  const second = {
    type: "image" as const,
    mimeType: "image/png" as const,
    bytes: Buffer.from(png, "base64"),
  };
  const messages: VeniceMessage[] = [
    { role: "user", content: "Earlier" },
    { role: "assistant", content: "Reply" },
    { role: "user", content: [image, { type: "text", text: "Compare" }, second] },
  ];
  const before = structuredClone(messages);
  const out = buildClassicRequest(messages, context, limits);
  assert.deepEqual(out.prompt.at(-1), { role: "user", content: "Compare", imagePath: [png, png] });
  assert.equal(out.prompt[0].imagePath, undefined);
  assert.deepEqual(structuredClone(messages), before);
});

test("system text uses separate systemPrompt; unsupported image roles fail explicitly", () => {
  const out = buildClassicRequest(
    [
      { role: "system", content: "Instructions" },
      { role: "user", content: "Hi" },
    ],
    context,
    limits
  );
  assert.equal(out.systemPrompt, "Instructions");
  assert.equal(out.prompt.length, 1);
  assert.throws(
    () => buildClassicRequest([{ role: "assistant", content: [image] }], context, limits),
    category("unsupported_content")
  );
});

test("limits reject count/bytes before serialization", () => {
  assert.throws(
    () =>
      buildClassicRequest([{ role: "user", content: [image, image] }], context, {
        ...limits,
        maxImages: 1,
      }),
    category("image_limit")
  );
  assert.throws(
    () => prepareInlineImage(image, { ...limits, maxBytesPerImage: 1 }),
    category("image_limit")
  );
  assert.throws(
    () => prepareInlineImage(image, { ...limits, maxImages: -1 }),
    category("invalid_request")
  );
});

test("remote URLs, malformed data and signature mismatches fail without echoing sensitive input", () => {
  const url = "https://example.invalid/private?token=synthetic-secret";
  assert.throws(
    () => prepareInlineImage({ type: "image_url", image_url: { url } }, limits),
    (error) => category("unsupported_content")(error) && !String(error).includes("synthetic-secret")
  );
  assert.throws(
    () =>
      prepareInlineImage(
        { type: "image_url", image_url: { url: "data:image/jpeg;base64," + png } },
        limits
      ),
    category("unsupported_mime")
  );
  assert.throws(
    () =>
      prepareInlineImage(
        { type: "image_url", image_url: { url: "data:image/png;base64,A" } },
        limits
      ),
    category("invalid_request")
  );
});

test("NDJSON decodes browser record shapes across every byte boundary and flushes EOF", () => {
  const records = [
    { kind: "meta", references: [], servingModelId: "venice-uncensored-1-2" },
    { kind: "meta", augmented: false, references: [], completion_id: "fixture-completion" },
    { kind: "content", content: "Caffè ☕" },
  ];
  const decoder = new ClassicStreamDecoder();
  const out = [];
  for (const byte of new TextEncoder().encode(records.map((x) => JSON.stringify(x)).join("\r\n"))) {
    out.push(...decoder.push(new Uint8Array([byte])));
  }
  out.push(...decoder.finish());
  assert.deepEqual(out, records);
  assert.deepEqual(decoder.finish(), []);
  assert.throws(() => decoder.push(new Uint8Array()), category("invalid_response"));
});

test("NDJSON rejects malformed records and does not echo raw upstream secrets", () => {
  for (const line of [
    "data: [DONE]",
    '{"kind":"error","message":"synthetic-secret"}',
    '{"kind":"content","content":1}',
    '{"kind":"meta","references":false}',
  ]) {
    assert.throws(
      () => new ClassicStreamDecoder().push(new TextEncoder().encode(line + "\n")),
      (error) => category("invalid_response")(error) && !String(error).includes("synthetic-secret")
    );
  }
});

test("NDJSON bounds incomplete records while allowing many small records per chunk", () => {
  const decoder = new ClassicStreamDecoder(40);
  assert.equal(
    decoder.push(new TextEncoder().encode('{"kind":"content","content":"a"}\n'.repeat(100))).length,
    100
  );
  const bounded = new ClassicStreamDecoder(10);
  bounded.push(new TextEncoder().encode("12345"));
  assert.throws(
    () => bounded.push(new TextEncoder().encode("678901")),
    category("invalid_response")
  );
});

test("NDJSON rejects truncated UTF-8 and accepts blank lines", () => {
  const decoder = new ClassicStreamDecoder();
  assert.deepEqual(decoder.push(new TextEncoder().encode("\r\n\n")), []);
  decoder.push(new Uint8Array([0xc3]));
  assert.throws(() => decoder.finish(), category("invalid_response"));
});
