import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PrivacyStore } from "../privacy-store.js";
import { loadPrivacyKey } from "../privacy-key.js";

test("real macOS Keychain creates, reopens and refuses missing credentials for an existing encrypted database", {
  skip: process.platform !== "darwin" || process.env.RDA_PRIVACY_KEYCHAIN_TEST !== "1",
}, (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rda-keychain-acceptance-"));
  const service = "com.remote-debug-agent.business-privacy.v1", account = createHash("sha256").update(directory).digest("hex");
  const remove = () => { try { execFileSync("/usr/bin/security", ["delete-generic-password", "-s", service, "-a", account], { stdio: "pipe" }); } catch {} };
  t.after(() => { remove(); fs.rmSync(directory, { recursive: true, force: true }); });
  const key = loadPrivacyKey(directory); assert.equal(key.length, 32);
  assert.deepEqual(loadPrivacyKey(directory), key);
  let store = new PrivacyStore({ directory });
  const auth = store.execute("create"); store.close();
  store = new PrivacyStore({ directory }); assert.equal(store.execute("attach", { auth }).contextId, auth.contextId); store.close();
  remove();
  assert.throws(() => new PrivacyStore({ directory }), { code: "BUSINESS_KEYSTORE_UNAVAILABLE" });
  for (const filename of fs.readdirSync(directory)) {
    const data = fs.readFileSync(path.join(directory, filename));
    for (const secret of [key, Buffer.from(key.toString("hex")), Buffer.from(key.toString("base64"))]) assert.equal(data.includes(secret), false);
  }
  key.fill(0);
});
