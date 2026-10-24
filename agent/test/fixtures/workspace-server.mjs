// Local browser fixture: disposable registry and local protocol substitutes only.
// No production configuration, SSH, MongoDB or OS authentication is accessed.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createManagerApp } from "../../server.js";
import { InstanceRegistry } from "../../instance-registry.js";
import { MemoryStore } from "../../memory-store.js";
import { loadConfig } from "../../config.js";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rda-workspace-preview-"));
const registry = new InstanceRegistry({ cwd: directory, env: {} });
const memoryStore = new MemoryStore({ cwd: directory });
const manualMongo = { enabled: true, configPath: "/fixture/config.json", driverPath: "/fixture/mongodb", configProfile: "manualAdmin", uriKey: "url", database: "fixture" };
for (const [id, name, host] of [["first", "隔离开发服务器", "first.fixture.invalid"], ["second", "隔离测试服务器", "second.fixture.invalid"]]) {
  registry.create({ id, name, host, username: "fixture", privateKeyPath: "/fixture/key", manualMongo });
  await memoryStore.upsertNote(registry.getInternal(id), { topic: "fixture", summary: "仅用于客户端界面验证", facts: ["不连接真实服务器"] });
}
const config = loadConfig({}, directory);
config.runtime.statePath = path.join(directory, ".runtime/state.json");
const token = "f".repeat(64);
const calls = [];
const workerManager = {
  memoryStore,
  publicInstances: () => registry.list().map(instance => ({ ...instance, memory: memoryStore.summary(instance), runtime: {
    status: instance.id === "first" ? "running" : "stopped", pid: instance.id === "first" ? 1234 : null,
    workerPort: instance.id === "first" ? 4400 : null, lastHeartbeatAt: new Date().toISOString(), events: [],
    health: { overall: "healthy", transport: { status: "connected" }, authentication: { status: "authenticated" }, operations: { active: instance.id === "first" ? 1 : 0, queued: 0 } },
  } })),
  runtimeFor: id => ({ status: id === "first" ? "running" : "stopped" }),
  shutdownAll: async () => {},
  async callInstance(id, route, body) {
    calls.push({ id, route });
    if (route === "/mongodb/query") return { ok: true, data: body.operation === "listDatabases" ? { databases: [{ name: "fixture" }] } : [{ name: "records" }] };
    return { ok: true, instanceId: id, fixture: true };
  },
};
const app = createManagerApp({ cwd: directory, config, registry, workerManager, authToken: token, manualOptions: {
  ownerVerification: { status: () => ({ supported: true, message: "隔离夹具：系统认证由替身提供" }), verify: async () => {} },
  openTerminal(_instance, options) {
    setImmediate(() => { options.onReady(); options.onData(Buffer.from("Isolated UI fixture\r\nfixture> ")); });
    return { write(data) { options.onData(Buffer.from(data)); }, resize() {}, close() {}, pause() {}, resume() {} };
  },
  openDatabase() {
    return { id: randomUUID(), closed: false, close() { this.closed = true; }, async request(query) {
      if (["connect", "check"].includes(query.operation)) return { fingerprint: "fixture-only", hosts: "fixture.invalid:27017", database: "fixture", profile: "manualAdmin", users: [{ user: "fixture", db: "fixture" }] };
      if (query.operation === "databases") return { data: [{ name: "fixture" }], hasMore: false };
      if (query.operation === "collections") return { data: [{ name: "records" }], hasMore: false };
      if (query.operation === "indexes") return { data: [{ name: "_id_", key: { _id: 1 } }], hasMore: false };
      if (query.operation === "find") return { data: [{ _id: { $oid: "000000000000000000000001" }, label: "隔离样本文档", enabled: true }], hasMore: false };
      return { data: [] };
    } };
  },
} });
await app.locals.manualWorkbench.store.register("preview", "preview-only-password-123");
const resources = app.locals.resourceManager;
resources.attach("first", "preview-epoch", () => {});
resources.report("first", "preview-epoch", { taskId: randomUUID(), type: "log_search", status: "running", phase: "scanning", label: "隔离夹具日志查询", progress: { completedFiles: 3, totalFiles: 5 }, capabilities: [] });
const server = http.createServer(app);
server.listen(0, "127.0.0.1"); await once(server, "listening");
console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, fixtureToken: token, administrator: "preview", fixturePassword: "preview-only-password-123", isolation: "temporary filesystem + protocol substitutes" }));
let closing = false;
async function close() {
  if (closing) return; closing = true;
  resources.close(); await app.locals.manualWorkbench.close(); server.closeAllConnections();
  await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true });
}
process.once("SIGTERM", () => close().then(() => process.exit(0)));
process.once("SIGINT", () => close().then(() => process.exit(0)));
