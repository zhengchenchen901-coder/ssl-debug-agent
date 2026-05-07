const connectionDot = document.querySelector("#connectionDot");
const connectionText = document.querySelector("#connectionText");
const targetHost = document.querySelector("#targetHost");
const lastSource = document.querySelector("#lastSource");
const totalCount = document.querySelector("#totalCount");
const errorCount = document.querySelector("#errorCount");
const allowedPaths = document.querySelector("#allowedPaths");
const timeoutLimit = document.querySelector("#timeoutLimit");
const outputLimit = document.querySelector("#outputLimit");
const lastEvent = document.querySelector("#lastEvent");
const timeline = document.querySelector("#timeline");
const emptyState = document.querySelector("#emptyState");
const filters = document.querySelector("#filters");
const pauseButton = document.querySelector("#pauseButton");
const clearButton = document.querySelector("#clearButton");

const toolLabels = {
  run: "命令",
  "read-file": "文件",
  "list-dir": "目录",
};

const statusLabels = {
  running: "进行中",
  completed: "成功",
  failed: "失败",
};

const state = {
  clearedAt: "",
  filter: "all",
  operations: new Map(),
  paused: false,
  seenEvents: new Set(),
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

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return "--";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) {
    return "--";
  }
  return `${ms} ms`;
}

function formatClock(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--";
  }

  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function targetLabel(target) {
  if (!target?.host) {
    return "未配置";
  }

  const user = target.username ? `${target.username}@` : "";
  return `${user}${target.host}:${target.port || 22}`;
}

function setConnection(status, label) {
  connectionDot.className = `dot ${status}`;
  connectionText.textContent = label;
}

function setAllowedPaths(paths) {
  allowedPaths.replaceChildren();
  const items = Array.isArray(paths) && paths.length > 0 ? paths : ["未配置"];

  for (const item of items) {
    allowedPaths.append(createElement("li", "", item));
  }
}

async function loadStatus() {
  try {
    const response = await fetch("/status", { cache: "no-store" });
    const data = await response.json();
    targetHost.textContent = targetLabel(data.target);
    setAllowedPaths(data.security?.allowedPaths);
    timeoutLimit.textContent = formatDuration(data.security?.maxTimeoutMs);
    outputLimit.textContent = formatBytes(data.security?.maxCommandOutputBytes);
  } catch {
    setConnection("offline", "状态不可用");
  }
}

function ensureOperation(event) {
  let operation = state.operations.get(event.operationId);
  if (!operation) {
    operation = {
      error: null,
      events: [],
      operationId: event.operationId,
      request: event.request || {},
      result: null,
      source: event.source,
      startedAt: event.time,
      status: "running",
      stderrChunks: [],
      stdoutChunks: [],
      target: event.target,
      tool: event.tool,
      updatedAt: event.time,
    };
    state.operations.set(event.operationId, operation);
  }

  return operation;
}

function applyEvent(event) {
  if (!event?.operationId || event.time < state.clearedAt || state.seenEvents.has(event.id)) {
    return;
  }

  state.seenEvents.add(event.id);
  const operation = ensureOperation(event);
  operation.events.push(event);
  operation.updatedAt = event.time;
  operation.source = event.source || operation.source;
  operation.target = event.target || operation.target;
  operation.request = event.request || operation.request;

  if (event.stage === "stdout") {
    operation.stdoutChunks.push(event.chunk || "");
  } else if (event.stage === "stderr") {
    operation.stderrChunks.push(event.chunk || "");
  } else if (event.stage === "completed") {
    operation.status = "completed";
    operation.result = event.result || null;
  } else if (event.stage === "failed") {
    operation.status = "failed";
    operation.error = event.error || null;
    operation.result = { durationMs: event.durationMs };
  } else {
    operation.status = operation.status === "completed" ? "completed" : "running";
  }

  updateSummary();
  if (!state.paused) {
    render();
  }
}

