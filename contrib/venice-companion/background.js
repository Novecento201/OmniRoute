/* global chrome, VENICE_BROKER_CONFIG */
importScripts("config.js");
// Dedicated companion: never injects fake auth, reads cookies, or mints attestations.
const endpoint = "https://outerface.venice.ai/api/inference/chat";
const requests = new Map();
let refreshTab;
let refreshing = false;
let lastRefresh = null;
async function broker(path, body) {
  const response = await fetch(VENICE_BROKER_CONFIG.url + path, {
    method: body ? "POST" : "GET",
    cache: "no-store",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      "X-OmniRoute-Broker-Key": VENICE_BROKER_CONFIG.key,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("Broker unavailable");
  return response.status === 204 ? null : response.json();
}
function expiry(token) {
  // Read ordinary JWT expiry metadata only. No signatures or attestation algorithm are synthesized.
  try {
    const raw = token.split(".")[1].replaceAll("-", "+").replaceAll("_", "/");
    const exp = JSON.parse(atob(raw)).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (
      details.url !== endpoint ||
      details.method !== "POST" ||
      details.initiator !== "https://venice.ai"
    )
      return;
    try {
      // Extract only userId. Prompt, image bytes and conversation history are never retained.
      const chunks = details.requestBody?.raw ?? [];
      const size = chunks.reduce((n, c) => n + (c.bytes?.byteLength ?? 0), 0);
      if (size > 32 * 1024 * 1024) return;
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const c of chunks) {
        if (c.bytes) {
          bytes.set(new Uint8Array(c.bytes), offset);
          offset += c.bytes.byteLength;
        }
      }
      const userId = JSON.parse(new TextDecoder().decode(bytes)).userId;
      if (typeof userId !== "string") return;
      if (requests.size > 32) requests.clear();
      requests.set(details.requestId, { userId, at: Date.now() });
    } catch {
      /* No raw parsing errors or source payloads in logs. */
    }
  },
  { urls: [endpoint + "*"] },
  ["requestBody"]
);
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const request = requests.get(details.requestId);
    requests.delete(details.requestId);
    if (!request || Date.now() - request.at > 5000 || details.url !== endpoint) return;
    const headers = new Map(
      (details.requestHeaders ?? []).map((h) => [h.name.toLowerCase(), h.value])
    );
    const authorization = headers.get("authorization");
    const attestation = headers.get("x-venice-client-attestation");
    if (!authorization?.startsWith("Bearer ") || !attestation) return;
    const bearer = authorization.slice(7);
    // Tokens exist only in this callback and the memory-only server broker.
    void broker("/state", {
      bearerToken: bearer,
      clientAttestation: attestation,
      userId: request.userId,
      bearerExpiresAt: expiry(bearer),
      attestationExpiresAt: expiry(attestation),
    }).catch(() => {});
  },
  { urls: [endpoint + "*"] },
  ["requestHeaders", "extraHeaders"]
);

// Runs only in a companion-owned Classic tab. The Venice application performs its normal auth/mint flow.
async function submitRefreshProbe() {
  const until = Date.now() + 18_000;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let textarea;
  while (Date.now() < until) {
    textarea = document.querySelector("textarea");
    if (textarea) break;
    await sleep(250);
  }
  if (!textarea) return false; // Login/permission pages must remain explicit.
  const visibleButtons = () =>
    [...document.querySelectorAll("button")].filter((b) => b.getClientRects().length);
  let selected = visibleButtons().find((b) => b.textContent.trim() === "Venice Uncensored 1.2");
  if (!selected) {
    const picker = visibleButtons().find((b) =>
      /^(Auto|Qwen 3\.8 Max|Qwen 3\.7 Plus|Google Gemma 4 31B Instruct)$/.test(b.textContent.trim())
    );
    if (!picker) return false;
    picker.click();
    await sleep(350);
    const choice = [...document.querySelectorAll("*")].find(
      (e) =>
        e.children.length === 0 &&
        e.textContent.trim() === "Venice Uncensored 1.2" &&
        e.getClientRects().length
    );
    if (!choice) return false;
    choice.click();
    await sleep(350);
    selected = visibleButtons().find((b) => b.textContent.trim() === "Venice Uncensored 1.2");
    if (!selected) return false;
  }
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (!setter) return false;
  setter.call(textarea, "OmniRoute session refresh check. Reply with OK only.");
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(200);
  const submit = document.querySelector('button[aria-label="Submit chat"]');
  if (!submit || submit.disabled) return false;
  submit.click();
  return true;
}
async function refresh(id) {
  if (refreshing) return;
  refreshing = true;
  try {
    if (refreshTab) {
      try {
        await chrome.tabs.remove(refreshTab);
      } catch {
        /* Already closed. */
      }
    }
    const tab = await chrome.tabs.create({ url: "https://venice.ai/chat/classic", active: false });
    refreshTab = tab.id;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, 12_000);
      const listener = (tabId, change) => {
        if (tabId === refreshTab && change.status === "complete") {
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
    const results = await chrome.scripting.executeScript({
      target: { tabId: refreshTab },
      func: submitRefreshProbe,
    });
    if (!results[0]?.result) await broker("/refresh-failed", { refreshId: id });
  } catch {
    await broker("/refresh-failed", { refreshId: id }).catch(() => {});
  } finally {
    refreshing = false;
  }
}
async function poll() {
  try {
    const command = await broker("/poll");
    if (command.refreshId !== null && command.refreshId !== lastRefresh) {
      lastRefresh = command.refreshId;
      void refresh(command.refreshId);
    }
  } catch {
    /* Broker offline: no credentials and no raw error are logged. */
  }
}
chrome.alarms.create("venice-broker", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => void poll());
chrome.runtime.onStartup.addListener(() => void poll());
chrome.runtime.onInstalled.addListener(() => void poll());
setInterval(() => void poll(), 2000);
void poll();
