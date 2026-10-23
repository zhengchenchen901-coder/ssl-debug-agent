"use strict";
// Windows-only native adapter. Never log native stdout/stderr: pipes can hold keys/capabilities.
const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");
const { execFileSync } = require("child_process");

function fail(code = "BUSINESS_STORAGE_UNAVAILABLE") {
  return Object.assign(new Error("Windows protected local storage is unavailable; no business operation was replayed."), { code, statusCode: 409, retriable: false });
}
function native(action, input = {}, run = execFileSync) {
  if (process.platform !== "win32") throw fail("BUSINESS_KEYSTORE_UNSUPPORTED");
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (!systemRoot || !path.isAbsolute(systemRoot)) throw fail("BUSINESS_KEYSTORE_UNAVAILABLE");
  try {
    const helper = path.join(__dirname, "native/windows-privacy.ps1");
    const manifestPath = fs.existsSync(path.join(__dirname, "runtime-manifest.json"))
      ? path.join(__dirname, "runtime-manifest.json") : path.join(__dirname, "runtime/agent/runtime-manifest.json");
    const expected = JSON.parse(fs.readFileSync(manifestPath, "utf8")).hashes?.["native/windows-privacy.ps1"];
    if (!/^[a-f0-9]{64}$/.test(expected || "") || createHash("sha256").update(fs.readFileSync(helper)).digest("hex") !== expected) throw fail("BUSINESS_STORAGE_INTEGRITY_INVALID");
    const raw = run(path.join(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper], {
        input: JSON.stringify({ action, ...input }), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
        timeout: 30000, maxBuffer: 128 * 1024, windowsHide: true,
      });
    const result = JSON.parse(raw);
    if (result.ok !== true) throw fail(/^BUSINESS_[A-Z_]+$/.test(result.code || "") ? result.code : undefined);
    return result;
  } catch (error) {
    if (error.code?.startsWith("BUSINESS_")) throw fail(error.code);
    throw fail(action === "key" ? "BUSINESS_KEYSTORE_UNAVAILABLE" : action.includes("context") ? "BUSINESS_CONTEXT_DENIED" : "BUSINESS_STORAGE_PATH_INVALID");
  }
}
function targetFor(directory) {
  return "RemoteDebugAgent/business-privacy/v1/" + createHash("sha256").update(fs.realpathSync.native(directory)).digest("hex");
}
function prepareStore(directory) { return native("prepare-store", { directory }); }
function protectStoreFiles(directory) { native("protect-store", { directory }); }
function loadKey(directory, { existing = false, run } = {}) {
  const target = targetFor(directory);
  const result = native("key", { directory, target, existing }, run);
  if (!/^[a-f0-9]{64}$/.test(result.key || "")) throw fail("BUSINESS_KEYSTORE_UNAVAILABLE");
  return Buffer.from(result.key, "hex");
}
function prepareContext(directory) { native("prepare-context", { directory }); }
function readContext(filename) { return native("read-context", { filename }).content; }
function createContext(filename, content) { return native("create-context", { filename, content }).created; }

module.exports = { prepareStore, protectStoreFiles, loadKey, prepareContext, readContext, createContext, targetFor };
