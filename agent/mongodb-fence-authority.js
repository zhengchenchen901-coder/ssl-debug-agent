import fs from "node:fs";
import path from "node:path";
import { createHash, createPublicKey, verify } from "node:crypto";
import { privacyError } from "./privacy-key.js";

export const FENCE_COVERAGE = Object.freeze(["dispatch", "upload", "execute", "resume", "replay", "old_processes", "queues", "leases", "restart", "authenticated_sessions", "inflight_transactions", "legacy_credentials"]);
export const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function fenceChallenge(plan) {
  return { version: 1, binding: plan.binding, targetScopeDigest: digest(plan.targetScope),
    replacementJobId: plan.replacementRequest.jobId, replacementRequestDigest: plan.requestDigest,
    sealRequestDigest: plan.sealDigest, effectDigest: plan.effectDigest };
}
function readOwnedFile(filename) {
  if (!path.isAbsolute(filename)) throw Error();
  for (let parent = path.dirname(filename); parent !== path.dirname(parent); parent = path.dirname(parent)) {
    const stat = fs.lstatSync(parent);
    if (stat.isSymbolicLink() && !(process.platform === "darwin" && ["/tmp", "/var"].includes(parent))) throw Error();
    if (process.platform !== "win32" && (stat.mode & 0o022 || ![0, process.getuid()].includes(stat.uid)) && !["/tmp", "/private/tmp"].includes(parent)) throw Error();
  }
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > 65536 || process.platform !== "win32" && (before.mode & 0o077 || ![0, process.getuid()].includes(before.uid))) throw Error();
    const value = JSON.parse(fs.readFileSync(fd, "utf8")), after = fs.fstatSync(fd), current = fs.lstatSync(filename);
    if (before.ino !== current.ino || before.dev !== current.dev || current.isSymbolicLink() || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw Error();
    return value;
  } finally { fs.closeSync(fd); }
}

// Trust is provisioned out of band by the installation owner. Neither paths,
// verification keys nor signed evidence can be supplied via MCP or the browser.
// The external issuer must actually enforce the asserted boundary; signature
// verification is NOT implementation of remote credential/session retirement.
export function inspectFenceAuthority(plan, options = {}, now = Date.now()) {
  const configured = options.trustFile && options.receiptDirectory;
  if (!configured) return { confirmed: false, reason: "executor_fence_authority_not_configured" };
  if (process.platform === "win32") return { confirmed: false, reason: "executor_fence_native_acl_verifier_required" };
  try {
    const trust = readOwnedFile(options.trustFile);
    const receipt = readOwnedFile(path.join(options.receiptDirectory, plan.id + ".json"));
    if (trust.version !== 1 || trust.boundaryType !== "externally-enforced-legacy-retirement-v1" || typeof trust.issuer !== "string") throw Error();
    const key = createPublicKey(trust.publicKey);
    if (key.asymmetricKeyType !== "ed25519" || receipt.version !== 1 || typeof receipt.signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(receipt.signature)) throw Error();
    const p = receipt.payload;
    if (!p || !verify(null, Buffer.from(JSON.stringify(p)), key, Buffer.from(receipt.signature, "base64"))) throw Error();
    if (p.issuer !== trust.issuer || p.challengeDigest !== digest(fenceChallenge(plan)) || p.riskPlanId !== plan.id ||
        typeof p.receiptId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(p.receiptId) ||
        !Number.isSafeInteger(p.issuedAt) || !Number.isSafeInteger(p.validUntil) || p.issuedAt > now || p.validUntil <= now ||
        p.validUntil - p.issuedAt > 3600000 || p.issuedAt < plan.createdAt ||
        p.protection !== "permanent" || p.historicalOutcome !== "unknown" || p.inFlightTransactions !== "terminal" ||
        p.restartSafe !== true || p.legacyCredentialsRevoked !== true || p.oldSessionsDrained !== true || p.oldQueuesDrained !== true ||
        !Array.isArray(p.coverage) || p.coverage.length !== FENCE_COVERAGE.length || FENCE_COVERAGE.some(x => !p.coverage.includes(x))) throw Error();
    return { confirmed: true, issuer: trust.issuer, receiptId: p.receiptId, fingerprint: digest(receipt), validUntil: p.validUntil };
  } catch { return { confirmed: false, reason: "executor_fence_receipt_missing_invalid_or_expired" }; }
}
export function requireFenceAuthority(plan, store) {
  const proof = inspectFenceAuthority(plan, store.fenceAuthority, store.now());
  if (!proof.confirmed) throw privacyError("BUSINESS_REPLACEMENT_FENCE_REQUIRED");
  return proof;
}
