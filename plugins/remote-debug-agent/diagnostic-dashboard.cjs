"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const childProcess = require("child_process");
const environment = require("./environment-report.cjs");

function statePath(dataDir) { return path.join(dataDir, ".runtime", "diagnostic-dashboard.json"); }

function request(endpoint, options) {
  return new Promise(function (resolve) {
    const req = http.request(endpoint, options || {}, function (res) {
      let body = "";
      res.on("data", function (chunk) { if (body.length < 1024 * 1024) body += chunk; });
      res.on("end", function () { try { resolve(JSON.parse(body)); } catch (_) { resolve(null); } });
    });
    req.setTimeout(1000, function () { req.destroy(); });
    req.on("error", function () { resolve(null); });
    req.end();
  });
}

async function stopDashboard(dataDir) {
  const state = environment.readJson(statePath(dataDir));
  if (!state || !/^http:\/\/127\.0\.0\.1:\d+$/.test(state.url) || typeof state.token !== "string") return;
  const result = await request(state.url + "/diagnostics/shutdown", { method: "POST", headers: { "X-Diagnostic-Token": state.token } });
  if (result && result.ok) {
    for (let attempt = 0; attempt < 20; attempt++) {
      if (!await request(state.url + "/api/environment-report")) break;
      await new Promise(function (resolve) { setTimeout(resolve, 25); });
    }
  }
}

async function ensureDashboard(pluginRoot, dataDir, report) {
  const settings = environment.effectiveEnvironment(process.env, dataDir).env;
  const agentState = environment.readJson(path.join(dataDir, ".runtime", "agent-state.json"));
  const configuredPort = Number(settings.REMOTE_DEBUG_AGENT_PORT || 4343);
  const port = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort < 65536 ? configuredPort : 4343;
  const candidates = [agentState && agentState.port, port].filter(function (value) { return Number.isInteger(value) && value > 0 && value < 65536; });
  for (const candidate of candidates) {
    const endpoint = "http://127.0.0.1:" + candidate;
    const result = await request(endpoint + "/api/environment-report");
    if (result && result.ok && result.report && result.report.dataDir === dataDir) {
      report.dashboardUrl = endpoint; environment.saveReport(dataDir, report); return;
    }
  }
  const previous = environment.readJson(statePath(dataDir));
  if (previous && /^http:\/\/127\.0\.0\.1:\d+$/.test(previous.url)) {
    const result = await request(previous.url + "/api/environment-report");
    if (result && result.mode === "diagnostic" && result.report && result.report.dataDir === dataDir) {
      report.dashboardUrl = previous.url; environment.saveReport(dataDir, report); return;
    }
  }
  const child = childProcess.spawn(process.execPath, [__filename, pluginRoot, dataDir, String(port)], {
    detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
  });
  await new Promise(function (resolve) {
    const timer = setTimeout(done, 3000);
    function done() { clearTimeout(timer); if (child.connected) child.disconnect(); child.unref(); resolve(); }
    child.once("error", done);
    child.once("message", function (message) {
      if (message.url) { report.dashboardUrl = message.url; environment.saveReport(dataDir, report); }
      done();
    });
  });
}

async function serve(pluginRoot, dataDir, preferredPort) {
  const token = crypto.randomBytes(24).toString("hex");
  const publicDir = path.join(pluginRoot, "runtime", "agent", "public");
  const assets = { "/": ["dashboard.html", "text/html"], "/dashboard.css": ["dashboard.css", "text/css"],
    "/environment-report.js": ["environment-report.js", "text/javascript"], "/dashboard.js": ["dashboard.js", "text/javascript"] };
  const server = http.createServer(function (req, res) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (!/^127\.0\.0\.1:\d+$/.test(req.headers.host || "")) { res.writeHead(403); res.end(); return; }
    if (req.method === "POST" && req.url === "/diagnostics/shutdown" && req.headers["x-diagnostic-token"] === token) {
      res.setHeader("Content-Type", "application/json");
      res.on("finish", function () { server.close(); sockets.forEach(function (socket) { socket.destroy(); }); });
      res.end('{"ok":true}'); return;
    }
    if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
    if (req.url === "/api/environment-report") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, mode: "diagnostic", report: environment.readReport(dataDir) })); return;
    }
    const asset = assets[req.url];
    if (!asset) { res.writeHead(404); res.end(); return; }
    try {
      let contents = fs.readFileSync(path.join(publicDir, asset[0]));
      if (req.url === "/") contents = contents.toString().replace('<script src="/dashboard.js" type="module"></script>', "");
      res.setHeader("Content-Type", asset[1] + "; charset=utf-8"); res.end(contents);
    } catch (_) {
      if (req.url === "/") {
        try {
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(fs.readFileSync(path.join(dataDir, ".runtime", "environment-dashboard.html"))); return;
        } catch (_) { /* no saved HTML */ }
      }
      res.writeHead(503); res.end("诊断页面文件缺失，请查看离线报告或重新安装插件。");
    }
  });
  const sockets = new Set();
  server.on("connection", function (socket) {
    sockets.add(socket); socket.on("close", function () { sockets.delete(socket); });
  });
  let bound = false;
  for (let offset = 0; offset < 10 && preferredPort + offset <= 65535; offset++) {
    bound = await new Promise(function (resolve) {
      function failed() { server.removeListener("listening", ready); resolve(false); }
      function ready() { server.removeListener("error", failed); resolve(true); }
      server.once("error", failed); server.once("listening", ready);
      server.listen(preferredPort + offset, "127.0.0.1");
    });
    if (bound) break;
  }
  if (!bound) { if (process.send) process.send({ error: "NO_DIAGNOSTIC_PORT" }); return; }
  const endpoint = "http://127.0.0.1:" + server.address().port;
  environment.writeJson(statePath(dataDir), { url: endpoint, token: token });
  if (process.send) process.send({ url: endpoint });
  // Diagnostic-only server is bounded and never launches workers or remote operations.
  const timer = setTimeout(function () { server.close(); sockets.forEach(function (socket) { socket.destroy(); }); }, 30 * 60 * 1000);
  timer.unref();
  server.on("close", function () { clearTimeout(timer); });
}

if (require.main === module) serve(process.argv[2], process.argv[3], Number(process.argv[4])).catch(function () { process.exitCode = 1; });
module.exports = { ensureDashboard, stopDashboard, serve };
