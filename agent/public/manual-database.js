"use strict";
(() => {
  let connectionId = "", descriptor = null, epoch = 0, busy = false, config = null, activitySentAt = 0;
  let cursor = null, cursorAction = "", databaseAfter = "", collectionDatabase = "", pageNumber = 0;
  let edit = null, dbSocket = null, dbTerminal = null, dbFit = null, shellReady = false, shellGeneration = 0;
  const text = (id, value) => { element(id).textContent = value; };
  const identity = (target) => target.users.length ? target.users.map((user) => `${user.user}@${user.db}`).join(", ") : "未认证连接（无数据库用户）";
  const targetText = (target) => `${target.instanceId} · ${target.hosts} · ${identity(target)} · ${target.profile}`;
  function show(mode) {
    const database = mode === "database";
    element("workspace").classList.toggle("database-mode", database);
    element("sshWorkArea").hidden = element("sshOperations").hidden = database;
    element("databaseWorkArea").hidden = element("databaseOperations").hidden = !database;
    element("sshNav").classList.toggle("active", !database);
    element("databaseNav").classList.toggle("active", database);
    requestAnimationFrame(() => database ? fitShell() : fitTerminal());
  }
  function activity() {
    lastInputAt = Date.now();
    if (!connectionId || lastInputAt - activitySentAt < 10000) return;
    activitySentAt = lastInputAt;
    api("/api/database/activity", { connectionId }).catch((error) => { if (token) text("dbMessage", error.message); });
  }
  function disconnectShell() {
    shellGeneration++; shellReady = false;
    const old = dbSocket; dbSocket = null; old?.close();
    if (dbTerminal) dbTerminal.options.disableStdin = true;
    element("dbShellConnect").disabled = !connectionId;
    element("dbShellDisconnect").disabled = true;
  }
  function clearCursor() {
    cursor = null; cursorAction = "";
    element("dbNext").hidden = element("dbMoreCollections").hidden = true;
  }
  function reset() {
    epoch++; activitySentAt = 0; connectionId = ""; descriptor = null; edit = null; busy = false;
    disconnectShell(); dbTerminal?.dispose(); dbTerminal = null; dbFit = null;
    clearCursor(); databaseAfter = "";
    for (const id of ["dbDatabases", "dbCollections", "dbDocuments"]) element(id).replaceChildren();
    element("dbEditor").value = ""; element("dbEditorPanel").hidden = true;
    element("dbMoreDatabases").hidden = true;
    text("dbStatus", "未连接"); text("dbTarget", "从实例管理保存的人工连接配置建立连接。");
    text("dbShellTarget", "先连接数据库并核验目标与身份。");
    text("dbShellHint", "需要远端已有兼容的 mongosh。shell 以 GUI 核验的配置和身份启动。");
    element("dbDisconnect").disabled = true; element("dbConnect").disabled = false;
  }
  async function loadConfig() {
    try {
      config = (await api("/api/database/config")).config;
      text("dbConfig", config.enabled ? `${config.configPath} · ${config.configProfile} · URI 字段 ${config.uriKey} · 客户端 ${config.mongoshPath}` : "尚未启用人工数据库管理连接，请在实例管理中单独配置。自动业务连接与沙盒管理连接不会被自动沿用。");
    } catch (error) { text("dbMessage", error.message); }
  }
  async function run(action) {
    if (busy) return;
    busy = true; text("dbMessage", "");
    const current = epoch;
    try { lastInputAt = Date.now(); await action(current); }
    catch (error) {
      if (current !== epoch) return;
      if (["MANUAL_DB_TARGET_CHANGED", "MANUAL_DB_CLOSED", "MANUAL_DB_NOT_CONNECTED"].includes(error.code)) reset();
      text("dbMessage", error.message);
    } finally { if (current === epoch) busy = false; }
  }
  async function request(input) {
    if (!connectionId) throw new Error("请先连接数据库。");
    const current = epoch;
    const result = await api("/api/database/query", { ...input, connectionId });
    if (current !== epoch) throw new Error("连接已切换，请重新查询。");
    return result;
  }
  function names(container, items, action) {
    for (const item of items) {
      const button = document.createElement("button"); button.className = "db-name"; button.textContent = item.name;
      button.addEventListener("click", () => run(() => action(item.name)));
      element(container).append(button);
    }
  }
  async function listDatabases(append = false) {
    clearCursor();
    const result = await request({ operation: "databases", after: append ? databaseAfter : "", pageSize: 100 });
    if (!append) element("dbDatabases").replaceChildren();
    names("dbDatabases", result.data, async (name) => {
      element("dbDatabase").value = name; element("dbCollection").value = "";
      await listCollections(name);
    });
    databaseAfter = result.after; element("dbMoreDatabases").hidden = !result.hasMore;
    if (!result.data.length) text("dbMessage", "无可列出的数据库。可直接填写账户允许访问的数据库与集合名称。");
  }
  async function listCollections(database, append = false) {
    const result = await request(append ? { operation: "next", cursor } : { operation: "collections", database, pageSize: 100 });
    clearCursor(); collectionDatabase = database;
    if (!append) element("dbCollections").replaceChildren();
    names("dbCollections", result.data, async (name) => {
      element("dbDatabase").value = database; element("dbCollection").value = name; await find();
    });
    cursor = result.cursor; cursorAction = "collections"; element("dbMoreCollections").hidden = !result.hasMore;
  }
  function documents(result, database, collection, operation) {
    edit = null; element("dbEditorPanel").hidden = true; element("dbEditor").value = "";
    element("dbDocuments").replaceChildren();
    clearCursor(); cursor = result.cursor; cursorAction = operation;
    element("dbNext").hidden = !result.hasMore;
    text("dbPageInfo", `${database}.${collection} · ${operation === "indexes" ? "索引" : "文档"} · 第 ${pageNumber} 页 · ${result.data.length} 项${result.hasMore ? " · 还有更多" : " · 已到末页"}`);
    for (const entry of result.data) {
      const button = document.createElement("button"); button.className = "db-document";
      const pre = document.createElement("pre"); pre.textContent = JSON.stringify(entry, null, 2); button.append(pre);
      button.addEventListener("click", () => {
        lastInputAt = Date.now();
        edit = operation === "find" ? { database, collection, original: entry } : null;
        element("dbEditorPanel").hidden = false;
        element("dbEditor").value = JSON.stringify(entry, null, 2);
        element("dbEditor").readOnly = operation !== "find";
        element("dbPrepare").hidden = operation !== "find";
        text("dbEditTarget", `${targetText(descriptor)} → ${database}.${collection}`);
      });
      element("dbDocuments").append(button);
    }
  }
  async function find(operation = "find", next = false) {
    const database = element("dbDatabase").value.trim(), collection = element("dbCollection").value.trim();
    const result = await request(next ? { operation: "next", cursor } : { operation, database, collection, filter: JSON.parse(element("dbFilter").value), sort: JSON.parse(element("dbSort").value), pageSize: Number(element("dbPageSize").value) });
    pageNumber = next ? pageNumber + 1 : 1;
    // A cursor remains bound to the original database and collection, even if inputs were edited.
    documents(result, result.database || database, result.collection || collection, result.kind || operation);
  }
  function fitShell() {
    if (!dbTerminal || element("databaseWorkArea").hidden || element("workspace").hidden) return;
    dbFit.fit();
    if (shellReady && dbSocket?.readyState === WebSocket.OPEN) dbSocket.send(JSON.stringify({ type: "resize", cols: dbTerminal.cols, rows: dbTerminal.rows }));
  }
  function createShell() {
    if (dbTerminal) return;
    dbTerminal = new window.Terminal({ cursorBlink: true, fontSize: 12, scrollback: 3000, disableStdin: true, theme: { background: "#090f17", foreground: "#cddaea" } });
    dbFit = new window.FitAddon.FitAddon(); dbTerminal.loadAddon(dbFit); dbTerminal.open(element("dbTerminal"));
    dbTerminal.onData((data) => {
      if (!shellReady || dbSocket?.readyState !== WebSocket.OPEN) return;
      lastInputAt = Date.now();
      for (let offset = 0; offset < data.length;) {
        let end = Math.min(offset + 8000, data.length);
        if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1])) end--;
        dbSocket.send(JSON.stringify({ type: "input", data: data.slice(offset, end) })); offset = end;
      }
    });
    fitShell();
  }
  async function connectShell() {
    if (!connectionId || dbSocket) return;
    const current = ++shellGeneration;
    element("dbShellConnect").disabled = true;
    try {
      createShell();
      const { ticket } = await api("/api/database/shell-ticket", { connectionId });
      if (current !== shellGeneration || !connectionId) return;
      const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/database-terminal`); dbSocket = ws; ws.binaryType = "arraybuffer";
      element("dbShellDisconnect").disabled = false;
      ws.addEventListener("open", () => { if (dbSocket === ws) ws.send(JSON.stringify({ type: "authenticate", ticket, cols: dbTerminal.cols, rows: dbTerminal.rows })); else ws.close(); });
      ws.addEventListener("message", (event) => {
        if (dbSocket !== ws) return;
        if (event.data instanceof ArrayBuffer) {
          const bytes = event.data.byteLength;
          dbTerminal.write(new Uint8Array(event.data), () => { if (dbSocket === ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "output-ack", bytes })); });
          return;
        }
        const message = JSON.parse(event.data);
        if (message.type === "ready") {
          shellReady = true; dbTerminal.options.disableStdin = false;
          text("dbShellHint", "客户端通道已启动；连接结果以 mongosh 提示为准。Ctrl+C 中断。手动切换库或连接后请核对新目标。");
          fitShell(); dbTerminal.focus();
        } else if (message.type === "error") text("dbShellHint", message.message);
      });
      ws.addEventListener("close", (event) => {
        if (dbSocket !== ws) return;
        disconnectShell();
        if (event.code === 4001) resetLogin("会话已过期，请重新登录。");
        else if (event.code === 4002) { reset(); text("dbMessage", "数据库连接已关闭或目标配置发生变化，请重新连接。"); }
      });
      ws.addEventListener("error", () => { if (dbSocket === ws) text("dbShellHint", "数据库 shell 连接失败，可检查配置后重试。"); });
    } catch (error) { if (current === shellGeneration) { disconnectShell(); text("dbShellHint", error.message); } }
  }
  element("databaseWorkArea").addEventListener("input", activity);
  element("databaseWorkArea").addEventListener("click", activity);
  element("databaseNav").addEventListener("click", () => { show("database"); activity(); });
  element("sshNav").addEventListener("click", () => show("ssh"));
  element("dbConnect").addEventListener("click", () => run(async (current) => {
    const result = await api("/api/database/connect", {});
    if (current !== epoch) return;
    connectionId = result.connectionId; descriptor = result.target;
    text("dbTitle", `${descriptor.ssh.name} · MongoDB`); text("dbStatus", "已连接");
    text("dbTarget", targetText(descriptor)); text("dbShellTarget", targetText(descriptor));
    element("dbConnect").disabled = true; element("dbDisconnect").disabled = false; element("dbShellConnect").disabled = false;
    element("dbDatabase").value = descriptor.database || "";
    await listDatabases();
  }));
  element("dbDisconnect").addEventListener("click", async () => {
    const old = connectionId; reset(); lastInputAt = Date.now();
    try { await api("/api/database/disconnect", { connectionId: old }); } catch (error) { text("dbMessage", error.message); }
  });
  element("dbList").addEventListener("click", () => run(() => listDatabases()));
  element("dbMoreDatabases").addEventListener("click", () => run(() => listDatabases(true)));
  element("dbMoreCollections").addEventListener("click", () => run(() => listCollections(collectionDatabase, true)));
  element("dbQueryForm").addEventListener("submit", (event) => { event.preventDefault(); void run(() => find()); });
  element("dbIndexes").addEventListener("click", () => run(() => find("indexes")));
  element("dbNext").addEventListener("click", () => run(() => find(cursorAction, true)));
  element("dbEditor").addEventListener("input", () => { lastInputAt = Date.now(); });
  element("dbPrepare").addEventListener("click", () => run(async (current) => {
    if (!edit) return;
    const replacement = JSON.parse(element("dbEditor").value);
    const result = await api("/api/database/prepare", { connectionId, ...edit, replacement });
    if (current !== epoch) return;
    if (!window.confirm(`${targetText(result.target)}\n目标：${result.database}.${result.collection}\n动作：replaceOne，替换当前文档全部内容（保留 _id）\n\n若原文档已变化将拒绝覆盖。确认执行？`)) return;
    const outcome = await api("/api/database/execute", { connectionId, planId: result.planId, confirmation: result.confirmation });
    if (current !== epoch) return;
    clearCursor(); edit = null; element("dbEditorPanel").hidden = true; element("dbEditor").value = ""; element("dbDocuments").replaceChildren();
    text("dbPageInfo", "文档列表已清除，请重新查询核对写入结果。");
    text("dbMessage", `替换已完成：匹配 ${outcome.matchedCount}，修改 ${outcome.modifiedCount}。请重新查询。`);
  }));
  element("dbShellConnect").addEventListener("click", connectShell);
  element("dbShellDisconnect").addEventListener("click", disconnectShell);
  element("dbShellClear").addEventListener("click", () => dbTerminal?.clear());
  window.addEventListener("resize", fitShell);
  window.ManualDatabase = { show, reset, loadConfig, check(state) {
    if (connectionId && state.databaseConnectionId !== connectionId) { reset(); text("dbMessage", "数据库连接已关闭，请重新连接。"); }
  } };
})();
