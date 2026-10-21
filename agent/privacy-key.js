import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

export function privacyError(code = "BUSINESS_STORAGE_UNAVAILABLE") {
  return Object.assign(new Error("Protected local storage is unavailable; no business operation was replayed."), { code, statusCode: 409, retriable: false });
}

// No file/environment fallback. The key never appears in argv, logs, or config.
// Windows/Linux deliberately fail closed until a native credential adapter exists.
export function loadPrivacyKey(directory, { platform = process.platform, run = execFileSync, existing = false } = {}) {
  if (platform !== "darwin") throw privacyError("BUSINESS_KEYSTORE_UNSUPPORTED");
  const service = "com.remote-debug-agent.business-privacy.v1";
  const account = createHash("sha256").update(directory).digest("hex");
  const read = () => {
    const value = run("/usr/bin/security", ["find-generic-password", "-s", service, "-a", account, "-w"], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 15000 }).trim();
    if (!/^[a-f0-9]{64}$/.test(value)) throw privacyError("BUSINESS_KEYSTORE_UNAVAILABLE");
    return Buffer.from(value, "hex");
  };
  try { return read(); } catch (error) {
    // errSecItemNotFound only. A locked/denied keychain must never trigger creation.
    if (existing || error.status !== 44) throw privacyError("BUSINESS_KEYSTORE_UNAVAILABLE");
  }
  const key = randomBytes(32);
  try {
    run("/usr/bin/security", ["-i"], { input: `add-generic-password -s ${service} -a ${account} -w ${key.toString("hex")}\n`, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 15000 });
    return read(); // Also handles a concurrent first creator without overwriting it.
  } catch { throw privacyError("BUSINESS_KEYSTORE_UNAVAILABLE"); }
  finally { key.fill(0); }
}
