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
