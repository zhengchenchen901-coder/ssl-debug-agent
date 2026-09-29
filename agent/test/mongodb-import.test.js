import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import crypto from "node:crypto";
import path from "node:path/posix";
import { buildMongoMutationScript, normalizeMongoImport, normalizeMongoTransaction, runMongoMutation } from "../mongodb-mutations.js";
import { MONGODB_RESULT_MARKER } from "../mongodb.js";

const config = {
  enabled: true, writeEnabled: true, configPath: "/home/app/config.json", driverPath: "/home/app/node_modules/mongodb",
  configProfile: "test", uriKey: "url", database: "test", allowedDatabases: ["test"],
  allowedCollections: ["members"], maxAffectedDocuments: 20,
};
const input = (count = 2000) => ({ importId: "seed-01", collection: "members", documents: Array.from({ length: count }, (_, i) => ({ _id: `m${i}`, value: i })) });

test("import splits at 2000 independently of ordinary transaction limits and applies instance policy", () => {
  const plan = normalizeMongoImport(input(4500), config);
  assert.deepEqual(plan.batches.map((batch) => batch.documents.length), [2000, 2000, 500]);
  assert.deepEqual(normalizeMongoImport(input(3), { ...config, maxImportBatchDocuments: 2 }).batches.map((batch) => batch.documents.length), [2, 1]);
  assert.equal(normalizeMongoImport(input(), { ...config, maxImportBatchDocuments: 9999 }).batches[0].documents.length, 2000);
  assert.throws(() => normalizeMongoTransaction({ operations: input(21).documents.map((document) => ({ operation: "insertOne", collection: "members", document })) }, config), { code: "MONGODB_TRANSACTION_TOO_LARGE" });
  const again = normalizeMongoImport(input(4500), config);
  assert.deepEqual(again.batches.map((b) => b.mutationId), plan.batches.map((b) => b.mutationId));
});

test("import enforces allowlists, explicit unique ids, count/byte limits, and UTF-8 byte splitting", () => {
  for (const [request, policy, code] of [
    [input(), { ...config, writeEnabled: false }, "MONGODB_MUTATIONS_DISABLED"],
    [{ ...input(), collection: "forbidden" }, config, "MONGODB_COLLECTION_NOT_ALLOWED"],
    [{ ...input(), database: "other" }, config, "MONGODB_DATABASE_NOT_ALLOWED"],
    [{ ...input(), documents: [{ _id: "a" }, { _id: "a" }] }, config, "MONGODB_IMPORT_DUPLICATE_ID"],
    [{ ...input(), documents: [{}] }, config, "MONGODB_MUTATION_ID_REQUIRED"],
    [{ ...input(), documents: [{ _id: { $in: [1] } }] }, config, "MONGODB_IMPORT_ID_INVALID"],
    [input(10001), config, "MONGODB_IMPORT_COUNT_LIMIT"],
    [{ ...input(30), documents: input(30).documents.map((d) => ({ ...d, text: "a".repeat(150000) })) }, config, "MONGODB_IMPORT_SIZE_LIMIT"],
    [{ ...input(101), batchSize: 1 }, config, "MONGODB_IMPORT_BATCH_LIMIT"],
  ]) assert.throws(() => normalizeMongoImport(request, policy), { code });
  const plan = normalizeMongoImport({ ...input(5), documents: input(5).documents.map((d) => ({ ...d, text: "中".repeat(70000) })) }, config);
  assert.deepEqual(plan.batches.map((b) => b.documents.length), [2, 2, 1]);
  for (const batch of plan.batches) assert.ok(Buffer.byteLength(JSON.stringify(batch.documents)) <= 512 * 1024);
});

