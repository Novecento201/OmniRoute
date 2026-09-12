import { VeniceAuthBroker } from "./authBroker.ts";

// Shared across Next module bundles / reloads within the same Node process.
const key = Symbol.for("omniroute.venice.classic.broker");
const scope = globalThis as typeof globalThis & { [key]?: VeniceAuthBroker };
export function getVeniceBroker(): VeniceAuthBroker {
  return (scope[key] ??= new VeniceAuthBroker());
}
export function veniceBrowserEnabled() {
  return process.env.OMNIROUTE_VENICE_BROWSER === "1";
}
export function hasValidatedVeniceVision(model: string) {
  return veniceBrowserEnabled() && getVeniceBroker().validatedImages(model) > 0;
}
