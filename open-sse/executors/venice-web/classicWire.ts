/**
 * Classic Web wire codec verified against browser traffic on 2026-09-12.
 * Not registered as a live transport: session/attestation renewal is still unverified.
 * Classic uses raw base64 imagePath entries and newline JSON, NOT Agentic multipart/SSE.
 */
export class VeniceWireError extends Error {
  constructor(
    public readonly category:
      | "invalid_request"
      | "unsupported_content"
      | "unsupported_mime"
      | "image_limit"
      | "invalid_response",
    message: string
  ) {
    super(message);
    this.name = "VeniceWireError";
  }
}

export type VeniceImageMime = "image/png" | "image/jpeg" | "image/webp";
export type VeniceContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "image"; mimeType: VeniceImageMime; bytes: Uint8Array };
export type VeniceMessage = {
  role: "user" | "assistant" | "system";
  content: string | VeniceContentPart[];
};
export type ClassicContext = {
  modelId: string;
  userId: string;
  requestId: string;
  conversationType: string;
  clientProcessingTime: number;
  enableLargeContextChat: boolean;
  includeVeniceSystemPrompt: boolean;
  isCharacter: boolean;
  reasoning: boolean;
  simpleMode: boolean;
  systemPrompt: string;
  temperature: number;
  topP: number;
  webEnabled: boolean;
  webScrapeEnabled: boolean;
  xSearchEnabled: boolean;
};
export type ImageLimits = {
  // Caller policy, not a claim about upstream byte limits.
  maxBytesPerImage: number;
  maxImages: number;
};
const fail = (category: VeniceWireError["category"], message: string): never => {
  throw new VeniceWireError(category, message);
};

function validateLimits(limits: ImageLimits) {
  if (
    !Number.isSafeInteger(limits.maxImages) ||
    limits.maxImages < 0 ||
    !Number.isSafeInteger(limits.maxBytesPerImage) ||
    limits.maxBytesPerImage < 1
  ) {
    fail("invalid_request", "Invalid Venice image limits");
  }
}

export function prepareInlineImage(
  part: Exclude<VeniceContentPart, { type: "text" }>,
  limits: ImageLimits
): string {
  validateLimits(limits);
  let mime: string;
  let bytes: Buffer;
  if (part.type === "image_url") {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(
      part.image_url.url
    );
    if (!match)
      return fail(
        "unsupported_content",
        "Expected a PNG, JPEG or WebP data URI; resolve remote/local assets server-side first"
      );
    mime = match[1];
    const encoded = match[2];
    if (encoded.length > Math.ceil(limits.maxBytesPerImage / 3) * 4)
      fail("image_limit", "Venice image exceeds configured byte limit");
    bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) fail("invalid_request", "Invalid image base64");
  } else if (part.type === "image") {
    mime = part.mimeType;
    if (part.bytes.byteLength > limits.maxBytesPerImage)
      fail("image_limit", "Venice image exceeds configured byte limit");
    bytes = Buffer.from(part.bytes);
  } else {
    return fail("unsupported_content", "Unsupported Venice content part");
  }
  if (bytes.length === 0 || bytes.length > limits.maxBytesPerImage)
    fail("image_limit", "Empty or oversized Venice image");
  const valid =
    (mime === "image/png" && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) ||
    (mime === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
    (mime === "image/webp" &&
      bytes.subarray(0, 4).toString() === "RIFF" &&
      bytes.subarray(8, 12).toString() === "WEBP");
  if (!valid) fail("unsupported_mime", "Image MIME and file signature do not match");
  // Signature validation is not raster decoding; the caller's asset service validates images.
  return bytes.toString("base64");
}

