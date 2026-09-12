# Venice browser authentication and Classic transport

Status on 2026-09-12: implemented behind `OMNIROUTE_VENICE_BROWSER=1`, with isolated regression evidence. **Live acceptance is pending installation of the paired Chrome companion.** Earlier browser protocol observations are not evidence that this new server transport works live. Agentic and Manga Builder production generation remain out of scope until Classic acceptance passes.

## Boundaries and source map

| Files                                                         | Responsibility                                                                                                                                                                                                         |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contrib/venice-companion/background.js`                      | Observe only real Classic requests from `https://venice.ai`; relay Bearer, attestation and user ID to the paired broker. Submit a neutral refresh probe through the real application in a companion-owned Classic tab. |
| `scripts/setup/setup-venice-browser.mjs`, `.gitignore`        | Generate a locally paired unpacked extension and runtime configuration in ignored `.venice-browser/`. Preserve pairing when updating companion code.                                                                   |
| `open-sse/executors/venice-web/authBroker.ts`                 | Memory-only secrets, redacted inspection/serialization, expiry, single-flight refresh, session-scoped capability evidence and account access.                                                                          |
| `open-sse/executors/venice-web/brokerServer.ts`               | Loopback-only HTTP broker, pinned Host and extension Origin, constant-time pairing-key verification, bounded JSON submissions and secret-free status/commands.                                                         |
| `open-sse/executors/venice-web/runtimeState.ts`, `runtime.ts` | Process singleton and opt-in listener lifecycle. Config contains the local pairing key, never Venice tokens.                                                                                                           |
| `open-sse/executors/venice-web/classicWire.ts`                | Previously audited Classic codec: `prompt[].imagePath` raw base64, PNG/JPEG/WebP signatures, order and size checks, incremental NDJSON decoder.                                                                        |
| `open-sse/executors/venice-web/classicTransport.ts`           | Fixed audited Classic endpoint, real browser auth, one auth retry, bounded request lifecycle, OpenAI JSON/SSE responses and safe diagnostics.                                                                          |
| `open-sse/executors/venice-web/models.ts`                     | Authenticated live catalog discovery with separate declared capabilities, account access and actual transport validation.                                                                                              |
| `open-sse/executors/venice-web.ts`                            | Opt-in dispatch to Classic; preserve legacy dispatch when disabled; sanitize legacy error and header metadata.                                                                                                         |
| `src/instrumentation-node.ts`                                 | Start the opted-in broker during Node startup.                                                                                                                                                                         |
| `src/app/api/providers/[id]/models/route.ts`                  | Opt-in dynamic model discovery for an existing Venice connection, without persisting transient native-vision evidence.                                                                                                 |
| `src/lib/modelCapabilities.ts`                                | In browser mode, enable Venice native vision only after a successful native image response in this process. Ignore catalog/custom overrides as proof. Other providers retain existing resolution.                      |
| `open-sse/utils/requestLogger.ts`                             | Fully redact authorization, cookies and attestation headers at client/request/response logging boundaries.                                                                                                             |
| `scripts/diagnostics/venice-browser-pilot.ts`                 | Live neutral-fixture probe through the actual executor and pre-executor components, with an isolated test database and sanitized report.                                                                               |

The existing `src/lib/guardrails/visionBridge.ts` is unchanged. Validated Venice native vision skips image description for a direct model route. Unknown/text-only capability retains the existing configured Bridge behavior. Combo routing retains upstream semantics. Native transport errors are explicit: there is currently **no automatic retry through Bridge after a native dispatch failure**. `mayUseVisionBridge` classifies only unsupported-content errors as eligible for a future optional retry; it is not a retry implementation. Authentication, entitlement, billing, rate-limit and cancellation errors must never trigger that conversion.

## Pairing and refresh

Run `node scripts/setup/setup-venice-browser.mjs` from this worktree with Node 24. Load `.venice-browser/extension` through Chrome's **Load unpacked** action. This one-time browser authorization is required before live tests. The existing ChatGPT browser extension is not this companion.

Permissions are limited to `webRequest`, `scripting`, `tabs`, `alarms`, Venice and loopback host access. No debugger or cookie-store permission is requested. The companion reads the actual outgoing Classic authorization headers; it neither manufactures tokens nor invokes the attestation-mint protocol itself. On refresh, Venice's own UI performs its normal authentication and attestation flow.

The broker listens on `127.0.0.1:20129`. The extension must present its generated pairing key; browser-origin requests must additionally match its stable extension ID. There is no endpoint that returns credentials. Keep the generated pairing files private: they authorize submission to the local broker, although they contain no Venice authentication. Files inherit the OS user-directory protections; do not describe this as encrypted storage. `.venice-browser/` is ignored by Git.