// Execute the generated remote helper, with transactional database and filesystem
// doubles. This checks behavior across separate SSH invocations and lost replies.
function harness({ cryptoModule = crypto, readPreference = "primary", legacyBson = false, cleanup = () => Promise.resolve() } = {}) {
  const files = new Map([[config.configPath, JSON.stringify({ test: { url: "test-uri" } })]]);
  const directories = new Set();
  const fds = new Map();
  let fd = 0;
  const state = { rows: new Map(), find: 0, insert: 0, remove: 0, failInsert: false, loseCommitReply: false, failConnect: false };
  const fs = {
    constants: { O_CREAT: 1, O_APPEND: 2, O_WRONLY: 4 },
    existsSync: (p) => files.has(p) || directories.has(p),
    lstatSync: () => ({ isSymbolicLink: () => false, mtimeMs: Date.now() }),
    statSync: () => ({ mtimeMs: Date.now() }),
    mkdirSync: (p) => { directories.add(p); directories.add(path.dirname(p)); },
    chmodSync() {}, fsyncSync() {},
    openSync(p, flags) {
      if (flags === "wx" && files.has(p)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
      if (flags === "w" || flags === "wx") files.set(p, "");
      fds.set(++fd, { p, append: typeof flags === "number" });
      return fd;
    },
    closeSync: (n) => fds.delete(n),
    writeFileSync(n, value) { const { p, append } = fds.get(n); files.set(p, (append ? files.get(p) || "" : "") + value); },
    readFileSync(p) { if (!files.has(p)) throw new Error(`missing ${p}`); return files.get(p); },
    renameSync(a, b) { files.set(b, files.get(a)); files.delete(a); },
    unlinkSync: (p) => files.delete(p),
    readdirSync: (p) => [...directories].filter((d) => path.dirname(d) === p).map((d) => path.basename(d)),
  };
  class Oid {
    constructor(hex) { this.hex = hex; this._bsontype = "ObjectID"; }
    toJSON() { return this.hex; }
    toHexString() { return this.hex; }
  }
  const encode = (v) => v instanceof Oid ? { $oid: v.hex } : Array.isArray(v) ? v.map(encode) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, value]) => [k, encode(value)])) : v;
  const bson = { EJSON: { stringify: (v) => JSON.stringify(encode(v)), parse: (s) => JSON.parse(s, (_k, v) => v?.$oid ? new Oid(v.$oid) : v) } };
  const key = (id) => JSON.stringify(encode(id));
  const clone = (value) => bson.EJSON.parse(bson.EJSON.stringify(value));
  const cloneRows = () => new Map([...state.rows].map(([k, v]) => [k, clone(v)]));
  const collection = {
    async findOne(filter, options) {
      if (legacyBson && typeof filter._id === "object") assert.ok(filter._id instanceof Oid);
      return clone((options?.session?.rows || state.rows).get(key(filter._id)) || null);
    },
    async insertOne(document, options) { return this.insertMany([document], options); },
    async deleteOne(filter, options) { return this.deleteMany({ _id: { $in: [filter._id] } }, options); },
    async updateOne(filter, update, { session }) {
      if (legacyBson && typeof filter._id === "object") assert.ok(filter._id instanceof Oid);
      const row = session.rows.get(key(filter._id));
      if (!row) return { n: 0 };
      Object.assign(row, clone(update.$set));
      return { n: 1 };
    },
    async replaceOne(filter, document, { session }) {
      if (legacyBson && typeof filter._id === "object") assert.ok(filter._id instanceof Oid);
      if (!session.rows.has(key(filter._id))) return { n: 0 };
      session.rows.set(key(filter._id), clone(document));
      return { n: 1 };
    },
    find(filter, options) {
      state.find++;
      const requestedIds = filter._id.$in || [filter._id];
      if (legacyBson) for (const id of requestedIds) if (typeof id === "object") assert.ok(id instanceof Oid);
      const ids = new Set(requestedIds.map(key));
      let limit = Infinity;
      const cursor = { limit(n) { limit = n; return cursor; }, maxTimeMS() { return cursor; },
        async toArray() { return [...(options?.session?.rows || state.rows)].filter(([k]) => ids.has(k)).slice(0, limit).map(([, v]) => clone(v)); } };
      return cursor;
    },
    async insertMany(documents, { session }) {
      state.insert++;
      for (const document of documents) {
        if (legacyBson && typeof document._id === "object") assert.ok(document._id instanceof Oid);
        if (session.rows.has(key(document._id))) throw new Error("duplicate");
        session.rows.set(key(document._id), clone(document));
        if (state.failInsert) { state.failInsert = false; throw new Error("injected partial insert failure"); }
      }
    },
    async deleteMany(filter, { session }) {
      state.remove++;
      let deletedCount = 0;
      for (const id of filter._id.$in) if (session.rows.delete(key(id))) deletedCount++;
      return { deletedCount };
    },
  };
  class MongoClient {
    async connect() { if (state.failConnect) throw new Error("connect failed"); }
    close() { return cleanup(); }
    db() { return { collection: () => collection }; }
    startSession() {
      return {
        rows: null,
        startTransaction(options = {}) {
          const effectiveReadPreference = options.readPreference || readPreference;
          if (effectiveReadPreference !== "primary") {
            throw new Error(`Read preference in a transaction must be primary, not: ${effectiveReadPreference}`);
          }
          this.rows = cloneRows();
        },
        async commitTransaction() {
          state.rows = this.rows;
          if (state.loseCommitReply) { state.loseCommitReply = false; throw new Error("reply lost"); }
        },
        async abortTransaction() { this.rows = null; },
        async withTransaction(callback, options) {
          this.startTransaction(options);
          try { await callback(); await this.commitTransaction(); }
          catch (error) { await this.abortTransaction(); throw error; }
        },
        endSession() { return cleanup(); },
      };
    }
  }
  const require = (name) => ({ fs, path, crypto: cryptoModule, bson: legacyBson ? {} : bson, [config.driverPath]: { MongoClient, ObjectID: Oid } })[name];
  require.resolve = () => "bson";
  async function execute(script) {
    let stdout = "";
    const process = { pid: 42, exitCode: 0, stdout: { write: (s) => { stdout += s; } } };
    await new vm.Script(script).runInNewContext({ require, process, Buffer });
    return { stdout, stderr: "", exitCode: process.exitCode, timedOut: false };
  }
  return { state, files, key, run: (request, policy = config) => runMongoMutation(request, { config: policy, runSSH: async (_command, { stdin }) => execute(stdin) }) };
}

