/** Internal metadata only: never derive these fields from upstream HTTP headers or bodies. */
export interface VeniceResponseDiagnostics {
  provider: "venice-web";
  transport: "classic";
  visionPath: "native" | "bridge" | "none";
  imageCount: number;
}

export function readVeniceResponseDiagnostics(
  provider: string | null | undefined,
  value: unknown
): VeniceResponseDiagnostics | undefined {
  if (provider !== "venice-web" && provider !== "ven") return undefined;
  if (!value || typeof value !== "object") return undefined;
  const diagnostic = value as Record<string, unknown>;
  if (
    diagnostic.provider !== "venice-web" ||
    diagnostic.transport !== "classic" ||
    (diagnostic.visionPath !== "native" &&
      diagnostic.visionPath !== "bridge" &&
      diagnostic.visionPath !== "none") ||
    !Number.isSafeInteger(diagnostic.imageCount) ||
    (diagnostic.imageCount as number) < 0 ||
    (diagnostic.imageCount as number) > 10
  ) {
    return undefined;
  }
  return {
    provider: "venice-web",
    transport: "classic",
    visionPath: diagnostic.visionPath as VeniceResponseDiagnostics["visionPath"],
    imageCount: diagnostic.imageCount as number,
  };
}

export function buildExecutorDiagnosticHeaders(
  provider: string | null | undefined,
  diagnostics: VeniceResponseDiagnostics | undefined
): Record<string, string> {
  // Validate again at the public boundary, including the actual selected provider.
  const safe = readVeniceResponseDiagnostics(provider, diagnostics);
  return safe
    ? {
        "x-omniroute-vision-path": safe.visionPath,
        "x-omniroute-venice-transport": safe.transport,
        "x-omniroute-image-count": String(safe.imageCount),
      }
    : {};
}
