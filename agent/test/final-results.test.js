import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FinalResultStore } from "../final-results.js";
import { createManagerApp } from "../server.js";
import { InstanceRegistry } from "../instance-registry.js";
import { loadConfig } from "../config.js";
import { TEST_HOST_FINGERPRINT } from "./helpers/http-auth.js";
import localAuth from "../../plugins/remote-debug-agent/local-auth.cjs";
import { mcpPeer } from "../../plugins/remote-debug-agent/test/helpers/local-mcp.js";

const absent = async (file) => assert.rejects(fs.stat(file), { code: "ENOENT" });
const input = (patch = {}) => ({ instanceId: "test", taskId: randomUUID(), title: "最终排查结果", type: "diagnostic", status: "completed", final: true,
  artifacts: [{ category: "reports", format: "markdown", name: "排查报告", content: "# 最终结论\n服务正常。" },
    { category: "results", format: "json", name: "汇总", content: { complete: true, count: 3 } },
    { category: "exports", format: "csv", name: "统计", content: "status,count\nok,3\n" }], ...patch });
async function sandbox(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rda-final-result-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, "output");
  return { directory, root, store: new FinalResultStore({ root, ...options }) };
}

test("only explicit final deliverables can enter output; invalid publication creates no directory", async (t) => {
  const { store, root } = await sandbox(t);
  assert.deepEqual((await store.listFinalResults({ instanceId: "test" })).results, []);
  await absent(root);
  for (const patch of [{ final: false }, { status: "running" }, { status: "paused" }, { instanceId: "../other" }, { instanceId: 123 }, { taskId: "../escape" },
    { artifacts: [] }, { artifacts: [{ category: "logs", format: "text", name: "progress", content: "intermediate" }] },
    { artifacts: [{ category: "reports", format: "text", name: "../escape", content: "no" }] }]) {
    await assert.rejects(store.publishFinalResult(input(patch)));
    await absent(root);
  }
});

test("final files are categorized, redacted, immutable, isolated and recoverable after restart", async (t) => {
  const { store, root } = await sandbox(t);
  const request = input();
  request.references = { operationIds: [randomUUID()], jobId: "job-final" };
  request.artifacts[0].content += "\npassword=FINAL_FIXTURE_SECRET\n";
  const first = await store.publishFinalResult(request);
  assert.equal(first.duplicate, false);
  const directory = path.join(root, "instances", "test", "tasks", request.taskId);
  assert.deepEqual((await fs.readdir(directory)).sort(), ["exports", "manifest.json", "reports", "results"]);
  for (const file of first.result.files) {
    const saved = await fs.readFile(path.join(directory, file.relativePath), "utf8");
    assert.doesNotMatch(saved, /FINAL_FIXTURE_SECRET/);
    assert.equal(Buffer.byteLength(saved), file.bytes);
    if (process.platform !== "win32") assert.equal((await fs.stat(path.join(directory, file.relativePath))).mode & 0o777, 0o600);
  }
  const restarted = new FinalResultStore({ root });
  assert.deepEqual(await restarted.getFinalResult("test", request.taskId), first.result);
  assert.equal((await restarted.publishFinalResult(request)).duplicate, true);
  await assert.rejects(restarted.publishFinalResult({ ...request, title: "改变结论" }), { code: "FINAL_RESULT_CONFLICT" });
  await assert.rejects(restarted.getFinalResult("other", request.taskId), { code: "FINAL_RESULT_NOT_FOUND" });
  await restarted.publishFinalResult({ ...request, instanceId: "other" });
  const manager = await restarted.publishFinalResult(input({ instanceId: null, status: "partial" }));
  assert.equal((await restarted.listFinalResults({ instanceId: null })).total, 1);
  assert.equal((await restarted.listFinalResults({ instanceId: "test" })).total, 1);
  assert.ok((await fs.stat(path.join(root, "manager", "tasks", manager.result.taskId))).isDirectory());
  assert.deepEqual(await fs.readdir(store.stageRoot), []);
});