When state is missing or expired, callers share one pending refresh. The companion polls and opens an owned background Classic tab, selects the audited free model **Venice Uncensored 1.2**, and submits “OmniRoute session refresh check. Reply with OK only.” It closes only its previous owned refresh tab. This uses a real completion and may leave the neutral probe in Venice history. Existing user tabs and conversations are not used as authoritative project state.

JWT expiry metadata is read when available. Unknown attestation lifetime is conservatively cached for 30 seconds; all state is capped at 60 seconds. This is a local cache policy, not an asserted upstream expiry. Refresh has a 65-second bound; the total Classic request deadline is 90 seconds, including refresh and stream consumption. One 401/403 response requests fresh browser state and allows one replay. A second rejection remains explicit; 402 and 429 are not replayed. DOM changes, missing login, unavailable companion and blocked entitlement must not be hidden by a text fallback.

The refresh DOM interaction still needs live validation. An unknown model-picker layout fails explicitly instead of guessing an undocumented endpoint or creating synthetic attestation data. MV3 alarms wake polling while the service worker is suspended; credentials are never stored in extension storage.

## Transport and diagnostics

Classic sends `POST https://outerface.venice.ai/api/inference/chat` with the audited JSON codec and actual Bearer/attestation headers. It accepts OpenAI text content or arrays with text and PNG/JPEG/WebP **data URI** image parts. Remote URLs and local filesystem paths must first be resolved by a trusted server-side asset layer; this milestone does not implement an arbitrary URL/file reader. No upload endpoint is invented because Classic uses inline raw base64.

The local safety ceiling is ten images and 10 MiB per image; a discovered model's lower `maxImages` applies. These are not verified production upstream limits. Native success records the maximum image count actually accepted in this process, independently of catalog declarations. The catalog schema declaration does not enable strict structured output: responses may contain fenced JSON. Native tools, Agentic continuation and strict structured-output enforcement are not implemented.

NDJSON metadata records are ignored for content; content records are decoded incrementally across Unicode boundaries. Non-stream responses become OpenAI chat completions. Streaming emits OpenAI chunks, one stop chunk and one `[DONE]`; cancellation aborts the upstream and closes its reader. Parsing, transport and upstream error bodies are reduced to fixed error categories without raw exception strings.

Executor diagnostics include request ID, provider, transport, model, vision path, input image count, serialized image hashes, stream flag, latency, status, refresh and fallback flags. Success responses also expose `x-omniroute-vision-path` and `x-omniroute-venice-transport`. These are transport-level diagnostics; the full application dashboard does not yet surface every field. Neither frontend nor diagnostics receive Bearer, attestation or cookies.

## Verification and remaining acceptance

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
```

Run with Node 24, `--import tsx/esm --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts --test`, followed by the listed files. **146 focused tests pass** across these suites, with affected suites rerun after changes. Mock upstream tests prove implementation behavior, not live Venice compatibility. `npm run typecheck:core` and a standalone strict check of the new broker/transport/model modules pass. An exploratory expanded typecheck reaches hundreds of errors in existing modules outside the core gate; it is not a green full-application build. Newly introduced diagnostics-script type errors found by that check were corrected. `npm run check:docs-all` reports seven existing provider-count mismatches in the reference/SVG documentation (356 versus 358); those unrelated generated documents were left unchanged. No production Next build or end-to-end HTTP acceptance is claimed.

The live probe is:

```text
node --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts scripts/diagnostics/venice-browser-pilot.ts <existing-neutral-protocol-audit-directory>
```

It checks exact audited fixture hashes before startup, waits up to 30 minutes for the companion, then tests real text, a native bootstrap image, the request parser → reasoning normalizer → real capability resolver/Bridge → compression → translator → upstream-body → executor path with one/two/three images, WebP streaming, browser refresh after invalidation, and stream cancellation. The only model is the audited `venice-uncensored-1-2`. It checks color answers as well as payload hashes and `visionPath=native`, and records `.venice-browser/pilot-results.json` without secrets. Its temporary DB uses OmniRoute's integration-test initialization mode; it does not validate production database migrations.

This probe does not yet cover the complete Next HTTP route, connection selection or dashboard registration. After browser pairing, run it and resolve any live incompatibility; then verify the real OpenAI-compatible HTTP entry point before declaring the milestone green. Keep the full Manga Builder/ComfyUI pilot and Agentic work deferred.
