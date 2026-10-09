(function () {
  "use strict";
  const panel = document.querySelector("#environmentPanel");
  if (!panel) return;
  const status = document.querySelector("#environmentStatus");
  const summary = document.querySelector("#environmentSummary");
  const rows = document.querySelector("#environmentRows");
  const recovery = document.querySelector("#environmentRecovery");
  const refresh = document.querySelector("#reloadEnvironmentButton");
  const history = document.querySelector("#environmentHistory");
  const historyRows = document.querySelector("#environmentHistoryRows");
  const labels = { pass: "符合", fail: "不符合", warn: "提示", skip: "未检查" };
  const stages = { environment: "启动环境", mcp: "MCP 加载", initialize: "MCP 初始化", tools: "工具发现", manager: "本地 Agent" };
  let snapshot = null;

  function element(tag, content, className) {
    const node = document.createElement(tag);
    node.textContent = content || "";
    if (className) node.className = className;
    return node;
  }

  function render(data) {
    const report = data.report;
    if (!report) { panel.hidden = true; return; }
    snapshot = data;
    panel.hidden = false;
    const failed = report.status === "failed";
    status.textContent = failed ? "检查失败" : report.status === "ready" ? "已发现工具" : report.status === "starting" ? "启动中" : "环境检查通过";
    status.className = "environment-status " + (failed ? "failed" : "passed");
    const mode = data.mode === "diagnostic" ? "仅诊断模式，实例操作不可用。" :
      data.mode === "offline" ? "离线报告，实例操作不可用。" : "";
    summary.textContent = mode + "检查时间：" + new Date(report.checkedAt).toLocaleString() +
      "；来源：" + (report.trigger === "startup" ? "插件启动" : report.trigger ? "手动检查" : "未记录") +
      "；最新阶段：" + (stages[report.stage] || report.stage) + "。";
    rows.replaceChildren();
    (report.checks || []).forEach(function (check) {
      const row = element("tr");
      [check.label, check.actual, check.required, labels[check.status] || check.status, check.remedy || "—"].forEach(function (value, index) {
        row.append(element("td", value, index === 3 ? "environment-result " + check.status : ""));
      });
      rows.append(row);
    });
    recovery.textContent = failed ? "修复后重新加载插件或新建聊天，启动入口将重新检查。刷新报告只读取最新结果，不会重启实例。" :
      "环境检查通过不代表当前聊天已加载工具；若工具仍不可用，请重新加载插件或新建聊天。";
    if (report.offlineDashboard) recovery.append(element("span", " 离线报告：" + report.offlineDashboard));
    historyRows.replaceChildren();
    (report.failures || []).slice().reverse().forEach(function (failure) {
      const text = new Date(failure.checkedAt).toLocaleString() + " · " + (stages[failure.stage] || failure.stage) + " · " +
        (failure.checks || []).map(function (check) { return check.label + "：" + check.actual; }).join("；");
      historyRows.append(element("p", text));
    });
    history.hidden = !(report.failures || []).length;
    if (data.mode !== "manager") {
      document.querySelectorAll(".metrics, .table-panel:not(#environmentPanel)").forEach(function (node) { node.hidden = true; });
      document.querySelector("#connectionText").textContent = data.mode === "offline" ? "离线诊断" : "仅诊断模式";
      document.querySelector("#connectionDot").className = "dot offline";
    }
    refresh.disabled = data.mode === "offline";
    refresh.title = data.mode === "offline" ? "重新运行环境检查后重新打开此文件" : "读取最新报告";
  }

  async function load() {
    if (window.environmentSnapshot) { render(window.environmentSnapshot); return; }
    try {
      const response = await fetch("/api/environment-report", { cache: "no-store" });
      if (!response.ok) throw new Error("报告读取失败");
      render(await response.json());
    } catch (_) {
      if (snapshot) summary.textContent = "报告服务不可用，以下为上次读取的结果；检查时间：" + new Date(snapshot.report.checkedAt).toLocaleString();
    }
  }
  refresh.addEventListener("click", load);
  load();
  if (!window.environmentSnapshot) setInterval(load, 5000);
})();
