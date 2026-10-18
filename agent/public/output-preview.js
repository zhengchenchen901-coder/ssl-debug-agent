(() => {
  const records = new Map(), views = new Map(), rows = new Map(), requests = new Set();
  let cursor = "", connection = null, reconnectTimer = null, unlocked = false, generation = 0;
  let streamStatus = "等待连接", notice = "", instanceNames = new Map();
  const DISPLAY_CHARS = 256 * 1024;
  const globalButton = document.querySelector("#globalOutputButton");
  const globalContainer = document.querySelector("#globalOutputPreview");

  function element(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  }

  function action(label, handler) {
    const node = element("button", "button", label);
    node.type = "button";
    node.addEventListener("click", handler);
    return node;
  }

  function clock(value) { return new Date(value).toLocaleTimeString(); }
  function belongs(record, key) { return key === null ? !record.instanceId || !instanceNames.has(record.instanceId) : record.instanceId === key; }
  function available(view) { return [...records.values()].filter((record) => belongs(record, view.key) && record.sequence > view.clearedThrough).sort((a, b) => b.sequence - a.sequence); }

  function status() {
    for (const view of views.values()) view.status.textContent = `${view.paused ? "显示已暂停 · " : ""}${streamStatus}${notice ? ` · ${notice}` : ""}`;
  }

  async function readRecord(id) {
    if (!unlocked) throw new Error("请先解锁面板");
    const controller = new AbortController();
    requests.add(controller);
    try {
      const response = await fetch(`/api/output-preview/records/${encodeURIComponent(id)}`, {
        headers: window.remoteDebugAuthHeaders(), cache: "no-store", signal: controller.signal,
      });
      if (response.status === 401) { window.dispatchEvent(new Event("remote-debug-auth-expired")); throw new Error("面板已锁定"); }
      if (response.status === 410) throw new Error("该记录已从内存缓存淘汰，请选择其他记录。");
      if (!response.ok) throw new Error(`读取失败（${response.status}）`);
      const result = await response.json();
      return result.record;
    } finally { requests.delete(controller); }
  }

  function recordText(record, mode) {
    if (mode === "wire") return record.wireMessage;
    return JSON.parse(record.wireMessage).result.content[0].text;
  }

  async function select(view, id) {
    view.selectedId = id;
    const selection = ++view.selection, currentGeneration = generation, mode = view.mode;
    view.body.textContent = "正在读取完整输出…";
    view.meta.textContent = "";
    view.copy.disabled = true;
    renderList(view);
    try {
      const record = await readRecord(id);
      if (!unlocked || currentGeneration !== generation || selection !== view.selection) return;
      const value = recordText(record, mode);
      view.body.textContent = value.slice(0, DISPLAY_CHARS);
      view.body.scrollTop = 0;
      const guard = record.outputGuard;
      view.meta.textContent = `${record.bytes.toLocaleString()} bytes · ${record.durationMs} ms · 请求 ${record.requestId ?? "--"} · 会话 ${record.sessionId.slice(0, 8)} · ${record.operationId}${guard ? ` · 替换 ${guard.replacements} 次 / 过滤 ${guard.omittedFields} 个字段` : ""}${value.length > DISPLAY_CHARS ? " · 页面仅展示前 256K 字符，复制可获取完整内容" : ""}`;
      view.copy.disabled = false;
    } catch (error) {
      if (unlocked && currentGeneration === generation && selection === view.selection) view.body.textContent = error.message;
    }
  }

  function renderList(view) {
    if (!view.open || view.paused) return;
    const items = available(view);
    view.list.replaceChildren(...items.map((record) => {
      const label = `${clock(record.time)}  ${record.blocked ? "已拦截" : record.isError ? "失败" : "成功"}\n${record.toolName}\n${record.durationMs} ms · ${record.bytes.toLocaleString()} bytes`;
      const button = action(label, () => { view.follow.checked = false; void select(view, record.id); });
      button.className = `output-preview-item${record.id === view.selectedId ? " selected" : ""}${record.isError ? " failed" : ""}`;
      button.setAttribute("aria-pressed", String(record.id === view.selectedId));
      return button;
    }));
    if (!items.length) view.list.append(element("p", "muted", "暂无输出"));
  }

  function refresh(view) {
    if (!view.open || view.paused) return;
    const items = available(view);
    if (view.selectedId && (!records.has(view.selectedId) || !belongs(records.get(view.selectedId), view.key))) {
      view.selection++;
      view.selectedId = null;
      view.body.textContent = "所选记录已从内存缓存淘汰。";
      view.copy.disabled = true;
      view.meta.textContent = "";
    }
    renderList(view);
    if (items[0] && (!view.selectedId || view.follow.checked && view.selectedId !== items[0].id)) void select(view, items[0].id);
  }

  function createView(key) {
    const panel = element("section", "output-preview");
    panel.setAttribute("aria-label", key === null ? "全局 MCP 输出预览" : "实例 MCP 输出预览");
    const toolbar = element("div", "output-preview-toolbar");
    const title = element("strong", "", key === null ? "全局 MCP 输出" : "Codex 输出预览");
    const connectionLabel = element("span", "output-preview-status", streamStatus);
    const followLabel = element("label", "output-preview-follow");
    const follow = element("input"); follow.type = "checkbox"; follow.checked = true;
    followLabel.append(follow, document.createTextNode("跟随最新"));
    const view = { key, panel, status: connectionLabel, open: false, paused: false, selectedId: null, selection: 0, mode: "content", clearedThrough: 0, follow };
    view.pause = action("暂停显示", () => { view.paused = !view.paused; view.pause.textContent = view.paused ? "继续显示" : "暂停显示"; status(); refresh(view); });
    const clear = action("清空显示", () => {
      view.clearedThrough = Math.max(0, ...[...records.values()].map((record) => record.sequence));
      view.selectedId = null; view.selection++;
      view.body.textContent = "已清空显示，等待新的工具返回。";
      view.meta.textContent = ""; view.copy.disabled = true; renderList(view);
    });
    view.modeButton = action("查看协议消息", () => {
      view.mode = view.mode === "content" ? "wire" : "content";
      view.modeButton.textContent = view.mode === "content" ? "查看协议消息" : "查看工具内容";
      if (view.selectedId) void select(view, view.selectedId);
    });
    view.copy = action("复制完整内容", async () => {
      const id = view.selectedId, mode = view.mode, currentGeneration = generation;
      if (!id) return;
      try {
        const record = await readRecord(id);
        if (!unlocked || generation !== currentGeneration || id !== view.selectedId) return;
        await navigator.clipboard.writeText(recordText(record, mode));
        if (unlocked && generation === currentGeneration) view.meta.textContent = view.meta.textContent.replace(/ · 完整内容已复制$/, "") + " · 完整内容已复制";
      } catch (error) { if (unlocked && generation === currentGeneration) view.meta.textContent = error.message; }
    });
    view.copy.disabled = true;
    view.expand = action("展开大窗口", () => {
      const expanded = panel.classList.toggle("output-preview-expanded");
      view.expand.textContent = expanded ? "还原窗口" : "展开大窗口";
    });
    const close = action("收起", () => toggle(key, false));
    toolbar.append(title, connectionLabel, followLabel, view.pause, clear, view.modeButton, view.copy, view.expand, close);
    const hint = element("p", "output-preview-hint", "显示插件最终脱敏后发出的工具结果；记录仅保留在内存中。每次工具返回后更新。");
    const content = element("div", "output-preview-content");
    view.list = element("div", "output-preview-list");
    view.list.setAttribute("aria-label", "最近工具调用");
    const detail = element("div", "output-preview-detail");
    view.meta = element("p", "output-preview-meta");
    view.body = element("pre", "output-preview-body", "等待插件返回工具结果…");
    detail.append(view.meta, view.body); content.append(view.list, detail); panel.append(toolbar, hint, content);
    follow.addEventListener("change", () => refresh(view));
    views.set(key, view);
    return view;
  }

  function toggle(key, force) {
    const view = views.get(key);
    if (!view) return;
    view.open = force ?? !view.open;
    if (!view.open) { view.panel.classList.remove("output-preview-expanded"); view.expand.textContent = "展开大窗口"; }
    if (key === null) globalContainer.hidden = !view.open;
    else if (rows.has(key)) rows.get(key).preview.hidden = !view.open;
    updateButtons(); status(); refresh(view);
  }

  function updateButtons() {
    for (const [key, row] of rows) {
      const button = row.row.querySelector('[data-action="preview"]');
      if (button) {
        const count = [...records.values()].filter((record) => belongs(record, key)).length;
        button.textContent = `输出预览${count ? ` (${count})` : ""}`;
        button.setAttribute("aria-expanded", String(views.get(key).open));
      }
    }
    if (globalButton) globalButton.setAttribute("aria-expanded", String(views.get(null)?.open || false));
  }

  function consume(event) {
    const changedEpoch = cursor && cursor.split(":")[0] !== event.cursor.split(":")[0];
    if (event.reset) {
      records.clear();
      for (const view of views.values()) { if (changedEpoch) view.clearedThrough = 0; view.selection++; view.selectedId = null; view.body.textContent = "等待选择输出记录…"; view.meta.textContent = ""; view.copy.disabled = true; }
    }
    if (event.gap) notice = "连接期间有记录超出缓存范围";
    for (const id of event.evictedIds || []) records.delete(id);
    for (const record of event.records || []) {
      records.set(record.id, record);
      if (record.droppedBefore) notice = `插件上报曾丢失 ${record.droppedBefore} 条记录`;
    }
    cursor = event.cursor;
    for (const view of views.values()) refresh(view);
    updateButtons(); status();
  }

  async function connect() {
    if (!unlocked || connection) return;
    const controller = new AbortController(), currentGeneration = generation;
    connection = controller;
    streamStatus = "正在连接"; status();
    let reader;
    try {
      const response = await fetch(`/api/output-preview/events${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, {
        headers: window.remoteDebugAuthHeaders(), cache: "no-store", signal: controller.signal,
      });
      if (response.status === 401) { window.dispatchEvent(new Event("remote-debug-auth-expired")); return; }
      if (!response.ok || !response.body) throw new Error("stream unavailable");
      reader = response.body.getReader();
      streamStatus = "实时连接中"; status();
      const decoder = new TextDecoder(); let buffer = "";
      while (unlocked && generation === currentGeneration) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 2 * 1024 * 1024) throw new Error("stream limit");
        let end;
        while ((end = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = block.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
          if (data && unlocked && generation === currentGeneration) consume(JSON.parse(data));
        }
      }
    } catch { /* Status below also covers manager restart and network loss. */ }
    finally {
      if (reader) { try { await reader.cancel(); } catch {} }
      if (connection === controller) connection = null;
      if (unlocked && currentGeneration === generation) {
        streamStatus = "连接断开，正在重连"; status();
        reconnectTimer = setTimeout(() => { reconnectTimer = null; void connect(); }, 2000);
      }
    }
  }

  function unlock() {
    if (unlocked || !window.remoteDebugAuthHeaders?.().Authorization) return;
    unlocked = true; generation++; void connect();
  }

  function lock() {
    unlocked = false; generation++;
    clearTimeout(reconnectTimer); reconnectTimer = null;
    connection?.abort(); connection = null;
    for (const request of requests) request.abort();
    requests.clear(); records.clear(); cursor = ""; notice = ""; streamStatus = "面板已锁定";
    for (const view of views.values()) {
      view.selection++; view.selectedId = null; view.clearedThrough = 0; view.paused = false; view.pause.textContent = "暂停显示";
      view.list.replaceChildren(); view.body.textContent = "面板已锁定"; view.meta.textContent = ""; view.copy.disabled = true;
      toggle(view.key, false);
    }
    status();
  }

  function renderRows(instances, renderRow, container) {
    instanceNames = new Map(instances.map((instance) => [instance.id, instance.name]));
    for (const [key, entry] of rows) if (!instanceNames.has(key)) {
      views.get(key).selection++;
      entry.row.remove(); entry.preview.remove(); rows.delete(key); views.delete(key);
      for (const [id, record] of records) if (record.instanceId === key) records.delete(id);
    }
    let position = container.firstChild;
    for (const instance of instances) {
      let entry = rows.get(instance.id);
      if (!entry) {
        const view = createView(instance.id);
        const preview = element("tr", "output-preview-row"), cell = element("td");
        preview.hidden = true; cell.colSpan = 10; cell.append(view.panel); preview.append(cell);
        entry = { row: renderRow(instance), preview }; rows.set(instance.id, entry);
      } else entry.row.replaceChildren(...renderRow(instance).children);
      // Keep preview DOM mounted during the five-second status refresh.
      for (const node of [entry.row, entry.preview]) {
        if (node !== position) container.insertBefore(node, position);
        position = node.nextSibling;
      }
    }
    updateButtons();
    for (const view of views.values()) refresh(view);
  }

  if (globalContainer) { const view = createView(null); globalContainer.append(view.panel); }
  globalButton?.addEventListener("click", () => toggle(null));
  window.addEventListener("remote-debug-unlocked", unlock);
  window.addEventListener("remote-debug-locked", lock);
  window.addEventListener("pagehide", lock);
  window.addEventListener("pageshow", unlock);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") for (const view of views.values()) { view.panel.classList.remove("output-preview-expanded"); view.expand.textContent = "展开大窗口"; }
  });
  window.remoteDebugOutputPreview = { renderRows, toggle, unlock, lock };
  unlock();
})();
