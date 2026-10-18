import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";
import { ManualWorkbench } from "../manual-workbench.js";
import { InstanceRegistry } from "../instance-registry.js";
import { normalizeManualMongo } from "../manual-mongodb-config.js";
import { manualMongoCommand, normalizeManualQuery, validateReplacement } from "../manual-mongodb.js";

const settings = { enabled: true, configPath: "/opt/db/config.json", driverPath: "/opt/db/node_modules/mongodb", configProfile: "human", uriKey: "url" };
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rda-manual-db-"));
  const registry = new InstanceRegistry({ cwd: directory, env: {}, registryPath: path.join(directory, "instances.json") });
  registry.create({ id: "test", host: "127.0.0.1", username: "ops", privateKeyPath: "/test/key", manualMongo: settings, mongodb: { enabled: false } });
  let count = 0, now = Date.now();
  const connections = [], terminals = [];
  const workbench = new ManualWorkbench({ registry, dataDirectory: directory, now: () => now, idleMs: 10000,
    openDatabase() {
      const database = { id: `connection-${++count}`, closed: false, requests: [], close() { this.closed = true; }, async request(value) {
        this.requests.push(value);
        if (this.failure) throw Object.assign(new Error("target changed"), { code: "MANUAL_DB_TARGET_CHANGED" });
        if (value.operation === "connect") return { fingerprint: "remote-private-hash", hosts: "localhost:27017", database: "test", users: [{ user: "editor", db: "admin" }], profile: "human" };
        if (value.operation === "replaceOne") return { matchedCount: 1, modifiedCount: 1 };
        return { data: [] };
      } }; connections.push(database); return database;
    },
    openTerminal(_instance, options) { const terminal = { ...options, close() { this.closed = true; }, write() {}, resize() {}, pause() {}, resume() {} }; terminals.push(terminal); queueMicrotask(options.onReady); return terminal; },
  });
  await workbench.store.register("admin", "test-password-secure-123");
  const { token } = await workbench.login({ username: "admin", password: "test-password-secure-123", instanceId: "test" });
  await workbench.start();
  t.after(async () => { await workbench.close(); await fs.rm(directory, { recursive: true, force: true }); });
  async function api(route, body, authorization = token, origin = workbench.origin) {
    const response = await fetch(workbench.origin + route, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${authorization}`, Origin: origin, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, ...await response.json() };
  }
  const connect = () => api("/api/database/connect", {});
  return { directory, registry, workbench, token, api, connect, connections, terminals, advance: (value) => { now += value; } };
}

test("manual connection settings persist independently and reject inline credentials or shell injection paths", async (t) => {
  const { registry, directory } = await fixture(t);
  const before = registry.get("test").mongodb;
  registry.update("test", { manualMongo: { database: "records", mongoshPath: "/opt/bin/mongosh" } });
  assert.deepEqual(registry.get("test").mongodb, before);
  const reloaded = new InstanceRegistry({ env: {}, registryPath: path.join(directory, "instances.json") });
  assert.equal(reloaded.get("test").manualMongo.database, "records");
  assert.equal(reloaded.get("test").manualMongo.configProfile, "human");
  assert.throws(() => normalizeManualMongo({ ...settings, uri: "mongodb://secret" }), { code: "MANUAL_DB_CONFIG_INVALID" });
  assert.throws(() => normalizeManualMongo({ ...settings, mongoshPath: "mongosh;id" }), { code: "MANUAL_DB_CONFIG_INVALID" });
  assert.throws(() => normalizeManualMongo({ ...settings, uriKey: "__proto__.uri" }), { code: "MANUAL_DB_CONFIG_INVALID" });
  assert.ok(!manualMongoCommand(registry.getInternal("test"), "abc").includes("mongodb://secret"));
});

test("manual GUI endpoints require bound human token and exact origin; target and connection overrides fail", async (t) => {
  const f = await fixture(t);
  for (const route of ["/api/database/connect", "/api/database/query", "/api/database/prepare", "/api/database/execute", "/api/database/shell-ticket"]) {
    const response = await f.api(route, {}, "a".repeat(64));
    // Validation may reject malformed payload before auth, but never opens a connection.
    assert.ok([400, 401].includes(response.status));
  }
  assert.equal(f.connections.length, 0);
  assert.equal((await f.api("/api/database/connect", {}, f.token, "http://evil.test")).status, 403);
  assert.equal((await f.api("/api/database/connect", { instanceId: "other" })).status, 400);
  const result = await f.connect();
  assert.equal(result.target.instanceId, "test"); assert.ok(!JSON.stringify(result).includes("remote-private-hash"));
  assert.equal((await f.api("/api/database/query", { connectionId: "stale", operation: "databases" })).status, 409);
  assert.equal((await f.api("/api/database/query", { connectionId: result.connectionId, operation: "find", database: "test", collection: "records", pageSize: 101 })).status, 400);
  assert.equal((await f.api("/api/database/query", { connectionId: result.connectionId, operation: "find", database: "test", collection: "records", sort: { x: 0 } })).status, 400);
});

test("GUI writes require exact target confirmation, expire, consume once and never enable automatic writes", async (t) => {
  const f = await fixture(t), connection = await f.connect();
  const input = { connectionId: connection.connectionId, database: "test", collection: "records", original: { _id: { $oid: "0123456789abcdef01234567" }, date: { $date: { $numberLong: "1" } } }, replacement: { _id: { $oid: "0123456789abcdef01234567" }, value: { $numberDecimal: "12.34" } } };
  const plan = await f.api("/api/database/prepare", input);
  assert.equal(plan.action, "replaceOne"); assert.equal(plan.target.users[0].user, "editor");
  assert.equal(f.connections[0].requests.filter((item) => item.operation === "replaceOne").length, 0);
  assert.equal((await f.api("/api/database/execute", { connectionId: connection.connectionId, planId: plan.planId, confirmation: "yes" })).status, 409);
  const execution = { connectionId: connection.connectionId, planId: plan.planId, confirmation: plan.confirmation };
  assert.equal((await f.api("/api/database/execute", execution)).modifiedCount, 1);
  assert.equal((await f.api("/api/database/execute", execution)).status, 409);
  const expired = await f.api("/api/database/prepare", input);
  f.workbench.sessions.get(f.token).databasePlan.expiresAt = 0;
  assert.equal((await f.api("/api/database/execute", { ...execution, planId: expired.planId })).status, 409);
  assert.equal(f.registry.getInternal("test").mongodb.enabled, false);
  const audit = await fs.readFile(path.join(f.workbench.directory, "sessions.jsonl"), "utf8");
  assert.ok(audit.includes("database-write-completed")); assert.ok(!audit.includes("12.34") && !audit.includes(f.token));
});

test("separate shell tickets cannot cross SSH/database channels; switching closes GUI and DB shell only", async (t) => {
  const f = await fixture(t), connection = await f.connect();
  const ssh = f.workbench.issueTicket(f.token), db = await f.api("/api/database/shell-ticket", { connectionId: connection.connectionId });
  assert.throws(() => f.workbench.consumeTicket(db.ticket), { code: "MANUAL_TICKET_INVALID" });
  assert.equal(f.workbench.consumeTicket(ssh.ticket).session.instanceId, "test");
  const ticket = await f.api("/api/database/shell-ticket", { connectionId: connection.connectionId });
  const ws = new WebSocket(f.workbench.origin.replace("http:", "ws:") + "/database-terminal", { origin: f.workbench.origin });
  await once(ws, "open");
  const ready = once(ws, "message");
  ws.send(JSON.stringify({ type: "authenticate", ticket: ticket.ticket, cols: 100, rows: 30 }));
  assert.equal(JSON.parse((await ready)[0]).type, "ready");
  assert.ok(f.terminals[0].command.includes("remote-private-hash"));
  const sshTerminal = { closed: false, close() { this.closed = true; } };
  f.workbench.sessions.get(f.token).terminal = sshTerminal;
  const closed = once(ws, "close"); await f.connect(); await closed;
  assert.equal(f.connections[0].closed, true); assert.equal(f.terminals[0].closed, true); assert.equal(sshTerminal.closed, false);
  assert.equal((await f.api("/api/database/query", { connectionId: connection.connectionId, operation: "databases" })).status, 409);
});

test("remote changes, human expiry, logout and instance configuration changes cancel database access", async (t) => {
  const f = await fixture(t); let connection = await f.connect();
  f.connections[0].failure = true;
  assert.equal((await f.api("/api/database/query", { connectionId: connection.connectionId, operation: "databases" })).status, 400);
  assert.equal(f.connections[0].closed, true);
  connection = await f.connect();
  f.advance(10001);
  assert.equal((await f.api("/api/database/query", { connectionId: connection.connectionId, operation: "databases" })).status, 401);
  assert.equal(f.connections[1].closed, true);
  const fresh = await f.workbench.login({ username: "admin", password: "test-password-secure-123", instanceId: "test" });
  await f.api("/api/database/connect", {}, fresh.token);
  f.registry.update("test", { manualMongo: { configProfile: "new-identity" } });
  assert.equal((await f.api("/api/session", undefined, fresh.token)).status, 401);
  assert.equal(f.connections[2].closed, true);
});

test("query validation preserves Extended JSON and rejects unbounded/surplus fields", () => {
  const filter = { _id: { $oid: "0123456789abcdef01234567" }, cost: { $gte: { $numberDecimal: "10.1" } } };
  assert.deepEqual(normalizeManualQuery({ operation: "find", database: "test", collection: "records", filter }).filter, filter);
  assert.throws(() => normalizeManualQuery({ operation: "find", database: "test", collection: "records", skip: 1e9 }));
  assert.throws(() => validateReplacement({ database: "test", collection: "records", original: {}, replacement: {} }));
});

test("an old in-flight GUI request cannot return data after logout or close a replacement connection", async (t) => {
  const f = await fixture(t), first = await f.connect();
  const old = f.connections[0], originalRequest = old.request.bind(old);
  let resolveOld, started;
  const dispatched = new Promise((resolve) => { started = resolve; });
  old.request = async (input) => input.operation !== "databases" ? originalRequest(input) : new Promise((resolve) => { resolveOld = resolve; started(); });
  const pending = f.api("/api/database/query", { connectionId: first.connectionId, operation: "databases" });
  await dispatched;
  const second = await f.connect(); assert.notEqual(second.connectionId, first.connectionId);
  resolveOld({ data: [{ secretOldResult: true }] });
  const stale = await pending;
  assert.equal(stale.error.code, "MANUAL_DB_TARGET_CHANGED");
  assert.ok(!JSON.stringify(stale).includes("secretOldResult"));
  assert.equal(f.connections[1].closed, false);
  const current = f.connections[1], request = current.request.bind(current);
  let finish, signal;
  const inFlight = new Promise((resolve) => { signal = resolve; });
  current.request = async (input) => input.operation !== "databases" ? request(input) : new Promise((resolve) => { finish = resolve; signal(); });
  const canceled = f.api("/api/database/query", { connectionId: second.connectionId, operation: "databases" });
  await inFlight; await f.api("/api/logout", {}); finish({ data: [{ afterLogout: true }] });
  const response = await canceled;
  assert.equal(response.status, 401); assert.ok(!JSON.stringify(response).includes("afterLogout")); assert.equal(current.closed, true);
});

test("GUI typing/click activity renews human idle time, while session inspection does not", async (t) => {
  const f = await fixture(t), connection = await f.connect();
  f.advance(5000);
  assert.equal((await f.api("/api/database/activity", { connectionId: connection.connectionId })).status, 200);
  f.advance(6000);
  assert.equal((await f.api("/api/session")).status, 200);
  f.advance(4001);
  assert.equal((await f.api("/api/database/activity", { connectionId: connection.connectionId })).status, 401);
  assert.equal(f.connections[0].closed, true);
});
