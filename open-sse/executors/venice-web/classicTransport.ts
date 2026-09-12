import { createHash, randomUUID } from "node:crypto";
import {
  buildClassicRequest,
  ClassicStreamDecoder,
  VeniceWireError,
  type VeniceMessage,
} from "./classicWire.ts";
import { abortError, VeniceAuthBroker, VeniceTransportError, withAbort } from "./authBroker.ts";

export const VENICE_CLASSIC_URL = "https://outerface.venice.ai/api/inference/chat";
export type ClassicExecuteInput = {
  model: string;
  body: unknown;
  stream: boolean;
  signal?: AbortSignal | null;
  correlationId?: string | null;
};
export function mayUseVisionBridge(error: unknown): boolean {
  return error instanceof VeniceTransportError && error.category === "unsupported_content";
}
/** Normalize delay metadata without forwarding arbitrary upstream header strings. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const normalized = value.trim();
  const delta = /^\d+$/.test(normalized);
  if (
    !delta &&
    !/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
      normalized
    )
  )
    return null;
  const seconds = delta
    ? Number(normalized)
    : Math.max(0, Math.ceil((Date.parse(normalized) - now) / 1000));
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : null;
}
function statusError(status: number): VeniceTransportError {
  return new VeniceTransportError(
    status === 401
      ? "auth_rejected"
      : status === 403
        ? "permission_denied"
        : status === 402
          ? "billing"
          : status === 429
            ? "rate_limit"
            : status === 413 || status === 415
              ? "unsupported_content"
              : "transport_failure",
    status >= 400 && status <= 599 ? status : 502
  );
}
function safeError(error: unknown, signal: AbortSignal): VeniceTransportError {
  if (signal.aborted) return abortError(signal);
  if (error instanceof VeniceTransportError) return error;
  if (error instanceof VeniceWireError)
    return new VeniceTransportError(
      error.category === "invalid_response" ? "invalid_response" : "unsupported_content",
      error.category === "invalid_response" ? 502 : 400
    );
  return new VeniceTransportError("transport_failure", 502);
}
function messagesFromBody(body: Record<string, unknown>): VeniceMessage[] {
  if (
    !Array.isArray(body.messages) ||
    body.messages.length === 0 ||
    (Array.isArray(body.tools) && body.tools.length)
  )
    throw new VeniceTransportError("unsupported_content", 400);
  // Runtime validation before entering the typed codec. No arbitrary file/URL access.
  for (const message of body.messages) {
    if (
      !message ||
      typeof message !== "object" ||
      !["system", "user", "assistant"].includes(message.role)
    )
      throw new VeniceTransportError("unsupported_content", 400);
    if (typeof message.content === "string") continue;
    if (!Array.isArray(message.content)) throw new VeniceTransportError("unsupported_content", 400);
    for (const part of message.content) {
      if (
        !part ||
        typeof part !== "object" ||
        !(
          (part.type === "text" && typeof part.text === "string") ||
          (part.type === "image_url" && typeof part.image_url?.url === "string")
        )
      )
        throw new VeniceTransportError("unsupported_content", 400);
    }
  }
  return body.messages as VeniceMessage[];
}

export class VeniceClassicTransport {
  constructor(
    private readonly broker: VeniceAuthBroker,
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = 90_000
  ) {}

  async execute(input: ClassicExecuteInput) {
    const controller = new AbortController();
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const signal = AbortSignal.any([
      controller.signal,
      deadline,
      ...(input.signal ? [input.signal] : []),
    ]);
    const started = Date.now();
    const body = (input.body ?? {}) as Record<string, unknown>;
    const model = typeof body.model === "string" ? body.model : input.model;
    const id = "chatcmpl-ven-" + randomUUID();
    const created = Math.floor(Date.now() / 1000);
    let imageCount = 0;
    const diagnostics = {
      provider: "venice-web",
      transport: "classic",
      visionPath: "none",
      model,
      imageCount,
      fallbackUsed: false,
      imageHashes: [] as string[],
      stream: input.stream,
      requestId: input.correlationId ?? id,
      latencyMs: 0,
      status: "pending",
      authRefreshed: false,
      retryAfterSeconds: null as number | null,
    };
    const headers = { authorization: "[REDACTED]", "x-venice-client-attestation": "[REDACTED]" };
    const metadata = { url: VENICE_CLASSIC_URL, headers, transformedBody: body, diagnostics };
    try {
      const messages = messagesFromBody(body);
      diagnostics.imageCount = messages.reduce(
        (count, message) =>
          count +
          (Array.isArray(message.content)
            ? message.content.filter((part) => part.type === "image_url").length
            : 0),
        0
      );
      const neededRefresh = !this.broker.valid();
      let state = await this.broker.acquire(signal);
      diagnostics.authRefreshed = neededRefresh;
      // Values observed for Venice Uncensored 1.2; model-specific overrides come from the request.
      const wire = buildClassicRequest(
        messages,
        {
          modelId: model,
          userId: state.userId,
          requestId: randomUUID().replaceAll("-", "").slice(0, 7),
          conversationType: "text",
          clientProcessingTime: 0,
          enableLargeContextChat: true,
          includeVeniceSystemPrompt: true,
          isCharacter: false,
          reasoning: body.reasoning === true,
          simpleMode: false,
          systemPrompt: "",
          temperature: typeof body.temperature === "number" ? body.temperature : 0.7,
          topP: typeof body.top_p === "number" ? body.top_p : 0.9,
          webEnabled: false,
          webScrapeEnabled: false,
          xSearchEnabled: false,
        },
        { maxImages: this.broker.imageLimit(model), maxBytesPerImage: 10 * 1024 * 1024 }
      );
      const images = wire.prompt.flatMap((m) => m.imagePath ?? []);
      imageCount = images.length;
      diagnostics.imageCount = imageCount;
      diagnostics.imageHashes = images.map((b) =>
        createHash("sha256").update(Buffer.from(b, "base64")).digest("hex")
      );
      let upstream: Response | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (signal.aborted) throw abortError(signal);
        wire.userId = state.userId;
        upstream = await withAbort(
          this.fetcher(VENICE_CLASSIC_URL, {
            method: "POST",
            redirect: "error",
            signal,
            headers: {
              "Content-Type": "application/json",
              Accept: "*/*",
              Origin: "https://venice.ai",
              Referer: "https://venice.ai/",
              Authorization: "Bearer " + state.bearerToken.reveal(),
              "x-venice-client-attestation": state.clientAttestation.reveal(),
            },
            body: JSON.stringify(wire),
          }),
          signal
        );
        if (attempt === 0 && [401, 403].includes(upstream.status)) {
          void upstream.body?.cancel().catch(() => {});
          state = await this.broker.acquire(signal, state.revision);
          diagnostics.authRefreshed = true;
          continue;
        }
        break;
      }
      if (!upstream?.ok) {
        if (upstream?.status === 429)
          diagnostics.retryAfterSeconds = parseRetryAfter(upstream.headers.get("retry-after"));
        if (upstream?.status === 401) this.broker.invalidate(state.revision);
        if (upstream && [402, 403].includes(upstream.status))
          this.broker.recordAccess(model, false, state.userId);
        if (upstream) void upstream.body?.cancel().catch(() => {});
        throw statusError(upstream?.status ?? 502);
      }
      if (!upstream.body) throw new VeniceTransportError("invalid_response", 502);
      const reader = upstream.body.getReader();
      const broker = this.broker;
      const decode = async function* () {
        const decoder = new ClassicStreamDecoder();
        let characters = 0;
        try {
          while (true) {
            const next = await withAbort(reader.read(), signal);
            const records = next.done ? decoder.finish() : decoder.push(next.value);
            for (const record of records) {
              if (record.kind !== "content") continue;
              characters += record.content.length;
              if (characters > 16 * 1024 * 1024)
                throw new VeniceTransportError("invalid_response", 502);
              if (record.content) yield record.content;
            }
            if (next.done) break;
          }
          if (!characters) throw new VeniceTransportError("invalid_response", 502);
          if (imageCount) broker.recordNativeSuccess(model, imageCount, state.userId);
          broker.recordAccess(model, true, state.userId);
          diagnostics.status = "success";
        } finally {
          void reader.cancel().catch(() => {});
          diagnostics.latencyMs = Date.now() - started;
        }
      };
      diagnostics.visionPath = imageCount ? "native" : "none";
      const responseHeaders = {
        "x-omniroute-vision-path": diagnostics.visionPath,
        "x-omniroute-venice-transport": "classic",
        "Cache-Control": "no-store",
      };
      if (!input.stream) {
        let content = "";
        for await (const text of decode()) content += text;
        return {
          ...metadata,
          response: Response.json(
            {
              id,
              object: "chat.completion",
              created,
              model,
              choices: [
                { index: 0, message: { role: "assistant", content }, finish_reason: "stop" },
              ],
            },
            { headers: responseHeaders }
          ),
        };
      }
      const iterator = decode();
      const encoder = new TextEncoder();
      const chunk = (delta: unknown, finish_reason: string | null) =>
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta, finish_reason }],
        })}\n\n`;
      const stream = new ReadableStream<Uint8Array>({
        async pull(target) {
          try {
            const next = await iterator.next();
            if (next.done) {
              target.enqueue(encoder.encode(chunk({}, "stop") + "data: [DONE]\n\n"));
              target.close();
            } else target.enqueue(encoder.encode(chunk({ content: next.value }, null)));
          } catch (error) {
            const safe = safeError(error, signal);
            diagnostics.status = safe.category;
            diagnostics.latencyMs = Date.now() - started;
            target.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ error: { message: safe.message, code: safe.category } })}\n\ndata: [DONE]\n\n`
              )
            );
            target.close();
          }
        },
        async cancel() {
          controller.abort(new DOMException("Cancelled", "AbortError"));
          diagnostics.status = "cancelled";
          diagnostics.latencyMs = Date.now() - started;
          void reader.cancel().catch(() => {});
          await iterator.return(undefined);
        },
      });
      return {
        ...metadata,
        response: new Response(stream, {
          headers: { ...responseHeaders, "Content-Type": "text/event-stream" },
        }),
      };
    } catch (error) {
      const safe = safeError(error, signal);
      controller.abort();
      diagnostics.status = safe.category;
      diagnostics.latencyMs = Date.now() - started;
      return {
        ...metadata,
        response: Response.json(
          { error: { message: safe.message, type: "upstream_error", code: safe.category } },
          {
            status: safe.status,
            headers:
              diagnostics.retryAfterSeconds !== null
                ? { "Retry-After": String(diagnostics.retryAfterSeconds) }
                : undefined,
          }
        ),
      };
    }
  }
}
