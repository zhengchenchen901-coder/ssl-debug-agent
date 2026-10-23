import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mutationPrepareHarness } from "./helpers/mutation-prepare-harness.js";

const uri = process.env.RDA_INDEX_TEST_URI, driverPath = process.env.RDA_INDEX_TEST_DRIVER;
// Explicitly opt in with a disposable, failpoint-enabled, TWO-member loopback
// replica set. Never attach this test to saved instances or an existing DB.
test("real secondary lag reproduces legacy verification failure; fixed helper recovers with one DDL", {
  skip: !uri || !driverPath, timeout: 60000,
}, async (t) => {
  assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:\d+(,127\.0\.0\.1:\d+)*\/[^?]*\?/);
  const driver = createRequire(import.meta.url)(driverPath);
  const base = new driver.MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true, readPreference: "primary", serverSelectionTimeoutMS: 10000 });
  const secondary = new driver.MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true, readPreference: "secondary", serverSelectionTimeoutMS: 10000 });
  await base.connect(); await secondary.connect();
  const dbName = "rda_index_" + randomUUID().replaceAll("-", "");
  const db = base.db(dbName), col = db.collection("orders");
  let stopped = false;
  t.after(async () => {
    try { if (stopped) await secondary.db("admin").command({ configureFailPoint: "rsSyncApplyStop", mode: "off" }, { readPreference: "secondary" }); }
    finally { await db.dropDatabase(); await base.close(); await secondary.close(); }
  });
  await col.insertOne({ tenant: "t", customer: "c" }, { writeConcern: { w: "majority", wtimeout: 10000 } });
  await secondary.db("admin").command({ configureFailPoint: "rsSyncApplyStop", mode: "alwaysOn" }, { readPreference: "secondary" }); stopped = true;
  // Reproduce inherited-secondary catalog verification after acknowledged DDL.
  // MongoDB 4.4 adds index-build voting: quorum=1 is only a fixture control so
  // this command can finish while the secondary applier is paused.
  const legacy = secondary.db(dbName).collection("orders");
  await db.command({ createIndexes: "orders", indexes: [{ key: { customer: 1 }, name: "idx_legacy" }],
    commitQuorum: 1, writeConcern: { w: 1 }, maxTimeMS: 10000 }, { readPreference: "primary" });
  assert.equal((await legacy.listIndexes().toArray()).some((i) => i.name === "idx_legacy"), false);
  assert.equal((await col.listIndexes({ readPreference: "primary" }).toArray()).some((i) => i.name === "idx_legacy"), true);
  t.diagnostic("Legacy command acknowledged; secondary catalog missing; primary catalog present (replication deliberately paused).");
  await secondary.db("admin").command({ configureFailPoint: "rsSyncApplyStop", mode: "off" }, { readPreference: "secondary" }); stopped = false;

  let ddl = 0, hide = true;
  class InstrumentedClient extends driver.MongoClient {
    constructor(connection, options) {
      super(connection, { ...options, monitorCommands: true });
      this.on("commandStarted", (event) => { if (["createIndexes", "dropIndexes"].includes(event.commandName)) ddl++; });
    }
    db(name, options) {
      const database = super.db(name, options), collection = database.collection.bind(database);
      database.collection = (...args) => {
        const result = collection(...args), list = result.listIndexes.bind(result);
        result.listIndexes = (readOptions) => {
          const cursor = list(readOptions);
          if (hide && ddl > 0) cursor.toArray = async () => [{ name: "_id_", key: { _id: 1 } }];
          return cursor;
        };
        return result;
      };
      return database;
    }
  }
  const h = mutationPrepareHarness(t, { driver: { MongoClient: InstrumentedClient }, uri });
  h.config.database = dbName; h.config.allowedDatabases = [dbName];
  const plan = await h.run({ mode: "prepare", kind: "index", database: dbName, collection: "orders", operation: "createIndex", name: "idx_fixed", key: { tenant: 1, customer: 1 } });
  const ticket = { intentId: "a".repeat(64), operationId: "real-execute" };
  const args = { mutationId: plan.mutationId, planHash: plan.planHash, _businessExecution: ticket };
  await assert.rejects(h.run({ ...args, mode: "commit", confirmation: "确认执行" }), { code: "MONGODB_INDEX_COMMIT_UNKNOWN" });
  assert.equal(ddl, 1); hide = false;
  assert.equal((await h.run({ ...args, mode: "recover_execution", database: dbName })).status, "committed");
  assert.equal((await h.run({ ...args, mode: "commit", confirmation: "确认执行" })).status, "committed"); assert.equal(ddl, 1);
  assert.equal((await h.run({ ...args, mode: "rollback", confirmation: "确认回滚" })).status, "rolled_back"); assert.equal(ddl, 2);
  assert.equal((await col.listIndexes().toArray()).some((i) => i.name === "idx_fixed"), false);
  t.diagnostic("New helper: one createIndexes, acknowledged journal, failed metadata observation, exact recovery, idempotent execute, verified compensating rollback.");
});
