import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

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

  addEventListener() {}

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

function createDashboardHarness(fetchImpl) {
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
    "toast",
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
    preferredWorkerPort: new FakeElement("input"),
    auditLog: new FakeElement("input"),
    enabled: new FakeElement("input"),
    approvedCommandsEnabled: new FakeElement("input"),
    mongodbWriteEnabled: new FakeElement("input"),
    mongodbAllowedDatabases: new FakeElement("textarea"),
    mongodbAllowedCollections: new FakeElement("textarea"),
  };

  const context = {
    document: {
      querySelector: (selector) => elements.get(selector.replace(/^#/, "")),
      createElement: (tagName) => new FakeElement(tagName),
    },
    fetch: fetchImpl,
    window: {
      confirm: () => true,
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

test("dashboard edits only selected MongoDB permissions and validates write scope", async () => {
  const script = await fs.readFile(path.resolve(here, "..", "public", "dashboard.js"), "utf8");
  const mongodb = { enabled: true, configPath: "/app/config.json", configProfile: "test" };
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
