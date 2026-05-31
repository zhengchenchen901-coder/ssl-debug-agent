const connectionDot = document.querySelector("#connectionDot");
const connectionText = document.querySelector("#connectionText");
const totalCount = document.querySelector("#totalCount");
const runningCount = document.querySelector("#runningCount");
const portRange = document.querySelector("#portRange");
const defaultInstance = document.querySelector("#defaultInstance");
const instanceRows = document.querySelector("#instanceRows");
const emptyState = document.querySelector("#emptyState");
const reloadButton = document.querySelector("#reloadButton");
const newButton = document.querySelector("#newButton");
const modalBackdrop = document.querySelector("#modalBackdrop");
const closeModalButton = document.querySelector("#closeModalButton");
const cancelModalButton = document.querySelector("#cancelModalButton");
const modalTitle = document.querySelector("#modalTitle");
const instanceForm = document.querySelector("#instanceForm");
const formMessage = document.querySelector("#formMessage");
const drawer = document.querySelector("#drawer");
const drawerMask = document.querySelector("#drawerMask");
const closeDrawerButton = document.querySelector("#closeDrawerButton");
const drawerTitle = document.querySelector("#drawerTitle");
const drawerBody = document.querySelector("#drawerBody");
const toast = document.querySelector("#toast");

const statusLabels = {
  running: "运行中",
  starting: "启动中",
  stopping: "停止中",
  stopped: "已停止",
  unhealthy: "不健康",
};

const state = {
  defaultInstanceId: "",
  manager: null,
  editingId: "",
  instances: [],
  toastTimer: null,
};

function text(value, fallback = "--") {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return String(value);
}

function createElement(tag, className, content) {
  const element = document.createElement(tag);
  if (className) {
    element.className = className;
  }
  if (content !== undefined) {
    element.textContent = content;
  }
  return element;
}

function setConnection(status, label) {
  connectionDot.className = `dot ${status}`;
  connectionText.textContent = label;
}

function targetLabel(instance) {
  return `${instance.host}:${instance.port || 22}`;
}

function runtimeOf(instance) {
  return instance.runtime || { status: "stopped" };
}

