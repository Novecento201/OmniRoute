# Venice browser authentication and Classic transport

Status on 2026-09-12: **Auth + live Classic transport acceptance passed** with `venice-uncensored-1-2` (Venice Uncensored 1.2), behind `OMNIROUTE_VENICE_BROWSER=1`. The authorized browser companion supplied real authentication. A live harness exercised the actual OpenAI-compatible POST route and handler over loopback HTTP: text, one/two/three native images, WebP streaming, browser renewal and cancellation passed. This is transport/route acceptance, not a production Next server or Manga Builder production acceptance. Agentic and the Manga Builder/ComfyUI pilot remain separate milestones.

## Boundaries and source map

| Files                                                                                                                                                                                                                         | Responsibility                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contrib/venice-companion/background.js`                                                                                                                                                                                      | Observe only real Classic requests from `https://venice.ai`; relay Bearer, attestation and user ID to the paired broker. Submit a neutral refresh probe through the real application in a companion-owned Classic tab. |
| `scripts/setup/setup-venice-browser.mjs`, `.gitignore`                                                                                                                                                                        | Generate a locally paired unpacked extension and runtime configuration in ignored `.venice-browser/`. Preserve pairing when updating companion code.                                                                   |
| `open-sse/executors/venice-web/authBroker.ts`                                                                                                                                                                                 | Memory-only secrets, redacted inspection/serialization, expiry, single-flight refresh, session-scoped capability evidence and account access.                                                                          |
| `open-sse/executors/venice-web/brokerServer.ts`                                                                                                                                                                               | Loopback-only HTTP broker, pinned Host and extension Origin, constant-time pairing-key verification, bounded JSON submissions and secret-free status/commands.                                                         |
| `open-sse/executors/venice-web/runtimeState.ts`, `runtime.ts`                                                                                                                                                                 | Process singleton and opt-in listener lifecycle. Config contains the local pairing key, never Venice tokens.                                                                                                           |
| `open-sse/executors/venice-web/classicWire.ts`                                                                                                                                                                                | Previously audited Classic codec: `prompt[].imagePath` raw base64, PNG/JPEG/WebP signatures, order and size checks, incremental NDJSON decoder.                                                                        |
| `open-sse/executors/venice-web/classicTransport.ts`                                                                                                                                                                           | Fixed audited Classic endpoint, real browser auth, one auth retry, bounded request lifecycle, OpenAI JSON/SSE responses and safe diagnostics.                                                                          |
| `open-sse/executors/venice-web/models.ts`                                                                                                                                                                                     | Authenticated live catalog discovery with separate declared capabilities, account access and actual transport validation.                                                                                              |
| `open-sse/executors/venice-web.ts`                                                                                                                                                                                            | Opt-in dispatch to Classic; preserve legacy dispatch when disabled; sanitize legacy error and header metadata.                                                                                                         |
| `src/instrumentation-node.ts`, `src/lib/providers/veniceBrowser.ts`                                                                                                                                                           | Start the opted-in broker and idempotently register a browser-session connection without API keys, tokens or placeholder credentials. Preserve an explicitly inactive connection.                                      |
| `src/lib/guardrails/visionBridgeCredentials.ts`, `src/app/api/providers/[id]/test/route.ts`                                                                                                                                   | Recognize only explicitly marked browser connections and report passive session readiness without quota-consuming health completions. Readiness does not grant vision capability.                                      |
| `src/app/api/providers/[id]/models/route.ts`                                                                                                                                                                                  | Opt-in dynamic model discovery for an existing Venice connection, without persisting transient native-vision evidence.                                                                                                 |
| `src/lib/modelCapabilities.ts`                                                                                                                                                                                                | In browser mode, enable Venice native vision only after a successful native image response in this process. Ignore catalog/custom overrides as proof. Other providers retain existing resolution.                      |
| `open-sse/utils/requestLogger.ts`                                                                                                                                                                                             | Fully redact authorization, cookies and attestation headers at client/request/response logging boundaries.                                                                                                             |
| `scripts/diagnostics/venice-browser-pilot.ts`                                                                                                                                                                                 | Live neutral-fixture probe through the actual executor and pre-executor components, with an isolated test database and sanitized report.                                                                               |
| `scripts/diagnostics/venice-browser-http-pilot.ts`                                                                                                                                                                            | Live fixture-only harness around the actual POST route, full handler, connection selection and transport; isolated DB; assert original hashes, public diagnostics and zero Bridge calls.                               |
| `open-sse/handlers/chatCore/executorDiagnostics.ts`                                                                                                                                                                           | Allowlist trusted internal Venice Classic diagnostic fields and build public response headers. Never derive these fields from upstream headers or response bodies.                                                     |
| `open-sse/handlers/chatCore.ts`, `open-sse/handlers/chatCore/{upstreamTimeouts,providerExecutionPipeline,nonStreamingProviderLeg,nonStreamingResponseHeaders,streamingResponseHeaders}.ts`, `src/lib/skills/toolLoopTypes.ts` | Carry trusted executor diagnostics through JSON and streaming response paths, including provider-leg changes, without changing other providers' metadata behavior.                                                     |

