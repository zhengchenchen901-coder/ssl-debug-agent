import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import {
  MONGODB_RESULT_MARKER,
  buildMongoScript,
  normalizeMongoQuery,
  redactMongoSecrets,
  runMongoQuery,
} from "../mongodb.js";

const mongodb = {
  enabled: true,
  configPath: "/home/github/app/config.json",
  driverPath: "/home/github/app/node_modules/mongodb",
  configProfile: "test",
  uriKey: "url",
  database: "yennefer",
};

test("MongoDB name discovery returns stable bounded pages", async () => {
  const names = Array.from({ length: 503 }, (_, i) => ({ name: `name${String(i).padStart(4, "0")}`, type: "collection" })).reverse();
  for (const operation of ["listDatabases", "listCollections"]) {
    let output = "";
    class MongoClient {
      async connect() {}
      async close() {}
      db() { return {
        admin: () => ({ listDatabases: async () => ({ databases: [...names] }) }),
        listCollections: () => ({ toArray: async () => [...names] }),
      }; }
    }
    const require = (name) => name === "fs"
      ? { readFileSync: () => JSON.stringify({ test: { url: "mongodb://example.test/yennefer" } }) }
      : { MongoClient };
    require.resolve = () => { throw new Error("no bson"); };
    await vm.runInNewContext(buildMongoScript({ operation, skip: 500, limit: 500 }, mongodb), {
      require, Buffer, process: { stdout: { write: (text) => { output += text; } } },
    });
    const result = JSON.parse(output.slice(MONGODB_RESULT_MARKER.length));
    assert.equal(result.ok, true);
    const items = operation === "listDatabases" ? result.data.databases : result.data;
    assert.deepEqual(items.map((item) => item.name), ["name0500", "name0501", "name0502"]);
  }
});

test("MongoDB query normalization keeps operations read-only and bounded", () => {
  const query = normalizeMongoQuery(
    {
      operation: "find",
      collection: "orders",
      filter: { status: "open" },
      limit: 900,
      skip: 2,
    },
    mongodb,
  );

  assert.equal(query.database, "yennefer");
  assert.equal(query.limit, 500);
  assert.equal(query.skip, 2);
  assert.deepEqual(query.filter, { status: "open" });

  assert.throws(
    () => normalizeMongoQuery({ operation: "deleteMany", collection: "orders" }, mongodb),
    (error) => error.code === "INVALID_MONGODB_OPERATION",
  );
  assert.throws(
    () => normalizeMongoQuery({ operation: "find", collection: "orders", filter: { $where: "return true" } }, mongodb),
    (error) => error.code === "MONGODB_OPERATOR_REJECTED",
  );
  assert.throws(
    () => normalizeMongoQuery({ operation: "aggregate", collection: "orders", pipeline: [{ $out: "backup" }] }, mongodb),
    (error) => error.code === "MONGODB_OPERATOR_REJECTED",
  );
});

test("MongoDB helper script contains no URI and uses the configured profile", () => {
  const script = buildMongoScript(
    { operation: "ping" },
    mongodb,
  );

  assert.match(script, /config\.json/);
  assert.match(script, /test/);
  assert.match(script, /MongoClient/);
  assert.match(script, /__REMOTE_DEBUG_MONGODB_RESULT__/);
  assert.doesNotMatch(script, /mongodb:\/\//i);
  assert.doesNotThrow(() => new vm.Script(script));
});

test("MongoDB query sends a fixed remote Node command and parses structured results", async () => {
  let receivedCommand;
  let receivedInput;
  const result = await runMongoQuery(
    {
      operation: "find",
      collection: "orders",
      filter: { status: "open" },
      projection: { _id: 0, status: 1 },
      limit: 2,
    },
    {
      config: { mongodb },
      operation: {
        operationId: "operation-1",
        signal: new AbortController().signal,
      },
      runSSH: async (command, options) => {
        receivedCommand = command;
        receivedInput = options.stdin;
        return {
          exitCode: 0,
          timedOut: false,
          stdout: `${MONGODB_RESULT_MARKER}${JSON.stringify({
            ok: true,
            operation: "find",
            database: "yennefer",
            collection: "orders",
            data: [{ status: "open" }],
          })}\n`,
          stderr: "",
          timing: { queueMs: 0, connectMs: 0, executionMs: 3 },
        };
      },
    },
  );

  assert.equal(receivedCommand, "node");
  assert.match(receivedInput, /config\.json/);
  assert.match(receivedInput, /orders/);
  assert.deepEqual(result.data, [{ status: "open" }]);
  assert.equal(result.resultCount, 1);
  assert.equal(result.database, "yennefer");
});

test("MongoDB error text redacts URI credentials", () => {
  const redacted = redactMongoSecrets(
    "MongoServerError: mongodb://user:password@example.test:27017/yennefer?authSource=admin",
  );

  assert.doesNotMatch(redacted, /password/);
  assert.match(redacted, /mongodb:\/\/\[REDACTED\]@/);
});

test("MongoDB runner errors do not leak URI credentials through causes", async () => {
  await assert.rejects(
    runMongoQuery(
      { operation: "ping" },
      {
        config: { mongodb },
        operation: {
          operationId: "operation-2",
          signal: new AbortController().signal,
        },
        runSSH: async () => {
          throw new Error("failed for mongodb://user:password@example.test/db");
        },
      },
    ),
    (error) => {
      assert.doesNotMatch(error.cause?.message || "", /password/);
      assert.doesNotMatch(error.details?.cause || "", /password/);
      return error.code === "MONGODB_QUERY_FAILED";
    },
  );
});