test("independent concurrent publishers choose one immutable final directory", async (t) => {
  const { root } = await sandbox(t), request = input();
  const publishers = Array.from({ length: 8 }, () => new FinalResultStore({ root }));
  const publications = await Promise.all(publishers.map((store) => store.publishFinalResult(request)));
  assert.equal(publications.filter((result) => !result.duplicate).length, 1);
  assert.equal(new Set(publications.map((result) => result.result.files[0].artifactId)).size, 1);
  assert.equal((await publishers[0].listFinalResults({ instanceId: "test" })).total, 1);
});

test("binary final attachments retain exact bytes and original download names", async (t) => {
  const { store } = await sandbox(t);
  const bytes = Buffer.from([0, 255, 137, 80, 78, 71, 13, 10, 0, 1, 2, 255]);
  const value = input({ artifacts: [{ category: "attachments", format: "binary", encoding: "base64", name: "最终截图.png", content: bytes.toString("base64") }] });
  const published = await store.publishFinalResult(value), file = published.result.files[0];
  assert.equal(file.encoding, "binary"); assert.equal(file.name, "最终截图.png");
  assert.deepEqual((await store.openArtifact("test", value.taskId, file.artifactId)).content, bytes);
  assert.equal((await store.publishFinalResult(value)).duplicate, true);
  for (const content of ["not base64", "a", "ab==", "YQ", "YQ==="]) await assert.rejects(store.publishFinalResult(input({ artifacts: [{ ...value.artifacts[0], content }] })), { code: "FINAL_RESULT_INVALID" });
});

test("failed staging never exposes a partial result and does not overwrite prior files", async (t) => {
  const { store, root } = await sandbox(t);
  const good = await store.publishFinalResult(input());
  let writes = 0;
  const originalWrite = store.writeFile.bind(store);
  store.writeFile = async (...args) => {
    if (++writes === 2) throw Object.assign(new Error("disk full fixture"), { code: "ENOSPC" });
    return originalWrite(...args);
  };
  const request = input();
  await assert.rejects(store.publishFinalResult(request), { code: "ENOSPC" });
  await absent(path.join(root, "instances", "test", "tasks", request.taskId));
  assert.deepEqual(await store.getFinalResult("test", good.result.taskId), good.result);
  assert.equal((await store.listFinalResults({ instanceId: "test" })).total, 1);
  assert.deepEqual(await fs.readdir(store.stageRoot), []);
});

test("bounds and final failure/cancellation summaries are explicit", async (t) => {
  const { store, root } = await sandbox(t, { maxFileBytes: 100, maxTaskBytes: 150 });
  await assert.rejects(store.publishFinalResult(input({ artifacts: [{ category: "reports", format: "text", name: "large", content: "x".repeat(101) }] })), { code: "FINAL_RESULT_TOO_LARGE" });
  await absent(root);
  await assert.rejects(store.publishFinalResult(input({ artifacts: [0, 1].map((i) => ({ category: "reports", format: "text", name: String(i), content: "x".repeat(80) })) })), { code: "FINAL_RESULT_TOO_LARGE" });
  for (const status of ["failed", "cancelled", "partial"]) assert.equal((await store.publishFinalResult(input({ status }))).result.status, status);
});

test("path escapes, symbolic/hard links and tampered files cannot be read", async (t) => {
  const { store, directory, root } = await sandbox(t);
  const outside = path.join(directory, "outside"); await fs.mkdir(outside);
  await fs.symlink(outside, root, "dir");
  await assert.rejects(store.publishFinalResult(input()), { code: "FINAL_RESULT_PATH_REJECTED" });
  assert.deepEqual(await fs.readdir(outside), []);
  await fs.unlink(root);
  const published = await store.publishFinalResult(input()), { taskId, files } = published.result;
  const file = files[0], target = path.join(root, "instances", "test", "tasks", taskId, file.relativePath);
  await assert.rejects(store.openArtifact("other", taskId, file.artifactId), { code: "FINAL_RESULT_NOT_FOUND" });
  await assert.rejects(store.openArtifact("test", taskId, "../escape"), { code: "FINAL_RESULT_INVALID" });
  const original = await fs.readFile(target);
  await fs.writeFile(target, "tampered");
  await assert.rejects(store.openArtifact("test", taskId, file.artifactId), { code: "FINAL_RESULT_CORRUPT" });
  await fs.unlink(target);
  const externalFile = path.join(outside, "file.txt"); await fs.writeFile(externalFile, original);
  await fs.symlink(externalFile, target);
  await assert.rejects(store.openArtifact("test", taskId, file.artifactId), { code: "FINAL_RESULT_PATH_REJECTED" });
  await fs.unlink(target); await fs.link(externalFile, target);
  await assert.rejects(store.openArtifact("test", taskId, file.artifactId), { code: "FINAL_RESULT_PATH_REJECTED" });
});

