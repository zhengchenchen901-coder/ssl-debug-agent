"use strict";
const element = (id) => document.getElementById(id);
const instanceId = new URL(window.location.href).searchParams.get("instanceId") || "";
const loginForm = element("loginForm");
let token = "", socket = null, terminal = null, fit = null, sessionPoll = null, ready = false;
let generation = 0, lastInputAt = 0;
element("loginInstance").textContent = instanceId || "未选择实例";
if (!instanceId) { element("loginMessage").textContent = "请从实例工作区点击“手动工作台”进入。"; element("loginButton").disabled = true; }

async function api(route, body) {
  const response = await fetch(route, { method: body === undefined ? "GET" : "POST", headers: {
    ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), credentials: "omit", cache: "no-store", redirect: "error" });
  const value = await response.json();
  if (!response.ok || !value.ok) {
    if (response.status === 401 && token) resetLogin("会话已失效，请重新登录。");
    throw Object.assign(new Error(value.error?.message || "请求失败，请稍后重试。"), { code: value.error?.code });
  }
  return value;
}

function setStatus(label, connected = false) {
  element("connectionStatus").textContent = label;
  element("connectionStatus").classList.toggle("connected", connected);
}
function disconnect() {
  generation++;
  ready = false;
  if (terminal) terminal.options.disableStdin = true;
  const previous = socket; socket = null;
  previous?.close();
  element("connectButton").disabled = !token;
  element("disconnectButton").disabled = true;
  setStatus("已断开");
  element("terminalHint").textContent = "已断开；重新连接将创建新的 Shell";
}
function resetLogin(message = "") {
  disconnect();
  window.ManualDatabase?.reset();
  resetRiskReview();
  token = "";
  clearInterval(sessionPoll);
  terminal?.dispose(); terminal = null; fit = null;
  element("workspace").hidden = true;
  element("loginPanel").hidden = false;
  element("logoutButton").hidden = true;
  element("loginMessage").textContent = message;
  loginForm.elements.password.value = "";
  loginForm.elements.username.focus();
}
function fitTerminal() {
  if (!terminal || element("workspace").hidden || element("sshWorkArea").hidden) return;
  fit.fit();
  if (ready && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
}
function createTerminal() {
  if (!window.Terminal || !window.FitAddon) throw new Error("终端组件未能加载，请刷新页面后重试。");
  terminal = new window.Terminal({ cursorBlink: true, fontSize: 13, lineHeight: 1.25, scrollback: 3000, disableStdin: true,
    fontFamily: 'Menlo, Monaco, Consolas, "Liberation Mono", monospace', theme: { background: "#1b252b", foreground: "#d8e6e7", cursor: "#80e0c1", selectionBackground: "#28443f" } });
  fit = new window.FitAddon.FitAddon();
  terminal.loadAddon(fit);
  terminal.open(element("terminal"));
  terminal.onData((data) => {
    if (!ready || socket?.readyState !== WebSocket.OPEN) return;
    lastInputAt = Date.now();
    for (let offset = 0; offset < data.length;) {
      let end = Math.min(data.length, offset + 8000);
      if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1])) end--;
      socket.send(JSON.stringify({ type: "input", data: data.slice(offset, end) }));
      offset = end;
    }
  });
  fitTerminal();
}