const commit = (batch) => ({ mode: "commit", mutationId: batch.mutationId, planHash: batch.planHash, confirmation: "确认执行" });
const rollback = (batch) => ({ ...commit(batch), mode: "rollback", confirmation: "确认回滚" });
const prepare = (request) => ({ ...request, kind: "import_plan" });

for (const [cleanupName, cleanup] of [
  ["void", () => undefined],
  ["synchronous throw", () => { throw new Error("cleanup failed"); }],
  ["rejected promise", () => Promise.reject(new Error("cleanup failed"))],
]) {
  for (const kind of ["document", "transaction", "import"]) {
    test(`${kind} preserves commit, rollback and idempotency with ${cleanupName} cleanup`, async () => {
      const h = harness({ cleanup });
      const operation = { operation: "insertOne", collection: "members", document: { _id: "cleanup-check" } };
      const prepared = await h.run(kind === "import" ? prepare(input(1)) : kind === "transaction" ? { kind, operations: [operation] } : operation);
      const plan = kind === "import" ? prepared.batches[0] : prepared;
      assert.equal((await h.run(commit(plan))).status, "committed");
      assert.equal(h.state.rows.size, 1);
      assert.equal((await h.run(commit(plan))).status, "committed");
      assert.equal(h.state.insert, 1);
      assert.equal((await h.run(rollback(plan))).status, "rolled_back");
      assert.equal(h.state.rows.size, 0);
      assert.equal((await h.run(rollback(plan))).status, "rolled_back");
      assert.equal(h.state.remove, 1);
    });
    test(`${kind} retains the original transaction error with ${cleanupName} cleanup`, async () => {
      const h = harness({ cleanup });
      const operation = { operation: "insertOne", collection: "members", document: { _id: "cleanup-check" } };
      const prepared = await h.run(kind === "import" ? prepare(input(1)) : kind === "transaction" ? { kind, operations: [operation] } : operation);
      const plan = kind === "import" ? prepared.batches[0] : prepared;
      h.state.failInsert = true;
      await assert.rejects(h.run(commit(plan)), /injected partial insert failure/);
      assert.equal(h.state.rows.size, 0);
      const manifest = JSON.parse([...h.files].find(([p]) => p.endsWith(`/${plan.mutationId}/manifest.json`))[1]);
      assert.equal(manifest.status, kind === "import" ? "commit_retryable" : "commit_failed");
    });
  }
}

