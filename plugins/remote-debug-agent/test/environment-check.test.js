import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import environment from "../environment-report.cjs";
import dashboard from "../diagnostic-dashboard.cjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "environment-check-"));
  t.after(async () => { await dashboard.stopDashboard(dataDir); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, env: { ...process.env, REMOTE_DEBUG_DATA_DIR: dataDir, REMOTE_DEBUG_AGENT_URL: "",
    REMOTE_DEBUG_AGENT_DIR: "", REMOTE_DEBUG_ENV_PATH: "", REMOTE_DEBUG_PROJECT_ROOT: "" } };
}

function get(endpoint, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request(endpoint, { method }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject); req.end();
  });
}

test("preflight enforces the packaged range without changing the default runtime", async (t) => {
  const { dataDir, env } = await fixture(t);
  const report = environment.collectReport(pluginRoot, env, { nodeVersion: "14.21.3", execPath: "/old/node" });
  assert.equal(report.status, "failed");
  assert.match(report.checks.find((c) => c.id === "node").actual, /14\.21\.3.*\/old\/node/);
  assert.equal(report.nodeRequirement, ">=22.18 <23");
  assert.equal(report.checks.find((c) => c.id === "config").status, "warn");
  environment.saveReport(dataDir, report);
  const repaired = environment.collectReport(pluginRoot, env, { nodeVersion: "22.23.3" });
  assert.equal(repaired.status, "checked");
  assert.equal(repaired.failures.length, 1);
  assert.equal(repaired.failures[0].checks[0].status, "fail");
  assert.equal(environment.compatibleNode("22.17.9", report.nodeRequirement), false);
  assert.equal(environment.compatibleNode("22.18.0", report.nodeRequirement), true);
  assert.equal(environment.compatibleNode("23.0.0", report.nodeRequirement), false);
  assert.equal(environment.compatibleNode("24.19.0", report.nodeRequirement), false);
});

