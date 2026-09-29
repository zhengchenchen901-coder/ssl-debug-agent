import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import {
  MONGODB_MUTATION_CONFIRMATION,
  MONGODB_ROLLBACK_CONFIRMATION,
  buildMongoMutationScript,
  normalizeMongoIndexChange,
  normalizeMongoMutation,
  normalizeMongoTransaction,
  runMongoMutation,
} from "../mongodb-mutations.js";
import { MONGODB_RESULT_MARKER } from "../mongodb.js";

const mongodb = {
  enabled: true,
  configPath: "/home/github/app/config.json",
  driverPath: "/home/github/app/node_modules/mongodb",
  configProfile: "test",
  uriKey: "url",
  database: "yennefer",
  writeEnabled: true,
  allowedDatabases: ["yennefer"],
  allowedCollections: ["members", "restaurant_members"],
  rollbackRoot: "/tmp/remote-debug-agent/mutations",
  maxAffectedDocuments: 20,
};

function fakeMutationResult(data) {
  return {
    exitCode: 0,
    timedOut: false,
    stdout: `${MONGODB_RESULT_MARKER}${JSON.stringify({ ok: true, data })}\n`,
    stderr: "",
    timing: { queueMs: 0, connectMs: 0, executionMs: 1 },
  };
}

test("MongoDB mutations are disabled unless explicitly enabled and scoped", () => {
  assert.throws(
    () => normalizeMongoMutation({ operation: "insertOne", collection: "members", document: { _id: "m1" } }, {
      ...mongodb,
      writeEnabled: false,
    }),
    (error) => error.code === "MONGODB_MUTATIONS_DISABLED",
  );
  assert.throws(
    () => normalizeMongoMutation({ operation: "updateOne", collection: "members", filter: {}, update: { $set: { status: "active" } } }, mongodb),
    (error) => error.code === "MONGODB_EMPTY_FILTER",
  );
  assert.throws(
    () => normalizeMongoMutation({ operation: "updateMany", collection: "members", filter: { status: "active" }, update: { $set: { status: "inactive" } } }, mongodb),
    (error) => error.code === "MONGODB_BATCH_SCOPE_REQUIRED",
  );
  assert.throws(
    () => normalizeMongoMutation({ operation: "updateOne", collection: "members", filter: { _id: "m1" }, update: { $where: "return true" } }, mongodb),
    (error) => error.code === "MONGODB_OPERATOR_REJECTED" || error.code === "MONGODB_UPDATE_OPERATOR_REJECTED",
  );
  assert.throws(
    () => normalizeMongoMutation({ operation: "insertOne", collection: "members", document: { _id: "m1" } }, {
      ...mongodb,
      rollbackRoot: "/tmp/other-place",
    }),
    (error) => error.code === "MONGODB_JOURNAL_ROOT_INVALID",
  );
});

test("MongoDB document and index mutation normalization is bounded", () => {
  const insert = normalizeMongoMutation(
    {
      operation: "insertOne",
      collection: "restaurant_members",
      document: { _id: "membership-1", restaurantId: "r1", memberId: "m1" },
      purpose: "add member",
    },
    mongodb,
  );
  assert.equal(insert.operation, "insertOne");
  assert.equal(insert.document._id, "membership-1");
  assert.equal(insert.riskLevel, "medium");

  const batch = normalizeMongoMutation(
    {
      operation: "updateMany",
      collection: "members",
      filter: { _id: { $in: ["m1", "m2"] } },
      update: { $set: { status: "active" } },
      expectedCount: 2,
    },
    mongodb,
  );
  assert.equal(batch.maxAffected, 20);
  assert.equal(batch.expectedCount, 2);
  assert.equal(batch.riskLevel, "high");

  const index = normalizeMongoIndexChange(
    {
      operation: "createIndex",
      collection: "restaurant_members",
      name: "restaurant_member_unique",
      key: { restaurantId: 1, memberId: 1 },
      options: { unique: true },
    },
    mongodb,
  );
  assert.deepEqual(index.key, { restaurantId: 1, memberId: 1 });
  assert.equal(index.options.unique, true);
  assert.equal(index.riskLevel, "high");
  assert.throws(
    () => normalizeMongoIndexChange({ operation: "dropIndex", collection: "members", name: "_id_" }, mongodb),
    (error) => error.code === "MONGODB_INDEX_IMMUTABLE",
  );

  const transaction = normalizeMongoTransaction(
    {
      database: "yennefer",
      operations: [
        {
          operation: "insertOne",
          collection: "restaurant_members",
          document: { _id: "membership-1", restaurantId: "r1", memberId: "m1" },
        },
        {
          operation: "updateOne",
          collection: "members",
          filter: { _id: "m1" },
          update: { $set: { status: "active" } },
        },
      ],
    },
    mongodb,
  );
  assert.equal(transaction.kind, "transaction");
  assert.deepEqual(transaction.collections, ["restaurant_members", "members"]);
});

