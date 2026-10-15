import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";
import { runSandboxAccess } from "../mongodb-sandbox-access.js";

const require = createRequire(import.meta.url);
function fixture(t, external = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rda-access-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { enabled: true, writeEnabled: true, configPath: "/home/github/app/config.json", driverPath: "/home/github/driver/mongodb", configProfile: "development", uriKey: "url", database: "business", allowedDatabases: ["business"], allowedCollections: ["orders"], sandboxManagementPassword: "fixture-sandbox-private-password" };
  const sourceConfig = { development: { url: "mongodb://admin:fixture-private@localhost:27017/business?authSource=admin" }, untouched: { keep: true } };
  if (external.uri) sourceConfig.development.url = external.uri;
  const translate = (name) => path.join(root, name);
  fs.mkdirSync(path.dirname(translate(config.configPath)), { recursive: true });
  fs.mkdirSync(translate("/tmp"));
  fs.writeFileSync(translate(config.configPath), JSON.stringify(sourceConfig), { mode: 0o644 });
  const remoteFs = Object.create(fs);
  for (const name of ["existsSync", "mkdirSync", "lstatSync", "readFileSync", "writeFileSync", "openSync", "unlinkSync", "chmodSync"]) remoteFs[name] = (file, ...args) => fs[name](typeof file === "number" ? file : translate(file), ...args);
  remoteFs.renameSync = (from, to) => fs.renameSync(translate(from), translate(to));
  remoteFs.realpathSync = (file) => "/" + path.relative(root, fs.realpathSync(translate(file))).split(path.sep).join("/");
  const state = { roles: new Map(), users: new Map(), grants: [{ role: "root", db: "admin" }], events: [], admin: true, failUser: false, failRoleCode: null, requirePrimary: false, unsafeManager: false, version: "4.4.30", wire: 9, setName: "test-rs" };
  class MongoClient {
    constructor(uri) { this.uri = uri; this.manager = !uri.includes("admin:fixture-private"); }
    async connect() {
      if (this.manager) {
        const uri = new URL(this.uri), user = state.users.get(decodeURIComponent(uri.username));
        if (!user || user.pwd !== decodeURIComponent(uri.password)) throw new Error("Authentication failed: NEVER-PRINT-SECRET");
      }
    }
    async close() {}
    db(database) { return { command: async (command, options) => {
      if (state.requirePrimary && options?.readPreference !== "primary") throw Object.assign(new Error("not primary NEVER-PRINT-SECRET"), { code: 10107 });
      if (command.buildInfo) return { version: state.version };
      if (command.isMaster) return { maxWireVersion: state.wire, setName: state.setName, ismaster: state.writablePrimary !== false };
      if (command.connectionStatus) return { authInfo: { authenticatedUsers: [{ user: this.manager ? decodeURIComponent(new URL(this.uri).username) : "admin", db: this.manager ? "remote_debug_agent" : "admin" }], authenticatedUserPrivileges: this.manager ? [{ resource: { db: state.unsafeManager ? "business" : "remote_debug_agent", collection: "__remote_debug_bulk_receipts" }, actions: ["remove", "find"] }] : state.admin ? [{ resource: { anyResource: true }, actions: ["createRole", "createUser", "grantRole", "changePassword"] }] : [] } };
      if (command.rolesInfo) return { roles: state.roles.has(command.rolesInfo.role) ? [structuredClone(state.roles.get(command.rolesInfo.role))] : [] };
      if (command.usersInfo) return { users: command.usersInfo.user === "admin" ? [{ roles: structuredClone(state.grants) }] : state.users.has(command.usersInfo.user) ? [structuredClone(state.users.get(command.usersInfo.user))] : [] };
      state.events.push({ database, command: Object.keys(command)[0] });
      if (command.createRole) {
        if (state.failRoleCode !== null) throw Object.assign(new Error("mongodb://secret:NEVER-PRINT-SECRET@localhost"), { code: state.failRoleCode });
        state.roles.set(command.createRole, { privileges: structuredClone(command.privileges), roles: structuredClone(command.roles) });
      }
      else if (command.createUser) {
        if (state.failUser) throw new Error("Database failure mongodb://secret:NEVER-PRINT-SECRET@localhost");
        state.users.set(command.createUser, structuredClone(command));
      } else if (command.grantRolesToUser) state.grants.push(...structuredClone(command.roles));
      else if (command.updateUser) state.users.get(command.updateUser).pwd = command.pwd;
      else throw new Error("Unexpected command");
      return { ok: 1 };
    } }; }
  }
  async function run(input = {}, action = "prepare", policy = config, instanceId = "test-server") {
    return runSandboxAccess(input, { action, config: policy, instanceId, runSSH: async (_command, options) => {
      let stdout = "";
      const processStub = { getuid: () => process.getuid(), stdout: { write: (text) => { stdout += text; } }, exitCode: 0 };
      const context = { require: (name) => name === "fs" ? remoteFs : name === config.driverPath ? external.driver || { MongoClient } : require(name), process: processStub, Buffer, URL };
      vm.runInNewContext("globalThis.done = " + options.stdin, context);
      await context.done;
      assert.ok(!stdout.includes("fixture-private") && !stdout.includes("NEVER-PRINT-SECRET"));
      return { stdout, exitCode: processStub.exitCode };
    } });
  }
  const fileConfig = () => JSON.parse(fs.readFileSync(translate(config.configPath), "utf8"));
  const execute = (plan, policy = config) => run({ setupId: plan.setupId, planHash: plan.planHash, confirmation: "确认配置沙盒" }, "execute", policy);
  return { root, config, state, run, execute, fileConfig, translate, sourceConfig };
}