function updateSummary() {
  const operations = [...state.operations.values()];
  totalCount.textContent = operations.length;
  errorCount.textContent = operations.filter((operation) => operation.status === "failed").length;

  const latest = [...operations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (latest) {
    lastSource.textContent = latest.source || "--";
    lastEvent.textContent = `${toolLabels[latest.tool] || latest.tool} ${statusLabels[latest.status]}`;
  } else {
    lastSource.textContent = "--";
    lastEvent.textContent = "等待插件调用";
  }
}

function visibleOperations() {
  return [...state.operations.values()]
    .filter((operation) => {
      if (state.filter === "all") {
        return true;
      }
      if (state.filter === "failed") {
        return operation.status === "failed";
      }
      return operation.tool === state.filter;
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function operationTitle(operation) {
  if (operation.tool === "run") {
    return operation.request?.cmd || "命令调用";
  }
  return operation.request?.path || "远端路径";
}

function metaItem(label, value) {
  const wrapper = createElement("div", "meta-item");
  wrapper.append(createElement("span", "", label));
  wrapper.append(createElement("strong", "", value));
  return wrapper;
}

function resultMetric(operation) {
  const result = operation.result;
  if (operation.status === "failed") {
    return operation.error?.code || "ERROR";
  }
  if (operation.tool === "run") {
    return result ? `exit ${text(result.exitCode, "null")}` : "运行中";
  }
  if (operation.tool === "read-file") {
    return result ? formatBytes(result.contentLength) : "读取中";
  }
  if (operation.tool === "list-dir") {
    return result ? `${result.entryCount} 项` : "读取中";
  }
  return "--";
}

function buildOutput(operation) {
  if (operation.tool === "run") {
    const stdout = operation.stdoutChunks.join("") || operation.result?.stdoutPreview || "";
    const stderr = operation.stderrChunks.join("") || operation.result?.stderrPreview || "";
    const sections = [];
    if (stdout) {
      sections.push(`[stdout]\n${stdout}`);
    }
    if (stderr) {
      sections.push(`[stderr]\n${stderr}`);
    }
    return sections.join("\n\n");
  }

  if (operation.tool === "read-file") {
    return operation.result?.contentPreview || "";
  }

  if (operation.tool === "list-dir" && operation.result?.entriesPreview) {
    return operation.result.entriesPreview
      .map((entry) => {
        const size = Number.isFinite(entry.size) ? ` ${formatBytes(entry.size)}` : "";
        return `${entry.name}${size}`;
      })
      .join("\n");
  }

  return "";
}

function renderOperation(operation) {
  const item = createElement("li", `event ${operation.status}`);
  const header = createElement("div", "event-header");
  const title = createElement("div", "event-title");
  title.append(createElement("strong", "", operationTitle(operation)));
  title.append(
    createElement(
      "span",
      "",
      `${toolLabels[operation.tool] || operation.tool} · ${text(operation.source)} · ${targetLabel(
        operation.target,
      )}`,
    ),
  );

  const pill = createElement("span", `status-pill ${operation.status}`, statusLabels[operation.status]);
  header.append(title, pill);

  const meta = createElement("div", "event-meta");
  meta.append(metaItem("开始", formatClock(operation.startedAt)));
  meta.append(metaItem("更新", formatClock(operation.updatedAt)));
  meta.append(metaItem("耗时", formatDuration(operation.result?.durationMs)));
  meta.append(metaItem("结果", resultMetric(operation)));

  item.append(header, meta);

  if (operation.error) {
    item.append(
      createElement(
        "div",
        "error-text",
        `${operation.error.code || "ERROR"}: ${operation.error.message || "操作失败"}`,
      ),
    );
  }

  const output = buildOutput(operation);
  if (output) {
    item.append(createElement("pre", "output", output));
  } else if (operation.status === "running") {
    item.append(createElement("div", "muted", "等待远端响应"));
  }

  return item;
}

function render() {
  const operations = visibleOperations();
  timeline.replaceChildren(...operations.map(renderOperation));
  emptyState.hidden = operations.length > 0;
}

function connectEvents() {
  const source = new EventSource("/events");

  source.onopen = () => {
    setConnection("live", "实时连接");
  };

  source.onerror = () => {
    setConnection("offline", "重连中");
  };

  source.addEventListener("snapshot", (message) => {
    const data = JSON.parse(message.data);
    for (const event of data.events || []) {
      applyEvent(event);
    }
    render();
  });

  source.addEventListener("activity", (message) => {
    applyEvent(JSON.parse(message.data));
  });
}

filters.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-filter]");
  if (!button) {
    return;
  }

  state.filter = button.dataset.filter;
  for (const filterButton of filters.querySelectorAll("button")) {
    filterButton.classList.toggle("active", filterButton === button);
  }
  render();
});

pauseButton.addEventListener("click", () => {
  state.paused = !state.paused;
  pauseButton.textContent = state.paused ? "继续" : "暂停";
  if (!state.paused) {
    render();
  }
});

clearButton.addEventListener("click", () => {
  state.clearedAt = new Date().toISOString();
  state.operations.clear();
  updateSummary();
  render();
});

loadStatus();
connectEvents();
