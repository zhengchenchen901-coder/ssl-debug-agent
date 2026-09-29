// This script is sent over the existing fixed Node helper channel. Keep it
// independent of local modules and compatible with older target Node versions.
export const MONGODB_BULK_RUNTIME = String.raw`
function __bulkFail(code, message, details) {
  var error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function __bulkStable(value) {
  if (Array.isArray(value)) return value.map(__bulkStable);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value).sort().reduce(function (result, key) {
    Object.defineProperty(result, key, { value: __bulkStable(value[key]), enumerable: true, writable: true, configurable: true });
    return result;
  }, {});
}

function __bulkHash(value) {
  return __crypto.createHash("sha256").update(JSON.stringify(__bulkStable(value))).digest("hex");
}

function __bulkBytes(value) {
  return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");
}

function __bulkRoot() {
  return __config.bulkRoot;
}

function __bulkJobId() {
  var jobId = __request.jobId || (__request.chunk && __request.chunk.jobId);
  if (typeof jobId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(jobId)) {
    __bulkFail("MONGODB_BULK_JOB_ID_INVALID", "jobId has an invalid format");
  }
  return jobId;
}

function __bulkJobDir(jobId) {
  var root = __bulkRoot();
  return __path.join(root, jobId);
}

function __bulkEnsureRoot() {
  var root = __bulkRoot();
  if (!__fs.existsSync(root)) __bulkFail("MONGODB_BULK_STORAGE_NOT_INITIALIZED", "bulk storage has not been initialized");
  var stat = __fs.lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) __bulkFail("MONGODB_BULK_STORAGE_INVALID", "bulk storage root must be a real directory");
  if ((stat.mode & 0o777) !== 0o700) __bulkFail("MONGODB_BULK_STORAGE_PERMISSIONS", "bulk storage root must have mode 0700");
  var marker = __path.join(root, ".storage-v1.json");
  if (!__fs.existsSync(marker) || __fs.lstatSync(marker).isSymbolicLink()) {
    __bulkFail("MONGODB_BULK_STORAGE_NOT_INITIALIZED", "bulk storage initialization record was not found");
  }
  if (!__fs.lstatSync(marker).isFile() || (__fs.lstatSync(marker).mode & 0o777) !== 0o600) {
    __bulkFail("MONGODB_BULK_STORAGE_PERMISSIONS", "bulk storage initialization record must be a regular 0600 file");
  }
  var state = __bulkReadJson(marker, 64 * 1024);
  if (!state || state.schemaVersion !== 1 || state.database !== __config.database || state.receiptsCollection !== __config.receiptsCollection) {
    __bulkFail("MONGODB_BULK_STORAGE_CONFIG_MISMATCH", "bulk storage belongs to a different database configuration");
  }
  return root;
}

function __bulkEnsureJobDir(jobId) {
  var root = __bulkEnsureRoot();
  var directory = __bulkJobDir(jobId);
  if (!__fs.existsSync(directory)) __fs.mkdirSync(directory, { mode: 0o700 });
  var stat = __fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) __bulkFail("MONGODB_BULK_PATH_INVALID", "bulk job path must be a real directory");
  if ((stat.mode & 0o777) !== 0o700) __fs.chmodSync(directory, 0o700);
  if (__path.dirname(directory) !== root) __bulkFail("MONGODB_BULK_PATH_INVALID", "bulk job path escaped the configured storage root");
  return directory;
}

function __bulkReadJson(filePath, maxBytes) {
  if (!__fs.existsSync(filePath)) return null;
  var stat = __fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) __bulkFail("MONGODB_BULK_PATH_INVALID", "bulk metadata must be a regular file");
  if (stat.size > maxBytes) __bulkFail("MONGODB_BULK_FILE_TOO_LARGE", "bulk metadata exceeds its size limit");
  try {
    return JSON.parse(__fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    __bulkFail("MONGODB_BULK_LOG_INVALID", "bulk metadata is damaged");
  }
}

function __bulkFsyncDirectory(directory) {
  var fd;
  try {
    fd = __fs.openSync(directory, "r");
    __fs.fsyncSync(fd);
  } catch (error) {
    __bulkFail("MONGODB_BULK_DURABILITY_UNAVAILABLE", "bulk storage could not confirm a durable directory update");
  } finally {
    if (fd !== undefined) try { __fs.closeSync(fd); } catch (_error) {}
  }
}

function __bulkWriteJson(filePath, value, maxBytes) {
  var directory = __path.dirname(filePath);
  var text = JSON.stringify(value, null, 2) + "\n";
  if (__bulkBytes(text) > maxBytes) __bulkFail("MONGODB_BULK_JOURNAL_TOO_LARGE", "bulk rollback log exceeds 8 MiB");
  var temporary = filePath + "." + process.pid + "." + __crypto.randomBytes(12).toString("hex") + ".tmp";
  var fd;
  try {
    fd = __fs.openSync(temporary, "wx", 0o600);
    __fs.writeFileSync(fd, text, "utf8");
    __fs.fsyncSync(fd);
    __fs.closeSync(fd);
    fd = undefined;
    __fs.renameSync(temporary, filePath);
    __fs.chmodSync(filePath, 0o600);
    __bulkFsyncDirectory(directory);
  } catch (error) {
    if (fd !== undefined) try { __fs.closeSync(fd); } catch (_closeError) {}
    try { if (__fs.existsSync(temporary)) __fs.unlinkSync(temporary); } catch (_unlinkError) {}
    if (error && error.code && /^MONGODB_/.test(error.code)) throw error;
    __bulkFail("MONGODB_BULK_DURABILITY_UNAVAILABLE", "bulk log could not be written atomically");
  }
}

function __bulkAppendJsonLine(filePath, value) {
  var fd;
  try {
    fd = __fs.openSync(filePath, __fs.constants.O_CREAT | __fs.constants.O_APPEND | __fs.constants.O_WRONLY, 0o600);
    __fs.writeFileSync(fd, JSON.stringify(value) + "\n", "utf8");
    __fs.fsyncSync(fd);
  } catch (_error) {
    __bulkFail("MONGODB_BULK_DURABILITY_UNAVAILABLE", "bulk job event could not be durably recorded");
  } finally {
    if (fd !== undefined) try { __fs.closeSync(fd); } catch (_closeError) {}
  }
}

function __bulkManifest(jobId, allowMissing) {
  var directory = __bulkJobDir(jobId);
  if (!__fs.existsSync(directory)) {
    if (allowMissing) return null;
    __bulkFail("MONGODB_BULK_JOB_NOT_FOUND", "bulk job was not found");
  }
  var manifest = __bulkReadJson(__path.join(directory, "manifest.json"), 4 * 1024 * 1024);
  if (!manifest || manifest.schemaVersion !== 1 || manifest.jobId !== jobId) __bulkFail("MONGODB_BULK_LOG_INVALID", "bulk job manifest is invalid");
  return manifest;
}

function __bulkSaveManifest(manifest) {
  __bulkWriteJson(__path.join(__bulkJobDir(manifest.jobId), "manifest.json"), manifest, 4 * 1024 * 1024);
}

function __bulkWithLock(lockPath, task) {
  var token = process.pid + ":" + __crypto.randomBytes(12).toString("hex");
  var startedAt = Date.now();
  var waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  var fd;
  while (fd === undefined) {
    try {
      fd = __fs.openSync(lockPath, "wx", 0o600);
      __fs.writeFileSync(fd, token, "utf8");
      __fs.fsyncSync(fd);
      __fs.closeSync(fd);
      fd = null;
      __bulkFsyncDirectory(__path.dirname(lockPath));
    } catch (error) {
      if (fd !== undefined && fd !== null) try { __fs.closeSync(fd); } catch (_closeError) {}
      fd = undefined;
      if (!error || error.code !== "EEXIST") __bulkFail("MONGODB_BULK_LOCK_FAILED", "bulk state lock could not be acquired");
      try {
        var stat = __fs.lstatSync(lockPath);
        if (stat.isSymbolicLink() || !stat.isFile()) __bulkFail("MONGODB_BULK_LOCK_FAILED", "bulk state lock is not a regular file");
        if (Date.now() - stat.mtimeMs > 30000) __fs.unlinkSync(lockPath);
      } catch (statError) {
        if (statError && statError.code !== "ENOENT") throw statError;
      }
      if (Date.now() - startedAt > 10000) __bulkFail("MONGODB_BULK_LOCK_BUSY", "bulk state lock remained busy");
      Atomics.wait(waitBuffer, 0, 0, 25);
    }
  }
  try { return task(); }
  finally {
    try {
      if (__fs.readFileSync(lockPath, "utf8") === token) {
        __fs.unlinkSync(lockPath);
        __bulkFsyncDirectory(__path.dirname(lockPath));
      }
    } catch (_error) {}
  }
}

function __bulkManifestLockPath(jobId) {
  return __path.join(__bulkJobDir(jobId), ".manifest.lock");
}

async function __bulkWithAsyncLock(lockPath, task) {
  var token = process.pid + ":" + __crypto.randomBytes(12).toString("hex");
  var startedAt = Date.now();
  while (true) {
    try {
      var fd = __fs.openSync(lockPath, "wx", 0o600);
      __fs.writeFileSync(fd, token, "utf8");
      __fs.fsyncSync(fd);
      __fs.closeSync(fd);
      __bulkFsyncDirectory(__path.dirname(lockPath));
      break;
    } catch (error) {
      if (!error || error.code !== "EEXIST") __bulkFail("MONGODB_BULK_LOCK_FAILED", "bulk preparation lock could not be acquired");
      try {
        var stat = __fs.lstatSync(lockPath);
        if (stat.isSymbolicLink() || !stat.isFile()) __bulkFail("MONGODB_BULK_LOCK_FAILED", "bulk preparation lock is not a regular file");
        if (Date.now() - stat.mtimeMs > 120000) __fs.unlinkSync(lockPath);
      } catch (statError) {
        if (statError && statError.code !== "ENOENT") throw statError;
      }
      if (Date.now() - startedAt > 600000) __bulkFail("MONGODB_BULK_LOCK_BUSY", "bulk preparation remained busy");
      await new Promise(function (resolve) { setTimeout(resolve, 100); });
    }
  }
  var heartbeat = setInterval(function () {
    try {
      if (__fs.readFileSync(lockPath, "utf8") === token) {
        var now = new Date();
        __fs.utimesSync(lockPath, now, now);
      }
    } catch (_error) {}
  }, 10000);
  if (heartbeat.unref) heartbeat.unref();
  try { return await task(); }
  finally {
    clearInterval(heartbeat);
    try {
      if (__fs.readFileSync(lockPath, "utf8") === token) {
        __fs.unlinkSync(lockPath);
        __bulkFsyncDirectory(__path.dirname(lockPath));
      }
    } catch (_error) {}
  }
}

function __bulkBatchPath(jobId, index) {
  return __path.join(__bulkJobDir(jobId), "batch-" + String(index).padStart(6, "0") + ".json");
}

function __bulkLoadBatch(jobId, index) {
  return __bulkReadJson(__bulkBatchPath(jobId, index), 8 * 1024 * 1024);
}

function __bulkLoadPlan(jobId, manifest) {
  var plan = __bulkReadJson(__path.join(__bulkJobDir(jobId), "plan.json"), 8 * 1024 * 1024);
  if (!plan || plan.schemaVersion !== 1 || plan.jobId !== jobId || plan.planHash !== manifest.planHash) {
    __bulkFail("MONGODB_BULK_LOG_INVALID", "final bulk plan is missing or does not match the manifest");
  }
  var planHash = __bulkHash({
    schemaVersion: plan.schemaVersion,
    jobId: plan.jobId,
    database: plan.database,
    purpose: plan.purpose,
    rollbackExpiresAt: plan.rollbackExpiresAt,
    chunks: plan.chunks,
    batches: plan.batches.map(function (batch) { return { index: batch.index, hash: batch.hash, documents: batch.documents, inputBytes: batch.inputBytes, rollbackBytes: batch.rollbackBytes, unitCount: batch.unitCount }; }),
  });
  if (planHash !== plan.planHash) __bulkFail("MONGODB_BULK_LOG_INVALID", "final bulk plan integrity check failed");
  return plan;
}

function __bulkStatus(manifest, plan, options) {
  var current = manifest.status;
  if (current === "running" || current === "rolling_back" || current === "reviewing") {
    var lease = __bulkReadJson(__path.join(__bulkRoot(), ".worker-lease.json"), 64 * 1024);
    if (!lease || lease.jobId !== manifest.jobId || Date.now() - Date.parse(lease.heartbeatAt) > 60000) {
      current = "recovery_required";
    }
  }
  var offset = options && Number.isInteger(options.offset) ? Math.max(0, options.offset) : 0;
  var limit = options && Number.isInteger(options.limit) ? Math.max(1, Math.min(100, options.limit)) : 20;
  var differenceCount = manifest.differenceCount || 0;
  var diffs = [];
  if (options && options.includeDifferences && differenceCount > offset) {
    var differenceCounts = manifest.differenceCounts || [];
    var skipped = 0;
    for (var i = 0; i < (manifest.batchCount || 0) && diffs.length < limit; i += 1) {
      var partCount = differenceCounts[i];
      if (!Number.isInteger(partCount)) {
        var countPart = __bulkReadJson(__path.join(__bulkJobDir(manifest.jobId), "differences-" + String(i).padStart(6, "0") + ".json"), 8 * 1024 * 1024);
        partCount = countPart && Array.isArray(countPart.items) ? countPart.items.length : 0;
      }
      if (skipped + partCount <= offset) { skipped += partCount; continue; }
      var part = __bulkReadJson(__path.join(__bulkJobDir(manifest.jobId), "differences-" + String(i).padStart(6, "0") + ".json"), 8 * 1024 * 1024);
      if (!part || !Array.isArray(part.items)) continue;
      var localStart = Math.max(0, offset - skipped);
      var available = limit - diffs.length;
      diffs = diffs.concat(part.items.slice(localStart, localStart + available));
      skipped += partCount;
    }
  }
  var committed = manifest.committedBatchIndexes || [];
  var rolledBack = manifest.rolledBackBatchIndexes || [];
  var activeBatchIndexes = manifest.runningBatchIndexes || [];
  var activePhase = manifest.activePhase || null;
  var queuedBatchCount = 0;
  if (activePhase === "execute") queuedBatchCount = Math.max(0, (manifest.batchCount || 0) - committed.length - activeBatchIndexes.length);
  else if (activePhase === "verify") queuedBatchCount = Math.max(0, (manifest.batchCount || 0) - (manifest.verifiedBatchCount || 0) - activeBatchIndexes.length);
  else if (activePhase === "rollback") queuedBatchCount = Math.max(0, committed.length - rolledBack.length - activeBatchIndexes.length);
  var nextRollback = null;
  for (var r = committed.length - 1; r >= 0; r -= 1) {
    if (rolledBack.indexOf(committed[r]) === -1) { nextRollback = committed[r]; break; }
  }
  return {
    jobId: manifest.jobId,
    database: manifest.database,
    status: current,
    mode: manifest.mode || "execute",
    desiredState: manifest.desiredState || "running",
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    planHash: manifest.planHash || undefined,
    rollbackExpiresAt: manifest.rollbackExpiresAt || undefined,
    operationCount: manifest.operationCount,
    unitCount: manifest.unitCount,
    batchCount: manifest.batchCount || 0,
    nextBatch: manifest.nextBatch || 0,
    nextVerifyBatch: manifest.nextVerifyBatch || 0,
    nextRollbackBatch: nextRollback,
    committedBatchCount: committed.length,
    rolledBackBatchCount: rolledBack.length,
    activeBatchIndexes: activeBatchIndexes,
    activePhase: activePhase,
    queuedBatchCount: queuedBatchCount,
    committed: manifest.committed || { matched: 0, modified: 0, inserted: 0, unchanged: 0 },
    verifiedBatchCount: manifest.verifiedBatchCount || 0,
    differences: diffs,
    differenceOffset: offset,
    differenceLimit: limit,
    differenceCount: differenceCount,
    hasMoreDifferences: offset + diffs.length < differenceCount,
    changedFields: manifest.changedFields || [],
    pauseReason: manifest.pauseReason,
    effectiveConcurrency: Math.min(__config.concurrency || 1, 4),
    planPreview: plan ? plan.batches.map(function (batch) { return { batchIndex: batch.index, operationCount: batch.documents, unitCount: batch.unitCount, changedFields: batch.changedFields, sampleIds: batch.sampleIds, rollbackBytes: batch.rollbackBytes }; }) : undefined,
  };
}

function __bulkGetPath(document, path) {
  var current = document;
  var parts = path.split(".");
  for (var i = 0; i < parts.length; i += 1) {
    if (current === null || current === undefined || !Object.prototype.hasOwnProperty.call(Object(current), parts[i])) return { exists: false };
    current = current[parts[i]];
  }
  return { exists: true, value: current };
}

function __bulkEqual(left, right) {
  return __bulkHash(__encode(left)) === __bulkHash(__encode(right));
}

function __bulkIdKey(value) {
  return __bulkHash(__encode(value));
}

function __bulkIdSummary(value) {
  var encoded = __encode(value);
  return typeof encoded === "string" ? encoded.slice(0, 256) : encoded;
}

function __bulkUnitIdKey(unitId) {
  return String(unitId);
}

function __bulkCheckExpected(document, operation) {
  var expected = operation.expected || {};
  var keys = Object.keys(expected);
  for (var i = 0; i < keys.length; i += 1) {
    var field = keys[i];
    var current = __bulkGetPath(document, field);
    var condition = expected[field];
    if (condition.exists !== current.exists) return false;
    if (condition.exists && !__bulkEqual(current.value, __decode(condition.value))) return false;
  }
  return true;
}

function __bulkUpdateSelector(operation) {
  var filter = { _id: __decode(operation.id) };
  var expected = operation.expected || {};
  Object.keys(expected).forEach(function (field) {
    var condition = expected[field];
    filter[field] = condition.exists ? { $eq: __decode(condition.value), $exists: true } : { $exists: false };
  });
  return filter;
}

function __bulkOperationId(operation) {
  return operation.operation === "insertOne" ? operation.document._id : operation.id;
}

function __bulkChangedFields(operations) {
  var fields = {};
  operations.forEach(function (operation) {
    if (operation.operation === "insertOne") {
      Object.keys(operation.document).forEach(function (field) { fields[field] = true; });
    } else {
      Object.keys(operation.update || {}).forEach(function (operator) {
        Object.keys(operation.update[operator] || {}).forEach(function (field) { fields[field] = true; });
      });
    }
  });
  return Object.keys(fields).sort().slice(0, 100);
}

function __bulkSnapshotCollection(database, collectionName, operations, session) {
  var collection = database.collection(collectionName);
  var ids = operations.map(__bulkOperationId).map(__decode);
  var cursor = collection.find({ _id: { $in: ids } }, session ? { session: session } : { readPreference: "primary" });
  if (cursor && typeof cursor.maxTimeMS === "function") cursor.maxTimeMS(15000);
  return cursor.toArray();
}

async function __bulkGetSnapshots(client, operations, session) {
  var byCollection = {};
  operations.forEach(function (operation) {
    if (!byCollection[operation.collection]) byCollection[operation.collection] = [];
    byCollection[operation.collection].push(operation);
  });
  var snapshots = {};
  var collectionNames = Object.keys(byCollection);
  for (var c = 0; c < collectionNames.length; c += 1) {
    var collectionName = collectionNames[c];
    snapshots[collectionName] = await __bulkSnapshotCollection(client.db(__config.database), collectionName, byCollection[collectionName], session);
  }
  return snapshots;
}

function __bulkFindById(documents, id) {
  var key = __bulkIdKey(id);
  for (var i = 0; i < documents.length; i += 1) if (__bulkIdKey(documents[i]._id) === key) return documents[i];
  return null;
}

function __bulkVerifyPreimages(operations, snapshots) {
  var before = [];
  var seen = {};
  operations.forEach(function (operation, index) {
    var key = operation.collection + ":" + __bulkIdKey(__bulkOperationId(operation));
    if (seen[key]) __bulkFail("MONGODB_BULK_DUPLICATE_TARGET", "one collection and document ID may appear only once in a job");
    seen[key] = true;
    var found = __bulkFindById(snapshots[operation.collection] || [], __bulkOperationId(operation));
    if (operation.operation === "insertOne") {
      if (found) __bulkFail("MONGODB_BULK_TARGET_EXISTS", "an insert target already exists");
      before.push({ operationIndex: index, document: null });
    } else {
      if (!found) __bulkFail("MONGODB_BULK_TARGET_NOT_FOUND", "an update target does not exist");
      if (!__bulkCheckExpected(found, operation)) __bulkFail("MONGODB_BULK_ORIGINAL_VALUE_MISMATCH", "an update original value does not match");
      before.push({ operationIndex: index, document: __encode(found) });
    }
  });
  return before;
}

function __bulkPlanSummary(manifest, plan) {
  return {
    jobId: manifest.jobId,
    status: manifest.status,
    database: manifest.database,
    planHash: manifest.planHash,
    unitCount: manifest.unitCount,
    operationCount: manifest.operationCount,
    batchCount: manifest.batchCount,
    rollbackExpiresAt: manifest.rollbackExpiresAt,
    changedFields: manifest.changedFields,
    batches: plan.batches.map(function (batch) {
      return { batchIndex: batch.index, operationCount: batch.documents, unitCount: batch.unitCount, changedFields: batch.changedFields, sampleIds: batch.sampleIds, rollbackBytes: batch.rollbackBytes };
    }),
    requiresConfirmation: true,
    atomicity: "per_batch",
  };
}

function __bulkChunkPath(jobId, index) {
  return __path.join(__bulkJobDir(jobId), "chunk-" + String(index).padStart(6, "0") + ".json");
}

function __bulkLoadChunks(manifest) {
  var units = [];
  for (var i = 0; i < manifest.chunks.length; i += 1) {
    var chunk = __bulkReadJson(__bulkChunkPath(manifest.jobId, i), 4 * 1024 * 1024);
    if (!chunk || __bulkHash({ jobId: chunk.body.jobId, database: chunk.body.database, chunkIndex: chunk.body.chunkIndex, purpose: chunk.body.purpose, rollbackTtlMs: chunk.body.rollbackTtlMs, units: chunk.body.units }) !== chunk.hash || chunk.body.chunkIndex !== i) __bulkFail("MONGODB_BULK_LOG_INVALID", "an uploaded chunk is missing or has changed");
    units = units.concat(chunk.body.units || []);
  }
  return units;
}

function __bulkPartition(units) {
  var result = [];
  var current = [];
  var operations = 0;
  var bytes = 2;
  function flush() {
    if (current.length) result.push(current);
    current = [];
    operations = 0;
    bytes = 2;
  }
  units.forEach(function (unit) {
    var unitOperations = unit.operations.length;
    var unitBytes = __bulkBytes(unit);
    if (unitOperations > __config.batchDocuments) __bulkFail("MONGODB_BULK_UNIT_EXCEEDS_BATCH", "one business unit exceeds the configured batch document limit");
    if (unitBytes > 512 * 1024) __bulkFail("MONGODB_BULK_UNIT_EXCEEDS_BATCH", "one business unit exceeds the 512 KiB batch input limit");
    if (current.length && (operations + unitOperations > __config.batchDocuments || bytes + unitBytes > 512 * 1024)) flush();
    current.push(unit);
    operations += unitOperations;
    bytes += unitBytes;
  });
  flush();
  return result;
}

function __bulkFlatten(units) {
  var result = [];
  units.forEach(function (unit) {
    unit.operations.forEach(function (operation) { result.push(operation); });
  });
  return result;
}

function __bulkCheckStorageCollection(client) {
  var collection = client.db(__config.database).collection(__config.receiptsCollection);
  return collection.listIndexes().toArray().then(function (indexes) {
    var valid = indexes.some(function (index) {
      return index.name === "remote_debug_bulk_receipt_expiry" && index.key && index.key.expiresAt === 1 && index.expireAfterSeconds === 0;
    });
    if (!valid) __bulkFail("MONGODB_BULK_STORAGE_NOT_INITIALIZED", "the technical receipt expiry index is missing");
    return collection;
  });
}

async function __bulkLoadClient() {
  var fileConfig;
  try { fileConfig = JSON.parse(__fs.readFileSync(__config.configPath, "utf8")); }
  catch (_error) { __bulkFail("MONGODB_CONFIG_UNREADABLE", "MongoDB application config could not be read"); }
  var profile = fileConfig && fileConfig[__config.configProfile];
  if (!profile || typeof profile !== "object") __bulkFail("MONGODB_PROFILE_NOT_FOUND", "MongoDB config profile was not found");
  var uri = __config.uriKey.split(".").reduce(function (value, key) { return value == null ? undefined : value[key]; }, profile);
  if (typeof uri !== "string" || !uri) __bulkFail("MONGODB_URI_NOT_FOUND", "MongoDB URI was not found in the configured profile");
  var driver = require(__config.driverPath);
  var MongoClient = driver.MongoClient || driver.default && driver.default.MongoClient;
  if (!MongoClient) __bulkFail("MONGODB_DRIVER_INVALID", "MongoDB driver does not export MongoClient");
  var client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true, serverSelectionTimeoutMS: 15000 });
  await client.connect();
  return client;
}

function __bulkReceiptId(jobId, index, action) {
  return jobId + ":" + String(index) + ":" + action;
}

async function __bulkFindReceipt(client, jobId, index, action) {
  var collection = client.db(__config.database).collection(__config.receiptsCollection);
  return collection.findOne({ _id: __bulkReceiptId(jobId, index, action) }, { readPreference: "primary" });
}

function __bulkApplySummary(manifest, summary) {
  manifest.committed = manifest.committed || { matched: 0, modified: 0, inserted: 0, unchanged: 0 };
  manifest.committed.matched += summary.matched || 0;
  manifest.committed.modified += summary.modified || 0;
  manifest.committed.inserted += summary.inserted || 0;
  manifest.committed.unchanged += summary.unchanged || 0;
}

function __bulkMarkBatch(manifest, index, summary) {
  return __bulkWithLock(__bulkManifestLockPath(manifest.jobId), function () {
    manifest = __bulkManifest(manifest.jobId, false);
    manifest.committedBatchIndexes = manifest.committedBatchIndexes || [];
    if (manifest.committedBatchIndexes.indexOf(index) === -1) {
      manifest.committedBatchIndexes.push(index);
      manifest.committedBatchIndexes.sort(function (a, b) { return a - b; });
      if (summary) __bulkApplySummary(manifest, summary);
    }
    var committed = {};
    manifest.committedBatchIndexes.forEach(function (batchIndex) { committed[batchIndex] = true; });
    var next = 0;
    while (committed[next]) next += 1;
    manifest.nextBatch = next;
    manifest.updatedAt = new Date().toISOString();
    var control = __bulkReadJson(__path.join(__bulkJobDir(manifest.jobId), "control.json"), 64 * 1024);
    manifest.desiredState = control && control.desiredState || manifest.desiredState || "running";
    manifest.status = manifest.desiredState === "pause" ? "pause_requested" : "running";
    manifest.pauseReason = undefined;
    __bulkSaveManifest(manifest);
    return manifest;
  });
}

function __bulkLeasePath() {
  return __path.join(__bulkRoot(), ".worker-lease.json");
}

function __bulkLeaseLockPath() {
  return __path.join(__bulkRoot(), ".worker-lease.lock");
}

function __bulkAssertLease(jobId, leaseId) {
  return __bulkWithLock(__bulkLeaseLockPath(), function () {
    var lease = __bulkReadJson(__bulkLeasePath(), 64 * 1024);
    if (!lease || lease.jobId !== jobId || lease.leaseId !== leaseId) __bulkFail("MONGODB_BULK_LEASE_LOST", "bulk worker lease is no longer owned by this task");
    lease.heartbeatAt = new Date().toISOString();
    __bulkWriteJson(__bulkLeasePath(), lease, 64 * 1024);
    return lease;
  });
}

function __bulkSetDispatch(jobId, planHash, leaseId, phase, batchIndexes) {
  var manifest = __bulkManifest(jobId, false);
  __bulkCheckPlan(manifest, planHash);
  __bulkAssertLease(jobId, leaseId);
  var plan = __bulkLoadPlan(jobId, manifest);
  if (["execute", "verify", "rollback"].indexOf(phase) === -1 || !Array.isArray(batchIndexes) || batchIndexes.length > 4) {
    __bulkFail("MONGODB_BULK_DISPATCH_INVALID", "bulk batch dispatch metadata is invalid");
  }
  batchIndexes.forEach(function (index) {
    if (!Number.isInteger(index) || index < 0 || index >= plan.batches.length) __bulkFail("MONGODB_BULK_DISPATCH_INVALID", "dispatched batch index is outside the fixed plan");
  });
  return __bulkWithLock(__bulkManifestLockPath(jobId), function () {
    var latest = __bulkManifest(jobId, false);
    if (latest.planHash !== planHash) __bulkFail("MONGODB_BULK_PLAN_HASH_MISMATCH", "planHash does not match the prepared job");
    latest.runningBatchIndexes = batchIndexes.slice();
    latest.activePhase = batchIndexes.length ? phase : null;
    latest.updatedAt = new Date().toISOString();
    __bulkSaveManifest(latest);
    return __bulkStatus(latest, plan, {});
  });
}

function __bulkAcquireLease(jobId, manifest, leaseId, mode) {
  return __bulkWithLock(__bulkLeaseLockPath(), function () {
    var leasePath = __bulkLeasePath();
    var existing = __bulkReadJson(leasePath, 64 * 1024);
    if (existing && Date.now() - Date.parse(existing.heartbeatAt) <= 60000) {
      if (existing.jobId === jobId && existing.leaseId === leaseId) return existing;
      __bulkFail("MONGODB_BULK_INSTANCE_BUSY", "another bulk task is active for this instance", { jobId: existing.jobId });
    }
    if (existing) try { __fs.unlinkSync(leasePath); } catch (_error) {}
    var lease = { jobId: jobId, leaseId: leaseId, mode: mode, heartbeatAt: new Date().toISOString() };
    __bulkWriteJson(leasePath, lease, 64 * 1024);
    manifest.leaseId = leaseId;
    manifest.mode = mode;
    manifest.desiredState = "running";
    manifest.status = mode === "rollback" ? "rolling_back" : "running";
    manifest.runningBatchIndexes = [];
    manifest.activePhase = mode === "rollback" ? "rollback" : "execute";
    manifest.pauseReason = undefined;
    manifest.updatedAt = new Date().toISOString();
    __bulkSaveManifest(manifest);
    return lease;
  });
}

function __bulkReleaseLease(jobId, leaseId) {
  return __bulkWithLock(__bulkLeaseLockPath(), function () {
    var lease = __bulkReadJson(__bulkLeasePath(), 64 * 1024);
    if (lease && lease.jobId === jobId && lease.leaseId === leaseId) {
      try { __fs.unlinkSync(__bulkLeasePath()); __bulkFsyncDirectory(__bulkRoot()); } catch (_error) {}
    }
  });
}

function __bulkCheckPlan(manifest, planHash) {
  if (!manifest.planHash || manifest.planHash !== planHash) __bulkFail("MONGODB_BULK_PLAN_HASH_MISMATCH", "planHash does not match the prepared job");
  if (Date.parse(manifest.rollbackExpiresAt) <= Date.now()) __bulkFail("MONGODB_BULK_ROLLBACK_EXPIRED", "bulk job rollback retention has expired");
}

function __bulkComparePreimage(current, document) {
  if (document === null) return current === null;
  return current !== null && __bulkHash(__encode(current)) === __bulkHash(document);
}

function __bulkGroup(operations) {
  var groups = {};
  operations.forEach(function (operation, index) {
    if (!groups[operation.collection]) groups[operation.collection] = [];
    groups[operation.collection].push({ operation: operation, index: index });
  });
  return groups;
}

function __bulkCount(value, primary, fallback) {
  if (value && value[primary] !== undefined && value[primary] !== null) return value[primary];
  return value && value[fallback] !== undefined && value[fallback] !== null ? value[fallback] : 0;
}

async function __bulkRunTransaction(jobId, planHash, batch, rollback) {
  var client = await __bulkLoadClient();
  var session = client.startSession();
  var receiptAction = rollback ? "rollback" : "commit";
  var receiptId = __bulkReceiptId(jobId, batch.index, receiptAction);
  var summary = { matched: 0, modified: 0, inserted: 0, unchanged: 0 };
  var after = [];
  var committing = false;
  try {
    await __bulkCheckStorageCollection(client);
    var previousReceipt = await __bulkFindReceipt(client, jobId, batch.index, receiptAction);
    if (previousReceipt) {
      if (previousReceipt.planHash !== planHash || previousReceipt.batchHash !== batch.hash || previousReceipt.action !== receiptAction) {
        __bulkFail("MONGODB_BULK_RECEIPT_CONFLICT", "technical receipt does not match this exact batch");
      }
      return { alreadyCommitted: true, summary: previousReceipt.summary || summary };
    }
    var beforeEntries = batch.before || [];
    var ops = batch.operations || [];
    session.startTransaction({ readPreference: "primary" });
    var beforeByIndex = {};
    beforeEntries.forEach(function (entry) { beforeByIndex[entry.operationIndex] = entry.document; });
    var snapshots = await __bulkGetSnapshots(client, ops, session);
    var groups = __bulkGroup(ops);
    var collectionNames = Object.keys(groups);
    for (var c = 0; c < collectionNames.length; c += 1) {
      var collectionName = collectionNames[c];
      var group = groups[collectionName];
      var currentDocs = snapshots[collectionName] || [];
      if (!rollback) {
        var writeOperations = [];
        group.forEach(function (entry) {
          var operation = entry.operation;
          var current = __bulkFindById(currentDocs, __bulkOperationId(operation));
          var expectedBefore = beforeByIndex[entry.index];
          if (!__bulkComparePreimage(current, expectedBefore)) __bulkFail("MONGODB_BULK_CONFLICT", "a document changed after its preimage was prepared", { batchIndex: batch.index, collection: collectionName });
          if (operation.operation === "insertOne") {
            writeOperations.push({ insertOne: { document: __decode(operation.document) } });
            summary.inserted += 1;
          } else {
            if (!__bulkCheckExpected(current, operation)) __bulkFail("MONGODB_BULK_CONFLICT", "an original field value changed before commit", { batchIndex: batch.index, collection: collectionName });
            writeOperations.push({ updateOne: { filter: __decode(__bulkUpdateSelector(operation)), update: __decode(operation.update), upsert: false } });
          }
        });
        if (writeOperations.length) {
          var writeResult = await client.db(__config.database).collection(collectionName).bulkWrite(writeOperations, { ordered: true, session: session });
          summary.matched += __bulkCount(writeResult, "matchedCount", "nMatched");
          summary.modified += __bulkCount(writeResult, "modifiedCount", "nModified");
          var expectedUpdates = group.filter(function (entry) { return entry.operation.operation === "updateOne"; }).length;
          if (__bulkCount(writeResult, "matchedCount", "nMatched") !== expectedUpdates) __bulkFail("MONGODB_BULK_CONFLICT", "one or more update preconditions did not match");
        }
      } else {
        var reverseOperations = [];
        group.forEach(function (entry) {
          var operation = entry.operation;
          var current = __bulkFindById(currentDocs, __bulkOperationId(operation));
          var afterItem = (batch.after || []).find(function (item) { return item.operationIndex === entry.index; });
          if (!afterItem || !current || __bulkHash(__encode(current)) !== afterItem.hash) __bulkFail("MONGODB_ROLLBACK_CONFLICT", "a document changed after this batch committed", { batchIndex: batch.index, collection: collectionName });
          if (operation.operation === "insertOne") reverseOperations.push({ deleteOne: { filter: { _id: __decode(__bulkOperationId(operation)) } } });
          else reverseOperations.push({ replaceOne: { filter: { _id: __decode(__bulkOperationId(operation)) }, replacement: __decode(beforeByIndex[entry.index]), upsert: false } });
        });
        if (reverseOperations.length) {
          var reverseResult = await client.db(__config.database).collection(collectionName).bulkWrite(reverseOperations, { ordered: true, session: session });
          var deleted = __bulkCount(reverseResult, "deletedCount", "nRemoved");
          var replaced = __bulkCount(reverseResult, "matchedCount", "nMatched");
          var expectedDelete = group.filter(function (entry) { return entry.operation.operation === "insertOne"; }).length;
          var expectedReplace = group.length - expectedDelete;
          if (deleted !== expectedDelete || replaced !== expectedReplace) __bulkFail("MONGODB_ROLLBACK_CONFLICT", "the batch could not be fully restored");
        }
      }
    }
    if (!rollback) {
      var afterSnapshots = await __bulkGetSnapshots(client, ops, session);
      ops.forEach(function (operation, index) {
        var current = __bulkFindById(afterSnapshots[operation.collection] || [], __bulkOperationId(operation));
        if (!current) __bulkFail("MONGODB_BULK_VERIFY_FAILED", "a target could not be read after its write");
        after.push({ operationIndex: index, id: __encode(current._id), hash: __bulkHash(__encode(current)) });
      });
      summary.unchanged = Math.max(0, summary.matched - summary.modified);
      __bulkWriteJson(__path.join(__bulkJobDir(jobId), "after-" + String(batch.index).padStart(6, "0") + ".json"), { batchHash: batch.hash, after: after }, 8 * 1024 * 1024);
    }
    var receipts = client.db(__config.database).collection(__config.receiptsCollection);
    var now = new Date();
    var expiry = new Date(Date.parse(batch.rollbackExpiresAt) + 24 * 60 * 60 * 1000);
    await receipts.insertOne({ _id: receiptId, jobId: jobId, planHash: planHash, batchIndex: batch.index, batchHash: batch.hash, action: receiptAction, committedAt: now, expiresAt: expiry, summary: summary }, { session: session });
    committing = true;
    await session.commitTransaction();
    return { alreadyCommitted: false, summary: summary };
  } catch (error) {
    try { await session.abortTransaction(); } catch (_abortError) {}
    if (committing) {
      try {
        var checkClient = await __bulkLoadClient();
        try {
          var receipt = await __bulkFindReceipt(checkClient, jobId, batch.index, receiptAction);
          if (receipt && receipt.planHash === planHash && receipt.batchHash === batch.hash) return { alreadyCommitted: true, summary: receipt.summary || summary };
        } finally { await checkClient.close(); }
      } catch (_checkError) {}
      __bulkFail("MONGODB_BULK_COMMIT_UNKNOWN", "transaction outcome is uncertain; retry only this exact batch after receipt inspection", { batchIndex: batch.index });
    }
    throw error;
  } finally {
    try { await session.endSession(); } catch (_sessionError) {}
    try { await client.close(); } catch (_clientError) {}
  }
}

async function __bulkInitializeReceiptCollection(client) {
  var database = client.db(__config.database);
  var collection = database.collection(__config.receiptsCollection);
  await collection.createIndex({ expiresAt: 1 }, { name: "remote_debug_bulk_receipt_expiry", expireAfterSeconds: 0 });
  var index = (await collection.listIndexes().toArray()).filter(function (item) { return item.name === "remote_debug_bulk_receipt_expiry"; })[0];
  if (!index || !index.key || index.key.expiresAt !== 1 || index.expireAfterSeconds !== 0) __bulkFail("MONGODB_BULK_STORAGE_INDEX_FAILED", "technical receipt expiry index could not be verified");
  var marker = { _id: "__remote_debug_bulk_storage_v1", schemaVersion: 1, database: __config.database, receiptsCollection: __config.receiptsCollection };
  var existing = await collection.findOne({ _id: marker._id }, { readPreference: "primary" });
  if (existing && (existing.schemaVersion !== 1 || existing.database !== marker.database || existing.receiptsCollection !== marker.receiptsCollection)) {
    __bulkFail("MONGODB_BULK_STORAGE_CONFLICT", "technical receipt collection contains a different storage marker");
  }
  if (!existing) await collection.insertOne(marker);
  return { index: index.name, marker: marker._id };
}

async function __bulkPrepareStorage() {
  var root = __bulkRoot();
  if (!__path.isAbsolute(root) || root === "/") __bulkFail("MONGODB_BULK_ROOT_INVALID", "bulk storage root must be a dedicated absolute path");
  try { __fs.mkdirSync(root, { recursive: true, mode: 0o700 }); }
  catch (_error) { __bulkFail("MONGODB_BULK_STORAGE_PERMISSIONS", "bulk storage directory could not be created before any business write"); }
  var stat = __fs.lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) __bulkFail("MONGODB_BULK_STORAGE_INVALID", "bulk storage root must be a real directory");
  __fs.chmodSync(root, 0o700);
  var probe = __path.join(root, ".write-probe-" + process.pid + "-" + __crypto.randomBytes(8).toString("hex"));
  var fd;
  try { fd = __fs.openSync(probe, "wx", 0o600); __fs.writeFileSync(fd, "ready", "utf8"); __fs.fsyncSync(fd); __fs.closeSync(fd); fd = undefined; __fs.unlinkSync(probe); __bulkFsyncDirectory(root); }
  catch (_error) {
    if (fd !== undefined) try { __fs.closeSync(fd); } catch (_closeError) {}
    try { if (__fs.existsSync(probe)) __fs.unlinkSync(probe); } catch (_unlinkError) {}
    __bulkFail("MONGODB_BULK_DURABILITY_UNAVAILABLE", "bulk storage could not complete a durable write probe");
  }
  var client = await __bulkLoadClient();
  try {
    var result = await __bulkInitializeReceiptCollection(client);
    __bulkWriteJson(__path.join(root, ".storage-v1.json"), { schemaVersion: 1, database: __config.database, receiptsCollection: __config.receiptsCollection, initializedAt: new Date().toISOString() }, 64 * 1024);
    return { initialized: true, storageRoot: root, directoryMode: "0700", fileMode: "0600", receiptsCollection: __config.receiptsCollection, ttlIndex: result.index, retainedThrough: "rollback expiry plus 24 hours" };
  } finally { try { await client.close(); } catch (_closeError) {} }
}

async function __bulkUpload() {
  var chunk = __request.chunk;
  var jobId = chunk.jobId;
  var dir = __bulkEnsureJobDir(jobId);
  var accepted = __bulkWithLock(__bulkManifestLockPath(jobId), function () {
    var manifestPath = __path.join(dir, "manifest.json");
    var manifest = __bulkReadJson(manifestPath, 4 * 1024 * 1024);
    var identity = { schemaVersion: 1, jobId: jobId, database: chunk.database, purpose: chunk.purpose, rollbackTtlMs: chunk.rollbackTtlMs, chunks: [], unitCount: 0, operationCount: 0, inputBytes: 0, status: "uploading", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    if (!manifest) {
      if (chunk.chunkIndex !== 0) __bulkFail("MONGODB_BULK_CHUNK_ORDER", "the first upload chunk must have index 0");
      manifest = identity;
    } else if (manifest.schemaVersion !== 1 || manifest.jobId !== jobId || manifest.database !== chunk.database || manifest.purpose !== chunk.purpose || manifest.rollbackTtlMs !== chunk.rollbackTtlMs) {
      __bulkFail("MONGODB_BULK_JOB_CONFLICT", "jobId already belongs to a different upload plan");
    }
    var chunkHash = __bulkHash({ jobId: jobId, database: chunk.database, chunkIndex: chunk.chunkIndex, purpose: chunk.purpose, rollbackTtlMs: chunk.rollbackTtlMs, units: chunk.units });
    if (chunkHash !== chunk.chunkHash) __bulkFail("MONGODB_BULK_CHUNK_HASH_MISMATCH", "chunk contents do not match their supplied digest");
    if (chunk.chunkIndex < manifest.chunks.length) {
      if (manifest.chunks[chunk.chunkIndex] !== chunkHash) __bulkFail("MONGODB_BULK_CHUNK_CONFLICT", "a repeated chunk index has different content");
      if (chunk.endOfUpload && manifest.status === "prepared" && manifest.planHash) {
        var existingPlan = __bulkPlanSummary(manifest, __bulkLoadPlan(jobId, manifest));
        existingPlan.duplicate = true;
        existingPlan.chunkIndex = chunk.chunkIndex;
        existingPlan.chunkHash = chunkHash;
        return { result: existingPlan };
      }
      if (chunk.endOfUpload && ["uploaded", "prepare_failed", "preparing"].indexOf(manifest.status) !== -1) return { finalize: true };
      return { result: { jobId: jobId, status: manifest.status, chunkIndex: chunk.chunkIndex, chunkHash: chunkHash, duplicate: true, planHash: manifest.planHash } };
    }
    if (manifest.status !== "uploading") __bulkFail("MONGODB_BULK_UPLOAD_CLOSED", "this upload has already been finalized");
    if (chunk.chunkIndex !== manifest.chunks.length) __bulkFail("MONGODB_BULK_CHUNK_ORDER", "chunks must be uploaded in sequence");
    if (manifest.operationCount + (chunk.operationCount || 0) > 100000 || manifest.inputBytes + (chunk.inputBytes || 0) > 40 * 1024 * 1024) {
      __bulkFail("MONGODB_BULK_JOB_SIZE_LIMIT", "a job is limited to 100000 operations and 40 MiB of input");
    }
    if (!chunk.endOfUpload && !(chunk.units || []).length) __bulkFail("MONGODB_BULK_EMPTY_CHUNK", "only the explicit end-of-upload chunk may be empty");
    if (chunk.endOfUpload && (chunk.units || []).length) __bulkFail("MONGODB_BULK_END_MARKER_INVALID", "the end-of-upload marker must be an empty chunk");
    var body = { jobId: jobId, database: chunk.database, chunkIndex: chunk.chunkIndex, purpose: chunk.purpose, rollbackTtlMs: chunk.rollbackTtlMs, units: chunk.units, endOfUpload: chunk.endOfUpload, operationCount: chunk.operationCount, inputBytes: chunk.inputBytes };
    __bulkWriteJson(__bulkChunkPath(jobId, chunk.chunkIndex), { hash: chunkHash, body: body }, 4 * 1024 * 1024);
    manifest.chunks.push(chunkHash);
    manifest.unitCount += (chunk.units || []).length;
    manifest.operationCount += chunk.operationCount || 0;
    manifest.inputBytes += chunk.inputBytes || 0;
    manifest.updatedAt = new Date().toISOString();
    if (chunk.endOfUpload) {
      if (manifest.operationCount === 0) __bulkFail("MONGODB_BULK_EMPTY_JOB", "a bulk job must contain at least one business operation");
      manifest.status = "uploaded";
    }
    __bulkSaveManifest(manifest);
    __bulkAppendJsonLine(__path.join(dir, "events.jsonl"), { at: manifest.updatedAt, event: chunk.endOfUpload ? "upload_finished" : "chunk_uploaded", chunkIndex: chunk.chunkIndex, chunkHash: chunkHash, unitCount: manifest.unitCount, operationCount: manifest.operationCount });
    if (!chunk.endOfUpload) return { result: { jobId: jobId, status: "uploading", chunkIndex: chunk.chunkIndex, chunkHash: chunkHash, nextChunkIndex: manifest.chunks.length, unitCount: manifest.unitCount, operationCount: manifest.operationCount, inputBytes: manifest.inputBytes } };
    return { finalize: true };
  });
  return accepted.finalize ? await __bulkFinalize(jobId) : accepted.result;
}

async function __bulkPrepareSlice(client, jobId, units, offset, allIds, allUnitIds, batches) {
  var operations = __bulkFlatten(units);
  var groups = __bulkGroup(operations);
  var snapshots = await __bulkGetSnapshots(client, operations, null);
  var before = __bulkVerifyPreimages(operations, snapshots);
  var directory = __bulkJobDir(jobId);
  var batchIndex = batches.length;
  var batch = {
    index: batchIndex,
    unitIds: units.map(function (unit) { return unit.unitId; }),
    unitCount: units.length,
    operations: operations,
    before: before,
    after: [],
    documents: operations.length,
    inputBytes: __bulkBytes(units),
    changedFields: __bulkChangedFields(operations),
    sampleIds: operations.slice(0, 3).map(function (operation) { return { collection: operation.collection, id: __bulkIdSummary(__bulkOperationId(operation)) }; }),
  };
  var rollbackBytes = __bulkBytes({ before: batch.before, operations: batch.operations });
  if (rollbackBytes > 8 * 1024 * 1024) {
    if (units.length < 2) __bulkFail("MONGODB_BULK_UNIT_ROLLBACK_TOO_LARGE", "one business unit exceeds the 8 MiB rollback log limit");
    var split = Math.ceil(units.length / 2);
    await __bulkPrepareSlice(client, jobId, units.slice(0, split), offset, allIds, allUnitIds, batches);
    await __bulkPrepareSlice(client, jobId, units.slice(split), offset + split, allIds, allUnitIds, batches);
    return;
  }
  batch.rollbackBytes = rollbackBytes;
  batch.hash = __bulkHash({ index: batch.index, unitIds: batch.unitIds, operations: batch.operations, before: batch.before });
  batch.rollbackExpiresAt = new Date(Date.now() + __request.chunk.rollbackTtlMs).toISOString();
  __bulkWriteJson(__bulkBatchPath(jobId, batchIndex), batch, 8 * 1024 * 1024);
  batches.push({ index: batchIndex, hash: batch.hash, documents: batch.documents, inputBytes: batch.inputBytes, rollbackBytes: batch.rollbackBytes, unitCount: batch.unitCount, changedFields: batch.changedFields, sampleIds: batch.sampleIds });
}

async function __bulkCheckTargetCollections(client, units) {
  var names = {};
  units.forEach(function (unit) {
    unit.operations.forEach(function (operation) { names[operation.collection] = true; });
  });
  var collectionNames = Object.keys(names);
  if (!collectionNames.length) __bulkFail("MONGODB_BULK_EMPTY_JOB", "a bulk job must contain at least one business operation");
  var existing = await client.db(__config.database).listCollections({ name: { $in: collectionNames } }, { nameOnly: true }).toArray();
  var present = {};
  existing.forEach(function (item) { present[item.name] = true; });
  var missing = collectionNames.filter(function (name) { return !present[name]; });
  if (missing.length) __bulkFail("MONGODB_BULK_COLLECTION_MISSING", "all business collections must exist before bulk transactions begin", { collections: missing });
}

async function __bulkFinalize(jobId) {
  return await __bulkWithAsyncLock(__path.join(__bulkJobDir(jobId), ".prepare.lock"), async function () {
    var manifest = __bulkManifest(jobId, false);
    if (manifest.status === "prepared" && manifest.planHash) return __bulkPlanSummary(manifest, __bulkLoadPlan(jobId, manifest));
    if (manifest.status !== "uploaded" && manifest.status !== "prepare_failed" && manifest.status !== "preparing") __bulkFail("MONGODB_BULK_UPLOAD_INCOMPLETE", "all chunks must be uploaded and explicitly closed before preparation");
    manifest.status = "preparing";
    manifest.updatedAt = new Date().toISOString();
    __bulkSaveManifest(manifest);
    var client = null;
    try {
      var units = __bulkLoadChunks(manifest);
      var seenUnits = {};
      var seenTargets = {};
      units.forEach(function (unit) {
        var unitKey = __bulkUnitIdKey(unit.unitId);
        if (seenUnits[unitKey]) __bulkFail("MONGODB_BULK_DUPLICATE_UNIT", "unitId must be unique within a job");
        seenUnits[unitKey] = true;
        unit.operations.forEach(function (operation) {
          var target = operation.collection + ":" + __bulkIdKey(operation.operation === "insertOne" ? operation.document._id : operation.id);
          if (seenTargets[target]) __bulkFail("MONGODB_BULK_DUPLICATE_TARGET", "one collection and document ID may appear only once in a job");
          seenTargets[target] = true;
        });
      });
      var partitions = __bulkPartition(units);
      var batches = [];
      client = await __bulkLoadClient();
      await __bulkCheckStorageCollection(client);
      await __bulkCheckTargetCollections(client, units);
      for (var i = 0; i < partitions.length; i += 1) await __bulkPrepareSlice(client, jobId, partitions[i], 0, seenTargets, seenUnits, batches);
      var rollbackExpiresAt = new Date(Date.now() + manifest.rollbackTtlMs).toISOString();
      var planValue = { schemaVersion: 1, jobId: jobId, database: manifest.database, purpose: manifest.purpose, rollbackExpiresAt: rollbackExpiresAt, chunks: manifest.chunks, batches: batches };
      var planHash = __bulkHash({ schemaVersion: planValue.schemaVersion, jobId: planValue.jobId, database: planValue.database, purpose: planValue.purpose, rollbackExpiresAt: rollbackExpiresAt, chunks: planValue.chunks, batches: batches.map(function (batch) { return { index: batch.index, hash: batch.hash, documents: batch.documents, inputBytes: batch.inputBytes, rollbackBytes: batch.rollbackBytes, unitCount: batch.unitCount }; }) });
      planValue.planHash = planHash;
      __bulkWriteJson(__path.join(__bulkJobDir(jobId), "plan.json"), planValue, 8 * 1024 * 1024);
      manifest.status = "prepared";
      manifest.planHash = planHash;
      manifest.batchCount = batches.length;
      manifest.rollbackExpiresAt = rollbackExpiresAt;
      manifest.nextBatch = 0;
      manifest.nextVerifyBatch = 0;
      manifest.verifiedBatchCount = 0;
      manifest.verifiedBatchIndexes = [];
      manifest.differenceCounts = [];
      manifest.committedBatchIndexes = [];
      manifest.rolledBackBatchIndexes = [];
      manifest.changedFields = Array.from(new Set(batches.reduce(function (all, batch) { return all.concat(batch.changedFields); }, []))).sort().slice(0, 100);
      manifest.differenceCount = 0;
      manifest.committed = { matched: 0, modified: 0, inserted: 0, unchanged: 0 };
      manifest.updatedAt = new Date().toISOString();
      __bulkSaveManifest(manifest);
      __bulkAppendJsonLine(__path.join(__bulkJobDir(jobId), "events.jsonl"), { at: manifest.updatedAt, event: "prepared", planHash: planHash, batchCount: batches.length, operationCount: manifest.operationCount });
      return __bulkPlanSummary(manifest, planValue);
    } catch (error) {
      manifest.status = "prepare_failed";
      manifest.pauseReason = error.code || "MONGODB_BULK_PREPARE_FAILED";
      manifest.updatedAt = new Date().toISOString();
      try { __bulkSaveManifest(manifest); } catch (_saveError) {}
      try { __bulkAppendJsonLine(__path.join(__bulkJobDir(jobId), "events.jsonl"), { at: manifest.updatedAt, event: "prepare_failed", reason: manifest.pauseReason }); } catch (_eventError) {}
      throw error;
    } finally {
      if (client) try { await client.close(); } catch (_closeError) {}
    }
  });
}

async function __bulkExecuteBatch(jobId, planHash, leaseId, index) {
  var manifest = __bulkManifest(jobId, false);
  __bulkCheckPlan(manifest, planHash);
  var lease = __bulkAssertLease(jobId, leaseId);
  var control = __bulkReadJson(__path.join(__bulkJobDir(jobId), "control.json"), 64 * 1024);
  if (control && control.desiredState === "pause") return __bulkPause(jobId, planHash, leaseId, "pause_requested");
  var plan = __bulkLoadPlan(jobId, manifest);
  var batch = __bulkLoadBatch(jobId, index);
  if (!batch || !plan.batches[index] || batch.hash !== plan.batches[index].hash) __bulkFail("MONGODB_BULK_LOG_INVALID", "batch rollback log is missing or changed");
  var existing = manifest.committedBatchIndexes || [];
  if (existing.indexOf(index) !== -1) return __bulkStatus(manifest, plan, {});
  if (index < (manifest.nextBatch || 0)) __bulkFail("MONGODB_BULK_BATCH_ORDER", "bulk batch index is behind the commit cursor");
  var executionControl = __bulkReadJson(__path.join(__bulkJobDir(jobId), "control.json"), 64 * 1024);
  if (executionControl && executionControl.desiredState === "pause") return __bulkPause(jobId, planHash, leaseId, "pause_requested");
  var result = await __bulkRunTransaction(jobId, planHash, batch, false);
  manifest = __bulkMarkBatch(manifest, index, result.summary);
  __bulkAppendJsonLine(__path.join(__bulkJobDir(jobId), "events.jsonl"), { at: new Date().toISOString(), event: "batch_committed", batchIndex: index, alreadyCommitted: result.alreadyCommitted, summary: result.summary });
  return __bulkStatus(manifest, plan, {});
}

async function __bulkVerifyBatch(jobId, planHash, leaseId, index) {
  var manifest = __bulkManifest(jobId, false);
  __bulkCheckPlan(manifest, planHash);
  __bulkAssertLease(jobId, leaseId);
  var control = __bulkReadJson(__path.join(__bulkJobDir(jobId), "control.json"), 64 * 1024);
  if (control && control.desiredState === "pause") return __bulkPause(jobId, planHash, leaseId, "pause_requested");
  var plan = __bulkLoadPlan(jobId, manifest);
  if ((manifest.committedBatchIndexes || []).indexOf(index) === -1) __bulkFail("MONGODB_BULK_VERIFY_ORDER", "uncommitted batch cannot be verified");
  if ((manifest.verifiedBatchIndexes || []).indexOf(index) !== -1) return __bulkStatus(manifest, plan, {});
  if (index < (manifest.nextVerifyBatch || 0)) __bulkFail("MONGODB_BULK_BATCH_ORDER", "verification batch index is behind the verification cursor");
  var batch = __bulkLoadBatch(jobId, index);
  var afterFile = __bulkReadJson(__path.join(__bulkJobDir(jobId), "after-" + String(index).padStart(6, "0") + ".json"), 8 * 1024 * 1024);
  if (!afterFile || afterFile.batchHash !== batch.hash) __bulkFail("MONGODB_BULK_LOG_INVALID", "postimage log is missing or changed; verification and rollback are unavailable");
  var client = await __bulkLoadClient();
  var differences = [];
  try {
    var snapshots = await __bulkGetSnapshots(client, batch.operations, null);
    batch.operations.forEach(function (operation, operationIndex) {
      var current = __bulkFindById(snapshots[operation.collection] || [], __bulkOperationId(operation));
      var expected = afterFile.after.filter(function (item) { return item.operationIndex === operationIndex; })[0];
      if (!current || !expected || __bulkHash(__encode(current)) !== expected.hash) {
        differences.push({ batchIndex: index, collection: operation.collection, id: __bulkIdSummary(__bulkOperationId(operation)), changedFields: __bulkChangedFields([operation]) });
      }
    });
  } finally { try { await client.close(); } catch (_closeError) {} }
  if (__bulkBytes({ items: differences }) > 8 * 1024 * 1024) __bulkFail("MONGODB_BULK_DIFF_TOO_LARGE", "verification differences exceed the bounded log size");
  __bulkWriteJson(__path.join(__bulkJobDir(jobId), "differences-" + String(index).padStart(6, "0") + ".json"), { batchIndex: index, items: differences }, 8 * 1024 * 1024);
  manifest = __bulkWithLock(__bulkManifestLockPath(jobId), function () {
    var latest = __bulkManifest(jobId, false);
    latest.verifiedBatchIndexes = latest.verifiedBatchIndexes || [];
    latest.differenceCounts = latest.differenceCounts || [];
    if (latest.verifiedBatchIndexes.indexOf(index) === -1) {
      latest.verifiedBatchIndexes.push(index);
      latest.verifiedBatchIndexes.sort(function (a, b) { return a - b; });
      latest.differenceCount = (latest.differenceCount || 0) + differences.length;
      latest.differenceCounts[index] = differences.length;
    }
    var verified = {};
    latest.verifiedBatchIndexes.forEach(function (batchIndex) { verified[batchIndex] = true; });
    var next = 0;
    while (verified[next]) next += 1;
    latest.nextVerifyBatch = next;
    latest.verifiedBatchCount = latest.verifiedBatchIndexes.length;
    latest.updatedAt = new Date().toISOString();
    var latestControl = __bulkReadJson(__path.join(__bulkJobDir(jobId), "control.json"), 64 * 1024);
    latest.desiredState = latestControl && latestControl.desiredState || latest.desiredState || "running";
    latest.status = latest.desiredState === "pause" ? "pause_requested" : "reviewing";
    __bulkSaveManifest(latest);
    return latest;
  });
  __bulkAppendJsonLine(__path.join(__bulkJobDir(jobId), "events.jsonl"), { at: manifest.updatedAt, event: "batch_verified", batchIndex: index, differenceCount: differences.length });
  return __bulkStatus(manifest, plan, { includeDifferences: true, offset: 0, limit: 10 });
}

async function __bulkRollbackBatch(jobId, planHash, leaseId, index) {
  var manifest = __bulkManifest(jobId, false);
  __bulkCheckPlan(manifest, planHash);
  __bulkAssertLease(jobId, leaseId);
  var plan = __bulkLoadPlan(jobId, manifest);
  var batch = __bulkLoadBatch(jobId, index);
  if (!batch || !plan.batches[index] || batch.hash !== plan.batches[index].hash) __bulkFail("MONGODB_BULK_LOG_INVALID", "batch rollback log is missing or changed");
  var control = __bulkReadJson(__path.join(__bulkJobDir(jobId), "control.json"), 64 * 1024);
  if (control && control.desiredState === "pause") return __bulkPause(jobId, planHash, leaseId, "pause_requested");
  var already = manifest.rolledBackBatchIndexes || [];
  if (already.indexOf(index) !== -1) return __bulkStatus(manifest, plan, {});
  var next = __bulkStatus(manifest, plan, {}).nextRollbackBatch;
  if (next !== index) __bulkFail("MONGODB_BULK_ROLLBACK_ORDER", "rollback must follow reverse commit order");
  var afterFile = __bulkReadJson(__path.join(__bulkJobDir(jobId), "after-" + String(index).padStart(6, "0") + ".json"), 8 * 1024 * 1024);
  if (!afterFile || afterFile.batchHash !== batch.hash) __bulkFail("MONGODB_BULK_LOG_INVALID", "postimage log is missing or changed; rollback is unavailable");
  batch.after = afterFile.after;
  var result = await __bulkRunTransaction(jobId, planHash, batch, true);
  manifest = __bulkWithLock(__bulkManifestLockPath(jobId), function () {
    var latest = __bulkManifest(jobId, false);
    latest.rolledBackBatchIndexes = latest.rolledBackBatchIndexes || [];
    if (latest.rolledBackBatchIndexes.indexOf(index) === -1) latest.rolledBackBatchIndexes.push(index);
    latest.updatedAt = new Date().toISOString();
    latest.status = "rolling_back";
    __bulkSaveManifest(latest);
    return latest;
  });
  __bulkAppendJsonLine(__path.join(__bulkJobDir(jobId), "events.jsonl"), { at: manifest.updatedAt, event: "batch_rolled_back", batchIndex: index, alreadyCommitted: result.alreadyCommitted });
  return __bulkStatus(manifest, plan, {});
}

function __bulkStart(jobId, planHash, leaseId, mode) {
  var manifest = __bulkManifest(jobId, false);
  __bulkCheckPlan(manifest, planHash);
  if (mode === "execute" && manifest.status !== "prepared" && manifest.status !== "paused" && manifest.status !== "recovery_required" && manifest.status !== "running" && manifest.status !== "reviewing") {
    __bulkFail("MONGODB_BULK_STATE_INVALID", "this job cannot be started from its current state");
  }
  if (mode === "rollback" && manifest.status !== "completed" && manifest.status !== "review_required" && manifest.status !== "paused" && manifest.status !== "recovery_required" && manifest.status !== "rolling_back") {
    __bulkFail("MONGODB_BULK_STATE_INVALID", "this job cannot be rolled back from its current state");
  }
  if (mode === "rollback" && Date.parse(manifest.rollbackExpiresAt) <= Date.now()) __bulkFail("MONGODB_BULK_ROLLBACK_EXPIRED", "bulk job rollback retention has expired");
  var lease = __bulkAcquireLease(jobId, manifest, leaseId, mode);
  return { jobId: jobId, planHash: planHash, leaseId: lease.leaseId, status: manifest.status, mode: mode, batchCount: manifest.batchCount, effectiveConcurrency: __config.concurrency || 1, accepted: true };
}

async function __bulkControl(jobId, command, planHash) {
  return __bulkWithLock(__bulkManifestLockPath(jobId), function () {
    var manifest = __bulkManifest(jobId, false);
    if (planHash && manifest.planHash !== planHash) __bulkFail("MONGODB_BULK_PLAN_HASH_MISMATCH", "planHash does not match the prepared job");
    if (command === "pause") {
      if (["completed", "rolled_back", "review_required", "failed"].indexOf(manifest.status) !== -1) __bulkFail("MONGODB_BULK_STATE_INVALID", "a terminal job cannot be paused");
      manifest.desiredState = "pause";
      manifest.status = "pause_requested";
    } else {
      if (["completed", "rolled_back", "review_required", "failed"].indexOf(manifest.status) !== -1) __bulkFail("MONGODB_BULK_STATE_INVALID", "a terminal job cannot be resumed");
      var lease = __bulkReadJson(__bulkLeasePath(), 64 * 1024);
      if (lease && Date.now() - Date.parse(lease.heartbeatAt) <= 60000) __bulkFail("MONGODB_BULK_INSTANCE_BUSY", "the current batch is still active", { jobId: lease.jobId });
      manifest.desiredState = "running";
      manifest.status = "paused";
    }
    manifest.updatedAt = new Date().toISOString();
    __bulkWriteJson(__path.join(__bulkJobDir(jobId), "control.json"), { desiredState: manifest.desiredState, at: manifest.updatedAt }, 64 * 1024);
    __bulkSaveManifest(manifest);
    __bulkAppendJsonLine(__path.join(__bulkJobDir(jobId), "events.jsonl"), { at: manifest.updatedAt, event: command === "pause" ? "pause_requested" : "resume_requested" });
    return { jobId: jobId, status: manifest.status, desiredState: manifest.desiredState, planHash: manifest.planHash, batchCount: manifest.batchCount, mode: manifest.mode || "execute" };
  });
}

function __bulkPause(jobId, planHash, leaseId, reason) {
  var manifest = __bulkManifest(jobId, false);
  if (planHash && manifest.planHash !== planHash) __bulkFail("MONGODB_BULK_PLAN_HASH_MISMATCH", "planHash does not match the prepared job");
  var lease = __bulkReadJson(__bulkLeasePath(), 64 * 1024);
  if (lease && lease.jobId === jobId && lease.leaseId === leaseId) __bulkReleaseLease(jobId, leaseId);
  manifest.desiredState = "pause";
  manifest.status = "paused";
  manifest.runningBatchIndexes = [];
  manifest.activePhase = null;
  manifest.pauseReason = String(reason || "paused").slice(0, 128);
  manifest.updatedAt = new Date().toISOString();
  __bulkWriteJson(__path.join(__bulkJobDir(jobId), "control.json"), { desiredState: "pause", at: manifest.updatedAt }, 64 * 1024);
  __bulkSaveManifest(manifest);
  __bulkAppendJsonLine(__path.join(__bulkJobDir(jobId), "events.jsonl"), { at: manifest.updatedAt, event: "paused", reason: manifest.pauseReason });
  return { jobId: jobId, status: manifest.status, pauseReason: manifest.pauseReason, planHash: manifest.planHash };
}

function __bulkFinish(jobId, planHash, leaseId, mode) {
  var manifest = __bulkManifest(jobId, false);
  __bulkCheckPlan(manifest, planHash);
  __bulkAssertLease(jobId, leaseId);
  var plan = __bulkLoadPlan(jobId, manifest);
  if (mode === "rollback") {
    if (__bulkStatus(manifest, plan, {}).nextRollbackBatch !== null) __bulkFail("MONGODB_BULK_ROLLBACK_INCOMPLETE", "not all committed batches have been rolled back");
    manifest.status = "rolled_back";
    manifest.rolledBackAt = new Date().toISOString();
  } else {
    if ((manifest.committedBatchIndexes || []).length !== manifest.batchCount || (manifest.verifiedBatchCount || 0) !== manifest.batchCount) __bulkFail("MONGODB_BULK_VERIFY_INCOMPLETE", "all batches must commit and verify before completion");
    manifest.status = manifest.differenceCount ? "review_required" : "completed";
    manifest.completedAt = new Date().toISOString();
  }
  manifest.updatedAt = new Date().toISOString();
  manifest.desiredState = "stop";
  manifest.runningBatchIndexes = [];
  manifest.activePhase = null;
  __bulkSaveManifest(manifest);
  __bulkReleaseLease(jobId, leaseId);
  __bulkAppendJsonLine(__path.join(__bulkJobDir(jobId), "events.jsonl"), { at: manifest.updatedAt, event: manifest.status, differenceCount: manifest.differenceCount });
  return __bulkStatus(manifest, plan, { includeDifferences: true, offset: 0, limit: 10 });
}

function __bulkGet(jobId) {
  var manifest = __bulkManifest(jobId, false);
  var plan = manifest.planHash ? __bulkLoadPlan(jobId, manifest) : null;
  var query = __request.query || {};
  if (manifest.status === "running" || manifest.status === "rolling_back" || manifest.status === "reviewing") {
    var lease = __bulkReadJson(__bulkLeasePath(), 64 * 1024);
    if (!lease || lease.jobId !== jobId || Date.now() - Date.parse(lease.heartbeatAt) > 60000) {
      manifest.status = "recovery_required";
      manifest.desiredState = "pause";
      manifest.pauseReason = "worker_restart_or_lost_lease";
      manifest.runningBatchIndexes = [];
      manifest.activePhase = null;
      manifest.updatedAt = new Date().toISOString();
      __bulkSaveManifest(manifest);
    }
  }
  return __bulkStatus(manifest, plan, { includeDifferences: query.includeDifferences === true, offset: query.offset, limit: query.limit });
}

function __bulkList() {
  var root = __bulkEnsureRoot();
  var dirs = __fs.readdirSync(root).filter(function (name) { return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name); });
  var items = [];
  dirs.forEach(function (name) {
    var manifest = __bulkReadJson(__path.join(root, name, "manifest.json"), 4 * 1024 * 1024);
    if (manifest && manifest.jobId === name) {
      items.push({ jobId: name, database: manifest.database, status: manifest.status, mode: manifest.mode || "execute", createdAt: manifest.createdAt, updatedAt: manifest.updatedAt, planHash: manifest.planHash, operationCount: manifest.operationCount, unitCount: manifest.unitCount, batchCount: manifest.batchCount || 0, rollbackExpiresAt: manifest.rollbackExpiresAt, pauseReason: manifest.pauseReason });
    }
  });
  items.sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });
  var offset = __request.offset || 0;
  var limit = __request.limit || 20;
  return { jobs: items.slice(offset, offset + limit), offset: offset, limit: limit, total: items.length, hasMore: offset + limit < items.length };
}

async function __bulkMain() {
  var data;
  try {
    __bulkEnsureRoot();
    var action = __request.action;
    if (action === "list") {
      data = __bulkList();
      process.stdout.write(__marker + JSON.stringify({ ok: true, data: data }) + "\n");
      return;
    }
    var jobId = __bulkJobId();
    if (action === "upload") data = await __bulkUpload();
    else if (action === "get") data = __bulkGet(jobId);
    else if (action === "executeStart") data = __bulkStart(jobId, __request.planHash, __request.leaseId, "execute");
    else if (action === "rollbackStart") data = __bulkStart(jobId, __request.planHash, __request.leaseId, "rollback");
    else if (action === "control") data = await __bulkControl(jobId, __request.command, __request.planHash);
    else if (action === "resume") {
      var resumeManifest = __bulkManifest(jobId, false);
      __bulkCheckPlan(resumeManifest, __request.planHash);
      data = __bulkStart(jobId, __request.planHash, __request.leaseId, resumeManifest.mode === "rollback" ? "rollback" : "execute");
    }
    else if (action === "executeBatch") data = await __bulkExecuteBatch(jobId, __request.planHash, __request.leaseId, __request.batchIndex);
    else if (action === "verifyBatch") data = await __bulkVerifyBatch(jobId, __request.planHash, __request.leaseId, __request.batchIndex);
    else if (action === "rollbackBatch") data = await __bulkRollbackBatch(jobId, __request.planHash, __request.leaseId, __request.batchIndex);
    else if (action === "dispatch") data = __bulkSetDispatch(jobId, __request.planHash, __request.leaseId, __request.phase, __request.batchIndexes);
    else if (action === "pause") data = __bulkPause(jobId, __request.planHash, __request.leaseId, __request.reason);
    else if (action === "heartbeat") {
      var heartbeatManifest = __bulkManifest(jobId, false);
      __bulkCheckPlan(heartbeatManifest, __request.planHash);
      var heartbeatLease = __bulkAssertLease(jobId, __request.leaseId);
      data = { jobId: jobId, leaseId: heartbeatLease.leaseId, heartbeatAt: heartbeatLease.heartbeatAt, status: heartbeatManifest.status };
    }
    else if (action === "finish") data = __bulkFinish(jobId, __request.planHash, __request.leaseId, __request.mode || "execute");
    else __bulkFail("MONGODB_BULK_ACTION_INVALID", "unsupported bulk action");
    process.stdout.write(__marker + JSON.stringify({ ok: true, data: data }) + "\n");
  } catch (error) {
    process.stdout.write(__marker + JSON.stringify({ ok: false, error: { code: error.code || "MONGODB_BULK_FAILED", message: String(error.message || error).slice(0, 2000), details: error.details } }) + "\n");
    process.exitCode = 1;
  }
}
`;
