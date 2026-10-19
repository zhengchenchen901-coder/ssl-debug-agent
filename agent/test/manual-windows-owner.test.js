import assert from "node:assert/strict";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { ManualOwnerVerification } from "../manual-owner-verification.js";

const execute = promisify(execFile);
const nativeDirectory = path.resolve(import.meta.dirname, "../native");

test("Windows preparation checks the native helper without asking for credentials or granting verification", async () => {
  let calls = 0;
  const owner = new ManualOwnerVerification("unused", { platform: "win32", execute: async (command, args) => {
    calls++;
    assert.match(command, /WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/);
    assert.ok(args.includes("-Check"));
    assert.ok(!args.includes("-Nonce"));
    return { stdout: '{"available":true,"verified":false}' };
  } });
  assert.equal((await owner.prepare()).prepared, true);
  assert.equal(calls, 1);
  owner.execute = async () => ({ stdout: '{"available":true,"verified":true}' });
  await assert.rejects(owner.prepare(), { code: "OWNER_WINDOWS_HELPER_UNAVAILABLE" });
});

test("Windows proof must be successful, from a successful process, and bound to the fresh nonce", async () => {
  const owner = new ManualOwnerVerification("unused", { platform: "win32", execute: async (_cmd, args) => ({ stdout: JSON.stringify({ verified: true, nonce: args.at(-1) }) }) });
  await owner.verify();
  owner.execute = async () => ({ stdout: JSON.stringify({ verified: true, nonce: "a".repeat(64) }) });
  await assert.rejects(owner.verify(), { code: "OWNER_VERIFICATION_FAILED" });
  owner.execute = async (_cmd, args) => { throw Object.assign(new Error("private details"), { stdout: JSON.stringify({ verified: true, nonce: args.at(-1) }) }); };
  await assert.rejects(owner.verify(), { code: "OWNER_WINDOWS_HELPER_FAILED" });
});

test("Windows failures distinguish cancellation, unpacking, rejected passwords and a different user without leaking diagnostics", async () => {
  for (const [reason, code, nativeError] of [
    ["cancelled", "OWNER_VERIFICATION_CANCELLED", 1223],
    ["prompt-error", "OWNER_WINDOWS_PROMPT_FAILED", 5],
    ["unpack-error", "OWNER_WINDOWS_UNPACK_FAILED", 50],
    ["logon-error", "OWNER_WINDOWS_LOGON_FAILED", 1326],
    ["identity-mismatch", "OWNER_WINDOWS_IDENTITY_MISMATCH", 0],
  ]) {
    const owner = new ManualOwnerVerification("unused", { platform: "win32", execute: async (_cmd, args) => {
      throw Object.assign(new Error("raw password or internal diagnostic"), { code: 1, stderr: "raw password or internal diagnostic",
        stdout: JSON.stringify({ verified: false, reason, nativeError, nonce: args.at(-1) }) });
    } });
    await assert.rejects(owner.verify(), (error) => error.code === code && !error.message.includes("raw password") && (nativeError === 0 || error.message.includes(String(nativeError)) || reason === "cancelled"));
  }
});

test("Windows timeout and abort never become successful verification", async () => {
  for (const [failure, code] of [[{ killed: true }, "OWNER_VERIFICATION_TIMEOUT"], [{ name: "AbortError" }, "OWNER_VERIFICATION_CANCELLED"]]) {
    const owner = new ManualOwnerVerification("unused", { platform: "win32", execute: async () => { throw Object.assign(new Error("private"), failure); } });
    await assert.rejects(owner.verify(), { code });
  }
});

test("real Windows helper prepares without prompting and decodes synthetic protected credentials", { skip: process.platform !== "win32" }, async () => {
  const owner = new ManualOwnerVerification("unused", { platform: "win32", nativeDirectory });
  assert.equal((await owner.prepare()).prepared, true);
  const result = await execute(path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(import.meta.dirname, "windows-owner-native.ps1"), "-Helper", path.join(nativeDirectory, "verify-owner.ps1")],
    { windowsHide: true, timeout: 20000, maxBuffer: 4096 });
  assert.deepEqual(JSON.parse(result.stdout), { protectedRoundTrip: true, unprotectedRoundTrip: true, legacyProtectedRoundTrip: false, identityForms: true });
});
