import { TEST_AUTH_TOKEN, fetch } from "./helpers/http-auth.js";
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { createApp, createManagerApp } from "../server.js";
import { InstanceRegistry } from "../instance-registry.js";
import { DEFAULT_ALLOWED_PATHS } from "../config.js";
import { serviceProfileHash, serviceTargetHash } from "../service-profiles.js";

const example = JSON.parse(await fs.readFile(new URL("../../docs/examples/test-server-be-service.json", import.meta.url)));
async function listen(t, app) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
async function post(url, route, input) {
  const res = await fetch(url + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  return { status: res.status, body: await res.json() };
}
async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "service-http-")); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = { agent: { host: "127.0.0.1", port: 0 }, ssh: {}, security: { allowedPaths: DEFAULT_ALLOWED_PATHS }, audit: { logPath: path.join(dir, "audit.jsonl") }, runtime: { statePath: path.join(dir, ".runtime", "state.json") } };
  const registry = new InstanceRegistry({ cwd: dir, env: {} });
  registry.create({ id: "test-server", host: "8.209.81.113", username: "root", privateKeyPath: "/key" });
  registry.create({ id: "default", host: "untested.invalid", username: "app", privateKeyPath: "/other" });
  const calls = [];
  const workerManager = { publicInstances: () => registry.list(), runtimeFor: () => ({ status: "running" }), callInstance: async (id, route, payload) => { calls.push({ id, route, payload }); return { ok: true, instanceId: id, status: "healthy", persisted: false }; } };
  const manager = await listen(t, createManagerApp({ authToken: TEST_AUTH_TOKEN, config, registry, workerManager }));
  return { dir, config, registry, calls, manager };
}

test("authenticated manager saves/selects exactly one instance profile; bad bindings and stale hashes never reach worker", async t => {
  const f = await setup(t);
  const unauth = await globalThis.fetch(f.manager + "/api/service-profiles"); assert.equal(unauth.status, 401);
  const saved = await post(f.manager, "/api/service-profiles", example); assert.equal(saved.status, 200);
  const response = await fetch(f.manager + "/api/service-profiles");
  const listed = await response.json();
  assert.equal(listed.instances.find(i => i.instanceId === "default").profiles.length, 0);
  const selected = listed.instances.find(i => i.instanceId === "test-server").profiles[0];
  assert.equal(selected.profileHash, saved.body.profileHash);
  const invalid = await post(f.manager, "/api/service-profiles", { ...example, instanceId: "default" }); assert.equal(invalid.status, 400);
  const input = { instanceId: "test-server", serviceId: "be", profileHash: selected.profileHash, confirmation: "启动服务" };
  for (const variant of [{ ...input, instanceId: undefined }, { ...input, instanceId: "default" }, { ...input, profileHash: "0".repeat(64) }, { ...input, cmd: "id" }, { ...input, _serviceProfiles: { be: example.profile } }, { ...input, _serviceTargetHash: "spoofed" }, { ...input, confirmation: undefined }]) {
    const rejected = await post(f.manager, "/services/start", variant); assert.equal(rejected.status, 400);
  }
  assert.equal(f.calls.length, 0);
  assert.equal((await post(f.manager, "/services/start", input)).status, 200);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].id, "test-server"); assert.equal(f.calls[0].route, "/services/start");
  assert.ok(!("instanceId" in f.calls[0].payload));
  assert.ok(Number.isSafeInteger(f.calls[0].payload.deadlineAt));
  assert.deepEqual(f.registry.get("default").serviceProfiles, {});
});

test("worker enforces saved target/hash/auth independently; never returns raw SSH/PM2 output", async t => {
  const f = await setup(t);
  f.registry.update("test-server", { serviceProfiles: { be: example.profile } });
  const profile = f.registry.get("test-server").serviceProfiles.be;
  const config = { ...f.config, instanceId: "test-server", ssh: { host: "8.209.81.113", port: 22, username: "root" }, serviceProfiles: { be: profile } };
  let sshCalls = 0;
  const worker = await listen(t, createApp({ authToken: TEST_AUTH_TOKEN, config, runSSH: async (command, options) => {
    sshCalls++; assert.equal(command, "node"); assert.ok(options.stdin.includes("serviceStartRuntime"));
    return { exitCode: 0, stdout: 'NEVER_RETURN_THIS_SECRET\n__REMOTE_DEBUG_SERVICE__{"status":"partial","phase":"verify","started":["YenneferBE_Next_A"],"persisted":false,"error":{"code":"SERVICE_PROCESS_EXITED"}}\n', stderr: "NEVER_RETURN_THIS_SECRET" };
  } }));
  const input = { serviceId: "be", profileHash: serviceProfileHash(profile), confirmation: "启动服务" };
  const unauth = await globalThis.fetch(worker + "/services/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }); assert.equal(unauth.status, 401);
  assert.equal((await post(worker, "/services/start", { ...input, profileHash: "stale" })).status, 400);
  assert.equal((await post(worker, "/services/start", { ...input, env: { NODE_OPTIONS: "bad" } })).status, 400);
  assert.equal(sshCalls, 0);
  const result = await post(worker, "/services/start", input); assert.equal(result.status, 200); assert.equal(result.body.status, "partial"); assert.equal(result.body.persisted, false);
  assert.ok(!JSON.stringify(result).includes("NEVER_RETURN_THIS_SECRET"));
  const audit = await fs.readFile(config.audit.logPath, "utf8"); assert.ok(!audit.includes("NEVER_RETURN_THIS_SECRET"));
  const lines = audit.trim().split("\n").map(JSON.parse);
  assert.ok(lines.some(line => line.tool === "service-start" && line.status === "partial" && !line.ok));
  const targetHash = serviceTargetHash(config.ssh, config.security.allowedPaths);
  config.ssh.hostKeyFingerprints = ["SHA256:" + "A".repeat(43)];
  const changedTrust = await post(worker, "/services/start", { ...input, _serviceTargetHash: targetHash });
  assert.equal(changedTrust.body.error.code, "SERVICE_TARGET_STALE"); assert.equal(sshCalls, 1);
  config.instanceId = "default";
  assert.equal((await post(worker, "/services/start", input)).body.error.code, "SERVICE_INSTANCE_MISMATCH"); assert.equal(sshCalls, 1);
});
