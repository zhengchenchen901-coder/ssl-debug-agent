import assert from "node:assert/strict";
import test from "node:test";
import { createOutputPreviewPublisher, outputPreviewMetadata } from "../output-preview.js";
import { createOutputGuard } from "../output-guard.js";

test("an unavailable output guard still permits fixed block previews without echoing request metadata", () => {
  const guard = createOutputGuard();
  for (let index = 0; index <= 2048; index++) guard.remember(`FIXTURE_SECRET_${index}`);
  const metadata = outputPreviewMetadata(guard, {
    sessionId: "11111111-1111-4111-8111-111111111111", sourceSequence: 1,
    operationId: "22222222-2222-4222-8222-222222222222", toolName: "remote_debug_run_command",
    requestId: "PRIVATE_REQUEST_ID", instanceId: "PRIVATE_INSTANCE_ID", durationMs: 10,
  });
  assert.equal(metadata.toolName, "unknown");
  assert.equal(metadata.instanceId, null);
  assert.equal(metadata.requestId, null);
  assert.doesNotMatch(JSON.stringify(metadata), /PRIVATE_|FIXTURE_SECRET/);
});

test("preview publisher stays bounded behind slow requests and reports dropped records", async () => {
  const sent = []; let finish;
  const publisher = createOutputPreviewPublisher({ maxEvents: 2, send: async (_settings, event) => {
    sent.push(event);
    if (event.id === 1) await new Promise((resolve) => { finish = resolve; });
    if (event.id === 2) throw new Error("offline");
  } });
  publisher.publish({}, { id: 1 }); publisher.publish({}, { id: 2 }); publisher.publish({}, { id: 3 });
  assert.deepEqual(sent.map((event) => event.id), [1]);
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  publisher.publish({}, { id: 4 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent.map((event) => event.id), [1, 2, 4]);
  assert.equal(sent[2].droppedBefore, 2);
  const bounded = createOutputPreviewPublisher({ maxBytes: 5, send: async () => assert.fail("oversize record sent") });
  bounded.publish({}, { text: "too large" });
});