test("legacy BSON without EJSON preserves ObjectId through transaction preview, commit and rollback", async () => {
  for (const combined of [false, true]) {
    const h = harness({ legacyBson: true });
    const id = { $oid: "507f1f77bcf86cd799439011" };
    const operation = { operation: "insertOne", collection: "members", document: { _id: id, nested: { ids: [id] } } };
    const plan = await h.run(combined ? { kind: "transaction", operations: [operation] } : operation);
    assert.equal(h.state.rows.size, 0);
    assert.equal((await h.run(commit(plan))).status, "committed");
    const row = h.state.rows.get(h.key(id));
    assert.equal(row._id.toHexString(), id.$oid);
    assert.equal(row.nested.ids[0].toHexString(), id.$oid);
    assert.equal((await h.run(rollback(plan))).status, "rolled_back");
    assert.equal(h.state.rows.size, 0);
  }
});

test("legacy ObjectId menu updates retain typed references and restore original snapshots", async () => {
  for (const combined of [false, true]) {
    const h = harness({ legacyBson: true });
    const id = { $oid: "507f1f77bcf86cd799439011" };
    const ref = { $oid: "507f1f77bcf86cd799439012" };
    const original = { _id: id, refs: [ref] };
    const seed = await h.run({ operation: "insertOne", collection: "members", document: original });
    await h.run(commit(seed));
    const operation = { operation: "updateOne", collection: "members", filter: { _id: id }, update: { $set: { refs: [] } }, expectedCount: 1 };
    const plan = await h.run(combined ? { kind: "transaction", operations: [operation] } : operation);
    assert.equal(h.state.rows.get(h.key(id)).refs[0].toHexString(), ref.$oid);
    await h.run(commit(plan));
    assert.equal(h.state.rows.get(h.key(id)).refs.length, 0);
    await h.run(rollback(plan));
    assert.equal(h.state.rows.get(h.key(id))._id.toHexString(), id.$oid);
    assert.equal(h.state.rows.get(h.key(id)).refs[0].toHexString(), ref.$oid);
  }
});

test("legacy ObjectId rollback still rejects externally changed documents", async () => {
  const h = harness({ legacyBson: true });
  const id = { $oid: "507f1f77bcf86cd799439011" };
  const plan = await h.run({ operation: "insertOne", collection: "members", document: { _id: id } });
  await h.run(commit(plan));
  h.state.rows.get(h.key(id)).external = true;
  await assert.rejects(h.run(rollback(plan)), { code: "MONGODB_ROLLBACK_CONFLICT" });
  assert.equal(h.state.rows.get(h.key(id)).external, true);
});

test("import commit retry and rollback override secondaryPreferred without changing the plan", async () => {
  const h = harness({ readPreference: "secondaryPreferred" });
  const request = prepare(input(2));
  const batch = (await h.run(request)).batches[0];
  h.state.failInsert = true;
  await assert.rejects(h.run(commit(batch)), /injected partial insert failure/);
  assert.equal(h.state.rows.size, 0);
  const retry = (await h.run(request)).batches[0];
  assert.equal(retry.status, "commit_retryable");
  assert.equal(retry.mutationId, batch.mutationId);
  assert.equal(retry.planHash, batch.planHash);
  assert.equal((await h.run(commit(batch))).status, "committed");
  assert.equal(h.state.rows.size, 2);
  assert.equal((await h.run(rollback(batch))).status, "rolled_back");
  assert.equal(h.state.rows.size, 0);
});