The existing `src/lib/guardrails/visionBridge.ts` is unchanged. Validated Venice native vision skips image description for a direct model route. Unknown/text-only capability retains the existing configured Bridge behavior. Combo routing retains upstream semantics. Native transport errors are explicit: there is currently **no automatic retry through Bridge after a native dispatch failure**. `mayUseVisionBridge` classifies only unsupported-content errors as eligible for a future optional retry; it is not a retry implementation. Authentication, entitlement, billing, rate-limit and cancellation errors must never trigger that conversion.

## Pairing and refresh

Run `node scripts/setup/setup-venice-browser.mjs` from this worktree with Node 24. Load `.venice-browser/extension` through Chrome's **Load unpacked** action. This one-time browser authorization is required before live tests. The existing ChatGPT browser extension is not this companion.

Permissions are limited to `webRequest`, `scripting`, `tabs`, `alarms`, Venice and loopback host access. No debugger or cookie-store permission is requested. The companion reads the actual outgoing Classic authorization headers; it neither manufactures tokens nor invokes the attestation-mint protocol itself. On refresh, Venice's own UI performs its normal authentication and attestation flow.

The broker listens on `127.0.0.1:20129`. The extension must present its generated pairing key; browser-origin requests must additionally match its stable extension ID. There is no endpoint that returns credentials. Keep the generated pairing files private: they authorize submission to the local broker, although they contain no Venice authentication. Files inherit the OS user-directory protections; do not describe this as encrypted storage. `.venice-browser/` is ignored by Git.

When state is missing or expired, callers share one pending refresh. The companion polls and opens an owned background Classic tab, selects the audited model **Venice Uncensored 1.2**, and submits “OmniRoute session refresh check. Reply with OK only.” It closes only its previous owned refresh tab. This uses a real completion, is subject to account quota and may leave the neutral probe in Venice history. Existing user tabs and conversations are not used as authoritative project state.

JWT expiry metadata is read when available. Unknown attestation lifetime is conservatively cached for 30 seconds; all state is capped at 60 seconds. This is a local cache policy, not an asserted upstream expiry. Refresh has a 65-second bound; the total Classic request deadline is 90 seconds, including refresh and stream consumption. One 401/403 response requests fresh browser state and allows one replay. A second rejection remains explicit; 402 and 429 are not replayed. DOM changes, missing login, unavailable companion and blocked entitlement must not be hidden by a text fallback.

The refresh DOM interaction passed live, including reacquisition after explicit broker invalidation. A random per-process refresh-ID starting value prevents the installed companion from mistaking a restarted broker's first request for an old command. An unknown model-picker layout fails explicitly instead of guessing an undocumented endpoint or creating synthetic attestation data. MV3 alarms wake polling while the service worker is suspended; credentials are never stored in extension storage.