test("sandbox access prepare is read-only; execute grants only fixed sandbox privileges and protects generated credentials", async (t) => {
  const h = fixture(t), plan = await h.run();
  assert.equal(plan.instanceId, "test-server"); assert.equal(plan.configModeAfter, "0600");
  assert.equal(h.state.events.length, 0); assert.deepEqual(h.fileConfig(), h.sourceConfig);
  assert.equal((await h.execute(plan)).status, "completed");
  assert.deepEqual(h.fileConfig().development, h.sourceConfig.development); assert.deepEqual(h.fileConfig().untouched, h.sourceConfig.untouched);
  assert.equal(fs.statSync(h.translate(h.config.configPath)).mode & 0o777, 0o600);
  assert.ok(h.state.events.every((event) => event.database === "remote_debug_agent" || event.command === "grantRolesToUser"));
  assert.deepEqual(h.state.events.map((event) => event.command), ["createRole", "createRole", "createUser", "grantRolesToUser"]);
  assert.equal(h.state.grants[0].role, "root");
  assert.ok(plan.executorPrivileges.every((item) => item.resource.db === "remote_debug_agent"));
  assert.equal(plan.collectionsInitialized, false);
  const count = h.state.events.length;
  assert.equal((await h.execute(plan)).status, "completed"); assert.equal(h.state.events.length, count);
  const repeated = await h.run(); await h.execute(repeated); assert.equal(h.state.events.length, count);
});

test("sandbox access rejects absent admin authority and conflicting roles before changes", async (t) => {
  const h = fixture(t); h.state.admin = false;
  await assert.rejects(h.run(), { code: "SANDBOX_SETUP_ADMIN_AUTHORITY_REQUIRED" });
  h.state.admin = true; h.state.roles.set("rda_sandbox_manager", { roles: [], privileges: [{ resource: { db: "business", collection: "" }, actions: ["remove"] }] });
  await assert.rejects(h.run(), { code: "SANDBOX_SETUP_ROLE_CONFLICT" });
  assert.equal(h.state.events.length, 0); assert.deepEqual(h.fileConfig(), h.sourceConfig);
});