test("single and combined mutation commits and rollbacks override secondaryPreferred", async () => {
  for (const combined of [false, true]) {
    const h = harness({ readPreference: "secondaryPreferred" });
    const operation = { operation: "insertOne", collection: "members", document: { _id: "primary-check" } };
    const request = combined ? { kind: "transaction", operations: [operation] } : operation;
    const plan = await h.run(request);
    assert.equal((await h.run(commit(plan))).status, "committed");
    assert.equal(h.state.rows.size, 1);
    assert.equal((await h.run(rollback(plan))).status, "rolled_back");
    assert.equal(h.state.rows.size, 0);
  }
});

test("import journals support remote crypto without randomUUID through prepare, commit and rollback", async () => {
  const h = harness({ cryptoModule: { createHash: crypto.createHash, randomBytes: crypto.randomBytes } });
  const plan = await h.run(prepare(input(2)));
  assert.equal(plan.status, "prepared");
  assert.equal(h.state.rows.size, 0);
  const batch = plan.batches[0];
  assert.equal((await h.run(prepare(input(2)))).batches[0].planHash, batch.planHash);
  assert.equal((await h.run(commit(batch))).status, "committed");
  assert.equal(h.state.rows.size, 2);
  assert.equal((await h.run(rollback(batch))).status, "rolled_back");
  assert.equal(h.state.rows.size, 0);
});

test("2000-document import uses bulk operations, stable journals, idempotent commit and atomic rollback", async () => {
  const h = harness();
  const plan = await h.run(prepare(input()));
  assert.equal(plan.batchCount, 1);
  assert.equal(h.state.rows.size, 0);
  const batch = plan.batches[0];
  const repeated = await h.run(prepare(input()));
  assert.equal(repeated.batches[0].planHash, batch.planHash);
  assert.equal((await h.run(commit(batch))).status, "committed");
  assert.equal(h.state.rows.size, 2000);
  assert.equal(h.state.insert, 1);
  assert.equal(h.state.find, 3); // prepare, pre-insert, post-insert
  await h.run(commit(batch));
  assert.equal(h.state.insert, 1);
  assert.equal((await h.run(prepare(input()))).batches[0].status, "committed");
  assert.equal((await h.run(rollback(batch))).status, "rolled_back");
  assert.equal(h.state.rows.size, 0);
  assert.equal(h.state.remove, 1);
  await h.run(rollback(batch));
  assert.equal(h.state.remove, 1);
});

test("failed batch aborts atomically and retries without repeating completed batches", async () => {
  const h = harness();
  const plan = await h.run(prepare({ ...input(3), batchSize: 2 }));
  await h.run(commit(plan.batches[0]));
  h.state.failInsert = true;
  await assert.rejects(h.run(commit(plan.batches[1])));
  assert.equal(h.state.rows.size, 2);
  const again = await h.run(prepare({ ...input(3), batchSize: 2 }));
  assert.deepEqual(again.batches.map((b) => b.status), ["committed", "commit_retryable"]);
  await h.run(commit(plan.batches[1]));
  assert.equal(h.state.rows.size, 3);
  await h.run(rollback(plan.batches[1]));
  assert.equal(h.state.rows.size, 2);
});

test("lost commit reply remains unknown and blocks unsafe retries or rollback", async () => {
  const h = harness();
  const plan = await h.run(prepare(input(2)));
  h.state.loseCommitReply = true;
  await assert.rejects(h.run(commit(plan.batches[0])));
  assert.equal(h.state.rows.size, 2);
  const again = await h.run(prepare(input(2)));
  assert.equal(again.batches[0].status, "commit_unknown");
  await assert.rejects(h.run(commit(plan.batches[0])), { code: "MONGODB_MUTATION_STATE_INVALID" });
  await assert.rejects(h.run(rollback(plan.batches[0])), { code: "MONGODB_MUTATION_NOT_COMMITTED" });
  assert.equal(h.state.insert, 1);
});

