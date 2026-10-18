"use strict";
const element = (id) => document.getElementById(id);
const instanceId = new URL(window.location.href).searchParams.get("instanceId") || "";
const loginForm = element("loginForm");
let token = "", socket = null, terminal = null, fit = null, sessionPoll = null, ready = false;
let generation = 0, lastInputAt = 0;
element("loginInstance").textContent = instanceId || "未选择实例";
if (!instanceId) { element("loginMessage").textContent = "请从实例列表点击“手动操作”进入。"; element("loginButton").disabled = true; }

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
    fontFamily: 'Menlo, Monaco, Consolas, "Liberation Mono", monospace', theme: { background: "#090f17", foreground: "#cddaea", cursor: "#80e0c1", selectionBackground: "#28443f" } });
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