Startup creates only an `authType: "none"` connection marked with `providerSpecificData.authMode: "browser"`. It stores no Bearer, attestation, cookie, API key or fake credential. Passive health checks distinguish connected state from an idle session needing refresh. The next completion performs the bounded refresh; generic keyless providers retain their existing readiness rules.

## Transport and diagnostics

Classic sends `POST https://outerface.venice.ai/api/inference/chat` with the audited JSON codec and actual Bearer/attestation headers. It accepts OpenAI text content or arrays with text and PNG/JPEG/WebP **data URI** image parts. Remote URLs and local filesystem paths must first be resolved by a trusted server-side asset layer; this milestone does not implement an arbitrary URL/file reader. No upload endpoint is invented because Classic uses inline raw base64.

The local safety ceiling is ten images and 10 MiB per image; a discovered model's lower `maxImages` applies. The observed catalog declared ten for the tested model; **three images were tested live**, not ten. These are not verified production upstream limits. Native success records the maximum image count actually accepted in this process, independently of catalog declarations. Validation is ephemeral: after a process restart, a successful native bootstrap must establish evidence again. The diagnostic harness makes that real direct-executor request before testing the full route with Bridge enabled. The catalog schema declaration does not enable strict structured output: live responses included fenced JSON. Native tools, Agentic continuation and strict structured-output enforcement are not implemented.

NDJSON metadata records are ignored for content; content records are decoded incrementally across Unicode boundaries. Non-stream responses become OpenAI chat completions. Streaming emits OpenAI chunks, one stop chunk and one `[DONE]`; cancellation aborts the upstream and closes its reader. Parsing, transport and upstream error bodies are reduced to fixed error categories without raw exception strings.

Executor diagnostics include request ID, provider, transport, model, vision path, input image count, serialized image hashes, stream flag, latency, status, refresh and fallback flags. A 429 response includes only a validated numeric `Retry-After`, parsed from a delta or HTTP date, and a `retryAfterSeconds` diagnostic. The transport does not automatically retry rate limits.

Successful JSON and SSE responses through the actual HTTP route expose `x-omniroute-vision-path`, `x-omniroute-venice-transport` and `x-omniroute-image-count`. These values come from a strict internal allowlist that verifies the actual selected provider, Classic transport and bounded image count. Upstream `x-omniroute-*` headers remain stripped, so an upstream cannot spoof these diagnostics. The dashboard does not yet surface every diagnostic field. Neither frontend nor diagnostics receive Bearer, attestation or cookies.

## Verification

Focused suites cover legacy text/SSE, complete redaction, loopback pairing and Host/Origin rejection, expiry and concurrent renewal, one 401/403 retry, permission/billing/rate-limit errors, inline hashes and ordering, Unicode NDJSON/SSE, invalid upstream responses, deadlines, cancellation, dynamic capabilities, Bridge skip and non-Venice regressions:

```text
tests/unit/executor-venice-web.test.ts
tests/unit/venice-web-auth-broker.test.ts
tests/unit/venice-web-classic-transport.test.ts
tests/unit/venice-web-classic-wire.test.ts
tests/unit/venice-web-image-path.test.ts
tests/unit/guardrails/visionBridge.test.ts
tests/unit/chatcore-upstream-body.test.ts
tests/unit/model-capabilities-registry.test.ts
tests/unit/request-logger-endpoints.test.ts
tests/unit/venice-http-diagnostics.test.ts
tests/unit/provider-execution-pipeline.test.ts
tests/unit/chatcore-nonstreaming-response-headers.test.ts
tests/unit/chatcore-streaming-response-headers.test.ts
tests/unit/chatcore-upstream-timeouts.test.ts
tests/unit/non-streaming-provider-leg.test.ts
tests/unit/upstream-response-headers-strip.test.ts
tests/unit/executor-contract-violation-terminal.test.ts
tests/unit/venice-web-browser-registration.test.ts
tests/unit/guardrails/visionBridgeCredentials.test.ts
tests/unit/venice-web-http-routing.test.ts
```