async function manager(t) {
  const { directory, root } = await sandbox(t);
  const registry = new InstanceRegistry({ cwd: directory, env: {}, registryPath: path.join(directory, "instances.json") });
  for (const id of ["test", "other"]) registry.create({ id, name: id, host: "fixture.invalid", username: "ops", privateKeyPath: "/fixture", passphrase: "CONFIGURED_FINAL_SECRET", hostKeyFingerprints: [TEST_HOST_FINGERPRINT] });
  const config = loadConfig({}, directory);
  config.agent = { host: "127.0.0.1", port: 0 };
  config.runtime.statePath = path.join(directory, ".runtime", "state.json");
  const token = localAuth.ensureAuthToken(localAuth.resolveAuthFile(directory));
  const app = createManagerApp({ config, registry, authToken: token, workerManager: {
    publicInstances: () => registry.list(), shutdownAll: async () => {}, callInstance: async (id) => ({ ok: true, instanceId: id, stdout: "intermediate probe", exitCode: 0 }),
  } });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { app.locals.resourceManager.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const request = async (route, options = {}) => {
    const response = await fetch(url + route, { ...options, headers: { ...headers, ...options.headers } });
    return { status: response.status, headers: response.headers, data: await response.json() };
  };
  return { directory, root, registry, app, url, headers, request };
}

test("authenticated API publishes, previews, downloads, pages, retains deleted-instance history and manually deletes", async (t) => {
  const { url, request, root, registry, headers } = await manager(t);
  const value = input(); value.artifacts[0].content += "\nCONFIGURED_FINAL_SECRET";
  for (const route of ["/api/final-results?instanceId=test", `/api/final-results/${value.taskId}?instanceId=test`]) assert.equal((await fetch(url + route)).status, 401);
  assert.equal((await request("/api/final-results", { method: "POST", body: JSON.stringify({ ...value, instanceId: "missing" }) })).status, 404);
  const published = await request("/api/final-results", { method: "POST", body: JSON.stringify(value) });
  assert.equal(published.status, 201);
  assert.equal((await request("/api/final-results", { method: "POST", body: JSON.stringify(value) })).status, 200);
  const artifact = published.data.result.files[0], base = `/api/final-results/${value.taskId}`;
  const preview = await request(`${base}/artifacts/${artifact.artifactId}?instanceId=test&maxBytes=10`);
  assert.equal(preview.data.truncated, true);
  assert.doesNotMatch((await request(`${base}/artifacts/${artifact.artifactId}?instanceId=test`)).data.content, /CONFIGURED_FINAL_SECRET/);
  assert.equal((await request(`${base}/artifacts/${artifact.artifactId}?instanceId=other`)).status, 404);
  assert.equal((await request(`/api/final-results?instanceId=test&limit=0`)).status, 400);
  assert.equal((await request(`/api/final-results`)).status, 400);
  const list = (await request("/api/final-results?instanceId=test")).data;
  assert.equal(list.outputDirectory, root); assert.equal(list.total, 1); assert.ok(list.totalBytes > 0);
  const malformed = await request("/api/final-results", { method: "POST", body: "{" }); assert.equal(malformed.status, 400);
  const response = await fetch(url + `${base}/artifacts/${artifact.artifactId}?instanceId=test&download=1`, { headers });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-disposition"), /^attachment;/);
  assert.match(response.headers.get("content-type"), /^application\/octet-stream/);
  assert.doesNotMatch(await response.text(), /CONFIGURED_FINAL_SECRET/);
  const binaryBytes = Buffer.from([0, 1, 2, 128, 255]);
  const binary = input({ artifacts: [{ category: "attachments", format: "binary", encoding: "base64", name: "验证.pdf", content: binaryBytes.toString("base64") }] });
  const binaryPublished = await request("/api/final-results", { method: "POST", body: JSON.stringify(binary) });
  const binaryRoute = `/api/final-results/${binary.taskId}/artifacts/${binaryPublished.data.result.files[0].artifactId}?instanceId=test`;
  assert.equal((await request(binaryRoute)).data.previewAvailable, false);
  const binaryDownload = await fetch(url + binaryRoute + "&download=1", { headers });
  assert.deepEqual(Buffer.from(await binaryDownload.arrayBuffer()), binaryBytes);
  assert.match(binaryDownload.headers.get("content-disposition"), /filename\*/);
  registry.delete("test");
  assert.equal((await request(`${base}?instanceId=test`)).status, 200);
  assert.equal((await request(`${base}?instanceId=test`, { method: "DELETE" })).status, 200);
  assert.equal((await request(`${base}?instanceId=test`)).status, 404);
  assert.equal((await request("/api/final-results?instanceId=other")).data.total, 0);
});

test("real MCP does not archive probes, publishes only final bundles, and retrieves final artifacts", { timeout: 30000 }, async (t) => {
  const { directory, root, url, app } = await manager(t);
  const peer = await mcpPeer(t, { root: directory, url });
  const probe = await peer.call("remote_debug_run_command", { instanceId: "test", cmd: "pwd" });
  assert.equal(probe.payload.stdout, "intermediate probe");
  await absent(root);
  // A terminal resource task is still an execution detail, not a deliverable.
  app.locals.resourceManager.attach("test", "fixture", () => {});
  app.locals.resourceManager.report("test", "fixture", { taskId: randomUUID(), type: "diagnostic", status: "completed" });
  await absent(root);
  const value = input(); value.artifacts[0].content += "\npassword=MCP_FINAL_SECRET\n";
  const result = await peer.call("remote_debug_publish_final_result", value);
  assert.equal(result.isError, undefined);
  assert.equal(result.payload.result.taskId, value.taskId);
  assert.equal((await peer.call("remote_debug_publish_final_result", value)).payload.duplicate, true);
  const listed = await peer.call("remote_debug_list_final_results", { instanceId: "test" });
  assert.equal(listed.payload.total, 1);
  const saved = await peer.call("remote_debug_get_final_result", { instanceId: "test", taskId: value.taskId });
  const file = saved.payload.result.files[0];
  const read = await peer.call("remote_debug_read_final_artifact", { instanceId: "test", taskId: value.taskId, artifactId: file.artifactId });
  assert.match(read.payload.content, /最终结论/); assert.doesNotMatch(read.payload.content, /MCP_FINAL_SECRET/);
  assert.equal((await peer.call("remote_debug_publish_final_result", { ...value, final: false })).isError, true);
  const folder = path.join(root, "instances", "test", "tasks");
  assert.deepEqual(await fs.readdir(folder), [value.taskId]);
  await peer.stop();
});


test("final publication accepts exact import mutation identifiers and rejects path/text references", async t => {
  const { store } = await sandbox(t);
  const mutationId = "import-" + "a".repeat(64);
  const result = await store.publishFinalResult(input({ references: { mutationId } }));
  assert.equal(result.result.references.mutationId, mutationId);
  for (const invalid of ["../escape", "/tmp/file", "import-" + "a".repeat(128), "bad text", "id\nsecret"])
    await assert.rejects(store.publishFinalResult(input({ references: { mutationId: invalid } })), { code: "FINAL_RESULT_INVALID" });
});
