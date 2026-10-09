// Keep this module compatible with Node 14: it diagnoses unsupported runtimes.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

function dataDirectory(env) {
  return path.resolve(env.REMOTE_DEBUG_DATA_DIR || env.REMOTE_DEBUG_PROJECT_ROOT ||
    (env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "RemoteDebugAgent") : path.join(os.homedir(), ".remote-debug-agent")));
}

function reportPath(dataDir) {
  return path.join(dataDir, ".runtime", "environment-report.json");
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return null; }
}

function readReport(dataDir) {
  return readJson(reportPath(dataDir));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + "." + process.pid + "." + crypto.randomBytes(6).toString("hex") + ".tmp";
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch (_) { /* renamed */ }
  }
}

function saveReport(dataDir, report) {
  writeJson(reportPath(dataDir), report);
  // An offline copy remains available even if the HTTP dashboard cannot start.
  try { writeOfflineDashboard(dataDir, report); } catch (_) { /* JSON is authoritative */ }
  return report;
}

function compatibleNode(version, requirement) {
  const v = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.replace(/^v/, ""));
  const range = /^>=(\d+)\.(\d+)(?:\.(\d+))? <(\d+)$/.exec(requirement);
  if (!v || !range) return false;
  const actual = v.slice(1).map(Number);
  const minimum = [Number(range[1]), Number(range[2]), Number(range[3] || 0)];
  return actual[0] < Number(range[4]) &&
    (actual[0] > minimum[0] || (actual[0] === minimum[0] &&
      (actual[1] > minimum[1] || (actual[1] === minimum[1] && actual[2] >= minimum[2]))));
}

