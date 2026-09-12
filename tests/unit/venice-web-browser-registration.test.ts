import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = mkdtempSync(path.join(os.tmpdir(), "venice-registration-"));
process.env.DATA_DIR = temp;
const { ensureDbInitialized, resetDbInstance } = await import("../../src/lib/db/core.ts");
const { getProviderConnections, updateProviderConnection } =
  await import("../../src/lib/db/providers.ts");
const { ensureRegisteredBrowserConnection, getBrowserSessionReadiness } =
  await import("../../src/lib/providers/veniceBrowser.ts");
const { getVeniceBroker } = await import("../../open-sse/executors/venice-web/runtimeState.ts");
const { isProviderConnectionUsable } =
  await import("../../src/lib/guardrails/visionBridgeCredentials.ts");
const before = process.env.OMNIROUTE_VENICE_BROWSER;
await ensureDbInitialized();
after(() => {
  getVeniceBroker().close();
  if (before === undefined) delete process.env.OMNIROUTE_VENICE_BROWSER;
  else process.env.OMNIROUTE_VENICE_BROWSER = before;
  resetDbInstance();
  rmSync(temp, { recursive: true, force: true, maxRetries: 5 });
});

test("startup registration is opt-in and idempotent, with no stored auth or placeholders", async () => {
  process.env.OMNIROUTE_VENICE_BROWSER = "0";
  assert.equal(await ensureRegisteredBrowserConnection(), null);
  process.env.OMNIROUTE_VENICE_BROWSER = "1";
  const created = await ensureRegisteredBrowserConnection();
  assert.ok(created?.id);
  assert.equal((await ensureRegisteredBrowserConnection())?.id, created.id);
  const rows = await getProviderConnections({ provider: "venice-web" });
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.authType, "none");
  for (const key of ["apiKey", "accessToken", "refreshToken", "idToken"]) assert.ok(!row[key]);
  assert.deepEqual(row.providerSpecificData, { authMode: "browser" });
  await updateProviderConnection(String(row.id), { isActive: false });
  assert.equal((await ensureRegisteredBrowserConnection())?.isActive, false);
});

test("browser readiness never grants generic keyless providers usable credentials", () => {
  process.env.OMNIROUTE_VENICE_BROWSER = "1";
  const row = {
    provider: "venice-web",
    authType: "none",
    providerSpecificData: { authMode: "browser" },
  };
  assert.equal(isProviderConnectionUsable(row), false);
  assert.equal(getBrowserSessionReadiness(row)?.skipped, true);
  assert.equal(getBrowserSessionReadiness({ ...row, provider: "openai" }), null);
  getVeniceBroker().poll();
  assert.equal(isProviderConnectionUsable(row), true);
  assert.equal(getBrowserSessionReadiness(row)?.valid, false);
  assert.equal(isProviderConnectionUsable({ ...row, provider: "openai" }), false);
  assert.equal(isProviderConnectionUsable({ ...row, providerSpecificData: {} }), false);
  assert.equal(isProviderConnectionUsable({ ...row, testStatus: "disabled" }), false);
  process.env.OMNIROUTE_VENICE_BROWSER = "0";
  assert.equal(isProviderConnectionUsable(row), false);
});