Run with Node 24, `--import tsx/esm --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts --test`, followed by the listed files. **259 focused tests pass**, with zero failures or skips. This includes real-route tests with an isolated mocked executor and all external network access disabled; those tests are separate from the live evidence below. The tests also cover broker restarts, sanitized Retry-After parsing, keyless connection registration, passive health checks and diagnostic-header spoofing rejection. `npm run typecheck:core` and the focused lint checks pass. A standalone strict check of the new broker/transport/model modules also passed during implementation.

An exploratory expanded typecheck reaches hundreds of existing errors outside the core gate; it is not a green full-application build. The full documentation check reports seven existing provider-count mismatches in reference/SVG documentation (356 versus 358). Those unrelated generated documents were left unchanged. No production Next build is claimed.

The live route probe is:

```text
node --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts scripts/diagnostics/venice-browser-http-pilot.ts <existing-neutral-protocol-audit-directory>
```

It checks the existing neutral fixtures' SHA-256 values before startup. `--check-fixtures` validates those files without starting services or making live calls. The full run uses a temporary DB in OmniRoute's integration-test initialization mode, a random loopback port and a local test nonce. It seeds a marked keyless browser connection, then executes the actual `src/app/api/v1/chat/completions/route.ts` POST handler and normal handler stack with real Venice dispatch. Retries, caching, stream recovery and unrelated fallback routes are disabled in the isolated test settings. Bridge stays enabled; the test asserts its actual invocation count remains zero after real native bootstrap. No production manga assets are used.

The successful report `.venice-browser/http-pilot-results.json` completed at **2026-09-12T06:39:05.518Z**:

| Live operation                     | Result                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------- |
| Native bootstrap and text          | HTTP 200; red recognized and text returned `OK`                                               |
| One PNG                            | HTTP 200; red recognized; original byte hash matched                                          |
| Two PNGs                           | HTTP 200; red/blue recognized in order; both hashes matched                                   |
| Two PNGs plus one JPEG             | HTTP 200; red/blue/green recognized in order; all three hashes matched                        |
| WebP with SSE                      | HTTP 200; orange recognized; hash matched; exactly one `[DONE]`                               |
| Browser renewal after invalidation | Fresh state acquired through the real browser; routed completion returned `OK`                |
| Stream cancellation                | Upstream diagnostic reached `cancelled`                                                       |
| Connection persistence             | Zero stored credential fields                                                                 |
| All routed native-image requests   | `visionPath=native`, `transport=classic`, correct image-count header, zero Bridge invocations |

The report contains only allowlisted diagnostics and neutral responses. The successful run predates a diagnostic-only correction: its `authRefreshed` flag counted 401/403 replays, so it is false on initial acquisition and forced-invalidation renewal. The current implementation also marks initial acquisition refresh; a regression test covers that change. Historical report values are retained unchanged.

The earlier component probe remains available as `scripts/diagnostics/venice-browser-pilot.ts` and writes `.venice-browser/pilot-results.json`. The probes pace requests by 20 seconds and permit one bounded 429 retry after at least 60 seconds, respecting a usable upstream Retry-After up to 120 seconds; this is test pacing, not a transport retry policy. Earlier attempts exposed a daily chat quota and a refresh-command collision after broker restart. The restart bug was fixed and regression-tested; after account quota became available, the complete live route probe passed. Color checks validate these neutral fixtures, not manga identity/anatomy quality.

The live harness covers the real POST route and connection-selection logic over loopback HTTP, but not the Next network server, URL rewrites, dashboard authentication, production database migrations or startup registration against a production DB. Registration is covered by isolated tests. Packaging/startup verification, persistent model-validation UX, server-side asset resolution, optional post-dispatch Bridge fallback, Agentic and the Manga Builder/ComfyUI one-panel pilot remain separate work. There is no remaining blocker to this scoped Classic transport acceptance.