test("connection failures before a transaction can retry the same import plan", async () => {
  const h = harness();
  const batch = (await h.run(prepare(input(2)))).batches[0];
  h.state.failConnect = true;
  await assert.rejects(h.run(commit(batch)));
  h.state.failConnect = false;
  assert.equal((await h.run(prepare(input(2)))).batches[0].status, "commit_retryable");
  await h.run(commit(batch));
  assert.equal(h.state.rows.size, 2);
});

test("partial preparation exposes completed plans and an explicit failed batch", async () => {
  const h = harness();
  h.state.rows.set(h.key("m2"), { _id: "m2", value: "preexisting" });
  const plan = await h.run(prepare({ ...input(3), batchSize: 2 }));
  assert.equal(plan.status, "prepare_partial");
  assert.equal(plan.batches.length, 1);
  assert.equal(plan.failedBatch.batchIndex, 1);
  assert.equal(plan.failedBatch.code, "MONGODB_MUTATION_TARGET_EXISTS");
  assert.equal(h.state.rows.size, 1);
});

test("rollback detects external changes and batch scope/plan confirmation is enforced", async () => {
  const h = harness();
  const batch = (await h.run(prepare(input(2)))).batches[0];
  await assert.rejects(h.run({ ...commit(batch), confirmation: "wrong" }), { code: "MONGODB_MUTATION_CONFIRMATION_REQUIRED" });
  await assert.rejects(h.run({ ...commit(batch), planHash: "0".repeat(64) }), { code: "MONGODB_MUTATION_PLAN_HASH_MISMATCH" });
  await assert.rejects(h.run(commit(batch), { ...config, maxImportBatchDocuments: 1 }), { code: "MONGODB_MUTATION_POLICY_CHANGED" });
  await assert.rejects(h.run(commit(batch), { ...config, allowedCollections: ["other"] }), { code: "MONGODB_MUTATION_POLICY_CHANGED" });
  await assert.rejects(h.run(commit(batch), { ...config, configProfile: "production" }), { code: "MONGODB_MUTATION_POLICY_CHANGED" });
  await h.run(commit(batch));
  h.state.rows.get(h.key("m0")).value = "external";
  await assert.rejects(h.run(rollback(batch)), { code: "MONGODB_ROLLBACK_CONFLICT" });
  assert.equal(h.state.rows.size, 2);
  assert.equal(h.state.remove, 0);
});

test("ObjectId import stays BSON typed through prepare, commit, duplicate checks and rollback", async () => {
  const h = harness();
  const request = { ...input(1), documents: [{ _id: { $oid: "abcdef012345678901234567" }, value: 1 }] };
  const batch = (await h.run(prepare(request))).batches[0];
  await h.run(commit(batch));
  await assert.rejects(h.run(prepare({ ...request, importId: "different" })), { code: "MONGODB_MUTATION_TARGET_EXISTS" });
  await h.run(rollback(batch));
  assert.equal(h.state.rows.size, 0);
});

test("lost rollback reply blocks deletion retries and preserves the uncertain state", async () => {
  const h = harness();
  const batch = (await h.run(prepare(input(2)))).batches[0];
  await h.run(commit(batch));
  h.state.loseCommitReply = true;
  await assert.rejects(h.run(rollback(batch)));
  assert.equal((await h.run(prepare(input(2)))).batches[0].status, "rollback_unknown");
  await assert.rejects(h.run(rollback(batch)), { code: "MONGODB_MUTATION_NOT_COMMITTED" });
  assert.equal(h.state.remove, 1);
});

test("large import script parses and fits the dedicated bounded transport", () => {
  const mutation = normalizeMongoImport({ ...input(20), documents: input(20).documents.map((d) => ({ ...d, text: "a".repeat(150000) })) }, config);
  const script = buildMongoMutationScript({ mode: "prepare", kind: "import_plan", mutation }, config);
  assert.ok(Buffer.byteLength(script) > 512 * 1024);
  assert.doesNotThrow(() => new vm.Script(script));
});
