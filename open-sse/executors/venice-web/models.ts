import { abortError, VeniceAuthBroker, VeniceTransportError, withAbort } from "./authBroker.ts";
export const VENICE_MODELS_URL = "https://outerface.venice.ai/api/app/models";

export function parseVeniceModels(value: unknown, broker: VeniceAuthBroker) {
  const text = (value as { text?: { models?: unknown } })?.text;
  if (!text || !Array.isArray(text.models)) throw new VeniceTransportError("invalid_response", 502);
  return text.models
    .filter(
      (row): row is Record<string, unknown> =>
        !!row && typeof row === "object" && row.active === true && typeof row.id === "string"
    )
    .map((row) => {
      const id = row.id as string;
      const maxImages =
        typeof row.maxImages === "number" &&
        Number.isSafeInteger(row.maxImages) &&
        row.maxImages >= 0
          ? row.maxImages
          : null;
      if (maxImages !== null) broker.setImageLimit(id, maxImages);
      return {
        id,
        name: typeof row.friendly_name === "string" ? row.friendly_name : id,
        supportedEndpoints: ["chat"],
        apiFormat: "chat-completions",
        // Transport evidence is ephemeral and must not be persisted as catalog declarations.
        supportsVision: broker.validatedImages(id) > 0 ? true : null,
        multiImage: broker.validatedImages(id) > 1,
        structuredOutput: false,
        venice: {
          catalog: {
            supportsMultiModal: row.supportsMultiModal === true,
            supportsMultipleImages: row.supportsMultipleImages === true,
            maxImages,
            supportsResponseSchema: row.supportsResponseSchema === true,
            proOnly: row.proOnly === true,
            usesCredits: row.usesCredits === true,
            active: true,
          },
          accountAccess: broker.access(id),
          transportValidation: { nativeImageCount: broker.validatedImages(id) },
        },
      };
    });
}
export async function discoverVeniceModels(
  broker: VeniceAuthBroker,
  fetcher: typeof fetch = fetch,
  signal = AbortSignal.timeout(90_000)
) {
  try {
    return await fetchVeniceModels(broker, fetcher, signal);
  } catch (error) {
    if (signal.aborted) throw abortError(signal);
    if (error instanceof VeniceTransportError) throw error;
    throw new VeniceTransportError("transport_failure", 502);
  }
}
async function fetchVeniceModels(
  broker: VeniceAuthBroker,
  fetcher: typeof fetch,
  signal: AbortSignal
) {
  let state = await broker.acquire(signal);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await withAbort(
      fetcher(VENICE_MODELS_URL, {
        signal,
        redirect: "error",
        headers: {
          Authorization: "Bearer " + state.bearerToken.reveal(),
          "x-venice-client-attestation": state.clientAttestation.reveal(),
          Origin: "https://venice.ai",
          Referer: "https://venice.ai/",
        },
      }),
      signal
    );
    if (attempt === 0 && [401, 403].includes(response.status)) {
      void response.body?.cancel().catch(() => {});
      state = await broker.acquire(signal, state.revision);
      continue;
    }
    if (!response.ok || !response.body) {
      void response.body?.cancel().catch(() => {});
      throw new VeniceTransportError(
        response.status === 401
          ? "auth_rejected"
          : response.status === 403
            ? "permission_denied"
            : response.status === 402
              ? "billing"
              : response.status === 429
                ? "rate_limit"
                : "transport_failure",
        response.status >= 400 ? response.status : 502
      );
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const next = await withAbort(reader.read(), signal);
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 4 * 1024 * 1024) throw new VeniceTransportError("invalid_response", 502);
        chunks.push(next.value);
      }
      let json: unknown;
      try {
        json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new VeniceTransportError("invalid_response", 502);
      }
      return parseVeniceModels(json, broker);
    } finally {
      void reader.cancel().catch(() => {});
    }
  }
  throw new VeniceTransportError("auth_rejected", 401);
}
