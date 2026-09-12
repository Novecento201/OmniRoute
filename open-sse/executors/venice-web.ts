/**
 * VeniceWebExecutor — Privacy-Focused AI Chat via venice.ai
 *
 * Opt-in Classic transport uses real browser-provided Bearer + attestation.
 * Without OMNIROUTE_VENICE_BROWSER=1, preserves the legacy cookie transport.
 */
import { BaseExecutor, type ExecuteInput } from "./base.ts";
import { makeExecutorErrorResult as makeErrorResult, normalizeCookie } from "../utils/error.ts";
import { VeniceClassicTransport } from "./venice-web/classicTransport.ts";
import { getVeniceBroker, veniceBrowserEnabled } from "./venice-web/runtimeState.ts";

const BASE_URL = "https://venice.ai";
const CHAT_URL = `${BASE_URL}/api/chat`;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

export class VeniceWebExecutor extends BaseExecutor {
  constructor() {
    super("venice-web", { id: "venice-web", baseUrl: "https://venice.ai" });
  }

  async execute(input: ExecuteInput) {
    if (veniceBrowserEnabled()) {
      try {
        const { startVeniceBrowserRuntime } = await import("./venice-web/runtime.ts");
        await startVeniceBrowserRuntime();
      } catch {
        return makeErrorResult(
          503,
          "Venice browser companion unavailable",
          input.body,
          "https://outerface.venice.ai/api/inference/chat"
        );
      }
      return new VeniceClassicTransport(getVeniceBroker()).execute(input);
    }
    const { body, credentials, signal, stream: wantStream } = input;
    const bodyObj = (body || {}) as Record<string, unknown>;
    const rawCookie = normalizeCookie(String(credentials?.apiKey ?? "").trim());

    const messages = (bodyObj.messages as Array<{ role: string; content: string }>) || [];
    const modelId = (bodyObj.model as string) || "venice-default";

    const reqBody = {
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      model: modelId,
      stream: wantStream,
      max_tokens: (bodyObj.max_tokens as number) || 4096,
    };

    const reqHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      Accept: wantStream ? "text/event-stream" : "application/json",
      Referer: `${BASE_URL}/`,
      Origin: BASE_URL,
    };
    if (rawCookie) reqHeaders.Cookie = rawCookie;
    const diagnosticHeaders = { ...reqHeaders, ...(rawCookie ? { Cookie: "[REDACTED]" } : {}) };

    let upstream: Response;
    try {
      upstream = await fetch(CHAT_URL, {
        method: "POST",
        headers: reqHeaders,
        body: JSON.stringify(reqBody),
        signal,
      });
    } catch {
      return makeErrorResult(502, "Venice fetch failed", body, CHAT_URL);
    }

    if (!upstream.ok) {
      void upstream.body?.cancel().catch(() => {});
      return makeErrorResult(
        upstream.status,
        `Venice upstream request failed (HTTP ${upstream.status})`,
        body,
        CHAT_URL
      );
    }

    if (!wantStream) {
      let data: Record<string, unknown>;
      try {
        data = (await upstream.json()) as Record<string, unknown>;
      } catch {
        return makeErrorResult(502, "Venice invalid response", body, CHAT_URL);
      }
      const content =
        (data?.choices as Array<{ message?: { content?: string } }>)?.[0]?.message?.content ||
        (data?.content as string) ||
        "";
      return {
        response: new Response(
          JSON.stringify({
            id: `chatcmpl-ven-${Date.now()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: modelId,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content },
                finish_reason: "stop",
              },
            ],
          }),
          { headers: { "Content-Type": "application/json" } }
        ),
        url: CHAT_URL,
        headers: diagnosticHeaders,
        transformedBody: reqBody,
      };
    }

    // Streaming: pass through SSE
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const stream = new ReadableStream({
      async start(controller) {
        const reader = upstream.body?.getReader();
        if (!reader) {
          controller.close();
          return;
        }

        let buffer = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (!line.startsWith("data:")) continue;
              const data = line.slice(5).trim();
              if (data === "[DONE]") {
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                continue;
              }
              try {
                const parsed = JSON.parse(data);
                const text = parsed.choices?.[0]?.delta?.content || "";
                if (text) {
                  const chunk = {
                    id: `chatcmpl-ven-${Date.now()}`,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: modelId,
                    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
                  };
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                }
              } catch {
                // Skip unparseable chunks
              }
            }
          }
        } catch {
          if (!signal?.aborted) controller.error(new Error("Venice stream failed"));
          else controller.close();
          return;
        } finally {
          reader.releaseLock();
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    return {
      response: new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      }),
      url: CHAT_URL,
      headers: diagnosticHeaders,
      transformedBody: reqBody,
    };
  }
}