function formatClock(value) {
  if (!value) {
    return "--";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--";
  }
  return date.toLocaleString([], {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function showToast(message) {
  clearTimeout(state.toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  state.toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 2400);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) {
    const error = new Error(data.error?.message || `HTTP ${response.status}`);
    error.code = data.error?.code || "REQUEST_FAILED";
    throw error;
  }
  return data;
}

async function loadInstances() {
  try {
    const data = await api("/api/instances", { cache: "no-store" });
    state.instances = data.instances || [];
    state.defaultInstanceId = data.defaultInstanceId || "";
    state.manager = data.manager || null;
    setConnection("live", "主进程在线");
    render();
  } catch (error) {
    setConnection("offline", "主进程不可用");
    showToast(error.message);
  }
}

function updateMetrics() {
  const running = state.instances.filter((instance) => runtimeOf(instance).status === "running");
  const range = state.manager?.workerPortRange;
  totalCount.textContent = state.instances.length;
  runningCount.textContent = running.length;
  portRange.textContent = range ? `${range.start}-${range.end}` : "--";
  defaultInstance.textContent = state.defaultInstanceId || "--";
}

function statusPill(status) {
  return createElement("span", `status-pill status-${status}`, statusLabels[status] || status);
}

function button(label, action, instance, className = "button") {
  const item = document.createElement("button");
  item.type = "button";
  item.className = className;
  item.dataset.action = action;
  item.dataset.id = instance.id;
  item.textContent = label;
  return item;
}

function renderRow(instance) {
  const runtime = runtimeOf(instance);
  const row = document.createElement("tr");

  const name = createElement("td");
  const nameMain = createElement("div", "cell-main");
  nameMain.append(createElement("strong", "", instance.name));
  nameMain.append(createElement("span", "mono", instance.id));
  name.append(nameMain);

  const target = createElement("td");
  const targetMain = createElement("div", "cell-main");
  targetMain.append(createElement("strong", "", targetLabel(instance)));
  targetMain.append(createElement("span", "", instance.enabled ? "已启用" : "已禁用"));
  target.append(targetMain);

  const user = createElement("td", "", text(instance.username));
  const ssh = createElement("td", "mono", String(instance.port || 22));
  const status = createElement("td");
  status.append(statusPill(runtime.status || "stopped"));

  const worker = createElement("td");
  const workerMain = createElement("div", "cell-main");
  workerMain.append(createElement("span", "mono", `port ${text(runtime.workerPort)}`));
  workerMain.append(createElement("span", "mono", `pid ${text(runtime.pid)}`));
  worker.append(workerMain);

  const heartbeat = createElement("td", "", formatClock(runtime.lastHeartbeatAt));
  const error = createElement(
    "td",
    runtime.lastError ? "cell-main" : "muted",
    runtime.lastError ? `${runtime.lastError.code || "ERROR"}: ${runtime.lastError.message || ""}` : "--",
  );

  const actions = createElement("td");
  const actionWrap = createElement("div", "record-actions");
  const start = button("启动", "start", instance);
  start.disabled = ["running", "starting"].includes(runtime.status);
  actionWrap.append(
    button("查看", "view", instance),
    button("编辑", "edit", instance),
    start,
    button("暂停", "pause", instance),
    button("删除", "delete", instance, "button danger"),
    button("刷新", "refresh", instance),
  );
  actions.append(actionWrap);

  row.append(name, target, user, ssh, status, worker, heartbeat, error, actions);
  return row;
}

function render() {
  updateMetrics();
  instanceRows.replaceChildren(...state.instances.map(renderRow));
  emptyState.hidden = state.instances.length > 0;
}

function findInstance(id) {
  return state.instances.find((instance) => instance.id === id);
}

function resetForm(instance) {
  instanceForm.reset();
  formMessage.textContent = "";
  state.editingId = instance?.id || "";
  modalTitle.textContent = instance ? "编辑实例" : "新建实例";
  instanceForm.elements.id.disabled = Boolean(instance);
  instanceForm.elements.id.value = instance?.id || "";
  instanceForm.elements.name.value = instance?.name || "";
  instanceForm.elements.host.value = instance?.host || "";
  instanceForm.elements.port.value = instance?.port || 22;
  instanceForm.elements.username.value = instance?.username || "";
  instanceForm.elements.privateKeyPath.value = instance?.privateKeyPath || "";
  instanceForm.elements.passphrase.value = "";
  instanceForm.elements.preferredWorkerPort.value = instance?.preferredWorkerPort || "";
  instanceForm.elements.auditLog.value = instance?.auditLog || "";
  instanceForm.elements.enabled.checked = instance ? Boolean(instance.enabled) : true;
  instanceForm.elements.approvedCommandsEnabled.checked = Boolean(instance?.approvedCommands?.enabled);
}

function openModal(instance = null) {
  resetForm(instance);
  modalBackdrop.hidden = false;
  instanceForm.elements.name.focus();
}

function closeModal() {
  modalBackdrop.hidden = true;
}

function formPayload() {
  const form = instanceForm.elements;
  const payload = {
    id: form.id.value.trim(),
    name: form.name.value.trim(),
    host: form.host.value.trim(),
    port: form.port.value,
    username: form.username.value.trim(),
    privateKeyPath: form.privateKeyPath.value.trim(),
    passphrase: form.passphrase.value,
    preferredWorkerPort: form.preferredWorkerPort.value,
    auditLog: form.auditLog.value.trim(),
    enabled: form.enabled.checked,
    approvedCommands: {
      enabled: form.approvedCommandsEnabled.checked,
    },
  };

  if (state.editingId) {
    delete payload.id;
  }
  if (!payload.passphrase) {
    delete payload.passphrase;
  }
  if (!payload.preferredWorkerPort) {
    delete payload.preferredWorkerPort;
  }
  if (!payload.auditLog) {
    delete payload.auditLog;
  }
  return payload;
}

async function submitForm(event) {
  event.preventDefault();
  formMessage.textContent = "";
  const payload = formPayload();
  try {
    if (state.editingId) {
      await api(`/api/instances/${encodeURIComponent(state.editingId)}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      showToast("实例已更新，运行中的实例需要刷新后生效");
    } else {
      await api("/api/instances", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      showToast("实例已创建");
    }
    closeModal();
    await loadInstances();
  } catch (error) {
    formMessage.textContent = `${error.code || "ERROR"}: ${error.message}`;
  }
}

function detailRow(label, value) {
  const row = createElement("div", "detail-row");
  row.append(createElement("span", "", label));
  row.append(createElement("strong", "", text(value)));
  return row;
}

function openDrawer(instance) {
  const runtime = runtimeOf(instance);
  drawerTitle.textContent = instance.name;
  const details = createElement("section", "detail-list");
  details.append(
    detailRow("实例 ID", instance.id),
    detailRow("目标", targetLabel(instance)),
    detailRow("用户名", instance.username),
    detailRow("私钥路径", instance.privateKeyPath),
    detailRow("私钥口令", instance.hasPassphrase ? "已配置" : "未配置"),
    detailRow("审计日志", instance.auditLog || "默认"),
    detailRow("状态", statusLabels[runtime.status] || runtime.status),
    detailRow("Worker 端口", runtime.workerPort),
    detailRow("进程 ID", runtime.pid),
    detailRow("最近心跳", formatClock(runtime.lastHeartbeatAt)),
    detailRow("最近错误", runtime.lastError ? `${runtime.lastError.code}: ${runtime.lastError.message}` : "--"),
  );

  const eventList = createElement("section", "event-list");
  const events = runtime.events || [];
  if (events.length === 0) {
    eventList.append(createElement("div", "muted", "暂无运行事件"));
  } else {
    for (const item of events.slice().reverse()) {
      eventList.append(
        createElement(
          "div",
          "event-item",
          `${formatClock(item.time)} · ${item.type}${item.reason ? ` · ${item.reason}` : ""}`,
        ),
      );
    }
  }

  drawerBody.replaceChildren(details, createElement("h2", "", "最近事件"), eventList);
  drawer.hidden = false;
  drawerMask.hidden = false;
}

function closeDrawer() {
  drawer.hidden = true;
  drawerMask.hidden = true;
}

async function runAction(action, id) {
  const instance = findInstance(id);
  if (!instance) {
    return;
  }

  if (action === "view") {
    openDrawer(instance);
    return;
  }
  if (action === "edit") {
    openModal(instance);
    return;
  }
  if (action === "delete" && !window.confirm(`删除实例 ${instance.name}？`)) {
    return;
  }

  const routeByAction = {
    start: `/api/instances/${encodeURIComponent(id)}/start`,
    pause: `/api/instances/${encodeURIComponent(id)}/pause`,
    delete: `/api/instances/${encodeURIComponent(id)}`,
    refresh: `/api/instances/${encodeURIComponent(id)}/refresh`,
  };
  const method = action === "delete" ? "DELETE" : "POST";

  try {
    await api(routeByAction[action], { method });
    showToast(action === "pause" ? "暂停功能后续支持" : "操作已完成");
  } catch (error) {
    showToast(`${error.code || "ERROR"}: ${error.message}`);
  } finally {
    await loadInstances();
  }
}

instanceRows.addEventListener("click", (event) => {
  const target = event.target.closest("button[data-action]");
  if (!target) {
    return;
  }
  runAction(target.dataset.action, target.dataset.id);
});

reloadButton.addEventListener("click", loadInstances);
newButton.addEventListener("click", () => openModal());
closeModalButton.addEventListener("click", closeModal);
cancelModalButton.addEventListener("click", closeModal);
modalBackdrop.addEventListener("click", (event) => {
  if (event.target === modalBackdrop) {
    closeModal();
  }
});
instanceForm.addEventListener("submit", submitForm);
closeDrawerButton.addEventListener("click", closeDrawer);
drawerMask.addEventListener("click", closeDrawer);

loadInstances();
setInterval(loadInstances, 5000);