test("account administration overrides secondary read preferences without changing business configuration", async (t) => {
  const h = fixture(t); h.state.requirePrimary = true;
  const source = h.fileConfig(); source.development.url += "&readPreference=secondaryPreferred";
  fs.writeFileSync(h.translate(h.config.configPath), JSON.stringify(source));
  const plan = await h.run();
  assert.equal(plan.environment.configuredReadPreference, "secondaryPreferred");
  assert.equal((await h.execute(plan)).status, "completed");
  assert.equal(h.fileConfig().development.url, source.development.url);
  assert.equal(new URL(h.fileConfig().remote_debug_manager.url).searchParams.get("readPreference"), "primary");
});

test("setup failures expose only the fixed phase and numeric database code", async (t) => {
  const h = fixture(t), plan = await h.run(); h.state.failRoleCode = 13;
  await assert.rejects(h.execute(plan), (error) => error.code === "SANDBOX_SETUP_FAILED" && error.message.includes("create-manager-role") && error.message.includes("database code 13") && !error.message.includes("NEVER-PRINT-SECRET"));
  const stored = JSON.parse(fs.readFileSync(h.translate("/tmp/remote-debug-agent/sandbox-access/" + plan.setupId + ".json"), "utf8"));
  assert.deepEqual(stored.errorDiagnostic, { phase: "create-manager-role", databaseCode: 13 });
  assert.equal(stored.status, "partial"); assert.equal(h.state.users.size, 0);
});

test("a direct connection to a secondary stops during read-only preflight", async (t) => {
  const h = fixture(t); h.state.writablePrimary = false;
  await assert.rejects(h.run(), { code: "SANDBOX_SETUP_PRIMARY_REQUIRED" });
  assert.equal(h.state.events.length, 0); assert.deepEqual(h.fileConfig(), h.sourceConfig);
});

test("sandbox access binds configuration and role state into an expiring immutable plan", async (t) => {
  const h = fixture(t), plan = await h.run();
  fs.appendFileSync(h.translate(h.config.configPath), "\n");
  await assert.rejects(h.execute(plan), { code: "SANDBOX_SETUP_PLAN_CONFLICT" });
  assert.equal(h.state.events.length, 0);
  const fresh = await h.run();
  const file = h.translate("/tmp/remote-debug-agent/sandbox-access/" + fresh.setupId + ".json");
  const changed = JSON.parse(fs.readFileSync(file, "utf8")); changed.snapshot.executionUser.user = "other"; fs.writeFileSync(file, JSON.stringify(changed));
  await assert.rejects(h.execute(fresh), { code: "SANDBOX_SETUP_PLAN_CONFLICT" });
});

test("partial account setup requires a new prepare and preserves original config on user creation failure", async (t) => {
  const h = fixture(t), plan = await h.run(); h.state.failUser = true;
  await assert.rejects(h.execute(plan), { code: "SANDBOX_SETUP_FAILED" });
  assert.deepEqual(h.fileConfig(), h.sourceConfig);
  await assert.rejects(h.execute(plan), { code: "SANDBOX_SETUP_INSPECT_PARTIAL_CHANGES" });
  h.state.failUser = false;
  const fresh = await h.run(); assert.equal(fresh.existing.profile, false);
  await h.execute(fresh); assert.ok(h.fileConfig().remote_debug_manager.url);
  assert.equal(h.state.events.filter((event) => event.command === "createRole").length, 2);
});

test("setup rejects unsafe files, foreign profiles, broad management credentials and unconfirmed execution", async (t) => {
  const h = fixture(t);
  await assert.rejects(h.run({ setupId: "a".repeat(36), planHash: "a".repeat(64) }, "execute"), { code: "SANDBOX_SETUP_CONFIRMATION_REQUIRED" });
  await assert.rejects(h.run({ role: "root" }), { code: "SANDBOX_SETUP_INPUT_INVALID" });
  await assert.rejects(h.run({}, "prepare", { ...h.config, sandboxDatabase: "business" }), { code: "SANDBOX_DATABASE_INVALID" });
  await assert.rejects(h.run({}, "prepare", { ...h.config, writeEnabled: false }), { code: "MONGODB_MUTATIONS_DISABLED" });
  await assert.rejects(h.run({}, "prepare", { ...h.config, sandboxManagementProfile: "development" }), { code: "SANDBOX_MANAGEMENT_PROFILE_INVALID" });
  const plan = await h.run(); await h.execute(plan); h.state.unsafeManager = true;
  await assert.rejects(h.run(), { code: "SANDBOX_SETUP_MANAGER_PRIVILEGES_UNSAFE" });
});