test("diagnostic dashboard reuses the original page, has no business endpoints, and safely releases its port", async (t) => {
  const { dataDir, env } = await fixture(t);
  const report = environment.collectReport(pluginRoot, env, { nodeVersion: "14.21.3" });
  environment.saveReport(dataDir, report);
  const server = http.createServer((_req, res) => { res.end("unrelated service"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const original = process.env.REMOTE_DEBUG_AGENT_PORT;
  process.env.REMOTE_DEBUG_AGENT_PORT = String(port);
  try { await dashboard.ensureDashboard(pluginRoot, dataDir, report); }
  finally {
    if (original === undefined) delete process.env.REMOTE_DEBUG_AGENT_PORT;
    else process.env.REMOTE_DEBUG_AGENT_PORT = original;
  }
  assert.ok(report.dashboardUrl);
  assert.notEqual(report.dashboardUrl, `http://127.0.0.1:${port}`);
  const response = await get(report.dashboardUrl + "/api/environment-report");
  assert.equal(JSON.parse(response.body).mode, "diagnostic");
  assert.equal(JSON.parse(response.body).report.status, "failed");
  const page = await get(report.dashboardUrl + "/");
  assert.match(page.body, /插件环境检查/);
  assert.doesNotMatch(page.body, /src="\/dashboard.js"/);
  assert.equal((await get(report.dashboardUrl + "/mongodb/query", "POST")).status, 405);
  assert.equal((await get(report.dashboardUrl + "/run", "POST")).status, 405);
  assert.equal((await get(report.dashboardUrl + "/diagnostics/shutdown", "POST")).status, 405);
  assert.equal((await get(report.dashboardUrl + "/..%2fconfig.env")).status, 404);
  assert.equal((await get(`http://127.0.0.1:${port}`)).body, "unrelated service");
  await dashboard.stopDashboard(dataDir);
  await assert.rejects(get(report.dashboardUrl + "/api/environment-report"));
});

test("offline report escapes embedded data and does not require an HTTP server", async (t) => {
  const { dataDir, env } = await fixture(t);
  const report = environment.collectReport(pluginRoot, env, { nodeVersion: "14.21.3" });
  report.checks[0].actual = '</script><script>alert("injected")</script>';
  environment.saveReport(dataDir, report);
  const html = await fs.readFile(report.offlineDashboard, "utf8");
  assert.match(html, /window.environmentSnapshot=/);
  assert.doesNotMatch(html, /<script>alert\("injected"\)/);
  assert.doesNotMatch(html, /src="\/dashboard.js"/);
  assert.doesNotMatch(html, /href="\/dashboard.css"/);
});

test("preflight rejects a corrupted runtime before MCP starts", async (t) => {
  const { dataDir, env } = await fixture(t);
  const installed = path.join(dataDir, "plugin");
  await fs.cp(pluginRoot, installed, { recursive: true });
  await fs.appendFile(path.join(installed, "runtime/agent/public/dashboard.css"), "/* modified */");
  const report = environment.collectReport(installed, env, { nodeVersion: "22.23.3" });
  assert.equal(report.status, "failed");
  assert.match(report.checks.find((c) => c.id === "artifacts").actual, /dashboard.css/);
});

test("missing dashboard files still leave an escaped offline failure report", async (t) => {
  const { dataDir, env } = await fixture(t);
  const installed = path.join(dataDir, "plugin");
  await fs.cp(pluginRoot, installed, { recursive: true });
  await fs.rm(path.join(installed, "runtime/agent/public/dashboard.html"));
  const report = environment.collectReport(installed, env, { nodeVersion: "22.23.3" });
  environment.saveReport(dataDir, report);
  assert.equal(report.status, "failed");
  assert.match(await fs.readFile(report.offlineDashboard, "utf8"), /页面运行文件缺失/);
});

test("an unreadable config file reports its condition without leaking values", async (t) => {
  const { dataDir, env } = await fixture(t);
  await fs.mkdir(path.join(dataDir, "config.env"));
  const report = environment.collectReport(pluginRoot, env, { nodeVersion: "22.23.3" });
  assert.equal(report.status, "failed");
  assert.equal(report.checks.find((check) => check.id === "config").status, "fail");
  assert.match(report.checks.find((check) => check.id === "config").actual, /EISDIR/);
});

test("launcher preserves a directory failure and saves its report in a writable fallback", async (t) => {
  const { dataDir, env } = await fixture(t);
  const blocked = path.join(dataDir, "not-a-directory");
  await fs.writeFile(blocked, "existing file");
  const result = spawnSync(process.execPath, [path.join(pluginRoot, "launch.cjs"), "--check"], {
    env: { ...env, REMOTE_DEBUG_DATA_DIR: blocked }, encoding: "utf8", timeout: 5000,
  });
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.configuredDataDir, blocked);
  assert.equal(report.checks.find((check) => check.id === "storage").status, "fail");
  assert.match(path.basename(report.dataDir), /^remote-debug-agent-diagnostics-/);
  t.after(() => fs.rm(report.dataDir, { recursive: true, force: true }));
  assert.match(await fs.readFile(report.offlineDashboard, "utf8"), /window.environmentSnapshot=/);
  assert.equal(await fs.readFile(blocked, "utf8"), "existing file");
});

test("runtime events update only their own attempt and do not claim tool availability before discovery", async (t) => {
  const { dataDir, env } = await fixture(t);
  const report = environment.collectReport(pluginRoot, env, { nodeVersion: "22.23.3" });
  environment.saveReport(dataDir, report);
  environment.recordRuntimeEvent(dataDir, { code: "MCP_TOOLS_LIST", toolCount: 29 }, "old-attempt");
  assert.equal(environment.readReport(dataDir).status, "checked");
  environment.recordRuntimeEvent(dataDir, { code: "MCP_INITIALIZE" }, report.attemptId);
  assert.equal(environment.readReport(dataDir).status, "starting");
  environment.recordRuntimeEvent(dataDir, { code: "MCP_TOOLS_LIST", toolCount: 29 }, report.attemptId);
  assert.equal(environment.readReport(dataDir).status, "ready");
  environment.recordRuntimeEvent(dataDir, { code: "AGENT_START_FAILED", level: "error" }, report.attemptId);
  assert.equal(environment.readReport(dataDir).status, "failed");
  environment.recordRuntimeEvent(dataDir, { code: "AGENT_READY" }, report.attemptId);
  assert.equal(environment.readReport(dataDir).status, "ready");
  assert.equal(environment.readReport(dataDir).failures.length, 1);
});

async function verifyHandshake(t, executable = process.execPath, extraEnv = {}) {
  const { dataDir, env } = await fixture(t);
  const child = spawn(executable, [path.join(pluginRoot, "launch.cjs")], {
    env: { ...env, ...extraEnv, REMOTE_DEBUG_AGENT_URL: "http://127.0.0.1:1" }, stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  let buffer = "", stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const results = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("handshake timeout: " + stderr)), 5000);
    child.once("error", reject);
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n"), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (line) results.push(JSON.parse(line));
      }
      if (results.length === 2) { clearTimeout(timer); resolve(); }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
  });
  assert.equal(results.find((result) => result.id === 1).result.serverInfo.name, "remote-debug-agent");
  assert.ok(results.find((result) => result.id === 2).result.tools.some((tool) => tool.name === "remote_debug_mongodb_query"));
  assert.equal(environment.readReport(dataDir).status, "ready");
  return environment.readReport(dataDir);
}

test("launcher preserves MCP JSON-line handshake and tool registration", async (t) => {
  await verifyHandshake(t);
});

test("a real Node 14 bootstrap relaunches MCP under the selected compatible runtime", async (t) => {
  const legacy = process.env.REMOTE_DEBUG_TEST_OLD_NODE || path.join(os.homedir(), ".nvm/versions/node/v14.21.3/bin/node");
  try { await fs.access(legacy); } catch { t.skip("legacy Node fixture unavailable"); return; }
  const report = await verifyHandshake(t, legacy, { REMOTE_DEBUG_NODE_PATH: process.execPath });
  assert.equal(report.nodeExecutable, process.execPath);
  assert.equal(report.runtimeSelection.bootstrapVersion, "14.21.3");
  assert.equal(report.runtimeSelection.source, "explicit");
  assert.equal(report.runtimeSelection.version, process.versions.node);
});

test("Python generates the offline dashboard when Node is absent", async (t) => {
  const { dataDir, env } = await fixture(t);
  const python = spawnSync(process.platform === "win32" ? "py" : "python3", process.platform === "win32" ? ["-3", "-c", "import sys; print(sys.executable)"] : ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" });
  if (python.status !== 0) { t.skip("Python 3 unavailable"); return; }
  const result = spawnSync(python.stdout.trim(), [path.join(pluginRoot, "scripts/offline-report.py")], {
    env: { ...env, PATH: "" }, encoding: "utf8", timeout: 5000,
  });
  assert.equal(result.status, 1, result.stderr);
  const report = environment.readReport(dataDir);
  assert.equal(report.nodeExecutable, null);
  assert.match(report.checks[0].actual, /未在当前 PATH 找到/);
  assert.match(await fs.readFile(report.offlineDashboard, "utf8"), /window.environmentSnapshot=/);
});
