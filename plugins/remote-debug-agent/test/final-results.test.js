import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { FINAL_RESULT_TOOLS, callFinalResultTool } from "../final-results.js";
import { createBusinessPrivacy } from "../business-privacy.js";
import { createOutputGuard } from "../output-guard.js";
import { OUTPUT_CONTRACTS } from "../output-contracts.js";

test("final report publication preserves opaque references and scrubs known business values before POST", async () => {
  const privacy = createBusinessPrivacy(), guard = createOutputGuard({ businessPrivacy: privacy });
  const instance = { id: "test", host: "fixture", mongodb: { database: "business", configProfile: "fixture" } };
  const scope = privacy.targetScope("http://127.0.0.1:4343", instance, "business");
  const query = guard.toolResult("remote_debug_mongodb_query", { data: [{ _id: "FINAL_PRIVATE_BUSINESS_ID" }] }, false, { scope, queryOperation: "find" });
  const reference = JSON.parse(query.content[0].text).data[0]._id;
  assert.match(reference, /^rda_ref_v1_/);
  let submitted;
  const input = { instanceId: "test", taskId: randomUUID(), title: "最终报告", final: true, status: "completed", artifacts: [
    { category: "reports", format: "text", name: "报告", content: `reference=${reference}\nFINAL_PRIVATE_BUSINESS_ID\npassword=FINAL_PASSWORD\n` },
  ] };
  await callFinalResultTool("remote_debug_publish_final_result", input, {
    sanitize: (value) => privacy.scrubKnown(guard.sanitize(value).value),
    post: async (route, value) => { assert.equal(route, "/api/final-results"); submitted = value; },
  });
  assert.match(submitted.artifacts[0].content, new RegExp(reference));
  assert.doesNotMatch(JSON.stringify(submitted), /FINAL_PRIVATE_BUSINESS_ID|FINAL_PASSWORD/);
  // The report path does not call resolve(): it cannot expand opaque values.
  assert.equal(privacy.resolve("remote_debug_mongodb_query", { filter: { _id: reference } }, scope).filter._id, "FINAL_PRIVATE_BUSINESS_ID");
});

test("final-result tools reject unknown/unscoped arguments and invalid read bounds before requests", async () => {
  const options = { get: async () => assert.fail("must not request"), post: async () => assert.fail("must not publish"), sanitize: (value) => value };
  for (const args of [{}, { instanceId: "../escape" }, { instanceId: 123 }, { instanceId: "test", unknown: true }, { instanceId: "test", limit: 0 }, { instanceId: "test", offset: -1 }]) {
    await assert.rejects(callFinalResultTool("remote_debug_list_final_results", args, options), { code: "FINAL_RESULT_INVALID" });
  }
  await assert.rejects(callFinalResultTool("remote_debug_read_final_artifact", { instanceId: "test", taskId: randomUUID(), artifactId: randomUUID(), maxBytes: 0 }, options));
  const route = await callFinalResultTool("remote_debug_list_final_results", { instanceId: null }, { ...options, get: async (route) => route });
  assert.equal(route, "/api/final-results?scope=manager&offset=0&limit=20");
  for (const tool of FINAL_RESULT_TOOLS) assert.ok(OUTPUT_CONTRACTS[tool.name]);
});
