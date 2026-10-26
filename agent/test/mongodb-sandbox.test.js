import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import crypto from "node:crypto";
import { bulkSandboxFixture } from "./helpers/bulk-sandbox-fixture.js";
import { inspectLocalSandbox } from "../local-sandbox.js";
import { runMongoBulk } from "../mongodb-bulk.js";

async function prepare(h, jobId) {
  await h.run({ action: "upload", chunk: { jobId, chunkIndex: 0, units: [{ unitId: "order", operations: [{ operation: "updateOne", collection: "orders", id: "order-1", expected: { count: { exists: true, value: 0 } }, update: { $inc: { count: 1 } } }] }] } });
  return h.run({ action: "upload", chunk: { jobId, chunkIndex: 1, endOfUpload: true, units: [] } });
}
const lease = "a".repeat(64);

test("new receipts live outside business DB and share the same committing session", async (t) => {
  const h = bulkSandboxFixture(t); await h.initialize();
  const plan = await prepare(h, "new-job");
  assert.equal(plan.receiptStorage.database, "remote_debug_agent");
  assert.equal(h.read("new-job", "plan.json").schemaVersion, 2);
  await h.run({ action: "executeStart", jobId: "new-job", planHash: plan.planHash, leaseId: lease });
  h.state.loseReply = true;
  await h.run({ action: "executeBatch", jobId: "new-job", planHash: plan.planHash, leaseId: lease, batchIndex: 0 });
  assert.equal(h.rows("business", "orders").get("order-1").count, 1);
  const business = h.state.events.find((event) => event.action === "businessWrite");
  const receipt = h.state.events.find((event) => event.action === "insert" && event.session);
  assert.equal(receipt.db, "remote_debug_agent"); assert.equal(business.session, receipt.session);
  const writes = h.state.events.filter((event) => event.action === "businessWrite").length;
  // A retry after a lost reply cannot apply the increment again.
  await h.run({ action: "executeBatch", jobId: "new-job", planHash: plan.planHash, leaseId: lease, batchIndex: 0 });
  assert.equal(h.state.events.filter((event) => event.action === "businessWrite").length, writes);
  assert.equal(h.rows("business", "__remote_debug_bulk_receipts").size, 0);
  await h.run({ action: "verifyBatch", jobId: "new-job", planHash: plan.planHash, leaseId: lease, batchIndex: 0 });
  await h.run({ action: "finish", jobId: "new-job", planHash: plan.planHash, leaseId: lease });
  const undoLease = "b".repeat(64);
  await h.run({ action: "rollbackStart", jobId: "new-job", planHash: plan.planHash, leaseId: undoLease });
  await h.run({ action: "rollbackBatch", jobId: "new-job", planHash: plan.planHash, leaseId: undoLease, batchIndex: 0 });
  assert.equal(h.rows("business", "orders").get("order-1").count, 0);
  assert.ok([...h.rows("remote_debug_agent", "__remote_debug_bulk_receipts").values()].some((receipt) => receipt.action === "rollback"));
});

test("failure to insert the sandbox receipt aborts the business update", async (t) => {
  const h = bulkSandboxFixture(t); await h.initialize(); const plan = await prepare(h, "failed-job");
  await h.run({ action: "executeStart", jobId: "failed-job", planHash: plan.planHash, leaseId: lease });
  h.state.rejectReceipt = true;
  await assert.rejects(h.run({ action: "executeBatch", jobId: "failed-job", planHash: plan.planHash, leaseId: lease, batchIndex: 0 }), { code: 13 });
  assert.equal(h.rows("business", "orders").get("order-1").count, 0);
});

test("legacy plan hashes and legacy business-DB receipts remain usable for recovery and rollback", async (t) => {
  const h = bulkSandboxFixture(t); await h.initialize(); const current = await prepare(h, "old-job");
  await h.definitions('__ttlInitializeReceiptCollection(new (require(__driverPath).MongoClient)("business-uri"), "business", __config.receiptsCollection);');
  // Reconstruct the on-disk v1 layout and digest exactly as released versions used it.
  const manifest = h.read("old-job", "manifest.json"), plan = h.read("old-job", "plan.json");
  delete manifest.receiptStorage; delete plan.receiptStorage; manifest.schemaVersion = plan.schemaVersion = 1;
  const legacyHash = await h.definitions(`__bulkHash(${JSON.stringify({ schemaVersion: 1, jobId: plan.jobId, database: plan.database, purpose: plan.purpose, rollbackExpiresAt: plan.rollbackExpiresAt, chunks: plan.chunks, batches: plan.batches.map(({ index, hash, documents, inputBytes, rollbackBytes, unitCount }) => ({ index, hash, documents, inputBytes, rollbackBytes, unitCount })) })});`);
  manifest.planHash = plan.planHash = legacyHash; h.write("old-job", "manifest.json", manifest); h.write("old-job", "plan.json", plan);
  const old = await h.run({ action: "get", jobId: "old-job" }); assert.equal(old.receiptStorage.legacy, true);
  await h.run({ action: "executeStart", jobId: "old-job", planHash: legacyHash, leaseId: lease });
  await h.run({ action: "executeBatch", jobId: "old-job", planHash: legacyHash, leaseId: lease, batchIndex: 0 });
  assert.ok(h.rows("business", "__remote_debug_bulk_receipts").has("old-job:0:commit"));
  await h.run({ action: "verifyBatch", jobId: "old-job", planHash: legacyHash, leaseId: lease, batchIndex: 0 });
  await h.run({ action: "finish", jobId: "old-job", planHash: legacyHash, leaseId: lease });
  const rollbackLease = "b".repeat(64);
  await h.run({ action: "rollbackStart", jobId: "old-job", planHash: legacyHash, leaseId: rollbackLease });
  await h.run({ action: "rollbackBatch", jobId: "old-job", planHash: legacyHash, leaseId: rollbackLease, batchIndex: 0 });
  assert.equal(h.rows("business", "orders").get("order-1").count, 0);
  assert.ok(h.rows("business", "__remote_debug_bulk_receipts").has("old-job:0:rollback"));
  await assert.rejects(h.run({ action: "sandboxPrepareCleanup", jobId: "old-job" }), { code: "SANDBOX_LEGACY_READ_ONLY" });
  assert.notEqual(current.planHash, legacyHash);
});

