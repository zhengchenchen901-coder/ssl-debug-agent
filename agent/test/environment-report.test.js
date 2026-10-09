import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { createManagerApp } from "../server.js";
import { loadConfig } from "../config.js";
import environment from "../../plugins/remote-debug-agent/environment-report.cjs";

const here = path.dirname(fileURLToPath(import.meta.url));

test("existing manager dashboard reads a failed MCP launch's report from its data directory", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "manager-environment-report-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const app = createManagerApp({ config: loadConfig({}, dataDir), cwd: dataDir, env: {} });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}/api/environment-report`;
  assert.equal((await (await fetch(endpoint)).json()).report, null);
  const report = { schemaVersion: 1, status: "failed", checks: [{ id: "node", status: "fail", actual: "14.21.3" }] };
  environment.writeJson(environment.reportPath(dataDir), report);
  const response = await fetch(endpoint);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { ok: true, mode: "manager", report });
});

class Element {
  constructor() { this.children = []; this.hidden = false; this.textContent = ""; }
  append(child) { this.children.push(child); }
  replaceChildren() { this.children = []; }
  addEventListener() {}
}

async function render(mode) {
  const ids = ["environmentPanel", "environmentStatus", "environmentSummary", "environmentRows", "environmentRecovery",
    "reloadEnvironmentButton", "environmentHistory", "environmentHistoryRows", "connectionText", "connectionDot"];
  const elements = new Map(ids.map((id) => [id, new Element()]));
  const instancePanel = new Element();
  const context = {
    document: { querySelector: (s) => elements.get(s.slice(1)), createElement: () => new Element(),
      querySelectorAll: () => [instancePanel] },
    window: { environmentSnapshot: { mode, report: { status: "failed", checkedAt: "2026-10-09T14:00:00Z", stage: "environment",
      checks: [{ label: "Node.js", actual: "14.21.3<script>test</script>", required: ">=22.18 <23", status: "fail", remedy: "使用 Node 22" }],
      failures: [{ checkedAt: "2026-10-09T13:00:00Z", stage: "environment", checks: [{ label: "Node.js", actual: "14.21.3" }] }] } } },
    fetch: () => { throw new Error("offline view must not fetch"); }, setInterval: () => {},
  };
  vm.runInNewContext(await fs.readFile(path.join(here, "../public/environment-report.js"), "utf8"), context);
  return { elements, instancePanel };
}

test("offline dashboard exposes failed conditions as text and hides instance controls", async () => {
  const { elements, instancePanel } = await render("offline");
  assert.equal(elements.get("environmentPanel").hidden, false);
  assert.equal(elements.get("environmentStatus").textContent, "检查失败");
  const cells = elements.get("environmentRows").children[0].children;
  assert.equal(cells[1].textContent, "14.21.3<script>test</script>");
  assert.equal(cells[2].textContent, ">=22.18 <23");
  assert.equal(cells[3].textContent, "不符合");
  assert.equal(instancePanel.hidden, true);
  assert.equal(elements.get("reloadEnvironmentButton").disabled, true);
  assert.equal(elements.get("environmentHistory").hidden, false);
});

test("manager report leaves the existing instance panel available", async () => {
  const { elements, instancePanel } = await render("manager");
  assert.equal(instancePanel.hidden, false);
  assert.equal(elements.get("reloadEnvironmentButton").disabled, false);
});