test("MongoDB mutation helper has no URI and uses the protected temporary journal", () => {
  const script = buildMongoMutationScript(
    {
      mode: "prepare",
      kind: "document",
      operationId: "operation-1",
      mutationId: "mutation-1",
      mutation: normalizeMongoMutation(
        {
          operation: "updateOne",
          collection: "members",
          filter: { _id: "m1" },
          update: { $set: { status: "active" } },
        },
        mongodb,
        { operationId: "operation-1" },
      ),
    },
    mongodb,
  );

  assert.match(script, /remote-debug-agent\/mutations/);
  assert.match(script, /journal\.jsonl/);
  assert.match(script, /withTransaction/);
  assert.match(buildMongoMutationScript({
    mode: "prepare",
    kind: "transaction",
    operationId: "operation-1",
    mutationId: "mutation-transaction-1",
    mutation: normalizeMongoTransaction(
      {
        database: "yennefer",
        operations: [{
          operation: "insertOne",
          collection: "restaurant_members",
          document: { _id: "membership-1", restaurantId: "r1", memberId: "m1" },
        }],
      },
      mongodb,
      { operationId: "operation-1" },
    ),
  }, mongodb), /beforeOperations/);
  assert.doesNotMatch(script, /mongodb:\/\//i);
  assert.doesNotThrow(() => new vm.Script(script));
});

test("remote mutation helper avoids unsupported Node 12 operators and preserves zero counts", () => {
  const script = buildMongoMutationScript({ mode: "prepare", kind: "document" }, mongodb);
  // All modes share the helper, so even unused import/rollback functions must parse.
  assert.doesNotMatch(script, /\?\.|\?\?/);
  for (const field of ["matchedCount", "deletedCount"]) {
    const expressions = [...script.matchAll(new RegExp(`result\\.${field} != null \\? result\\.${field} : result\\.n`, "g"))];
    assert.ok(expressions.length >= 2, `${field}: commit and rollback guards`);
    for (const [expression] of expressions) {
      for (const [value, expected] of [[0, 0], [1, 1], [null, 7], [undefined, 7]]) {
        assert.equal(vm.runInNewContext(expression, { result: { [field]: value, n: 7 } }), expected);
      }
    }
  }
});

test("MongoDB mutation runner forwards fixed node helper and confirmation requirements", async () => {
  const calls = [];
  const prepared = await runMongoMutation(
    {
      mode: "prepare",
      operation: "insertOne",
      collection: "members",
      document: { _id: "m1", status: "active" },
    },
    {
      config: { mongodb },
      operation: { operationId: "operation-1", signal: new AbortController().signal },
      runSSH: async (command, options) => {
        calls.push({ command, stdin: options.stdin });
        return fakeMutationResult({
          mutationId: "mutation-1",
          planHash: "a".repeat(64),
          status: "planned",
        });
      },
    },
  );
  assert.equal(prepared.mutationId, "mutation-1");
  assert.equal(calls[0].command, "node");
  assert.match(calls[0].stdin, /insertOne/);

  await assert.rejects(
    runMongoMutation(
      {
        mode: "commit",
        mutationId: "mutation-1",
        planHash: "a".repeat(64),
        confirmation: "wrong",
      },
      { config: { mongodb }, runSSH: async () => fakeMutationResult({}) },
    ),
    (error) => error.code === "MONGODB_MUTATION_CONFIRMATION_REQUIRED",
  );
  await assert.rejects(
    runMongoMutation(
      {
        mode: "rollback",
        mutationId: "mutation-1",
        planHash: "a".repeat(64),
        confirmation: MONGODB_MUTATION_CONFIRMATION,
      },
      { config: { mongodb }, runSSH: async () => fakeMutationResult({}) },
    ),
    (error) => error.code === "MONGODB_ROLLBACK_CONFIRMATION_REQUIRED",
  );
  assert.equal(MONGODB_ROLLBACK_CONFIRMATION, "确认回滚");
});