test("sandbox location is bound into the plan and configuration changes cannot silently redirect jobs", async (t) => {
  const h = bulkSandboxFixture(t); await h.initialize(); await prepare(h, "pinned-job");
  await assert.rejects(h.run({ action: "get", jobId: "pinned-job" }, { ...h.config, configProfile: "other-profile" }), { code: "SANDBOX_DATABASE_CHANGED" });
  const manifest = h.read("pinned-job", "manifest.json"); manifest.receiptStorage.database = "business"; h.write("pinned-job", "manifest.json", manifest);
  await assert.rejects(h.run({ action: "get", jobId: "pinned-job" }), { code: "MONGODB_BULK_LOG_INVALID" });
});

test("sandbox cleanup refuses symlinked files and roots", async (t) => {
  if (process.platform === "win32") return t.skip("symlink creation may require Windows Developer Mode");
  const h = bulkSandboxFixture(t); await h.initialize(); await prepare(h, "linked-job");
  const manifest = h.read("linked-job", "manifest.json"), plan = h.read("linked-job", "plan.json");
  manifest.status = "completed"; manifest.rollbackExpiresAt = plan.rollbackExpiresAt = "2020-01-01T00:00:00Z";
  const body = { schemaVersion: 2, jobId: plan.jobId, database: plan.database, purpose: plan.purpose, receiptStorage: plan.receiptStorage, rollbackExpiresAt: plan.rollbackExpiresAt, chunks: plan.chunks, batches: plan.batches.map(({ index, hash, documents, inputBytes, rollbackBytes, unitCount }) => ({ index, hash, documents, inputBytes, rollbackBytes, unitCount })) };
  manifest.planHash = plan.planHash = await h.definitions(`__bulkHash(${JSON.stringify(body)});`);
  h.write("linked-job", "manifest.json", manifest); h.write("linked-job", "plan.json", plan);
  fs.symlinkSync(h.translate(h.config.configPath), h.translate(h.config.bulkRoot + "/linked-job/after-999999.json"));
  await assert.rejects(h.run({ action: "sandboxPrepareCleanup", jobId: "linked-job" }), { code: "SANDBOX_PATH_REJECTED" });
  assert.equal(h.state.events.filter((event) => event.action === "deleteMany").length, 0);
});

test("sandbox managers reject business privileges and require a distinct management profile", async (t) => {
  const h = bulkSandboxFixture(t); await h.initialize();
  await assert.rejects(h.run({ action: "sandboxStatus", offset: 0, limit: 20 }, { ...h.config, sandboxManagementProfile: "business" }), { code: "SANDBOX_MANAGEMENT_NOT_CONFIGURED" });
  h.state.unsafeManager = true;
  await assert.rejects(h.run({ action: "sandboxStatus", offset: 0, limit: 20 }), { code: "SANDBOX_MANAGEMENT_ROLE_UNSAFE" });
  h.state.unsafeManager = false;
  assert.equal((await h.run({ action: "sandboxStatus", offset: 0, limit: 20 })).sandboxDatabase, "remote_debug_agent");
  const source = JSON.parse(fs.readFileSync(h.translate(h.config.configPath), "utf8"));
  source.manager.url = "mongodb://manager:fixture@127.0.0.1:27018/?replicaSet=fixture";
  fs.writeFileSync(h.translate(h.config.configPath), JSON.stringify(source));
  await assert.rejects(h.run({ action: "sandboxStatus", offset: 0, limit: 20 }), { code: "SANDBOX_CLUSTER_MISMATCH" });
});

