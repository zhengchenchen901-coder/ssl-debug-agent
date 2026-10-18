const terminal = new Set(["completed", "partial", "stopped", "failed", "cancelled", "interrupted", "expired"]);
const statuses = { queued: "排队", starting: "等待资源", running: "运行中", paused: "已暂停", cancelling: "取消中", stopping: "停止中", completed: "已完成", partial: "部分完成", stopped: "已停止", failed: "失败", cancelled: "已取消", interrupted: "已中断", expired: "已过期" };
const phases = { queued: "排队", waiting_resources: "等待资源", scanning: "扫描日志", executing: "执行", execute: "执行批次", verifying: "校验", verify: "校验批次", rollback: "回滚批次", paused: "已暂停", pausing: "等待当前批次结束", finished: "已结束", resumed_as_new_execution: "已恢复为新执行" };
function el(tag, className = "", text = "") { const node = document.createElement(tag); node.className = className; node.textContent = text; return node; }
function bytes(value) { if (!Number.isFinite(value)) return "--"; return value >= 1073741824 ? `${(value / 1073741824).toFixed(2)} GiB` : value >= 1048576 ? `${(value / 1048576).toFixed(1)} MiB` : `${(value / 1024).toFixed(1)} KiB`; }

function createInstanceTasks({ instanceId, api, notify }) {
  const element = el("section", "instance-tasks"); element.setAttribute("aria-label", "实例任务列表");
  const heading = el("div", "task-heading"), title = el("h2", "", "实例任务"), refresh = el("button", "button", "刷新任务"); refresh.type = "button";
  heading.append(title, refresh);
  const summary = el("p", "muted", "正在读取任务…"), list = el("div", "task-list"), pager = el("div", "task-actions");
  const message = el("p", "task-message"); message.setAttribute("role", "status");
  element.append(heading, summary, message, list, pager);
  const pending = new Set(), expanded = new Set(), abort = new AbortController();
  let disposed = false, loading = false, offset = 0, data, online = true;
  const base = `/api/instances/${encodeURIComponent(instanceId)}/tasks`;
  async function action(task, operation) {
    pending.add(task.taskId); render();
    try {
      if (operation === "mode") await api(`${base}/${encodeURIComponent(task.taskId)}/resource-mode`, { method: "POST", signal: abort.signal,
        body: JSON.stringify({ mode: task.resourceMode === "manual_max" ? "auto" : "manual_max", expectedRevision: task.modeRevision }) });
      else await api(`${base}/${encodeURIComponent(task.taskId)}/control`, { method: "POST", signal: abort.signal, body: JSON.stringify({ action: operation }) });
      if (!disposed) notify(operation === "mode" ? "任务调度模式已更新" : "任务控制请求已提交");
    } catch (error) { if (!disposed) { message.textContent = error.message; notify(error.message); } }
    finally { pending.delete(task.taskId); if (!disposed) await load(); }
  }
  function button(task, label, operation) {
    const node = el("button", operation === "mode" && task.resourceMode === "manual_max" ? "button task-maximum" : "button", label);
    node.type = "button"; node.disabled = pending.has(task.taskId) || !online;
    node.dataset.taskId = task.taskId; node.dataset.operation = operation;
    node.addEventListener("click", () => action(task, operation)); return node;
  }
  function render() {
    if (!data || disposed) return;
    const focus = document.activeElement?.dataset;
    const pool = data.pool || {}, sample = pool.sample, capacity = pool.available || {};
    summary.textContent = `共 ${data.total} 项 · 共享 CPU 池上限 ${((pool.policy?.cpuMilliCores || 0) / 1000).toFixed(2)} 核 · ${capacity.sampleFresh ? `主机 CPU ${(sample.cpuBusyRatio * 100).toFixed(0)}%，可用内存 ${bytes(sample.memoryAvailableBytes)}` : sample ? "采样已过期，任务启动前会重新校验" : "远端采样尚未就绪，后台任务保守等待"}`;
    const cards = [];
    for (const task of data.tasks) {
      const card = el("article", "task-card"); card.dataset.taskId = task.taskId;
      const top = el("div", "task-heading");
      top.append(el("strong", "", task.label), el("span", task.resourceMode === "manual_max" ? "task-mode task-maximum" : "task-mode", task.resourceMode === "manual_max" ? "手动最高档" : "自动档"));
      const p = task.progress || {}, budget = task.budget || {};
      const source = { "codex-plugin": "Codex 工具", "http-api": "API", api: "API" }[task.source] || task.source || "API";
      const phase = el("p", "task-phase", `${statuses[task.status] || task.status} · ${phases[task.phase] || task.phase} · 来源 ${source} · 已用 ${Math.floor((task.elapsedMs || 0) / 1000)} 秒`);
      const progress = el("p", "", task.type === "log_search"
        ? `文件 ${p.completedFiles || 0}/${p.totalFiles ?? "--"} · 已扫描 ${bytes(p.scannedBytes || 0)} · 匹配 ${(p.matchedLines || 0).toLocaleString()} 行`
        : task.type === "mongo_bulk" ? `批次 ${p.nextBatch || 0}/${p.batchCount ?? "--"} · 已校验 ${p.nextVerifyBatch || 0} 批` : "非批量任务受保底资源保护");
      const resource = el("p", "muted", `获配 CPU ${(budget.cpuMilliCores || 0) / 10}% 单核 · 实际 CPU ${Number.isFinite(task.cpuMilliCoresUsed) ? `${(task.cpuMilliCoresUsed / 10).toFixed(0)}%` : "--"} · RSS ${bytes(task.usage?.rssBytes)} / ${bytes(budget.rssLimitBytes)} · 读取 ${bytes(budget.readBytesPerSecond)}/s · SSH 传输 ${bytes(budget.transferBytesPerSecond)}/s · ${task.enforcement === "cooperative" ? "进程协作限速" : task.enforcement === "batch_dispatch" ? "批次调度控制" : "准入控制"}`);
      const reason = el("p", "task-reason", task.appliedRevision < task.budgetRevision ? "正在调整资源，等待执行器确认…" : task.reason || "");
      card.append(top, phase, progress, resource, reason);
      card.append(el("p", "muted", `任务 ${task.referenceId || task.taskId}`));
      const actions = el("div", "task-actions");
      if (!terminal.has(task.status) && task.status !== "cancelling" && task.bulk) actions.append(button(task, pending.has(task.taskId) ? "正在提交…" : task.resourceMode === "manual_max" ? "恢复自动" : "手动最高档", "mode"));
      if (!terminal.has(task.status)) {
        if (task.capabilities.includes("pause") && !["paused", "stopping", "cancelling"].includes(task.status)) actions.append(button(task, "暂停", "pause"));
        if (task.capabilities.includes("resume") && task.status === "paused") actions.append(button(task, "继续", "resume"));
        if (task.capabilities.includes("stop_after_file") && ["running", "paused", "stopping"].includes(task.status)) actions.append(button(task, "当前文件结束后停止", "stop_after_file"));
        if (task.capabilities.includes("cancel") && task.status !== "cancelling") actions.append(button(task, "取消任务", "cancel"));
      }
      const detail = el("details", "task-detail"); detail.open = expanded.has(task.taskId);
      detail.addEventListener("toggle", () => { if (detail.open) expanded.add(task.taskId); else expanded.delete(task.taskId); });
      detail.append(el("summary", "", "任务详情"), el("pre", "", JSON.stringify({ taskId: task.taskId, jobId: task.referenceId,
        type: task.type, phase: task.phase, createdAt: new Date(task.createdAt).toLocaleString(), progress: task.progress,
        usage: task.usage, budget: task.budget }, null, 2)));
      card.append(actions, detail); cards.push(card);
    }
    if (!cards.length) cards.push(el("p", "muted", "暂无任务。新操作会自动登记；已结束任务保留有限时间。"));
    list.replaceChildren(...cards); pager.replaceChildren();
    if (offset > 0) { const previous = el("button", "button", "上一页"); previous.type = "button"; previous.onclick = () => { offset = Math.max(0, offset - 20); load(); }; pager.append(previous); }
    if (data.nextOffset !== null) { const next = el("button", "button", "下一页"); next.type = "button"; next.onclick = () => { offset = data.nextOffset; load(); }; pager.append(next); }
    if (focus?.taskId && focus.operation) list.querySelector(`[data-task-id="${CSS.escape(focus.taskId)}"][data-operation="${CSS.escape(focus.operation)}"]`)?.focus();
  }
  async function load() {
    if (disposed || loading || document.hidden) return;
    loading = true;
    try {
      const result = await api(`${base}?offset=${offset}&limit=20`, { signal: abort.signal });
      if (!disposed) { data = result; online = true; message.textContent = ""; render(); }
    } catch (error) { if (!disposed) { online = false; message.textContent = `任务状态暂不可用：${error.message}`; render(); } }
    finally { loading = false; }
  }
  refresh.onclick = load; load(); const timer = setInterval(load, 2000);
  return { element, destroy() { disposed = true; clearInterval(timer); abort.abort(); } };
}
window.remoteDebugInstanceTasks = { create: createInstanceTasks };