async function connect() {
  if (!token || socket) return;
  const currentGeneration = ++generation;
  element("connectButton").disabled = true;
  element("workMessage").textContent = "";
  setStatus("连接中");
  try {
    const { ticket } = await api("/api/terminal-ticket", {});
    if (generation !== currentGeneration || !token) return;
    const ws = new WebSocket(`${window.location.origin.replace(/^http/, "ws")}/terminal`);
    ws.binaryType = "arraybuffer";
    socket = ws;
    element("disconnectButton").disabled = false;
    ws.addEventListener("open", () => {
      if (socket !== ws) { ws.close(); return; }
      ws.send(JSON.stringify({ type: "authenticate", ticket, cols: terminal.cols, rows: terminal.rows }));
    });
    ws.addEventListener("message", (event) => {
      if (socket !== ws) return;
      if (event.data instanceof ArrayBuffer) {
        const bytes = event.data.byteLength;
        terminal.write(new Uint8Array(event.data), () => {
          if (socket === ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "output-ack", bytes }));
        });
        return;
      }
      const message = JSON.parse(event.data);
      if (message.type === "ready") {
        ready = true;
        lastInputAt = Date.now();
        terminal.options.disableStdin = false;
        setStatus("已连接", true);
        element("terminalHint").textContent = "SSH 交互式 Shell · 当前输入直接发送至服务器";
        fitTerminal(); terminal.focus();
      } else if (message.type === "error") element("workMessage").textContent = message.message;
    });
    ws.addEventListener("close", (event) => {
      if (socket !== ws) return;
      disconnect();
      if (event.code === 4001) resetLogin("会话已过期或实例配置已变化，请重新登录。");
    });
    ws.addEventListener("error", () => { if (socket === ws) element("workMessage").textContent = "终端连接中断，可重新连接。"; });
  } catch (error) {
    if (generation === currentGeneration) { disconnect(); element("workMessage").textContent = error.message; }
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  element("loginButton").disabled = true;
  element("loginMessage").textContent = "正在验证…";
  try {
    const password = loginForm.elements.password.value;
    loginForm.elements.password.value = "";
    const result = await api("/api/login", { username: loginForm.elements.username.value.trim(), password, instanceId });
    token = result.token;
    const target = result.target;
    element("instanceName").textContent = target.name;
    element("targetHost").textContent = `${target.host}:${target.port}`;
    element("targetUser").textContent = target.username;
    element("targetId").textContent = target.id;
    element("terminalTarget").textContent = `${target.username}@${target.host}`;
    element("workspace").hidden = false;
    element("loginPanel").hidden = true;
    element("logoutButton").hidden = false;
    window.ManualDatabase?.show("ssh");
    createTerminal();
    window.ManualDatabase?.loadConfig();
    lastInputAt = Date.now();
    sessionPoll = setInterval(() => {
      if (Date.now() - lastInputAt >= result.idleTimeoutMs) {
        api("/api/logout", {}).catch(() => {});
        resetLogin("会话因长时间未输入而退出，请重新登录。");
        return;
      }
      api("/api/session").then((state) => window.ManualDatabase?.check(state)).catch((error) => { element("workMessage").textContent = error.message; });
    }, 15_000);
    await connect();
  } catch (error) {
    const previousToken = token;
    if (previousToken) api("/api/logout", {}).catch(() => {});
    resetLogin(error.message);
  } finally { element("loginButton").disabled = !instanceId; }
});
element("connectButton").addEventListener("click", connect);
element("disconnectButton").addEventListener("click", disconnect);
element("clearButton").addEventListener("click", () => terminal?.clear());
element("logoutButton").addEventListener("click", async () => {
  const pending = api("/api/logout", {});
  resetLogin("已退出登录。");
  try { await pending; }
  catch { element("loginMessage").textContent = "本地登录已退出，服务端未响应；旧会话将按有效期退出。"; }
});
window.addEventListener("resize", fitTerminal);
window.addEventListener("pagehide", () => {
  if (token) fetch("/api/logout", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: "{}", keepalive: true, credentials: "omit", redirect: "error" }).catch(() => {});
  socket?.close(); window.ManualDatabase?.reset(); token = "";
});

