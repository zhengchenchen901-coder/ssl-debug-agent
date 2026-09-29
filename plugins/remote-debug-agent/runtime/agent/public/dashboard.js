const connectionDot = document.querySelector("#connectionDot");
const connectionText = document.querySelector("#connectionText");
const totalCount = document.querySelector("#totalCount");
const runningCount = document.querySelector("#runningCount");
const portRange = document.querySelector("#portRange");
const defaultInstance = document.querySelector("#defaultInstance");
const instanceRows = document.querySelector("#instanceRows");
const emptyState = document.querySelector("#emptyState");
const tableHint = document.querySelector("#tableHint");
const shutdownButton = document.querySelector("#shutdownButton");
const reloadButton = document.querySelector("#reloadButton");
const newButton = document.querySelector("#newButton");
const modalBackdrop = document.querySelector("#modalBackdrop");
const closeModalButton = document.querySelector("#closeModalButton");
const cancelModalButton = document.querySelector("#cancelModalButton");
const modalTitle = document.querySelector("#modalTitle");
const instanceForm = document.querySelector("#instanceForm");
const formMessage = document.querySelector("#formMessage");
const saveFormButton = instanceForm.querySelector('button[type="submit"]');
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

const memoryStatusLabels = {
  missing: "未初始化",
  initializing: "初始化中",
  ready: "已就绪",
  partial: "部分可用",
  failed: "初始化失败",
  stale: "目标已变化",
};

const state = {
  defaultInstanceId: "",
  lifecycle: null,
  manager: null,
  editingId: "",
  instances: [],
  online: false,
  pendingActions: new Set(),
  lastConnectionError: "",
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

function healthOf(runtime) {
  return runtime.health || {
    overall: runtime.status === "running" ? "unknown" : "stopped",
    transport: {},
    authentication: {},
    operations: {},
  };
}

function memoryOf(instance) {
  return instance.memory || { status: "missing", updatedAt: null, summary: {} };
}

function memoryStatusOf(memory) {
  return memory?.status || "missing";
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
  const raw = await response.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = {
      ok: false,
      error: {
        code: `HTTP_${response.status || "ERROR"}`,
        message: response.ok ? "响应不是有效 JSON" : `HTTP ${response.status}`,
      },
    };
  }
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
    state.lifecycle = data.lifecycle || null;
    state.manager = data.manager || null;
    state.online = true;
    state.lastConnectionError = "";
    setConnection("live", "主进程在线");
    render();
  } catch (error) {
    const message = error.message || "连接失败";
    state.online = false;
    state.lifecycle = null;
    state.manager = null;
    setConnection("offline", "主进程不可用");
    render();
    if (state.lastConnectionError !== message) {
      state.lastConnectionError = message;
      showToast(message);
    }
  }
}

function updateMetrics() {
  const running = state.instances.filter((instance) => runtimeOf(instance).status === "running");
  const range = state.manager?.workerPortRange;
  totalCount.textContent = state.instances.length;
  runningCount.textContent = state.online ? running.length : "--";
  portRange.textContent = range ? `${range.start}-${range.end}` : "--";
  defaultInstance.textContent = state.defaultInstanceId || "--";
  if (tableHint) {
    tableHint.textContent = state.online
      ? "管理本地 worker 与远端 SSH 连接"
      : "主进程不可用，保留上次实例状态供查看";
  }
  if (newButton) {
    newButton.disabled = !state.online;
    newButton.title = state.online ? "" : "主进程不可用";
  }
  if (saveFormButton) {
    saveFormButton.disabled = !state.online;
    saveFormButton.title = state.online ? "" : "主进程不可用";
  }
  if (shutdownButton) {
    shutdownButton.hidden = state.lifecycle?.lifetime !== "manual";
    shutdownButton.disabled = !state.online;
    shutdownButton.title = state.online ? "" : "主进程不可用";
  }
}

function statusLabel(status) {
  return statusLabels[status] || status;
}

function memoryStatusLabel(memory) {
  const status = memoryStatusOf(memory);
  return memoryStatusLabels[status] || status;
}

function statusPill(status) {
  const label = statusLabel(status);
  const pill = createElement(
    "span",
    `status-pill status-${state.online ? status : "stopped"}`,
    state.online ? label : `上次：${label}`,
  );
  if (!state.online) {
    pill.title = "主进程不可用，显示上次刷新状态";
  }
  return pill;
}

