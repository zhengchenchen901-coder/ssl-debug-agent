// Runs on Node 14+ even when the actual MCP runtime is unsupported.
"use strict";
const path = require("path");
const url = require("url");
const os = require("os");
const crypto = require("crypto");
const environment = require("./environment-report.cjs");
const runtime = require("./node-runtime.cjs");

async function main() {
  const selection = runtime.selectRuntime(__dirname, process.env);
  if (selection.compatible && selection.executable !== process.execPath) {
    process.exitCode = await runtime.relaunch(selection.executable, __filename,
      process.argv.slice(2), process.env, selection.source);
    return;
  }
  let dataDir = environment.dataDirectory(process.env);
  const report = environment.collectReport(__dirname, process.env, {
    trigger: process.argv.includes("--check") ? "manual-check" : process.argv.includes("--diagnose") ? "manual-diagnosis" : "startup",
  });
  if (!selection.compatible && selection.source === "explicit") {
    report.status = "failed";
    report.checks.push({ id: "node-selection", label: "指定的 Node.js", actual: selection.executable +
      "（" + (selection.version || "无法执行") + "）", required: selection.requirement, status: "fail",
      remedy: "修正 REMOTE_DEBUG_NODE_PATH，或移除该设置以自动查找已安装的兼容 Node.js。" });
  }
  try {
    environment.saveReport(dataDir, report);
  } catch (_) {
    report.configuredDataDir = dataDir;
    dataDir = path.join(os.tmpdir(), "remote-debug-agent-diagnostics-" +
      crypto.createHash("sha256").update(os.homedir() + dataDir).digest("hex").slice(0, 16));
    report.dataDir = dataDir;
    report.offlineDashboard = path.join(dataDir, ".runtime", "environment-dashboard.html");
    report.status = "failed";
    if (!report.checks.some(function (check) { return check.id === "storage" && check.status === "fail"; })) {
      report.checks.push({ id: "report-write", label: "检查报告写入", actual: "目标目录不可写", required: "当前用户可保存报告", status: "fail",
        remedy: "检查数据目录权限；此次报告临时保存到系统临时目录。" });
    }
    environment.saveReport(dataDir, report);
  }
  if (process.argv.includes("--check")) {
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === "failed" ? 1 : 0;
    return;
  }
  if (report.status === "failed") {
    await require("./diagnostic-dashboard.cjs").ensureDashboard(__dirname, dataDir, report);
    report.checks.filter(function (item) { return item.status === "fail"; }).forEach(function (item) {
      console.error(item.label + "：" + item.actual + "；要求：" + item.required + "。" + item.remedy);
    });
    console.error("环境检查报告：" + (report.dashboardUrl || report.offlineDashboard));
    process.exitCode = 1;
    return;
  }
  await require("./diagnostic-dashboard.cjs").stopDashboard(dataDir);
  process.env.REMOTE_DEBUG_ENVIRONMENT_ATTEMPT_ID = report.attemptId;
  const entry = process.argv.includes("--diagnose") ? "scripts/diagnose-mcp.js" : "mcp-server.js";
  try {
    await import(url.pathToFileURL(path.join(__dirname, entry)).href);
  } catch (_) {
    report.status = "failed"; report.stage = "mcp";
    report.checks.push({ id: "mcp", label: "MCP 程序加载", actual: "加载失败", required: "MCP 程序可被当前 Node 加载",
      status: "fail", remedy: "检查插件运行日志，重新安装完整插件；不要使用零散文件覆盖不同版本。" });
    environment.saveReport(dataDir, report);
    await require("./diagnostic-dashboard.cjs").ensureDashboard(__dirname, dataDir, report);
    console.error("MCP 加载失败，环境检查报告：" + (report.dashboardUrl || report.offlineDashboard));
    process.exitCode = 1;
  }
}

main().catch(function (error) {
  console.error("环境检查无法完成（" + (error.code || "CHECK_FAILED") + "）；请检查诊断目录权限。可用 scripts/offline-report.py 生成离线报告。");
  process.exitCode = 1;
});