let currentRiskReview = null;
const riskApi = () => element("riskStage").value === "execution" ? "/api/execution-risk/" : "/api/risk-replacement/";
const prepareRiskIntro = element("riskIntro").textContent, prepareRiskFooter = element("riskFooter").textContent;
element("riskStage").addEventListener("change", () => {
  const execution = element("riskStage").value === "execution";
  element("riskIntro").textContent = execution ? "原执行及历史在途事务结果仍未知。请核对原执行身份、精确文档和顺序、集合前置条件的变化，并明确接受迟到提交、重复及部分成功风险。本次审核独立于准备阶段审批。" : prepareRiskIntro;
  element("riskFooter").textContent = execution ? "批准只允许在同一导入中准备一个新的精确接续计划。原执行仍未知；此页面不会执行业务写入。接续计划准备后，仍须单独确认其精确范围及计划身份。" : prepareRiskFooter;
  currentRiskReview = null; element("riskDetails").textContent = ""; riskButtonState(); });
function resetRiskReview() {
  resetTerminationReview();
  currentRiskReview = null;
  element("riskDetails").textContent = "";
  element("riskAcknowledgement").checked = false;
  element("riskConfirmation").value = "";
  element("riskApprove").disabled = true;
  element("riskWorkArea").hidden = true;
  element("riskNav").classList.remove("active");
}
function renderRiskReview(plan) {
    element("riskPhrase").textContent = "确认语句：" + plan.confirmation;
    if (plan.kind === "import_execution") {
      element("riskDetails").textContent = JSON.stringify({
        审核阶段: "执行结果未知：独立人工风险接受", 绑定身份: plan.binding, 原执行已知事实: plan.knownExecution,
        原状态: plan.originalStatus, 历史结果: plan.historicalOutcome, 缺失证据: plan.missingEvidence, 唯一替代谱系: plan.lineage,
        原集合UUID: plan.originalCollectionIdentity, 当前集合UUID: plan.collectionIdentity, 前置条件读取来源: plan.prerequisiteSource,
        新批次: plan.mutationId, 新不可变计划: plan.planHash, 文档数: plan.documentCount,
        精确文档含类型及顺序: plan.orderedDocuments, 精确批次请求: plan.orderedRequest,
        剩余风险: plan.warning, 审核哈希: plan.reviewHash, 批准审计: plan.approvalAuditId,
        迟到机器观测: plan.lateObservation, 已观察到原执行精确提交回执: plan.lateOriginalCommitObserved,
        状态: plan.state, 到期时间: new Date(plan.expiresAt).toLocaleString()
      }, null, 2); return;
    }
    element("riskDetails").textContent = JSON.stringify({
      实例: plan.binding.instanceId, 数据库: plan.binding.database, 原意图: plan.binding.intentId, 任务类型: plan.kind || "bulk", 原任务: plan.binding.importId || plan.binding.jobId,
      原请求摘要: plan.binding.requestDigest, 原操作身份: plan.binding.originalOperationId,
      原计划哈希: plan.binding.planHash, 替代任务: plan.replacementImportId || plan.replacementJobId, 替代请求摘要: plan.replacementRequestDigest,
      业务效果摘要: plan.effectDigest, 文档数: plan.documentCount, 批次原子性: plan.atomicity, 原批次身份: plan.originalBatches, 重试批次身份: plan.replacementBatches, 单元数: plan.unitCount, 操作数: plan.operationCount, 集合: plan.collections,
      状态: plan.state, 历史结果: "未知", 全局撤权已有证明: plan.remoteFenceConfirmed,
      外部证明是否为批准前提: plan.approvalPolicy !== "human-risk-acceptance-v2",
      外部证明状态: plan.approvalPolicy === "human-risk-acceptance-v2" ? "不作为本次人工裁决的前提" : plan.fenceReason || null, 阻断回执: plan.fenceReceiptId || null,
      审核策略: plan.approvalPolicy, 审核说明: plan.reviewMemo, 说明来源: "调用者说明，未经独立验证",
      系统观测: plan.observations, 历史证据缺口: plan.historicalEvidenceGaps, 剩余风险: plan.warning, 旧任务状态: plan.originalTaskState,
      远端终止记录: plan.remoteTermination, 终止范围: "本系统后续调度及新版执行器；不保证召回历史已派发进程", 已派发旧进程结果: plan.legacyInFlightOutcome,
      人工批准: plan.humanApproved, 审阅哈希: plan.reviewHash, 到期时间: new Date(plan.expiresAt).toLocaleString()
    }, null, 2);
}
function riskButtonState() {
  element("riskApprove").disabled = !currentRiskReview?.canApprove || !element("riskAcknowledgement").checked ||
    element("riskConfirmation").value !== currentRiskReview.confirmation;
}
element("riskNav").addEventListener("click", () => {
  element("terminationWorkArea").hidden = true;
  element("terminationNav").classList.remove("active");
  element("sshWorkArea").hidden = true;
  element("databaseWorkArea").hidden = true;
  element("riskWorkArea").hidden = false;
  element("riskNav").classList.add("active");
  element("sshNav").classList.remove("active");
  element("databaseNav").classList.remove("active");
  lastInputAt = Date.now();
});
for (const id of ["sshNav", "databaseNav"]) element(id).addEventListener("click", () => {
  element("terminationWorkArea").hidden = true; element("terminationNav").classList.remove("active");
  element("riskWorkArea").hidden = true; element("riskNav").classList.remove("active");
});
element("riskPlanId").addEventListener("input", () => { currentRiskReview = null; riskButtonState(); });
element("riskAcknowledgement").addEventListener("change", riskButtonState);
element("riskConfirmation").addEventListener("input", riskButtonState);
element("riskLoad").addEventListener("click", async () => {
  currentRiskReview = null; riskButtonState(); element("riskMessage").textContent = "";
  element("riskAcknowledgement").checked = false; element("riskConfirmation").value = "";
  try {
    const plan = await api(riskApi() + "review", { riskPlanId: element("riskPlanId").value.trim() });
    currentRiskReview = plan;
    renderRiskReview(plan);
    element("riskMessage").textContent = plan.canApprove ? "请核对上方计划，再勾选风险确认并输入完整语句。" : "当前计划不可批准；请检查计划状态、有效期和是否已有替代任务。";
    lastInputAt = Date.now(); riskButtonState();
  } catch (error) { element("riskMessage").textContent = error.message; }
});
element("riskApprove").addEventListener("click", async () => {
  const plan = currentRiskReview;
  if (!plan || element("riskApprove").disabled) return;
  element("riskApprove").disabled = true;
  try {
    const approved = await api(riskApi() + "approve", { riskPlanId: plan.riskPlanId, reviewHash: plan.reviewHash,
      confirmation: element("riskConfirmation").value });
    currentRiskReview = approved;
    renderRiskReview(approved);
    element("riskMessage").textContent = plan.kind === "import_execution" ? "已独立接受本次执行未知风险。尚未执行业务写入；请通过结构化接续入口建立同一导入的唯一新计划，再单独确认新 mutationId/planHash。原执行仍未知。" : "此计划已获人工批准。原任务已关闭本机后续调度；下一步将记录远端终止并建立关联替代任务，尚未执行补分。";
    lastInputAt = Date.now();
  } catch (error) { currentRiskReview = null; element("riskMessage").textContent = error.message + " 请重新读取计划。"; }
  riskButtonState();
});

