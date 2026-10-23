import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadPrivacyKey } from "../privacy-key.js";

test("macOS keeps the existing Keychain lookup, stdin creation, account binding and denial behavior", () => {
  const directory = "/private/rda-macos-contract", calls = [], hex = "a".repeat(64);
  const run = (file, args, options) => {
    calls.push({ file, args, options });
    if (calls.length === 1) throw Object.assign(new Error("not found"), { status: 44 });
    return hex + "\n";
  };
  const key = loadPrivacyKey(directory, { platform: "darwin", run });
  assert.equal(key.length, 32); key.fill(0);
  const account = createHash("sha256").update(directory).digest("hex");
  assert.equal(calls.length, 3);
  for (const call of calls) assert.equal(call.file, "/usr/bin/security");
  assert.deepEqual(calls[0].args, ["find-generic-password", "-s", "com.remote-debug-agent.business-privacy.v1", "-a", account, "-w"]);
  assert.deepEqual(calls[1].args, ["-i"]);
  assert.match(calls[1].options.input, /^add-generic-password -s com\.remote-debug-agent\.business-privacy\.v1 -a [a-f0-9]{64} -w [a-f0-9]{64}\n$/);
  assert.deepEqual(calls[2].args, calls[0].args);
  for (const status of [44, 36, 1]) {
    let count = 0;
    assert.throws(() => loadPrivacyKey(directory, { platform: "darwin", existing: true, run: () => { count++; throw { status }; } }), { code: "BUSINESS_KEYSTORE_UNAVAILABLE" });
    assert.equal(count, 1);
  }
  assert.throws(() => loadPrivacyKey(directory, { platform: "linux" }), { code: "BUSINESS_KEYSTORE_UNSUPPORTED" });
});