function effectiveEnvironment(env, dataDir) {
  const configPath = path.resolve(env.REMOTE_DEBUG_ENV_PATH || path.join(dataDir, "config.env"));
  const effective = Object.assign({}, env);
  let configError = null;
  try {
   if (fs.existsSync(configPath)) {
    fs.readFileSync(configPath, "utf8").split(/\r?\n/).forEach(function (line) {
      const match = /^\s*(REMOTE_DEBUG_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match) return;
      let value = match[2];
      if ((value[0] === '"' && value[value.length - 1] === '"') ||
          (value[0] === "'" && value[value.length - 1] === "'")) value = value.slice(1, -1);
      else value = value.replace(/\s+#.*$/, "");
      effective[match[1]] = value;
    });
   }
  } catch (error) { configError = error.code || "CONFIG_UNREADABLE"; }
  return { env: effective, configPath: configPath, configError: configError };
}

function collectReport(pluginRoot, env, options) {
  options = options || {};
  const dataDir = dataDirectory(env);
  const settings = effectiveEnvironment(env, dataDir);
  const runtimeRoot = path.join(pluginRoot, "runtime", "agent");
  const manifest = readJson(path.join(runtimeRoot, "runtime-manifest.json"));
  const pkg = readJson(path.join(pluginRoot, "package.json"));
  const requirement = manifest && manifest.node || pkg && pkg.engines && pkg.engines.node || "unknown";
  const version = options.nodeVersion || process.versions.node;
  const checks = [];
  function check(id, label, actual, required, status, remedy) {
    checks.push({ id: id, label: label, actual: actual, required: required, status: status,
      remedy: status === "fail" || status === "warn" ? remedy : "" });
  }
  check("node", "插件启动使用的 Node.js", version + "（" + (options.execPath || process.execPath) + "）",
    requirement, compatibleNode(version, requirement) ? "pass" : "fail",
    "安装满足版本范围的 Node.js，或通过 REMOTE_DEBUG_NODE_PATH 指定已有版本；启动入口会自动查找 PATH/NVM，无需改变其他项目的默认版本。");
  const selection = env.REMOTE_DEBUG_BOOTSTRAP_NODE_PATH ? {
    bootstrapExecutable: env.REMOTE_DEBUG_BOOTSTRAP_NODE_PATH,
    bootstrapVersion: env.REMOTE_DEBUG_BOOTSTRAP_NODE_VERSION,
    executable: process.execPath, version: process.versions.node, source: env.REMOTE_DEBUG_NODE_SELECTION_SOURCE,
  } : null;
  if (selection) check("node-selection", "运行环境选择",
    "入口 Node " + selection.bootstrapVersion + " → 插件 Node " + selection.version + "（" + selection.source + "）",
    "插件运行进程使用符合版本范围的 Node.js", "pass", "");
  const external = settings.env.REMOTE_DEBUG_AGENT_URL || settings.env.REMOTE_DEBUG_AGENT_DIR;
  if (!external) {
    const valid = manifest && manifest.version === 1 && typeof manifest.runtimeId === "string" &&
      typeof manifest.server === "string" && typeof manifest.worker === "string" && manifest.hashes;
    check("manifest", "预构建运行清单", valid ? manifest.runtimeId : "缺失或格式无效",
      "存在有效的 runtime-manifest.json", valid ? "pass" : "fail", "重新安装完整插件，开发环境可重新构建 runtime。");
    if (valid) {
      const requiredFiles = [manifest.server, manifest.worker, "public/dashboard.html", "public/dashboard.css",
        "public/dashboard.js", "public/environment-report.js"];
      const invalid = requiredFiles.filter(function (file) {
        const resolved = path.resolve(runtimeRoot, file);
        if (!resolved.startsWith(runtimeRoot + path.sep) || !fs.existsSync(resolved)) return true;
        try {
          return !manifest.hashes[file] || crypto.createHash("sha256").update(fs.readFileSync(resolved)).digest("hex") !== manifest.hashes[file];
        } catch (_) { return true; }
      });
      check("artifacts", "运行文件完整性", invalid.length ? "缺失或校验不匹配：" + invalid.join("、") : "完整",
        "运行文件存在且 SHA-256 与清单一致", invalid.length ? "fail" : "pass", "重新安装或重新构建插件，避免混用不同版本的文件。");
    }
  } else {
    check("artifacts", "运行文件完整性", "使用自定义 Agent", "由自定义部署管理运行文件", "skip", "连接与配置将在对应功能调用时检查。");
  }
  check("config", "本地配置文件", settings.configError ? settings.configPath + "（" + settings.configError + "）" :
    fs.existsSync(settings.configPath) ? settings.configPath : "未创建",
    "可选；文件存在时需可读，连接信息也可来自实例配置或环境变量",
    settings.configError ? "fail" : fs.existsSync(settings.configPath) ? "pass" : "warn",
    settings.configError ? "将 REMOTE_DEBUG_ENV_PATH 指向可读的配置文件，并检查文件权限。" :
      "如需配置连接，在 dashboard 新建实例；缺少此文件本身不阻止 MCP 启动。");
  try {
    fs.mkdirSync(path.join(dataDir, ".runtime"), { recursive: true, mode: 0o700 });
    const probe = path.join(dataDir, ".runtime", ".environment-probe-" + process.pid + "-" + crypto.randomBytes(6).toString("hex"));
    fs.writeFileSync(probe, "", { mode: 0o600 }); fs.unlinkSync(probe);
    check("storage", "诊断报告目录", dataDir, "当前用户可创建和写入报告", "pass", "");
  } catch (_) {
    check("storage", "诊断报告目录", dataDir, "当前用户可创建和写入报告", "fail", "为当前用户提供目录写入权限，或设置 REMOTE_DEBUG_DATA_DIR 到可写目录。");
  }
  const previous = readReport(dataDir);
  const history = previous && Array.isArray(previous.failures) ? previous.failures.slice(-9) : [];
  if (previous && previous.status === "failed") {
    history.push({ checkedAt: previous.checkedAt, stage: previous.stage,
      checks: previous.checks.filter(function (item) { return item.status === "fail"; }) });
  }
  return {
    schemaVersion: 1, attemptId: crypto.randomBytes(16).toString("hex"), trigger: options.trigger || "startup",
    checkedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    pluginRoot: pluginRoot, nodeExecutable: options.execPath || process.execPath,
    nodeRequirement: requirement, runtimeSelection: selection, dataDir: dataDir,
    status: checks.some(function (item) { return item.status === "fail"; }) ? "failed" : "checked",
    stage: "environment", checks: checks, failures: history.slice(-10),
    offlineDashboard: path.join(dataDir, ".runtime", "environment-dashboard.html"),
    dashboardUrl: null,
  };
}

function writeOfflineDashboard(dataDir, report) {
  const publicDir = path.join(report.pluginRoot, "runtime", "agent", "public");
  const file = path.join(dataDir, ".runtime", "environment-dashboard.html");
  if (!["dashboard.html", "dashboard.css", "environment-report.js"].every(function (name) {
    return fs.existsSync(path.join(publicDir, name));
  })) {
    function escape(value) { return String(value || "").replace(/[&<>"']/g, function (char) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
    }); }
    const rows = report.checks.map(function (check) {
      return "<tr>" + [check.label, check.actual, check.required, check.status, check.remedy].map(function (value) {
        return "<td>" + escape(value) + "</td>";
      }).join("") + "</tr>";
    }).join("");
    fs.writeFileSync(file, '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Remote Debug Agent</title>' +
      '<style>body{font:14px system-ui;background:#f5f7fb;color:#1f2329;margin:28px}main{background:white;padding:20px;border-radius:8px;overflow:auto}' +
      'td,th{text-align:left;padding:12px;border-bottom:1px solid #d9dee8;overflow-wrap:anywhere}table{width:100%}</style>' +
      '<header><p>Remote Debug Agent</p><h1>连接实例管理</h1></header><main><h2>插件环境检查</h2><p>离线诊断 · ' +
      escape(report.checkedAt) + ' · 页面运行文件缺失，请根据下表修复插件。</p><table><thead><tr><th>检查项</th><th>实际情况</th>' +
      '<th>符合条件</th><th>结果</th><th>解决方法</th></tr></thead><tbody>' + rows + '</tbody></table></main></html>', { mode: 0o600 });
    return;
  }
  let html = fs.readFileSync(path.join(publicDir, "dashboard.html"), "utf8");
  const css = fs.readFileSync(path.join(publicDir, "dashboard.css"), "utf8");
  const script = fs.readFileSync(path.join(publicDir, "environment-report.js"), "utf8");
  const embedded = JSON.stringify({ ok: true, mode: "offline", report: report }).replace(/</g, "\\u003c");
  html = html.replace('<link rel="stylesheet" href="/dashboard.css" />', function () { return "<style>" + css + "</style>"; })
    .replace('<script src="/environment-report.js" defer></script>',
      function () { return "<script>window.environmentSnapshot=" + embedded + ";</script><script>" + script + "</script>"; })
    .replace('<script src="/dashboard.js" type="module"></script>', "");
  fs.writeFileSync(file, html, { mode: 0o600 });
}

function recordRuntimeEvent(dataDir, event, attemptId) {
  if (!attemptId) return;
  const report = readReport(dataDir);
  if (!report || report.attemptId !== attemptId) return;
  const states = {
    MCP_INITIALIZE: ["initialize", "MCP 初始化", "已收到初始化请求", "等待后续工具发现", "pass"],
    MCP_TOOLS_LIST: ["tools", "MCP 工具发现", String(event.toolCount) + " 个工具", "宿主请求工具列表", "pass"],
    AGENT_READY: ["manager", "本地 Agent", "已就绪", "Agent 正常响应健康检查", "pass"],
    AGENT_READY_AFTER_LOCK_WAIT: ["manager", "本地 Agent", "已就绪", "Agent 正常响应健康检查", "pass"],
    AGENT_REUSED: ["manager", "本地 Agent", "已复用", "Agent 正常响应健康检查", "pass"],
    AGENT_FALLBACK_REUSED: ["manager", "本地 Agent", "已复用", "Agent 正常响应健康检查", "pass"],
    AGENT_LEASE_RECOVERY_READY: ["manager", "本地 Agent", "已恢复", "Agent 正常响应健康检查", "pass"],
  };
  let item = states[event.code];
  if (!item && (event.level === "error" && typeof event.code === "string" && !event.code.startsWith("MCP_TOOLS_CALL"))) {
    item = ["manager", "本地 Agent 启动", event.code || "启动失败", "Agent 正常启动并响应健康检查", "fail"];
  }
  if (!item) return;
  const failureSnapshot = report.status === "failed" ? { checkedAt: report.checkedAt, stage: report.stage,
    checks: report.checks.filter(function (check) { return check.status === "fail"; }) } : null;
  report.checks = report.checks.filter(function (check) { return check.id !== item[0]; });
  report.checks.push({ id: item[0], label: item[1], actual: item[2], required: item[3], status: item[4],
    remedy: item[4] === "fail" ? "检查本地配置、运行文件与端口；详细原因见 MCP 运行日志。" : "" });
  report.stage = item[0];
  report.status = report.checks.some(function (check) { return check.status === "fail"; }) ? "failed" :
    (report.checks.some(function (check) { return check.id === "tools"; }) ? "ready" : "starting");
  report.updatedAt = new Date().toISOString();
  if (failureSnapshot && report.status !== "failed") report.failures = (report.failures || []).concat([failureSnapshot]).slice(-10);
  if (event.agentUrl && /^http:\/\/127\.0\.0\.1:\d+\/?$/.test(event.agentUrl)) report.dashboardUrl = event.agentUrl;
  saveReport(dataDir, report);
  return report;
}

module.exports = { dataDirectory, reportPath, readJson, writeJson, readReport, saveReport,
  compatibleNode, effectiveEnvironment, collectReport, writeOfflineDashboard, recordRuntimeEvent };
