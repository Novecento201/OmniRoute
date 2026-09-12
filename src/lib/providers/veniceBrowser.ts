import { createProviderConnection, getProviderConnections } from "@/lib/db/providers";
import {
  getVeniceBroker,
  veniceBrowserEnabled,
} from "@omniroute/open-sse/executors/venice-web/runtimeState.ts";

/** Passive readiness only: background health sweeps must not consume browser chat quota. */
export function getBrowserSessionReadiness(connection: {
  provider?: unknown;
  providerSpecificData?: unknown;
}) {
  if (
    connection.provider !== "venice-web" ||
    !veniceBrowserEnabled() ||
    (connection.providerSpecificData as Record<string, unknown> | null)?.authMode !== "browser"
  )
    return null;
  const status = getVeniceBroker().status();
  return {
    valid: status.connected,
    skipped: !status.connected,
    error: status.connected
      ? null
      : status.companionAvailable
        ? "Browser session will refresh on the next Classic request"
        : "Venice browser companion unavailable",
    diagnosis: null,
    latencyMs: 0,
  };
}

/** Register only the browser routing identity. Actual authentication stays in the broker. */
export async function ensureRegisteredBrowserConnection() {
  if (!veniceBrowserEnabled()) return null;
  const connections = await getProviderConnections({ provider: "venice-web" });
  const existing = connections.find(
    (connection) =>
      (connection.providerSpecificData as Record<string, unknown> | undefined)?.authMode ===
      "browser"
  );
  // Do not overwrite legacy cookie connections or reactivate a user-disabled browser row.
  if (existing) return existing;
  return createProviderConnection({
    provider: "venice-web",
    authType: "none",
    name: "Venice browser session",
    isActive: true,
    defaultModel: "venice-uncensored-1-2",
    providerSpecificData: { authMode: "browser" },
  });
}
