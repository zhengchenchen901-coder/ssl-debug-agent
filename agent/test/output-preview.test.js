import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createOutputPreviewStore } from "../output-preview.js";
import { createActivityLog } from "../activity.js";
import { createOutputGuard } from "../../plugins/remote-debug-agent/output-guard.js";
import { createManagerApp } from "../server.js";
import { InstanceRegistry } from "../instance-registry.js";
import { loadConfig } from "../config.js";
import { TEST_AUTH_TOKEN, TEST_HOST_FINGERPRINT } from "./helpers/http-auth.js";

function event(sequence, instanceId = "test", text = "正常输出") {
  const guard = createOutputGuard();
  return { sessionId: "11111111-1111-4111-8111-111111111111", sourceSequence: sequence,
    operationId: randomUUID(), requestId: sequence, toolName: "remote_debug_run_command", instanceId, durationMs: 12, droppedBefore: 0,
    wireMessage: guard.serialize({ jsonrpc: "2.0", id: sequence, result: guard.toolResult("remote_debug_run_command", { stdout: text, exitCode: 0 }) }).toString() };
}

test("preview cache isolates instances, bounds counts/bytes, deduplicates and detects replay gaps", () => {
  const store = createOutputPreviewStore({ maxInstanceEvents: 2, maxEvents: 3 });
  const initial = store.snapshot().cursor;
  const a = store.publish(event(1)), b = store.publish(event(2));
  const cursor = store.snapshot().cursor;
  store.publish(event(3, "other"));
  const replay = store.snapshot(cursor);
  assert.equal(replay.gap, false);
  assert.deepEqual(replay.records.map((record) => record.requestId), [3]);
  const beforeEviction = store.snapshot().cursor;
  store.publish(event(4));
  assert.equal(store.get(a.id), null);
  assert.ok(store.get(b.id));
  assert.equal(store.snapshot(initial).gap, true);
  assert.equal(store.snapshot(beforeEviction).gap, true);
  assert.equal(store.snapshot(beforeEviction).reset, true);
  const same = event(4); same.wireMessage = event(4, "test", "different").wireMessage;
  store.publish(same);
  assert.doesNotMatch(store.get(`${same.sessionId}:4`).wireMessage, /different/);
  assert.equal(store.snapshot("old-manager:4").reset, true);
  assert.equal(store.snapshot().records.length, 3);
  const beforeDelete = store.snapshot().cursor;
  store.removeInstance("test");
  assert.equal(store.snapshot(beforeDelete).gap, true);
  assert.deepEqual(store.snapshot().records.map((record) => record.instanceId), ["other"]);
  const bounded = createOutputPreviewStore({ maxInstanceBytes: 2000, maxBytes: 2100 });
  bounded.publish(event(1, "test", "x".repeat(800)));
  bounded.publish(event(2, "test", "y".repeat(800)));
  assert.equal(bounded.snapshot().records.length, 1);
  bounded.publish(event(3, "other", "z".repeat(800)));
  assert.equal(bounded.snapshot().records.length, 1);
});

test("preview summaries omit content, guard raw metadata shapes and retain exact final wire messages", () => {
  const store = createOutputPreviewStore();
  const input = event(1, "test", "safe output password=PRIVATE_FIXTURE");
  const record = store.publish(input);
  assert.equal(store.get(record.id).wireMessage, input.wireMessage);
  assert.doesNotMatch(JSON.stringify(store.snapshot()), /safe output|PRIVATE_FIXTURE|wireMessage/);
  assert.ok(record.outputGuard.replacements > 0);
  assert.doesNotMatch(store.get(record.id).wireMessage, /PRIVATE_FIXTURE/);
  assert.throws(() => store.publish({ ...event(2), raw: "no" }), /Invalid/);
  assert.throws(() => store.publish({ ...event(2), wireMessage: '{"result":{"content":[]}}' }), /Invalid/);
  assert.throws(() => store.publish({ ...event(2), sessionId: "bad", requestId: {} }), /Invalid/);
});