function memoryStatusPill(memory) {
  const status = memoryStatusOf(memory);
  const label = memoryStatusLabel(memory);
  const pill = createElement(
    "span",
    `status-pill memory-status-${status}`,
    state.online ? label : `缓存：${label}`,
  );
  if (!state.online) {
    pill.title = "主进程不可用，显示本地缓存的 Memory 状态";
  }
  return pill;
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

function actionKey(action, id) {
  return `${action}:${id}`;
}

function isActionPending(action, id) {
  return state.pendingActions.has(actionKey(action, id));
}

function setActionPending(action, id, pending) {
  const key = actionKey(action, id);
  if (pending) {
    state.pendingActions.add(key);
  } else {
    state.pendingActions.delete(key);
  }
  render();
}

function renderRow(instance) {
  const runtime = runtimeOf(instance);
  const health = healthOf(runtime);
  const transportHealth = health.transport || {};
  const operationHealth = health.operations || {};
  const canUseManager = state.online;
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
  const statusMain = createElement("div", "cell-main");
  statusMain.append(
    statusPill(runtime.status || "stopped"),
    createElement("span", "mono", `SSH ${text(transportHealth.status)}`),
    createElement(
      "span",
      "mono",
      `active ${text(operationHealth.active, "0")} / queued ${text(operationHealth.queued, "0")}`,
    ),
    createElement("span", "mono", `reconnects ${text(transportHealth.reconnectCount, "0")}`),
  );
  status.append(statusMain);

  const memoryInfo = memoryOf(instance);
  const memory = createElement("td");
  const memoryMain = createElement("div", "cell-main");
  memoryMain.append(memoryStatusPill(memoryInfo));
  memoryMain.append(createElement("span", "", formatClock(memoryInfo.updatedAt)));
  memory.append(memoryMain);

  const worker = createElement("td");
  const workerMain = createElement("div", "cell-main");
  workerMain.append(createElement("span", "mono", `port ${text(runtime.workerPort)}`));
  workerMain.append(createElement("span", "mono", `pid ${text(runtime.pid)}`));
  worker.append(workerMain);

  const heartbeat = createElement("td", "", formatClock(runtime.lastHeartbeatAt));
  const recentError = runtime.lastError || transportHealth.lastError;
  const error = createElement(
    "td",
    recentError ? "cell-main" : "muted",
    recentError ? `${recentError.code || "ERROR"}: ${recentError.message || ""}` : "--",
  );

  const actions = createElement("td");
  const actionWrap = createElement("div", "record-actions");
  const view = button("查看", "view", instance);
  const edit = button("编辑", "edit", instance);
  edit.disabled = !canUseManager;
  edit.title = canUseManager ? "" : "主进程不可用";
  const startLoading = isActionPending("start", instance.id) || runtime.status === "starting";
  const start = button(startLoading ? "启动中" : "启动", "start", instance);
  start.disabled = !canUseManager || startLoading || runtime.status === "running";
  start.title = canUseManager ? "" : "主进程不可用";
  start.classList.toggle("is-loading", startLoading);
  start.setAttribute("aria-busy", String(startLoading));
  const stopLoading = isActionPending("stop", instance.id) || runtime.status === "stopping";
  const stop = button(stopLoading ? "停止中" : "停止", "stop", instance);
  stop.disabled = !canUseManager || stopLoading || runtime.status === "stopped" || (!runtime.pid && !runtime.workerPort);
  stop.title = canUseManager ? "" : "主进程不可用";
  stop.classList.toggle("is-loading", stopLoading);
  stop.setAttribute("aria-busy", String(stopLoading));
  const deleteButton = button("删除", "delete", instance, "button danger");
  deleteButton.disabled = !canUseManager;
  deleteButton.title = canUseManager ? "" : "主进程不可用";
  const refresh = button("重新加载配置", "refresh", instance);
  refresh.disabled = !canUseManager;
  refresh.title = canUseManager ? "" : "主进程不可用";
  actionWrap.append(
    view,
    edit,
    start,
    stop,
    deleteButton,
    refresh,
  );
  actions.append(actionWrap);

  row.append(name, target, user, ssh, status, memory, worker, heartbeat, error, actions);
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
  const mongodb = instance?.mongodb;
  document.querySelector("#mongodbPermissions").disabled = !mongodb;
  document.querySelector("#mongodbHint").textContent = mongodb
    ? "仅修改当前实例的写入权限，保留已有连接配置。"
    : "当前实例尚未配置 MongoDB 连接，请先在实例配置文件中配置连接，再设置写入权限。";
  instanceForm.elements.mongodbWriteEnabled.checked = Boolean(mongodb?.writeEnabled || mongodb?.mutationsEnabled);
  mongoOptionsGeneration++;
  document.querySelector("#mongodbCollectionSearch").value = "";
  setMongoOptions(instanceForm.elements.mongodbAllowedDatabases, [], mongodb?.allowedDatabases || []);
  setMongoOptions(instanceForm.elements.mongodbAllowedCollections, [], mongodb?.allowedCollections || []);
  document.querySelector("#mongodbOptionsStatus").textContent = "";
}

let mongoOptionsGeneration = 0;
let mongoCollectionOptions = [];
let mongoCollectionSelection = new Set();

function selectedMongoNames(select) {
  if (select === instanceForm.elements.mongodbAllowedCollections) {
    for (const option of select.children) {
      if (option.selected) mongoCollectionSelection.add(option.value);
      else mongoCollectionSelection.delete(option.value);
    }
    return [...mongoCollectionSelection];
  }
  return Array.from(select.selectedOptions, (option) => option.value);
}

function setMongoOptions(select, names, selected) {
  const available = new Set(names);
  if (select === instanceForm.elements.mongodbAllowedCollections) {
    mongoCollectionOptions = [...new Set([...names, ...selected])].sort().map((name) => ({
      name, label: available.has(name) ? name : `${name}（已保存/已选）`,
    }));
    mongoCollectionSelection = new Set(selected);
    renderMongoCollectionOptions();
    return;
  }
  select.replaceChildren(...[...new Set([...names, ...selected])].sort().map((name) => {
    const option = createElement("option", "", available.has(name) ? name : `${name}（已保存/已选）`);
    option.value = name;
    option.selected = selected.includes(name);
    return option;
  }));
}

function renderMongoCollectionOptions() {
  const query = document.querySelector("#mongodbCollectionSearch").value.trim().toLowerCase();
  const matches = mongoCollectionOptions.filter((item) => item.name.toLowerCase().includes(query));
  instanceForm.elements.mongodbAllowedCollections.replaceChildren(...matches.map(({ name, label }) => {
    const option = createElement("option", "", label);
    option.value = name;
    option.selected = mongoCollectionSelection.has(name);
    return option;
  }));
  updateMongoCollectionStatus();
}

function updateMongoCollectionStatus() {
  const count = instanceForm.elements.mongodbAllowedCollections.children.length;
  const query = document.querySelector("#mongodbCollectionSearch").value.trim();
  document.querySelector("#mongodbCollectionSearchStatus").textContent =
    `${query && !count ? "没有匹配的集合。" : ""}显示 ${count} / ${mongoCollectionOptions.length} 个集合，已选 ${mongoCollectionSelection.size} 个。`;
}

function filterMongoCollections() {
  selectedMongoNames(instanceForm.elements.mongodbAllowedCollections);
  renderMongoCollectionOptions();
}

async function loadMongoOptions(collectionsOnly = false) {
  const instanceId = state.editingId;
  if (!findInstance(instanceId)?.mongodb) return;
  const generation = ++mongoOptionsGeneration;
  const isCurrent = () => generation === mongoOptionsGeneration && state.editingId === instanceId;
  const status = document.querySelector("#mongodbOptionsStatus");
  const databases = instanceForm.elements.mongodbAllowedDatabases;
  const collections = instanceForm.elements.mongodbAllowedCollections;
  status.textContent = "正在通过当前实例只读加载选项…";
  const readNames = async (operation, database) => {
    const names = new Set();
    for (let skip = 0; skip < 10000; skip += 500) {
      const result = await api("/mongodb/query", {
        method: "POST",
        body: JSON.stringify({ instanceId, operation, ...(database ? { database } : {}), limit: 500, skip }),
      });
      if (!isCurrent()) return [];
      const items = operation === "listDatabases" ? result.data?.databases || [] : result.data || [];
      const previousCount = names.size;
      for (const item of items) names.add(item.name);
      if (items.length < 500) return [...names];
      if (names.size === previousCount) throw new Error("当前 worker 尚不支持分批读取，请重新加载实例配置后重试");
    }
    throw new Error("名称数量超过 10000 项读取上限");
  };
  try {
    if (!collectionsOnly) {
      const names = await readNames("listDatabases");
      if (!isCurrent()) return;
      setMongoOptions(databases, names, selectedMongoNames(databases));
    }
    const selectedDatabases = selectedMongoNames(databases);
    const names = [];
    for (const database of selectedDatabases) {
      const items = await readNames("listCollections", database);
      if (!isCurrent()) return;
      names.push(...items);
    }
    if (!isCurrent()) return;
    setMongoOptions(collections, names, selectedMongoNames(collections));
    status.textContent = selectedDatabases.length
      ? "选项已读取。"
      : "请先选择数据库，再加载集合选项。";
  } catch (error) {
    if (isCurrent()) status.textContent = `读取失败：${error.message}。已保留当前选择，可重新读取。`;
  }
}

function openModal(instance = null) {
  resetForm(instance);
  modalBackdrop.hidden = false;
  instanceForm.elements.name.focus();
  void loadMongoOptions();
}

function closeModal() {
  mongoOptionsGeneration++;
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
  const mongodb = findInstance(state.editingId)?.mongodb;
  if (mongodb) {
    const writeEnabled = form.mongodbWriteEnabled.checked;
    const allowedDatabases = selectedMongoNames(form.mongodbAllowedDatabases);
    const allowedCollections = selectedMongoNames(form.mongodbAllowedCollections);
    const changes = {};
    if (writeEnabled !== Boolean(mongodb.writeEnabled || mongodb.mutationsEnabled)) {
      changes.writeEnabled = writeEnabled;
      // The legacy alias also enables writes; disabling must turn both off.
      if (mongodb.mutationsEnabled !== undefined) changes.mutationsEnabled = false;
    }
    for (const [key, values] of Object.entries({ allowedDatabases, allowedCollections })) {
      if (JSON.stringify([...values].sort()) !== JSON.stringify([...(mongodb[key] || [])].sort())) {
        if (!values.length) throw new Error("已有白名单不可清空；如需停止写入，请关闭写入开关。");
        changes[key] = values;
      }
    }
    if (Object.keys(changes).length) {
      if (writeEnabled && (!allowedDatabases.length || !allowedCollections.length)) {
        throw new Error("允许写入时，请填写允许的数据库和集合。");
      }
      payload.mongodb = changes;
    }
  }
  return payload;
}

async function submitForm(event) {
  event.preventDefault();
  formMessage.textContent = "";
  if (!state.online) {
    formMessage.textContent = "主进程不可用，恢复后再保存";
    return;
  }
  try {
    const payload = formPayload();
    if (state.editingId) {
      await api(`/api/instances/${encodeURIComponent(state.editingId)}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      showToast("实例已保存，运行中的实例请点击行内“重新加载配置”生效");
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

function compactOverview(items) {
  const parts = items
    .map(([label, value]) => [label, text(value, "")])
    .filter(([, value]) => value)
    .map(([label, value]) => `${label}: ${value}`);
  return parts.length > 0 ? parts.join(" / ") : "--";
}

function compactPathList(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return "--";
  }
  const visible = values.slice(0, 3).map((value) => String(value));
  if (values.length > visible.length) {
    visible.push(`等 ${values.length} 项`);
  }
  return visible.join("，");
}

function openDrawer(instance) {
  const runtime = runtimeOf(instance);
  const health = healthOf(runtime);
  const transportHealth = health.transport || {};
  const authenticationHealth = health.authentication || {};
  const operationHealth = health.operations || {};
  const memory = memoryOf(instance);
  const memorySummary = memory.summary || {};
  const resources = memorySummary.resources || {};
  const services = memorySummary.services || {};
  drawerTitle.textContent = instance.name;
  const details = createElement("section", "detail-list");
  details.append(
    detailRow("实例 ID", instance.id),
    detailRow("目标", targetLabel(instance)),
    detailRow("用户名", instance.username),
    detailRow("私钥路径", instance.privateKeyPath),
    detailRow("私钥口令", instance.hasPassphrase ? "已配置" : "未配置"),
    detailRow("审计日志", instance.auditLog || "默认"),
    detailRow("状态", state.online ? statusLabel(runtime.status) : `上次：${statusLabel(runtime.status)}`),
    detailRow("Worker 端口", runtime.workerPort),
    detailRow("进程 ID", runtime.pid),
    detailRow("最近心跳", formatClock(runtime.lastHeartbeatAt)),
    detailRow("最近错误", runtime.lastError ? `${runtime.lastError.code}: ${runtime.lastError.message}` : "--"),
    detailRow("Memory 状态", state.online ? memoryStatusLabel(memory) : `缓存：${memoryStatusLabel(memory)}`),
    detailRow("Memory 更新时间", formatClock(memory.updatedAt)),
    detailRow("系统摘要", memorySummary.system),
    detailRow("资源概览", compactOverview([["磁盘", resources.disk], ["内存", resources.memory]])),
    detailRow("服务概览", compactOverview([["nginx", services.nginx], ["mongod", services.mongod], ["pm2", services.pm2]])),
    detailRow("配置路径", compactPathList(memorySummary.configPaths)),
    detailRow("日志路径", compactPathList(memorySummary.logPaths)),
  );

  details.append(
    detailRow("Health overall", health.overall),
    detailRow("SSH transport", transportHealth.status),
    detailRow("SSH generation", transportHealth.generation),
    detailRow("SSH reconnects", transportHealth.reconnectCount),
    detailRow("SSH next retry", formatClock(transportHealth.nextRetryAt)),
    detailRow("Authentication", authenticationHealth.status),
    detailRow("Active operations", operationHealth.active),
    detailRow("Queued operations", operationHealth.queued),
    detailRow("Active SSH channels", operationHealth.activeChannels),
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

const managerActions = new Set(["edit", "delete", "start", "stop", "refresh"]);

async function runAction(action, id) {
  const instance = findInstance(id);
  if (!instance) {
    return;
  }

  if (!state.online && managerActions.has(action)) {
    showToast("主进程不可用，恢复后再操作");
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
    stop: `/api/instances/${encodeURIComponent(id)}/stop`,
    delete: `/api/instances/${encodeURIComponent(id)}`,
    refresh: `/api/instances/${encodeURIComponent(id)}/refresh`,
  };
  const method = action === "delete" ? "DELETE" : "POST";

  try {
    setActionPending(action, id, true);
    await api(routeByAction[action], { method });
    showToast(action === "stop" ? "实例已停止" : "操作已完成");
  } catch (error) {
    showToast(`${error.code || "ERROR"}: ${error.message}`);
  } finally {
    try {
      await loadInstances();
    } finally {
      setActionPending(action, id, false);
    }
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
document.querySelector("#reloadMongoOptions").addEventListener("click", () => loadMongoOptions());
instanceForm.elements.mongodbAllowedDatabases.addEventListener("change", () => loadMongoOptions(true));
document.querySelector("#mongodbCollectionSearch").addEventListener("input", filterMongoCollections);
document.querySelector("#mongodbCollectionSearch").addEventListener("keydown", (event) => {
  if (event.key === "Enter") event.preventDefault();
});
instanceForm.elements.mongodbAllowedCollections.addEventListener("change", () => {
  selectedMongoNames(instanceForm.elements.mongodbAllowedCollections);
  updateMongoCollectionStatus();
});
newButton.addEventListener("click", () => openModal());
shutdownButton?.addEventListener("click", async () => {
  if (!state.online) {
    showToast("主进程不可用，恢复后再操作");
    return;
  }
  if (!window.confirm("关闭 Manager 会停止所有 worker，并断开当前 dashboard。确定关闭吗？")) {
    return;
  }

  try {
    shutdownButton.disabled = true;
    await api("/api/shutdown", { method: "POST" });
    showToast("Manager 正在关闭");
    setConnection("offline", "主进程正在关闭");
  } catch (error) {
    shutdownButton.disabled = false;
    showToast(`${error.code || "ERROR"}: ${error.message}`);
  }
});
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