test("cleanup denies retained or active jobs and export never reads before-images", async (t) => {
  const h = bulkSandboxFixture(t); await h.initialize(); await prepare(h, "retained-job");
  await assert.rejects(h.run({ action: "sandboxPrepareCleanup", jobId: "retained-job" }), { code: "SANDBOX_JOB_IN_USE" });
  const manifest = h.read("retained-job", "manifest.json"); manifest.status = "completed"; h.write("retained-job", "manifest.json", manifest);
  await assert.rejects(h.run({ action: "sandboxPrepareCleanup", jobId: "retained-job" }), { code: "SANDBOX_RETENTION_ACTIVE" });
  fs.appendFileSync(h.translate(h.config.bulkRoot + "/retained-job/events.jsonl"), JSON.stringify({ at: "now", event: "example", reason: "token=secret-value", before: { password: "sensitive business document" } }) + "\n");
  const exported = await h.run({ action: "sandboxExport", jobId: "retained-job", limit: 20 });
  assert.ok(!JSON.stringify(exported).includes("secret-value")); assert.ok(!JSON.stringify(exported).includes("sensitive business document"));
});

test("expired-job cleanup is fixed to matching sandbox records and rejects stale previews", async (t) => {
  const h = bulkSandboxFixture(t); await h.initialize(); await prepare(h, "expired-job");
  const manifest = h.read("expired-job", "manifest.json"), plan = h.read("expired-job", "plan.json");
  manifest.status = "completed"; plan.rollbackExpiresAt = manifest.rollbackExpiresAt = "2020-01-01T00:00:00Z";
  const digest = await h.definitions(`__bulkHash(${JSON.stringify({ schemaVersion: 2, jobId: plan.jobId, database: plan.database, purpose: plan.purpose, receiptStorage: plan.receiptStorage, rollbackExpiresAt: plan.rollbackExpiresAt, chunks: plan.chunks, batches: plan.batches.map(({ index, hash, documents, inputBytes, rollbackBytes, unitCount }) => ({ index, hash, documents, inputBytes, rollbackBytes, unitCount })) })});`);
  manifest.planHash = plan.planHash = digest; h.write("expired-job", "manifest.json", manifest); h.write("expired-job", "plan.json", plan);
  const receipts = h.rows("remote_debug_agent", "__remote_debug_bulk_receipts");
  receipts.set("expired", { _id: "expired", jobId: "expired-job", planHash: digest, scope: plan.receiptStorage.scope, businessDatabase: "business", expiresAt: new Date("2020-01-01") });
  receipts.set("other-scope", { _id: "other-scope", jobId: "expired-job", planHash: digest, scope: "other", businessDatabase: "business", expiresAt: new Date("2020-01-01") });
  const preview = await h.run({ action: "sandboxPrepareCleanup", jobId: "expired-job" });
  await assert.rejects(h.run({ action: "sandboxCleanup", confirmation: "确认清理", jobId: "expired-job", cleanupHash: "0".repeat(64) }), { code: "SANDBOX_CLEANUP_CONFLICT" });
  const result = await h.run({ action: "sandboxCleanup", confirmation: "确认清理", jobId: "expired-job", cleanupHash: preview.cleanupHash });
  assert.ok(result.removedFiles > 0); assert.equal(fs.existsSync(h.translate(h.config.bulkRoot + "/expired-job")), false);
  assert.equal(result.removedReceipts, 1); assert.ok(receipts.has("other-scope"));
  const query = h.state.events.find((event) => event.action === "deleteMany"); assert.equal(query.db, "remote_debug_agent"); assert.equal(query.filter.planHash, digest);
});

test("management input rejects paths and cleanup requires its explicit confirmation", async () => {
  const config = { bulkEnabled: false, writeEnabled: false, database: "business", allowedDatabases: ["business"], allowedCollections: ["orders"] };
  await assert.rejects(runMongoBulk({ action: "sandboxExport", jobId: "../orders" }, { config }), { code: "SANDBOX_JOB_INVALID" });
  await assert.rejects(runMongoBulk({ action: "sandboxCleanup", jobId: "job", cleanupHash: "a".repeat(64) }, { config }), { code: "SANDBOX_CONFIRMATION_REQUIRED" });
});

test("local sandbox exports only fixed audit paths with bounded redaction", async (t) => {
  const h = bulkSandboxFixture(t), dataDir = h.nativeRoot;
  const dir = dataDir + "/.remote-debug/instances/one"; fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dir + "/audit.jsonl", JSON.stringify({ cmd: "curl --token secret-token", password: "secret-password" }) + "\n");
  const result = await inspectLocalSandbox(dataDir, "one", { action: "export", limit: 20 });
  assert.ok(!JSON.stringify(result).includes("secret-token")); assert.ok(!JSON.stringify(result).includes("secret-password"));
  await assert.rejects(inspectLocalSandbox(dataDir, "../outside", { action: "status" }), { code: "SANDBOX_PATH_REJECTED" });
  await assert.rejects(inspectLocalSandbox(dataDir, "one", { action: "cleanup" }), { code: "SANDBOX_ACTION_INVALID" });
});
