import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { createHash } from "node:crypto";
import {
  VeniceAuthBroker,
  VeniceTransportError,
  SecretString,
} from "../../open-sse/executors/venice-web/authBroker.ts";
import {
  VeniceClassicTransport,
  mayUseVisionBridge,
} from "../../open-sse/executors/venice-web/classicTransport.ts";
import {
  parseVeniceModels,
  discoverVeniceModels,
} from "../../open-sse/executors/venice-web/models.ts";

const auth = {
  bearerToken: "synthetic-bearer-DO-NOT-LOG",
  clientAttestation: "synthetic-attestation-DO-NOT-LOG",
  userId: "fixture-user",
};
const model = "venice-uncensored-1-2";
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=";
const input = (count = 0, stream = false) => ({
  model,
  stream,
  body: {
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Inspect fixtures" },
          ...Array.from({ length: count }, () => ({
            type: "image_url",
            image_url: { url: "data:image/png;base64," + png },
          })),
        ],
      },
    ],
  },
});
const ndjson = () =>
  new Response(
    '{"kind":"meta","servingModelId":"fixture"}\n{"kind":"content","content":"Caffè ☕"}',
    { headers: { "Content-Type": "text/html" } }
  );
const freshBroker = () => {
  const b = new VeniceAuthBroker();
  b.submit(auth);
  return b;
};
const safe = (value: unknown) => {
  const text = JSON.stringify(value) + inspect(value);
  for (const secret of Object.values(auth).slice(0, 2)) assert.equal(text.includes(secret), false);
};

test("secrets are redacted in JSON and Node inspection; broker status has no auth", () => {
  const b = freshBroker();
  safe(b);
  safe(new SecretString(auth.bearerToken));
  b.close();
});

test("missing and expired fields fail explicitly", () => {
  const b = new VeniceAuthBroker(() => 10_000);
  for (const state of [
    { ...auth, bearerToken: "" },
    { ...auth, clientAttestation: "" },
    { ...auth, attestationExpiresAt: 9000 },
  ])
    assert.throws(() => b.submit(state), VeniceTransportError);
  b.close();
});

test("expired state single-flights a browser refresh; changed account clears validation", async () => {
  let now = 10_000;
  const b = new VeniceAuthBroker(() => now);
  b.submit({ ...auth, attestationExpiresAt: 20_000 });
  b.recordNativeSuccess(model, 2);
  now = 18_000;
  const first = b.acquire();
  const second = b.acquire();
  assert.ok(b.poll().refreshId);
  b.submit({ ...auth, userId: "second-user", attestationExpiresAt: 50_000 });
  assert.equal((await first).revision, (await second).revision);
  assert.equal(b.validatedImages(model), 0);
  b.close();
});

test("companion failure and cancelled waiter fail clearly without discarding other waiters", async () => {
  const b = new VeniceAuthBroker();
  const ac = new AbortController();
  const cancelled = b.acquire(ac.signal);
  const other = b.acquire();
  ac.abort();
  await assert.rejects(
    cancelled,
    (e: unknown) => e instanceof VeniceTransportError && e.category === "cancelled"
  );
  b.failRefresh(b.poll().refreshId!);
  await assert.rejects(
    other,
    (e: unknown) => e instanceof VeniceTransportError && e.category === "companion_unavailable"
  );
  b.close();
});

for (const count of [0, 1, 2, 3]) {
  test(`Classic ${count} images: endpoint, auth, original hashes, native diagnostic, no leaks`, async () => {
    const b = freshBroker();
    const transport = new VeniceClassicTransport(b, async (url, init) => {
      assert.equal(url, "https://outerface.venice.ai/api/inference/chat");
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer " + auth.bearerToken);
      assert.equal(
        new Headers(init?.headers).get("x-venice-client-attestation"),
        auth.clientAttestation
      );
      const wire = JSON.parse(String(init?.body));
      assert.deepEqual(wire.prompt[0].imagePath ?? [], Array(count).fill(png));
      return ndjson();
    });
    const result = await transport.execute(input(count));
    assert.equal(result.response.status, 200);
    assert.equal((await result.response.json()).choices[0].message.content, "Caffè ☕");
    assert.equal(result.diagnostics.visionPath, count ? "native" : "none");
    assert.deepEqual(
      result.diagnostics.imageHashes,
      Array(count).fill(createHash("sha256").update(Buffer.from(png, "base64")).digest("hex"))
    );
    assert.equal(b.validatedImages(model), count);
    safe(result);
    b.close();
  });
}

test("SSE converts NDJSON with one DONE and a stable completion id", async () => {
  const b = freshBroker();
  const result = await new VeniceClassicTransport(b, async () => ndjson()).execute(input(1, true));
  const text = await result.response.text();
  assert.equal(text.match(/\[DONE\]/g)?.length, 1);
  assert.match(text, /Caffè ☕/);
  assert.match(text, /"finish_reason":"stop"/);
  const events = text
    .split("\n")
    .filter((l) => l.startsWith("data: {"))
    .map((l) => JSON.parse(l.slice(6)));
  assert.equal(new Set(events.map((e) => e.id)).size, 1);
  assert.equal(b.validatedImages(model), 1);
  safe(result);
  b.close();
});

