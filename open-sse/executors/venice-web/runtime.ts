import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Server } from "node:http";
import { startAuthBrokerServer } from "./brokerServer.ts";
import { getVeniceBroker, veniceBrowserEnabled } from "./runtimeState.ts";

const key = Symbol.for("omniroute.venice.classic.server");
const scope = globalThis as typeof globalThis & { [key]?: Promise<Server> };
export function startVeniceBrowserRuntime(): Promise<Server | null> {
  if (!veniceBrowserEnabled()) return Promise.resolve(null);
  if (!scope[key]) {
    scope[key] = (async () => {
      const filename =
        process.env.OMNIROUTE_VENICE_BROWSER_CONFIG ?? path.resolve(".venice-browser/runtime.json");
      let config: { port: number; pairingKey: string; extensionId: string };
      try {
        config = JSON.parse(await readFile(filename, "utf8"));
      } catch {
        throw new Error("Venice companion not paired; run setup-venice-browser");
      }
      if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535)
        throw new Error("Invalid Venice broker port");
      return startAuthBrokerServer(getVeniceBroker(), config);
    })().catch((error) => {
      delete scope[key];
      throw error;
    });
  }
  return scope[key]!;
}