let currentTerminationReview = null;
let terminationBusy = false;
function resetTerminationReview() {
  currentTerminationReview = null;
  element("terminationWorkArea").hidden = true;
  element("terminationNav").classList.remove("active");
  element("terminationDetails").textContent = "";
  element("terminationMessage").textContent = "";
  element("terminationAcknowledgement").checked = false;
  element("terminationConfirmation").value = "";
  terminationButtonState();
}
function terminationButtonState() {
  element("terminationApprove").disabled = terminationBusy || !currentTerminationReview?.canApprove ||
    !element("terminationAcknowledgement").checked || element("terminationConfirmation").value !== currentTerminationReview.confirmation;
}
function setTerminationBusy(busy) {
  terminationBusy = busy;
  for (const id of ["terminationLoad", "terminationDatabase", "terminationJobId", "terminationPlanHash", "terminationReason", "terminationAcknowledgement", "terminationConfirmation"]) element(id).disabled = busy;
  terminationButtonState();
}
function renderTerminationReview(plan) {
  element("terminationDetails").textContent = JSON.stringify({
    实例: plan.instanceId, 数据库: plan.database, 任务: plan.jobId, 原计划哈希: plan.planHash,
    终止原因: plan.reason, 任务观测: plan.observations, 终止状态: plan.state,
    本地永久阻断: plan.managedAdmissionClosed, 远端终止记录: plan.remoteTermination,
    审核哈希: plan.reviewHash, 终止记录: plan.terminationId, 剩余风险: plan.warning,
    历史结果: plan.historicalOutcome, 已派发旧进程结果: plan.legacyInFlightOutcome,
    远端核验异常: plan.recoveryCode || null
  }, null, 2);
}
element("terminationNav").addEventListener("click", () => {
  for (const id of ["ssh", "database", "risk"]) {
    element(id + "WorkArea").hidden = true; element(id + "Nav").classList.remove("active");
  }
  element("terminationWorkArea").hidden = false;
  element("terminationNav").classList.add("active");
  lastInputAt = Date.now();
});
for (const id of ["terminationDatabase", "terminationJobId", "terminationPlanHash", "terminationReason"]) element(id).addEventListener("input", () => {
  currentTerminationReview = null; terminationButtonState();
});
for (const id of ["terminationAcknowledgement", "terminationConfirmation"]) element(id).addEventListener("input", terminationButtonState);
element("terminationLoad").addEventListener("click", async () => {
  if (terminationBusy) return;
  currentTerminationReview = null; terminationButtonState();
  element("terminationAcknowledgement").checked = false; element("terminationConfirmation").value = "";
  element("terminationDetails").textContent = ""; element("terminationMessage").textContent = "";
  const requestToken = token;
  setTerminationBusy(true);
  try {
    const plan = await api("/api/job-termination/review", {
      database: element("terminationDatabase").value.trim(), jobId: element("terminationJobId").value.trim(),
      planHash: element("terminationPlanHash").value.trim(), reason: element("terminationReason").value.trim()
    });
    if (token !== requestToken) return;
    currentTerminationReview = plan; renderTerminationReview(plan);
    element("terminationMessage").textContent = plan.state === "terminated_unknown" ? "此任务已永久终止，后续不再恢复。" : "请核对具体任务与影响，确认后完成系统身份验证。";
    lastInputAt = Date.now();
  } catch (error) { element("terminationMessage").textContent = error.message; }
  finally { setTerminationBusy(false); }
});
element("terminationApprove").addEventListener("click", async () => {
  const plan = currentTerminationReview;
  if (!plan || element("terminationApprove").disabled) return;
  const requestToken = token;
  setTerminationBusy(true);
  try {
    const result = await api("/api/job-termination/approve", { terminationId: plan.terminationId,
      reviewHash: plan.reviewHash, confirmation: element("terminationConfirmation").value });
    if (token !== requestToken) return;
    currentTerminationReview = result; renderTerminationReview(result);
    element("terminationAcknowledgement").checked = false; element("terminationConfirmation").value = "";
    element("terminationMessage").textContent = result.state === "terminated_unknown"
      ? "任务已永久终止，远端终止记录已核验。未回滚业务数据，未创建新任务。"
      : "本地已永久阻断，远端终止记录待核验。重新读取审核后可补齐终止记录；不会恢复业务执行。";
    lastInputAt = Date.now();
  } catch (error) { currentTerminationReview = null; element("terminationMessage").textContent = error.message + " 请重新读取终止状态。"; }
  finally { setTerminationBusy(false); }
});