async function fixture(t, store) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rda-output-preview-api-"));
  const registry = new InstanceRegistry({ cwd: directory, env: {}, registryPath: path.join(directory, "instances.json") });
  registry.create({ id: "test", name: "Test", host: "fixture.invalid", username: "ops", privateKeyPath: "/fixture", hostKeyFingerprints: [TEST_HOST_FINGERPRINT] });
  const config = loadConfig({}, directory);
  config.agent = { host: "127.0.0.1", port: 0 };
  config.runtime.statePath = path.join(directory, ".runtime", "state.json");
  const workerManager = {
    publicInstances: () => registry.list(), shutdownAll: async () => {},
    callInstance: async (id, _route, payload) => {
      assert.equal(id, "test");
      if (payload.cmd === "failure") throw Object.assign(new Error("fixture failed"), { code: "FIXTURE_ERROR" });
      return { instanceId: id, stdout: "fixture" };
    },
  };
  const activity = createActivityLog();
  const app = createManagerApp({ config, registry, workerManager, authToken: TEST_AUTH_TOKEN, outputPreview: store, activity });
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: `Bearer ${TEST_AUTH_TOKEN}`, "Content-Type": "application/json" };
  return { app, base, headers, activity };
}

test("dedicated preview APIs authenticate, stream only metadata, fetch full >512KiB output and report expiration", { timeout: 15000 }, async (t) => {
  const store = createOutputPreviewStore({ maxInstanceEvents: 1 });
  const { activity, base, headers } = await fixture(t, store);
  for (const route of ["records", "events", "records/missing"]) assert.equal((await fetch(`${base}/api/output-preview/${route}`)).status, 401);
  assert.equal((await fetch(`${base}/api/output-preview/records`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401);
  const controller = new AbortController(); t.after(() => controller.abort());
  const stream = await fetch(`${base}/api/output-preview/events`, { headers, signal: controller.signal });
  const reader = stream.body.getReader();
  let buffer = "";
  async function next() {
    while (!buffer.includes("\n\n")) buffer += new TextDecoder().decode((await reader.read()).value);
    const end = buffer.indexOf("\n\n"), block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
    return JSON.parse(block.split("\n").find((line) => line.startsWith("data: ")).slice(6));
  }
  const initial = await next(); assert.equal(initial.records.length, 0);
  const input = event(1, "test", "中文输出" + "safe row\n".repeat(70 * 1024));
  const post = await fetch(`${base}/api/output-preview/records`, { method: "POST", headers, body: JSON.stringify(input) });
  assert.equal(post.status, 202);
  const id = (await post.json()).id;
  const pushed = await next();
  assert.equal(pushed.records[0].instanceId, "test");
  assert.doesNotMatch(JSON.stringify(pushed), /中文输出|wireMessage/);
  const full = await (await fetch(`${base}/api/output-preview/records/${encodeURIComponent(id)}`, { headers })).json();
  assert.equal(full.record.wireMessage, input.wireMessage);
  assert.equal(activity.list().length, 0);
  await fetch(`${base}/api/output-preview/records`, { method: "POST", headers, body: JSON.stringify(event(2)) });
  assert.deepEqual((await next()).evictedIds, [id]);
  assert.equal((await fetch(`${base}/api/output-preview/records/${encodeURIComponent(id)}`, { headers })).status, 410);
  const snapshot = await (await fetch(`${base}/api/output-preview/records?cursor=${encodeURIComponent(initial.cursor)}`, { headers })).json();
  assert.equal(snapshot.gap, true);
  assert.equal((await fetch(`${base}/api/output-preview/records`, { method: "POST", headers, body: JSON.stringify({ raw: "private" }) })).status, 400);
  const malformed = await fetch(`${base}/api/output-preview/records`, { method: "POST", headers, body: '{"PRIVATE_INPUT",invalid}' });
  assert.equal(malformed.status, 400);
  assert.doesNotMatch(await malformed.text(), /PRIVATE_INPUT|SyntaxError|stack/);
  // Large JSON allowance applies only to the separate ingest route.
  assert.equal((await fetch(`${base}/run`, { method: "POST", headers, body: JSON.stringify({ cmd: "safe row\n".repeat(70 * 1024) }) })).status, 413);
  controller.abort();
});

test("manager returns the selected instance even when callers omit it or execution fails", async (t) => {
  const { base, headers } = await fixture(t);
  for (const cmd of ["ps aux", "failure"]) {
    const response = await fetch(`${base}/run`, { method: "POST", headers, body: JSON.stringify({ cmd }) });
    assert.equal(response.headers.get("X-Remote-Debug-Instance-Id"), "test");
    assert.equal(response.status, cmd === "failure" ? 500 : 200);
  }
});
