import { mkdir, writeFile, copyFile, access } from "node:fs/promises";
import { generateKeyPairSync, createHash, randomBytes } from "node:crypto";
import path from "node:path";

const root = path.resolve(".venice-browser");
const extension = path.join(root, "extension");
await mkdir(extension, { recursive: true });
await copyFile(
  path.resolve("contrib/venice-companion/background.js"),
  path.join(extension, "background.js")
);
try {
  await access(path.join(root, "runtime.json"));
  console.log("Existing pairing preserved. Companion:", extension);
  process.exit(0);
} catch {
  /* First setup. */
}
const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const der = publicKey.export({ type: "spki", format: "der" });
const extensionId = [...createHash("sha256").update(der).digest().subarray(0, 16)]
  .map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15)))
  .join("");
const pairingKey = randomBytes(32).toString("base64url");
const port = 20129;
await writeFile(
  path.join(root, "runtime.json"),
  JSON.stringify({ port, extensionId, pairingKey }),
  { mode: 0o600 }
);
await writeFile(
  path.join(extension, "config.js"),
  "const VENICE_BROKER_CONFIG = " +
    JSON.stringify({ url: "http://127.0.0.1:" + port, key: pairingKey }) +
    ";\n",
  { mode: 0o600 }
);
await writeFile(
  path.join(extension, "manifest.json"),
  JSON.stringify(
    {
      manifest_version: 3,
      name: "OmniRoute Venice Auth Companion",
      version: "0.1.0",
      description:
        "Relays real Venice browser authentication to your paired local OmniRoute process.",
      key: der.toString("base64"),
      permissions: ["webRequest", "scripting", "tabs", "alarms"],
      host_permissions: [
        "https://venice.ai/*",
        "https://outerface.venice.ai/*",
        "http://127.0.0.1/*",
      ],
      background: { service_worker: "background.js" },
    },
    null,
    2
  )
);
console.log("Companion prepared:", extension);
console.log(
  "Venice tokens are never stored here. Start OmniRoute with OMNIROUTE_VENICE_BROWSER=1."
);