for (const status of [401, 403]) {
  test(`HTTP ${status} retries once with fresh real-state submission; then stops explicitly`, async () => {
    const b = freshBroker();
    let calls = 0;
    const transport = new VeniceClassicTransport(b, async () => {
      calls++;
      if (calls === 1) b.submit({ ...auth, bearerToken: "replacement-synthetic" });
      return new Response(auth.bearerToken, { status });
    });
    const result = await transport.execute(input(1));
    assert.equal(calls, 2);
    assert.equal(result.response.status, status);
    assert.equal(result.diagnostics.authRefreshed, true);
    assert.equal(b.validatedImages(model), 0);
    safe(await result.response.json());
    safe(result);
    b.close();
  });
}

test("401 followed by refreshed successful response completes", async () => {
  const b = freshBroker();
  let calls = 0;
  const result = await new VeniceClassicTransport(b, async () => {
    calls++;
    if (calls === 1) {
      b.submit({ ...auth, bearerToken: "fresh-synthetic" });
      return new Response("", { status: 401 });
    }
    return ndjson();
  }).execute(input());
  assert.equal(result.response.status, 200);
  assert.equal(calls, 2);
  b.close();
});

for (const status of [402, 429, 500]) {
  test(`HTTP ${status} does not auth-retry or bridge`, async () => {
    const b = freshBroker();
    let calls = 0;
    const result = await new VeniceClassicTransport(b, async () => {
      calls++;
      return new Response(auth.clientAttestation, { status });
    }).execute(input(1));
    assert.equal(calls, 1);
    assert.equal(result.response.status, status);
    safe(await result.response.json());
    b.close();
  });
}
test("fallback classification excludes auth, permission, billing and rate-limit failures", () => {
  for (const category of [
    "auth_rejected",
    "auth_expired",
    "permission_denied",
    "billing",
    "rate_limit",
  ] as const)
    assert.equal(mayUseVisionBridge(new VeniceTransportError(category, 403)), false);
  assert.equal(mayUseVisionBridge(new VeniceTransportError("unsupported_content", 415)), true);
});

test("abort during upstream read cancels the reader and returns explicit 499", async () => {
  const b = freshBroker();
  const ac = new AbortController();
  let cancelled = false;
  const transport = new VeniceClassicTransport(b, async (_url, init) => {
    assert.ok(init?.signal);
    return new Response(
      new ReadableStream({
        start() {
          setTimeout(() => ac.abort(), 5);
        },
        cancel() {
          cancelled = true;
        },
      })
    );
  });
  const result = await transport.execute({ ...input(1), signal: ac.signal });
  assert.equal(result.response.status, 499);
  assert.equal(cancelled, true);
  assert.equal(b.validatedImages(model), 0);
  b.close();
});

test("downstream stream cancellation aborts the upstream", async () => {
  const b = freshBroker();
  let upstreamSignal: AbortSignal | undefined;
  let cancelled = false;
  const result = await new VeniceClassicTransport(b, async (_u, init) => {
    upstreamSignal = init?.signal ?? undefined;
    return new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      })
    );
  }).execute(input(1, true));
  await result.response.body!.cancel();
  assert.equal(upstreamSignal?.aborted, true);
  assert.equal(cancelled, true);
  b.close();
});

test("request deadline bounds fetch even if a mock ignores AbortSignal", async () => {
  const b = freshBroker();
  const result = await new VeniceClassicTransport(
    b,
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return ndjson();
    },
    5
  ).execute(input());
  assert.equal(result.response.status, 504);
  safe(result);
  b.close();
});

test("invalid upstream stream and thrown token-bearing errors are sanitized", async () => {
  for (const fetcher of [
    async () => new Response(auth.bearerToken),
    async () => {
      throw new Error(auth.clientAttestation);
    },
  ]) {
    const b = freshBroker();
    const result = await new VeniceClassicTransport(b, fetcher).execute(input(1));
    assert.equal(result.response.status, 502);
    assert.equal(b.validatedImages(model), 0);
    safe(await result.response.json());
    safe(result);
    b.close();
  }
});

test("catalog declarations do not grant access or enable native vision", async () => {
  const b = freshBroker();
  const catalog = {
    text: {
      models: [
        {
          id: model,
          friendly_name: "Venice Uncensored 1.2",
          active: true,
          supportsMultiModal: true,
          supportsMultipleImages: true,
          maxImages: 2,
          supportsResponseSchema: true,
        },
      ],
    },
  };
  const rows = parseVeniceModels(catalog, b);
  assert.equal(rows[0].supportsVision, null);
  assert.equal(rows[0].venice.accountAccess, "unknown");
  assert.equal(rows[0].structuredOutput, false);
  assert.equal(b.imageLimit(model), 2);
  b.recordNativeSuccess(model, 2);
  b.recordAccess(model, true);
  const found = await discoverVeniceModels(b, async (url) => {
    assert.equal(url, "https://outerface.venice.ai/api/app/models");
    return Response.json(catalog);
  });
  assert.equal(found[0].supportsVision, true);
  assert.equal(found[0].multiImage, true);
  assert.equal(found[0].venice.accountAccess, "available");
  safe(found);
  b.close();
});

test("model discovery sanitizes network and stream failures", async () => {
  const b = freshBroker();
  for (const fetcher of [
    async () => {
      throw new Error(auth.bearerToken);
    },
    async () =>
      new Response(
        new ReadableStream({
          pull() {
            throw new Error(auth.clientAttestation);
          },
        })
      ),
  ]) {
    await assert.rejects(discoverVeniceModels(b, fetcher), (error: unknown) => {
      assert.ok(error instanceof VeniceTransportError);
      assert.equal(error.category, "transport_failure");
      safe(error);
      return true;
    });
  }
  b.close();
});