export function buildClassicRequest(
  messages: VeniceMessage[],
  context: ClassicContext,
  limits: ImageLimits
) {
  validateLimits(limits);
  if (!context.modelId || !context.userId || !context.requestId || messages.length === 0)
    fail("invalid_request", "Missing Venice model, context or messages");
  const prompt: Array<{ role: "user" | "assistant"; content: string; imagePath?: string[] }> = [];
  const system = context.systemPrompt ? [context.systemPrompt] : [];
  let imageCount = 0;
  for (const message of messages) {
    if (!["user", "assistant", "system"].includes(message.role))
      fail("unsupported_content", "Unsupported Venice message role");
    const parts =
      typeof message.content === "string"
        ? [{ type: "text" as const, text: message.content }]
        : message.content;
    const text: string[] = [];
    const images: string[] = [];
    for (const part of parts) {
      if (part.type === "text") text.push(part.text);
      else {
        if (message.role !== "user") fail("unsupported_content", "Images require a user message");
        imageCount++;
        if (imageCount > limits.maxImages) fail("image_limit", "Too many Venice images");
        images.push(prepareInlineImage(part, limits));
      }
    }
    if (message.role === "system") system.push(text.join("\n"));
    else
      prompt.push({
        role: message.role,
        content: text.join("\n"),
        ...(images.length ? { imagePath: images } : {}),
      });
  }
  if (!prompt.length) fail("invalid_request", "Venice requires a user or assistant message");
  return { ...context, systemPrompt: system.join("\n\n"), prompt };
}

export type ClassicRecord =
  | { kind: "content"; content: string }
  | {
      kind: "meta";
      servingModelId?: string;
      completion_id?: string;
      references?: unknown[];
      augmented?: boolean;
    };

/** Bounded incremental NDJSON decoder; independent of HTTP MIME and OpenAI SSE. */
export class ClassicStreamDecoder {
  private decoder = new TextDecoder("utf-8", { fatal: true });
  private pending = "";
  private finished = false;
  constructor(private readonly maxRecordCharacters = 1_048_576) {
    if (!Number.isSafeInteger(maxRecordCharacters) || maxRecordCharacters < 1)
      fail("invalid_request", "Invalid Venice record limit");
  }
  push(chunk: Uint8Array): ClassicRecord[] {
    if (this.finished) return fail("invalid_response", "Venice stream already finished");
    let text: string;
    try {
      text = this.decoder.decode(chunk, { stream: true });
    } catch {
      return fail("invalid_response", "Invalid Venice UTF-8");
    }
    return this.consume(text, false);
  }
  finish(): ClassicRecord[] {
    if (this.finished) return [];
    this.finished = true;
    let text: string;
    try {
      text = this.decoder.decode();
    } catch {
      return fail("invalid_response", "Truncated Venice UTF-8");
    }
    return this.consume(text, true);
  }
  private consume(text: string, final: boolean): ClassicRecord[] {
    const records: ClassicRecord[] = [];
    // Split before concatenation to cap incomplete records rather than whole network chunks.
    const segments = text.split("\n");
    for (let i = 0; i < segments.length; i++) {
      if (this.pending.length + segments[i].length > this.maxRecordCharacters)
        fail("invalid_response", "Venice record exceeds configured limit");
      this.pending += segments[i];
      if (i < segments.length - 1 || final) {
        const line = this.pending.trim();
        this.pending = "";
        if (line) records.push(this.parse(line));
      }
    }
    return records;
  }
  private parse(line: string): ClassicRecord {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return fail("invalid_response", "Invalid Venice JSON record");
    }
    if (!value || typeof value !== "object")
      return fail("invalid_response", "Invalid Venice record");
    const record = value as Record<string, unknown>;
    if (record.kind === "content" && typeof record.content === "string")
      return { kind: "content", content: record.content };
    if (record.kind === "meta") {
      for (const key of ["servingModelId", "completion_id"]) {
        if (record[key] !== undefined && typeof record[key] !== "string")
          fail("invalid_response", "Invalid Venice metadata");
      }
      if (record.references !== undefined && !Array.isArray(record.references))
        fail("invalid_response", "Invalid Venice references");
      if (record.augmented !== undefined && typeof record.augmented !== "boolean")
        fail("invalid_response", "Invalid Venice metadata");
      return {
        kind: "meta",
        ...(typeof record.servingModelId === "string"
          ? { servingModelId: record.servingModelId }
          : {}),
        ...(typeof record.completion_id === "string"
          ? { completion_id: record.completion_id }
          : {}),
        ...(Array.isArray(record.references) ? { references: record.references } : {}),
        ...(typeof record.augmented === "boolean" ? { augmented: record.augmented } : {}),
      };
    }
    return fail("invalid_response", "Unsupported Venice stream record");
  }
}
