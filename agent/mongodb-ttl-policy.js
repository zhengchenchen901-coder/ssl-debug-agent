export const MONGODB_TECHNICAL_RECEIPTS_COLLECTION = "__remote_debug_bulk_receipts";

// Shared by both fixed remote helpers. Keep compatible with remote Node 12+.
export const MONGODB_TTL_POLICY_SCRIPT = String.raw`
function __ttlRejectBusinessIndex(options) {
  if (options && Object.prototype.hasOwnProperty.call(options, "expireAfterSeconds")) {
    __ttlFail("MONGODB_TTL_INDEX_REJECTED", "business TTL indexes are not supported: automatic document deletion cannot be recovered by index rollback");
  }
}

function __ttlAssertReceiptName(name) {
  if (name !== "__remote_debug_bulk_receipts") {
    __ttlFail("MONGODB_BULK_RECEIPTS_RESERVED", "TTL cleanup is restricted to the reserved __remote_debug_bulk_receipts collection");
  }
}

function __ttlValidReceiptMarker(marker, database, name) {
  return marker && marker._id === "__remote_debug_bulk_storage_v1" && marker.schemaVersion === 1 && marker.database === database && marker.receiptsCollection === name;
}

function __ttlValidReceiptIndex(index) {
  return index && index.name === "remote_debug_bulk_receipt_expiry" && index.key && Object.keys(index.key).length === 1 && index.key.expiresAt === 1 && index.expireAfterSeconds === 0 && !index.partialFilterExpression && !index.unique && !index.sparse;
}

async function __ttlCheckReceiptOwnership(collection, database, name, initialize) {
  __ttlAssertReceiptName(name);
  var markerId = "__remote_debug_bulk_storage_v1";
  var existing = await collection.findOne({ _id: markerId }, { readPreference: "primary", maxTimeMS: 15000 });
  if (existing) {
    if (!__ttlValidReceiptMarker(existing, database, name)) __ttlFail("MONGODB_BULK_STORAGE_CONFLICT", "technical receipt collection has a different ownership marker");
    return existing;
  }
  if (!initialize) __ttlFail("MONGODB_BULK_STORAGE_NOT_INITIALIZED", "technical receipt ownership marker is missing");
  if (await collection.findOne({}, { readPreference: "primary", maxTimeMS: 15000 })) {
    __ttlFail("MONGODB_BULK_STORAGE_CONFLICT", "cannot adopt a non-empty collection for automatic TTL cleanup");
  }
  var marker = { _id: markerId, schemaVersion: 1, database: database, receiptsCollection: name };
  try { await collection.insertOne(marker); }
  catch (error) {
    if (error.code !== 11000) throw error;
    var concurrent = await collection.findOne({ _id: markerId }, { readPreference: "primary", maxTimeMS: 15000 });
    if (!__ttlValidReceiptMarker(concurrent, database, name)) __ttlFail("MONGODB_BULK_STORAGE_CONFLICT", "technical receipt collection ownership changed during initialization");
  }
  return marker;
}

async function __ttlInitializeReceiptCollection(client, database, name) {
  __ttlAssertReceiptName(name);
  var db = client.db(database);
  var namespaces = await db.listCollections({ name: name }, { nameOnly: true }).toArray();
  if (namespaces.some(function (item) { return item.type && item.type !== "collection"; })) {
    __ttlFail("MONGODB_BULK_STORAGE_CONFLICT", "technical receipt namespace must be a regular collection");
  }
  var collection = db.collection(name);
  // Verify or establish ownership before installing any automatically deleting index.
  await __ttlCheckReceiptOwnership(collection, database, name, true);
  var indexes = await collection.listIndexes().toArray();
  var existing = indexes.filter(function (index) { return index.name === "remote_debug_bulk_receipt_expiry"; })[0];
  if (existing && !__ttlValidReceiptIndex(existing)) __ttlFail("MONGODB_BULK_STORAGE_CONFLICT", "technical receipt expiry index has a different definition");
  if (!existing) await collection.createIndex({ expiresAt: 1 }, { name: "remote_debug_bulk_receipt_expiry", expireAfterSeconds: 0 });
  var after = (await collection.listIndexes().toArray()).filter(function (index) { return index.name === "remote_debug_bulk_receipt_expiry"; })[0];
  if (!__ttlValidReceiptIndex(after)) __ttlFail("MONGODB_BULK_STORAGE_INDEX_FAILED", "technical receipt expiry index could not be verified");
  return { index: after.name, marker: "__remote_debug_bulk_storage_v1" };
}
`;
