import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

test("dashboard unlock, logout and expired credentials stay confined to one tab", async () => {
  const script = await fs.readFile(path.resolve(here, "..", "public", "dashboard.js"), "utf8");
  const calls = [];
  let expired = false;
  const { context, elements } = createDashboardHarness(async (route, options) => {
    calls.push({ route, headers: options.headers });
    return { ok: !expired, status: expired ? 401 : 200, text: async () => JSON.stringify(expired ? { ok: false, error: { code: "LOCAL_AUTH_INVALID", message: "expired" } } : { ok: true, instances: [] }) };
  }, null);
  vm.runInContext(script, context);
  assert.equal(calls.length, 0);
  assert.equal(elements.get("authPanel").hidden, false);
  elements.get("authToken").value = "c".repeat(64);
  await elements.get("authForm").listeners.submit({ preventDefault() {} });
  assert.equal(elements.get("authPanel").hidden, true);
  assert.equal(elements.get("authToken").value, "");
  assert.equal(context.sessionStorage.getItem("remote-debug-auth"), "c".repeat(64));
  assert.ok(calls.every((call) => call.headers.Authorization === "Bearer " + "c".repeat(64)));
  expired = true;
  await context.loadInstances();
  assert.equal(context.sessionStorage.getItem("remote-debug-auth"), null);
  assert.equal(elements.get("authPanel").hidden, false);
  expired = false;
  elements.get("authToken").value = "d".repeat(64);
  await elements.get("authForm").listeners.submit({ preventDefault() {} });
  elements.get("authLogout").listeners.click();
  assert.equal(context.sessionStorage.getItem("remote-debug-auth"), null);
  assert.equal(elements.get("authPanel").hidden, false);
});

const here = path.dirname(fileURLToPath(import.meta.url));

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName;
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.hidden = false;
    this.disabled = false;
    this.title = "";
    this.type = "";
    this._className = "";
    this._textContent = "";
    this.classList = {
      toggle: (className, force) => {
        const classes = new Set(this._className.split(/\s+/).filter(Boolean));
        if (force) {
          classes.add(className);
        } else {
          classes.delete(className);
        }
        this._className = [...classes].join(" ");
      },
    };
  }

  get className() {
    return this._className;
  }

  get selectedOptions() {
    return this.children.filter((child) => child.selected);
  }

  set className(value) {
    this._className = String(value || "");
  }

  get textContent() {
    return [
      this._textContent,
      ...this.children.map((child) => child.textContent || ""),
    ].join("");
  }

  set textContent(value) {
    this._textContent = String(value ?? "");
    this.children = [];
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = children;
    this._textContent = "";
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  addEventListener(name, handler) {
    this.listeners ||= {};
    this.listeners[name] = handler;
  }

  focus() {}

  querySelector(selector) {
    if (selector === 'button[type="submit"]') {
      return this.submitButton;
    }
    return null;
  }

  closest() {
    return null;
  }
}