test("password resets use latest per-instance settings and invalidate old prepared plans", async (t) => {
  const h = fixture(t), initial = await h.run(); await h.execute(initial);
  const stale = await h.run();
  const changed = { ...h.config, sandboxManagementPassword: "new-instance-specific-password" };
  await assert.rejects(h.execute(stale, changed), { code: "SANDBOX_SETUP_PLAN_CONFLICT" });
  const fresh = await h.run({}, "prepare", changed);
  assert.equal(fresh.managerUser, initial.managerUser); assert.equal(fresh.passwordReset, true);
  const count = h.state.events.length;
  await h.execute(fresh, changed);
  assert.deepEqual(h.state.events.slice(count).map((event) => event.command), ["updateUser"]);
  assert.equal(h.state.users.get(initial.managerUser).pwd, changed.sandboxManagementPassword);
  assert.equal(decodeURIComponent(new URL(h.fileConfig().remote_debug_manager.url).password), changed.sandboxManagementPassword);
});

test("instances and environments cannot reuse one another's setup plan or credential", async (t) => {
  const h = fixture(t), first = await h.run();
  h.state.version = "6.0.26"; h.state.wire = 17; h.state.setName = undefined;
  const other = await h.run({}, "prepare", h.config, "default");
  assert.notEqual(first.managerUser, other.managerUser);
  assert.equal(first.environment.serverVersion, "4.4.30"); assert.equal(other.environment.serverVersion, "6.0.26");
  assert.equal(other.environment.deployment, "standalone"); assert.equal(other.environment.transactionsSupported, false);
  await assert.rejects(h.execute(first), { code: "SANDBOX_SETUP_PLAN_CONFLICT" });
  h.state.version = "3.6.23"; h.state.wire = 6;
  await assert.rejects(h.run(), { code: "SANDBOX_SETUP_SERVER_UNSUPPORTED" });
  assert.equal(h.state.events.length, 0);
});

test("real authenticated MongoDB sandbox setup and owned password reset deny business access", { skip: !process.env.MONGODB_SANDBOX_ACCESS_TEST_URI || !process.env.MONGODB_SANDBOX_ACCESS_TEST_DRIVER }, async (t) => {
  const driver = require(process.env.MONGODB_SANDBOX_ACCESS_TEST_DRIVER);
  const h = fixture(t, { uri: process.env.MONGODB_SANDBOX_ACCESS_TEST_URI, driver });
  const plan = await h.run(); assert.equal(plan.environment.deployment, "replicaSet");
  assert.equal((await h.execute(plan)).status, "completed");
  let manager = new driver.MongoClient(h.fileConfig().remote_debug_manager.url, { useNewUrlParser: true, useUnifiedTopology: true });
  await manager.connect();
  await assert.rejects(manager.db("business").collection("orders").findOne({}), (error) => error.code === 13);
  await manager.close();
  const changed = { ...h.config, sandboxManagementPassword: "real-fixture-rotated-password" };
  const next = await h.run({}, "prepare", changed); assert.equal(next.passwordReset, true);
  await h.execute(next, changed);
  manager = new driver.MongoClient(h.fileConfig().remote_debug_manager.url, { useNewUrlParser: true, useUnifiedTopology: true });
  await manager.connect(); await manager.close();
  assert.deepEqual(h.fileConfig().development, h.sourceConfig.development);
});
