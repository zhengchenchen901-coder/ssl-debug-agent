// This helper manages only the configured plugin namespace and fixed job root.
// It never receives a database name, collection name or file path from tools.
export const MONGODB_SANDBOX_RUNTIME = String.raw`
function __sandboxConnectionTarget(uri) {
  var match = /^(mongodb(?:\+srv)?):\/\/([^/?#]+)(?:[/?]|$)/i.exec(uri || "");
  if (!match) __bulkFail("SANDBOX_SOURCE_INVALID", "MongoDB source connection is invalid");
  var authority = match[2].split("@").pop().toLowerCase().split(",").sort().join(",");
  var replicaSet = /[?&]replicaSet=([^&]+)/i.exec(uri);
  return match[1].toLowerCase() + "://" + authority + (replicaSet ? "/" + decodeURIComponent(replicaSet[1]) : "");
}

function __sandboxSourceTarget(source) {
  var profile = source[__config.configProfile];
  var uri = (__config.uriKey || "url").split(".").reduce(function (current, key) { return current && current[key]; }, profile);
  return __sandboxConnectionTarget(uri);
}

function __sandboxRedact(value, depth) {
  depth = depth || 0;
  if (depth > 6) return "[bounded]";
  if (typeof value === "string") return value.replace(/(mongodb(?:\+srv)?:\/\/)[^@\s]+@/gi, "$1[redacted]@").replace(/((?:password|token|secret|passwd|pwd)\s*[=:]\s*|--(?:token|password|secret)\s+)[^\s,;]+/gi, "$1[redacted]").slice(0, 2048);
  if (Array.isArray(value)) return value.slice(0, 100).map(function (item) { return __sandboxRedact(item, depth + 1); });
  if (value && typeof value === "object") {
    var result = {};
    Object.keys(value).slice(0, 100).forEach(function (key) {
      if (/password|passphrase|secret|token|credential|uri|before|document|privatekey/i.test(key)) result[key] = "[redacted]";
      else result[key] = __sandboxRedact(value[key], depth + 1);
    });
    return result;
  }
  return value;
}

async function __sandboxLoadClient() {
  var profileName = __config.sandboxManagementProfile;
  if (!profileName || profileName === __config.configProfile || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(profileName)) {
    __bulkFail("SANDBOX_MANAGEMENT_NOT_CONFIGURED", "configure a separate sandboxManagementProfile with sandbox-only MongoDB permissions");
  }
  var source = JSON.parse(__fs.readFileSync(__config.configPath, "utf8"));
  var profile = source[profileName];
  var uri = (__config.sandboxManagementUriKey || "url").split(".").reduce(function (current, key) { return current && current[key]; }, profile);
  if (typeof uri !== "string" || !uri) __bulkFail("SANDBOX_MANAGEMENT_NOT_CONFIGURED", "the sandbox management profile has no connection URI");
  if (__sandboxConnectionTarget(uri) !== __sandboxSourceTarget(source)) __bulkFail("SANDBOX_CLUSTER_MISMATCH", "management and execution profiles must use the same MongoDB endpoints and replica set");
  var driver = require(__config.driverPath);
  var client = new driver.MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
  try {
    await client.connect();
    var status = await client.db("admin").command({ connectionStatus: 1, showPrivileges: true });
    var privileges = status.authInfo && status.authInfo.authenticatedUserPrivileges;
    if (!Array.isArray(privileges) || !privileges.length || privileges.some(function (entry) {
      var resource = entry.resource || {};
      return resource.db !== __config.sandboxDatabase || ["", __config.receiptsCollection].indexOf(resource.collection) === -1 ||
        !Array.isArray(entry.actions) || entry.actions.some(function (action) { return ["find", "remove", "listIndexes", "listCollections", "collStats", "dbStats"].indexOf(action) === -1; });
    })) __bulkFail("SANDBOX_MANAGEMENT_ROLE_UNSAFE", "management credentials must have only read/cleanup permissions in the dedicated sandbox database");
    var collection = client.db(__config.sandboxDatabase).collection(__config.receiptsCollection);
    await __ttlCheckReceiptOwnership(collection, __config.sandboxDatabase, __config.receiptsCollection, false);
    return client;
  } catch (error) { try { await client.close(); } catch (_) {} throw error; }
}

function __sandboxFiles(jobId) {
  var root = __fs.realpathSync(__bulkRoot());
  var directory = __bulkJobDir(jobId);
  var stat = __fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || __path.dirname(__fs.realpathSync(directory)) !== root) __bulkFail("SANDBOX_PATH_REJECTED", "job directory escapes the sandbox");
  var names = __fs.readdirSync(directory);
  if (names.length > 2000) __bulkFail("SANDBOX_SCAN_LIMIT", "job directory exceeds the bounded cleanup file count");
  return names.filter(function (name) { return name !== ".manifest.lock"; }).sort().map(function (name) {
    if (!/^(manifest|plan|control)\.json$|^(chunk|batch|after|differences)-[0-9]+\.json$|^events\.jsonl$/.test(name)) __bulkFail("SANDBOX_PATH_REJECTED", "sandbox job contains an unknown file or active lock");
    var file = __path.join(directory, name), metadata = __fs.lstatSync(file);
    if (metadata.isSymbolicLink() || !metadata.isFile() || __path.dirname(__fs.realpathSync(file)) !== __fs.realpathSync(directory)) __bulkFail("SANDBOX_PATH_REJECTED", "job file is not a regular sandbox file");
    return { name: name, bytes: metadata.size, modified: metadata.mtimeMs };
  });
}

function __sandboxCleanupPlan(jobId) {
  var manifest = __bulkManifest(jobId, false);
  var plan = __bulkLoadPlan(jobId, manifest);
  var storage = __bulkReceiptStorage(manifest);
  if (storage.legacy) __bulkFail("SANDBOX_LEGACY_READ_ONLY", "legacy business-database receipt collections are retained and cannot be cleaned by sandbox management");
  var lease = __bulkReadJson(__bulkLeasePath(), 64 * 1024);
  if (["completed", "rolled_back"].indexOf(manifest.status) === -1 || (lease && lease.jobId === jobId && Date.now() - Date.parse(lease.heartbeatAt) < 60000)) __bulkFail("SANDBOX_JOB_IN_USE", "only finished jobs without an active lease can be cleaned");
  var retainedUntil = Date.parse(plan.rollbackExpiresAt) + 24 * 60 * 60 * 1000;
  if (!Number.isFinite(retainedUntil) || Date.now() <= retainedUntil) __bulkFail("SANDBOX_RETENTION_ACTIVE", "job recovery records are retained through rollback expiry plus 24 hours");
  var files = __sandboxFiles(jobId);
  var body = { jobId: jobId, planHash: plan.planHash, manifestHash: __bulkHash(manifest), receiptStorage: storage, retainedUntil: retainedUntil, files: files };
  return { jobId: jobId, cleanupHash: __bulkHash(body), fileCount: files.length, bytes: files.reduce(function (sum, file) { return sum + file.bytes; }, 0), retainedUntil: new Date(retainedUntil).toISOString(), receiptStorage: storage };
}

function __sandboxLog(jobId, limit) {
  var manifest = __bulkManifest(jobId, false);
  if (manifest.planHash) __bulkLoadPlan(jobId, manifest);
  var file = __path.join(__bulkJobDir(jobId), "events.jsonl");
  if (!__fs.existsSync(file)) return { jobId: jobId, records: [] };
  var stat = __fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) __bulkFail("SANDBOX_PATH_REJECTED", "log is not a regular sandbox file");
  var start = Math.max(0, stat.size - 65536), buffer = Buffer.alloc(Math.min(stat.size, 65536));
  var fd = __fs.openSync(file, "r");
  try { __fs.readSync(fd, buffer, 0, buffer.length, start); } finally { __fs.closeSync(fd); }
  var lines = buffer.toString("utf8").split(/\r?\n/); if (start) lines.shift();
  var records = lines.filter(Boolean).slice(-limit).map(function (line) {
    try { var event = JSON.parse(line), allowed = {}; ["at", "event", "batchIndex", "chunkIndex", "reason", "summary"].forEach(function (key) { if (event[key] !== undefined) allowed[key] = event[key]; }); return __sandboxRedact(allowed); }
    catch (_) { return { event: "unparseable_record" }; }
  });
  return { jobId: jobId, records: records, scannedBytes: buffer.length, truncated: start > 0 };
}

async function __sandboxManage() {
  if (__request.action === "sandboxCleanup" && __request.confirmation !== "确认清理") __bulkFail("SANDBOX_CONFIRMATION_REQUIRED", "cleanup requires explicit 确认清理");
  var client = await __sandboxLoadClient();
  try {
    var action = __request.action;
    if (action === "sandboxStatus") {
      var entries = __fs.readdirSync(__bulkRoot()).filter(function (name) { return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) && name[0] !== "."; });
      if (entries.length > 2000) __bulkFail("SANDBOX_SCAN_LIMIT", "sandbox exceeds the bounded job scan limit");
      var jobs = [], bytes = 0, scannedEntries = 0;
      for (var index = 0; index < entries.length; index++) {
        var name = entries[index];
        if (!__fs.lstatSync(__bulkJobDir(name)).isDirectory() || __fs.lstatSync(__bulkJobDir(name)).isSymbolicLink()) continue;
        var manifest = __bulkManifest(name, false);
        if (manifest.planHash) __bulkLoadPlan(name, manifest);
        var files = __fs.readdirSync(__bulkJobDir(name));
        scannedEntries += files.length + 1;
        if (scannedEntries > __storageLimits.maxFiles + __storageLimits.controlReserveFiles + 2000) __bulkFail("SANDBOX_SCAN_LIMIT", "sandbox inspection exceeds the bounded metadata scan limit");
        if (files.length > 2000) __bulkFail("SANDBOX_SCAN_LIMIT", "job exceeds the bounded file scan limit");
        files.forEach(function (file) { var stat = __fs.lstatSync(__path.join(__bulkJobDir(name), file)); if (stat.isFile() && !stat.isSymbolicLink()) bytes += stat.size; });
        jobs.push({ jobId: name, status: manifest.status, rollbackExpiresAt: manifest.rollbackExpiresAt, receiptStorage: __bulkReceiptStorage(manifest) });
      }
      return { sandboxDatabase: __config.sandboxDatabase, storageRoot: __bulkRoot(), jobs: jobs.slice(__request.offset, __request.offset + __request.limit), jobCount: jobs.length, bytes: bytes, hasMore: jobs.length > __request.offset + __request.limit };
    }
    var jobId = __request.jobId;
    if (action === "sandboxExport") return __sandboxLog(jobId, __request.limit);
    if (action === "sandboxPrepareCleanup") return __bulkWithLock(__bulkManifestLockPath(jobId), function () { return __sandboxCleanupPlan(jobId); });
    if (action === "sandboxCleanup") {
      var deleted = await __bulkWithAsyncLock(__bulkManifestLockPath(jobId), async function () {
        var preview = __sandboxCleanupPlan(jobId);
        if (preview.cleanupHash !== __request.cleanupHash) __bulkFail("SANDBOX_CLEANUP_CONFLICT", "sandbox job changed after cleanup was prepared");
        var manifest = __bulkManifest(jobId, false), storage = __bulkReceiptStorage(manifest);
        var collection = client.db(__config.sandboxDatabase).collection(__config.receiptsCollection);
        var result = await collection.deleteMany({ jobId: jobId, planHash: manifest.planHash, scope: storage.scope, businessDatabase: manifest.database, expiresAt: { $lte: new Date() } });
        __bulkWithLock(__path.join(__bulkRoot(), ".storage-quota.lock"), function () {
          __sandboxFiles(jobId).forEach(function (file) { __fs.unlinkSync(__path.join(__bulkJobDir(jobId), file.name)); });
        });
        return { jobId: jobId, removedFiles: preview.fileCount, removedBytes: preview.bytes, removedReceipts: result.deletedCount || 0 };
      });
      __fs.rmdirSync(__bulkJobDir(jobId));
      return deleted;
    }
    __bulkFail("SANDBOX_ACTION_INVALID", "unknown sandbox management action");
  } finally { try { await client.close(); } catch (_) {} }
}
`;