function createDashboardHarness(fetchImpl, initialToken = "a".repeat(64)) {
  const elements = new Map();
  const ids = [
    "connectionDot",
    "connectionText",
    "totalCount",
    "runningCount",
    "portRange",
    "defaultInstance",
    "instanceRows",
    "emptyState",
    "tableHint",
    "shutdownButton",
    "reloadButton",
    "newButton",
    "modalBackdrop",
    "closeModalButton",
    "cancelModalButton",
    "modalTitle",
    "instanceForm",
    "formMessage",
    "mongodbPermissions",
    "mongodbHint",
    "mongodbOptionsStatus",
    "mongodbCollectionSearch",
    "mongodbCollectionSearchStatus",
    "reloadMongoOptions",
    "drawer",
    "drawerMask",
    "closeDrawerButton",
    "drawerTitle",
    "drawerBody",
    "toast", "authPanel", "authForm", "authLogout", "authMessage", "authToken", "environmentPanel",
  ];

  for (const id of ids) {
    elements.set(id, new FakeElement(id));
  }

  const form = elements.get("instanceForm");
  form.submitButton = new FakeElement("button");
  form.reset = () => {};
  form.elements = {
    id: new FakeElement("input"),
    name: new FakeElement("input"),
    host: new FakeElement("input"),
    port: new FakeElement("input"),
    username: new FakeElement("input"),
    privateKeyPath: new FakeElement("input"),
    passphrase: new FakeElement("input"),
    hostKeyFingerprints: new FakeElement("textarea"),
    preferredWorkerPort: new FakeElement("input"),
    auditLog: new FakeElement("input"),
    enabled: new FakeElement("input"),
    approvedCommandsEnabled: new FakeElement("input"),
    ...Object.fromEntries(["Enabled", "ConfigPath", "DriverPath", "ConfigProfile", "UriKey", "Database", "MongoshPath", "NodePath"].map((suffix) => ["manualMongo" + suffix, new FakeElement("input")])),
    mongodbEnabled: new FakeElement("input"),
    mongodbConfigPath: new FakeElement("input"),
    mongodbDriverPath: new FakeElement("input"),
    mongodbConfigProfile: new FakeElement("input"),
    mongodbUriKey: new FakeElement("input"),
    mongodbDatabase: new FakeElement("input"),
    mongodbWriteEnabled: new FakeElement("input"),
    sandboxDatabase: new FakeElement("input"),
    sandboxManagementProfile: new FakeElement("input"),
    sandboxManagementPassword: new FakeElement("input"),
    mongodbAllowedDatabases: new FakeElement("textarea"),
    mongodbAllowedCollections: new FakeElement("textarea"),
  };

  let storedToken = initialToken;
  const context = {
    document: {
      querySelector: (selector) => elements.get(selector.replace(/^#/, "")),
      querySelectorAll: () => [],
      createElement: (tagName) => new FakeElement(tagName),
    },
    sessionStorage: { getItem: () => storedToken, setItem: (_key, value) => { storedToken = value; }, removeItem: () => { storedToken = null; } },
    Event: class { constructor(type) { this.type = type; } },
    fetch: fetchImpl,
    window: {
      confirm: () => true, dispatchEvent: () => {}, addEventListener: () => {},
    },
    setInterval: () => 0,
    setTimeout: () => 0,
    clearTimeout: () => {},
    console,
  };

  vm.createContext(context);
  return { context, elements };
}

test("dashboard marks offline runtime and memory values as stale snapshots", async () => {
  const script = await fs.readFile(path.resolve(here, "..", "public", "dashboard.js"), "utf8");
  let online = true;
  const responsePayload = {
    ok: true,
    defaultInstanceId: "default",
    manager: { workerPortRange: { start: 4400, end: 4499 } },
    lifecycle: { lifetime: "desktop" },
    instances: [
      {
        id: "default",
        name: "default",
        enabled: true,
        host: "prod.example.com",
        port: 22,
        username: "root",
        runtime: {
          status: "running",
          pid: 1234,
          workerPort: 4400,
          lastHeartbeatAt: "2026-06-02T06:00:00.000Z",
          events: [],
        },
        memory: {
          status: "partial",
          updatedAt: "2026-06-02T06:00:00.000Z",
          summary: {},
        },
      },
    ],
  };

  const { context, elements } = createDashboardHarness(async () => {
    if (!online) {
      throw new Error("fetch failed");
    }

    return {
      ok: true,
      text: async () => JSON.stringify(responsePayload),
    };
  });

  vm.runInContext(script, context);
  await context.loadInstances();
  assert.match(elements.get("instanceRows").textContent, /运行中/);

  online = false;
  await context.loadInstances();
  assert.match(elements.get("connectionText").textContent, /主进程不可用/);
  assert.match(elements.get("runningCount").textContent, /^--$/);
  assert.match(elements.get("instanceRows").textContent, /上次：运行中/);
  assert.match(elements.get("instanceRows").textContent, /缓存：部分可用/);
});

test("MongoDB selectors discover names per instance and retain choices on failure or stale responses", async () => {
  const script = await fs.readFile(path.resolve(here, "..", "public", "dashboard.js"), "utf8");
  const instances = [
    { id: "test-server", name: "test", mongodb: { allowedDatabases: ["yennefer"], allowedCollections: ["Saved"] } },
    { id: "default", name: "prod", mongodb: { allowedDatabases: ["production"] } },
  ];
  const queries = [];
  let fail = false;
  let delayed;
  let delay = false;
  let paginate = false;
  const response = (data) => ({ ok: true, text: async () => JSON.stringify({ ok: true, data }) });
  const { context, elements } = createDashboardHarness(async (url, options) => {
    if (url === "/api/instances") return { ok: true, text: async () => JSON.stringify({ ok: true, instances }) };
    const query = JSON.parse(options.body);
    queries.push(query);
    if (fail) throw new Error("SSH unavailable");
    if (delay) return new Promise((resolve) => { delayed = resolve; });
    if (paginate && query.operation === "listCollections") {
      return response(query.skip === 0 ? Array.from({ length: 500 }, (_, i) => ({ name: `collection${i}` })) : [{ name: "LastCollection" }]);
    }
    return response(query.operation === "listDatabases"
      ? { databases: [{ name: "yennefer" }, { name: "other" }] }
      : [{ name: "Customer" }, { name: "CustomerRestaurantRelation" }]);
  });
  vm.runInContext(script, context);
  await context.loadInstances();
  context.resetForm(instances[0]);
  await context.loadMongoOptions();
  const form = elements.get("instanceForm").elements;
  assert.deepEqual(queries.map((q) => [q.instanceId, q.operation, q.database]), [
    ["test-server", "listDatabases", undefined], ["test-server", "listCollections", "yennefer"],
  ]);
  assert.deepEqual(Array.from(form.mongodbAllowedCollections.children, (o) => o.value), ["Customer", "CustomerRestaurantRelation", "Saved"]);
  assert.deepEqual(Array.from(form.mongodbAllowedCollections.selectedOptions, (o) => o.value), ["Saved"]);
  const search = elements.get("mongodbCollectionSearch");
  search.value = " CUSTOMER ";
  context.filterMongoCollections();
  assert.deepEqual(Array.from(form.mongodbAllowedCollections.children, (o) => o.value), ["Customer", "CustomerRestaurantRelation"]);
  form.mongodbAllowedCollections.children[0].selected = true;
  search.value = "no-match";
  context.filterMongoCollections();
  assert.equal(form.mongodbAllowedCollections.children.length, 0);
  assert.match(elements.get("mongodbCollectionSearchStatus").textContent, /没有匹配.*已选 2/);
  assert.deepEqual(Array.from(context.selectedMongoNames(form.mongodbAllowedCollections)).sort(), ["Customer", "Saved"]);
  search.value = "";
  context.filterMongoCollections();
  assert.deepEqual(Array.from(form.mongodbAllowedCollections.selectedOptions, (o) => o.value), ["Customer", "Saved"]);
  form.mongodbAllowedCollections.children[0].selected = false;
  context.filterMongoCollections();
  assert.deepEqual(Array.from(context.selectedMongoNames(form.mongodbAllowedCollections)), ["Saved"]);
  paginate = true;
  await context.loadMongoOptions(true);
  assert.ok(form.mongodbAllowedCollections.children.some((o) => o.value === "LastCollection"));
  assert.equal(queries.at(-1).skip, 500);
  fail = true;
  await context.loadMongoOptions();
  assert.match(elements.get("mongodbOptionsStatus").textContent, /读取失败/);
  assert.equal(form.mongodbAllowedCollections.selectedOptions[0].value, "Saved");
  fail = false;
  delay = true;
  const pending = context.loadMongoOptions();
  context.resetForm(instances[1]);
  delayed(response({ databases: [{ name: "wrong-instance" }] }));
  await pending;
  assert.deepEqual(Array.from(form.mongodbAllowedDatabases.children, (o) => o.value), ["production"]);
});

test("Dashboard sandbox setup saves the selected password, previews its environment and requires confirmation", async () => {
  const script = await fs.readFile(path.resolve(here, "..", "public", "dashboard.js"), "utf8");
  const instances = [{ id: "test-server", name: "test", mongodb: { enabled: true, configPath: "/home/github/test/config.json", driverPath: "/home/github/test/driver", configProfile: "development", database: "business", writeEnabled: true, allowedDatabases: ["business"], allowedCollections: ["orders"], hasSandboxManagementPassword: true } }, { id: "default", name: "production" }];
  const calls = [], plan = { setupId: "setup-1", planHash: "a".repeat(64), environment: { serverVersion: "4.4.30", deployment: "replicaSet" }, sandboxDatabase: "remote_debug_agent", managerUser: "scoped-manager", collection: "__remote_debug_bulk_receipts", executionUser: { user: "admin", db: "admin" }, configPath: "/home/github/test/config.json", passwordReset: true };
  const { context, elements } = createDashboardHarness(async (url, options) => {
    calls.push({ url, body: options.body ? JSON.parse(options.body) : null });
    const result = url.endsWith("/prepare") ? plan : { ok: true, instances };
    return { ok: true, text: async () => JSON.stringify(result) };
  });
  let preview = ""; context.window.confirm = (text) => { preview = text; return false; };
  vm.runInContext(script, context); await context.loadInstances(); context.openModal(instances[0]);
  const form = elements.get("instanceForm").elements;
  assert.equal(form.sandboxManagementPassword.value, ""); assert.match(form.sandboxManagementPassword.placeholder, /已保存/);
  form.sandboxManagementPassword.value = "new-test-private-password";
  await context.submitForm({ preventDefault() {}, submitter: { value: "sandbox" } });
  const saved = calls.find((item) => item.url === "/api/instances/test-server");
  assert.equal(saved.body.mongodb.sandboxManagementPassword, "new-test-private-password");
  assert.equal(form.sandboxManagementPassword.value, "");
  assert.match(preview, /test-server/); assert.match(preview, /4.4.30/); assert.match(preview, /replicaSet/); assert.ok(!preview.includes("new-test-private-password"));
  assert.ok(!calls.some((item) => item.url.endsWith("/execute"))); assert.ok(!calls.some((item) => item.url.includes("default")));
  context.window.confirm = () => true; context.openModal(instances[0]);
  await context.submitForm({ preventDefault() {}, submitter: { value: "sandbox" } });
  const execute = calls.find((item) => item.url.endsWith("/execute"));
  assert.deepEqual(execute.body, { instanceId: "test-server", setupId: plan.setupId, planHash: plan.planHash, confirmation: "确认配置沙盒" });
  assert.ok(!JSON.stringify(execute.body).includes("password"));
});

test("dashboard edits only selected MongoDB permissions and validates write scope", async () => {
  const script = await fs.readFile(path.resolve(here, "..", "public", "dashboard.js"), "utf8");
  const mongodb = { enabled: true, configPath: "/app/config.json", driverPath: "/app/node_modules/mongodb", configProfile: "test" };
  const instances = [
    { id: "default", name: "default", host: "prod", username: "app" },
    { id: "test-server", name: "test", host: "test", username: "app", mongodb },
  ];
  const requests = [];
  const { context, elements } = createDashboardHarness(async (url, options) => {
    requests.push({ url, options });
    return { ok: true, text: async () => JSON.stringify({ ok: true, instances }) };
  });
  vm.runInContext(script, context);
  await context.loadInstances();
  context.openModal(instances[1]);
  const form = elements.get("instanceForm").elements;
  assert.equal(context.formPayload().mongodb, undefined);
  form.mongodbWriteEnabled.checked = true;
  await context.submitForm({ preventDefault() {} });
  assert.match(elements.get("formMessage").textContent, /请填写允许的数据库和集合/);
  assert.equal(requests.some(({ options }) => options.method === "PUT"), false);
  context.setMongoOptions(form.mongodbAllowedDatabases, ["yennefer"], ["yennefer"]);
  context.setMongoOptions(form.mongodbAllowedCollections, ["Customer", "CustomerRestaurantRelation"], ["Customer", "CustomerRestaurantRelation"]);
  await context.submitForm({ preventDefault() {} });
  const saved = requests.find(({ options }) => options.method === "PUT");
  assert.equal(saved.url, "/api/instances/test-server");
  assert.deepEqual(JSON.parse(saved.options.body).mongodb, {
    writeEnabled: true,
    allowedDatabases: ["yennefer"],
    allowedCollections: ["Customer", "CustomerRestaurantRelation"],
  });
  assert.equal(mongodb.configPath, "/app/config.json");
  context.openModal(instances[0]);
  assert.equal(elements.get("mongodbPermissions").disabled, true);
  assert.equal(context.formPayload().mongodb, undefined);

  mongodb.mutationsEnabled = true;
  await context.loadInstances();
  context.openModal(instances[1]);
  assert.equal(form.mongodbWriteEnabled.checked, true);
  form.mongodbWriteEnabled.checked = false;
  assert.deepEqual(JSON.parse(JSON.stringify(context.formPayload().mongodb)), {
    writeEnabled: false, mutationsEnabled: false,
  });
  mongodb.allowedCollections = ["Customer"];
  await context.loadInstances();
  context.openModal(instances[1]);
  context.setMongoOptions(form.mongodbAllowedCollections, [], []);
  assert.throws(() => context.formPayload(), /已有白名单不可清空/);
});

test("dashboard creates a MongoDB connection with required fields and keeps it read-only initially", async () => {
  const script = await fs.readFile(path.resolve(here, "..", "public", "dashboard.js"), "utf8");
  const { context, elements } = createDashboardHarness(async () => ({
    ok: true, text: async () => JSON.stringify({ ok: true, instances: [] }),
  }));
  vm.runInContext(script, context);
  await context.loadInstances();
  context.resetForm(null);
  const form = elements.get("instanceForm").elements;
  assert.equal(context.formPayload().mongodb, undefined);
  assert.equal(form.mongodbConfigPath.disabled, true);
  assert.equal(form.mongodbConfigPath.required, false);
  form.mongodbEnabled.checked = true;
  context.updateMongoConnectionState();
  assert.equal(form.mongodbConfigPath.required, true);
  assert.equal(form.mongodbDatabase.required, false);
  assert.equal(form.mongodbConfigPath.disabled, false);
  assert.equal(elements.get("mongodbPermissions").disabled, true);
  assert.throws(() => context.formPayload(), /远程配置文件路径/);
  form.mongodbConfigPath.value = " /srv/app/config.json ";
  assert.throws(() => context.formPayload(), /驱动路径/);
  form.mongodbDriverPath.value = "/srv/app/node_modules/mongodb";
  assert.throws(() => context.formPayload(), /配置分组/);
  form.mongodbConfigProfile.value = " development ";
  form.mongodbUriKey.value = " ";
  assert.throws(() => context.formPayload(), /URI 字段名/);
  form.mongodbUriKey.value = " mongodb.url ";
  assert.deepEqual(JSON.parse(JSON.stringify(context.formPayload().mongodb)), {
    enabled: true,
    configPath: "/srv/app/config.json",
    driverPath: "/srv/app/node_modules/mongodb",
    configProfile: "development",
    uriKey: "mongodb.url",
    database: "",
    writeEnabled: false,
    sandboxDatabase: "remote_debug_agent",
  });
  form.mongodbEnabled.checked = false;
  context.updateMongoConnectionState();
  assert.equal(form.mongodbConfigPath.required, false);
  assert.equal(context.formPayload().mongodb, undefined);
});

test("dashboard saves connection changes only for the edited instance and preserves existing permissions", async () => {
  const script = await fs.readFile(path.resolve(here, "..", "public", "dashboard.js"), "utf8");
  const production = {
    enabled: true, configPath: "/prod/config.json", driverPath: "/prod/node_modules/mongodb",
    configProfile: "production", uriKey: "url", database: "production",
  };
  const mongodb = {
    ...production, configPath: "/test/config.json", configProfile: "development", database: "yennefer",
    writeEnabled: true, allowedDatabases: ["yennefer"], allowedCollections: ["Customer"],
    rollbackRoot: "/tmp/mutations", maxAffectedDocuments: 100, bulkEnabled: true,
  };
  const instances = [
    { id: "default", name: "production", host: "prod", username: "app", mongodb: production },
    { id: "test-server", name: "test", host: "test", username: "app", mongodb },
  ];
  const requests = [];
  const { context, elements } = createDashboardHarness(async (url, options = {}) => {
    if (options.method === "PUT") requests.push({ url, body: JSON.parse(options.body) });
    return { ok: true, text: async () => JSON.stringify({ ok: true, instances }) };
  });
  vm.runInContext(script, context);
  await context.loadInstances();
  context.resetForm(instances[1]);
  const form = elements.get("instanceForm").elements;
  assert.equal(form.mongodbConfigPath.value, mongodb.configPath);
  assert.equal(form.mongodbDriverPath.value, mongodb.driverPath);
  assert.equal(form.mongodbConfigProfile.value, "development");
  assert.equal(form.mongodbUriKey.value, "url");
  assert.equal(form.mongodbDatabase.value, "yennefer");
  assert.equal(context.formPayload().mongodb, undefined);
  form.mongodbConfigPath.value = " /test/shared/config.json ";
  form.mongodbDatabase.value = "";
  context.updateMongoConnectionState();
  assert.equal(elements.get("reloadMongoOptions").disabled, true);
  await context.submitForm({ preventDefault() {} });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/instances/test-server");
  assert.deepEqual(requests[0].body.mongodb, { configPath: "/test/shared/config.json", database: "" });
  assert.equal(mongodb.configPath, "/test/config.json");
  assert.equal(production.configPath, "/prod/config.json");
  context.resetForm(instances[1]);
  form.mongodbEnabled.checked = false;
  context.updateMongoConnectionState();
  assert.equal(elements.get("mongodbPermissions").disabled, true);
  assert.deepEqual(JSON.parse(JSON.stringify(context.formPayload().mongodb)), { enabled: false });
  mongodb.enabled = false;
  await context.loadInstances();
  context.resetForm(instances[1]);
  assert.equal(form.mongodbConfigPath.value, "/test/config.json");
  form.mongodbEnabled.checked = true;
  context.updateMongoConnectionState();
  assert.deepEqual(JSON.parse(JSON.stringify(context.formPayload().mongodb)), { enabled: true });
});

test("editing a connection discards pending discovery and blocks queries using the previous connection", async () => {
  const script = await fs.readFile(path.resolve(here, "..", "public", "dashboard.js"), "utf8");
  const instance = { id: "test-server", mongodb: {
    enabled: true, configPath: "/test/config.json", driverPath: "/test/node_modules/mongodb",
    configProfile: "development", uriKey: "url", database: "yennefer", allowedDatabases: ["yennefer"],
  } };
  const queries = [];
  let finishQuery;
  const { context, elements } = createDashboardHarness(async (url, options) => {
    if (url === "/api/instances") return { ok: true, text: async () => JSON.stringify({ ok: true, instances: [instance] }) };
    queries.push(JSON.parse(options.body));
    return new Promise((resolve) => { finishQuery = resolve; });
  });
  vm.runInContext(script, context);
  await context.loadInstances();
  context.resetForm(instance);
  const pending = context.loadMongoOptions();
  elements.get("instanceForm").elements.mongodbConfigProfile.value = "production";
  context.updateMongoConnectionState();
  finishQuery({ ok: true, text: async () => JSON.stringify({ ok: true, data: { databases: [{ name: "old-database" }] } }) });
  await pending;
  await context.loadMongoOptions();
  assert.equal(queries.length, 1);
  assert.deepEqual(Array.from(elements.get("instanceForm").elements.mongodbAllowedDatabases.children, (o) => o.value), ["yennefer"]);
  assert.equal(elements.get("reloadMongoOptions").disabled, true);
  assert.match(elements.get("mongodbHint").textContent, /先保存连接配置并重新加载实例/);
});

test("manual MongoDB profile editing is per-instance and does not alter automatic or sandbox connections", async () => {
  const script = await fs.readFile(path.resolve(here, "..", "public", "dashboard.js"), "utf8");
  const business = { enabled: false, configPath: "/business/config.json", driverPath: "/business/driver", configProfile: "business", uriKey: "url", database: "business" };
  const instances = [{ id: "test", name: "test", host: "test", username: "ops", mongodb: business,
    manualMongo: { enabled: true, configPath: "/manual/config.json", driverPath: "/manual/driver", configProfile: "human", uriKey: "url", database: "records", mongoshPath: "/bin/mongosh", nodePath: "node" } }, { id: "other", host: "other", username: "ops" }];
  const { context, elements } = createDashboardHarness(async () => ({ ok: true, text: async () => JSON.stringify({ ok: true, instances }) }));
  vm.runInContext(script, context); await context.loadInstances(); context.resetForm(instances[0]);
  const form = elements.get("instanceForm").elements;
  assert.equal(form.manualMongoConfigProfile.value, "human");
  form.manualMongoConfigProfile.value = "humanReader";
  const payload = JSON.parse(JSON.stringify(context.formPayload()));
  assert.equal(payload.manualMongo.configProfile, "humanReader");
  assert.equal(payload.mongodb, undefined);
  context.resetForm(instances[1]);
  assert.equal(form.manualMongoConfigProfile.value, ""); assert.equal(context.formPayload().manualMongo, undefined);
  assert.equal(instances[0].manualMongo.configProfile, "human"); assert.equal(business.configProfile, "business");
});
