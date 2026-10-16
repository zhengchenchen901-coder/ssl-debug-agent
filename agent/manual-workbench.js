import express from "express";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import localAuth from "../plugins/remote-debug-agent/local-auth.cjs";
import { ManualAdminStore, ManualLoginLimiter, manualError, validateAdminCredentials } from "./manual-auth.js";
import { ManualOwnerVerification } from "./manual-owner-verification.js";
import { openManualTerminal, terminalSize } from "./manual-terminal.js";

const moduleDirectory = typeof __dirname === "string" ? __dirname : path.dirname(fileURLToPath(import.meta.url));
const ASSETS = new Set(["manual.html", "manual.js", "manual.css", "vendor/xterm.js", "vendor/xterm.css", "vendor/addon-fit.js"]);
const IDLE_MS = 15 * 60_000;
const MAX_SESSION_MS = 8 * 60 * 60_000;
const TOKEN = /^[a-f0-9]{64}$/;
const SSH_MESSAGES = {
  SSH_HOST_KEY_REQUIRED: "请先在实例配置中填写已核验的 SSH 主机指纹。",
  SSH_HOST_KEY_MISMATCH: "SSH 主机指纹不匹配，连接已拒绝。",
  MANUAL_SSH_CONFIG_INVALID: "无法读取 SSH 私钥或实例配置，请检查实例设置。",
  MANUAL_SSH_TIMEOUT: "SSH 连接或终端启动超时。",
  MANUAL_SSH_FAILED: "SSH 连接失败或已断开，请检查网络、SSH 账户与私钥。",
  MANUAL_SHELL_FAILED: "远端交互式 Shell 无法启动或已断开。",
};
function digest(instance) { return createHash("sha256").update(JSON.stringify(instance)).digest("hex"); }
function target(instance) {
  return { id: instance.id, name: instance.name, host: instance.host, port: instance.port, username: instance.username };
}
function assertFields(body, allowed) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !allowed.includes(key))) {
    throw manualError("MANUAL_REQUEST_INVALID", "请求包含不支持的字段。");
  }
}
function route(action) {
  return (request, response, next) => Promise.resolve().then(() => action(request, response)).catch(next);
}
function sendError(error, _request, response, _next) {
  const known = typeof error.code === "string" && /^(ADMIN_|OWNER_|MANUAL_|INSTANCE_)/.test(error.code);
  response.status(known ? error.statusCode || 400 : 503).json({ ok: false, error: {
    code: known ? error.code : "MANUAL_UNAVAILABLE", message: known ? error.message : "手动工作台暂不可用，请检查本地配置和文件权限。",
  } });
}

export class ManualWorkbench {
  constructor({ registry, dataDirectory, lifecycle, ...options }) {
    this.registry = registry;
    this.lifecycle = lifecycle;
    this.directory = path.join(dataDirectory, ".remote-debug", "manual-admin");
    this.store = options.store || new ManualAdminStore(this.directory);
    this.ownerVerification = options.ownerVerification || new ManualOwnerVerification(path.join(this.directory, "native"));
    this.openTerminal = options.openTerminal || openManualTerminal;
    this.now = options.now || Date.now;
    this.idleMs = options.idleMs || IDLE_MS;
    this.maxSessionMs = options.maxSessionMs || MAX_SESSION_MS;
    this.limiter = new ManualLoginLimiter(this.now);
    this.sessions = new Map();
    this.tickets = new Map();
    this.registering = false;
    this.credentialEpoch = 0;
    this.server = null;
    this.starting = null;
    this.closing = false;
  }

  status() { return { ok: true, adminCount: this.store.read().length, ownerVerification: this.ownerVerification.status() }; }

  audit(event, session = {}) {
    // Only metadata; never terminal bytes, passwords, tokens or private-key paths.
    const entry = { time: new Date(this.now()).toISOString(), event, sessionId: session.id, instanceId: session.instanceId, username: session.username };
    this.store.protectDirectory();
    const logPath = path.join(this.directory, "sessions.jsonl");
    if (fs.existsSync(logPath)) {
      localAuth.protectOrCheck(logPath, false, false);
      if (fs.lstatSync(logPath).nlink !== 1) throw manualError("ADMIN_STORAGE_INVALID", "审计文件无效。", 503);
    }
    const fd = fs.openSync(logPath, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0), 0o600);
    try {
      if (fs.fstatSync(fd).nlink !== 1) throw manualError("ADMIN_STORAGE_INVALID", "审计文件无效。", 503);
      fs.writeSync(fd, JSON.stringify(entry) + "\n");
    } finally { fs.closeSync(fd); }
    localAuth.protectOrCheck(logPath, false, true);
  }

  async register(body) {
    assertFields(body, ["username", "password", "existingUsername", "existingPassword"]);
    validateAdminCredentials(body.username, body.password);
    if (this.closing) throw manualError("MANUAL_STOPPING", "工作台正在关闭。", 503);
    if (this.registering) throw manualError("ADMIN_REGISTRATION_BUSY", "另一个注册请求正在进行中。", 409);
    this.registering = true;
    try {
      if (this.store.read().length && !await this.limiter.run(() => this.store.verify(body.existingUsername, body.existingPassword))) {
        throw manualError("ADMIN_LOGIN_FAILED", "已有管理员账号或密码不正确。", 401);
      }
      await this.ownerVerification.verify();
      if (this.closing) throw manualError("MANUAL_STOPPING", "工作台正在关闭。", 503);
      await this.store.register(body.username, body.password);
      this.audit("admin-registered", { username: body.username });
      return { ok: true };
    } finally { this.registering = false; }
  }

  async resetAdmin(body) {
    assertFields(body, ["username", "password"]);
    validateAdminCredentials(body.username, body.password);
    if (this.closing || this.registering) throw manualError("ADMIN_REGISTRATION_BUSY", "另一个管理员操作正在进行中，请稍后重试。", 409);
    this.registering = true;
    try {
      await this.ownerVerification.verify();
      if (this.closing) throw manualError("MANUAL_STOPPING", "工作台正在关闭。", 503);
      await this.store.reset(body.username, body.password);
      this.credentialEpoch++;
      for (const [token, session] of this.sessions) if (session.username === body.username) this.revoke(token, "password-reset");
      this.audit("admin-password-reset", { username: body.username });
      return { ok: true };
    } finally { this.registering = false; }
  }

  instance(id) {
    const instance = typeof id === "string" && this.registry.getInternal(id);
    if (!instance || !instance.enabled) throw manualError("INSTANCE_UNAVAILABLE", "实例不存在或已禁用。", 404);
    return instance;
  }

  async login(body) {
    assertFields(body, ["username", "password", "instanceId"]);
    const credentialEpoch = this.credentialEpoch;
    if (!await this.limiter.run(() => this.store.verify(body.username, body.password)) || credentialEpoch !== this.credentialEpoch) {
      this.audit("login-failed");
      throw manualError("ADMIN_LOGIN_FAILED", "管理员账号或密码不正确。", 401);
    }
    if (this.closing) throw manualError("MANUAL_STOPPING", "工作台正在关闭。", 503);
    const instance = this.instance(body.instanceId);
    this.prune();
    if (this.sessions.size >= 8) throw manualError("MANUAL_SESSION_LIMIT", "最多同时打开 8 个人工会话。", 409);
    const token = randomBytes(32).toString("hex");
    const session = { id: randomUUID(), username: body.username, instanceId: instance.id, fingerprint: digest(instance), createdAt: this.now(), lastInputAt: this.now(), socket: null };
    this.audit("login", session);
    this.sessions.set(token, session);
    this.keepAlive(session);
    return { ok: true, token, target: target(instance), idleTimeoutMs: this.idleMs, maxSessionMs: this.maxSessionMs };
  }

  keepAlive(session) {
    this.lifecycle?.registerLease({ clientId: `manual:${session.id}`, source: "manual-workbench", ttlMs: 45_000 });
  }

  getSession(token) {
    const session = TOKEN.test(token || "") && this.sessions.get(token);
    if (!session) throw manualError("MANUAL_AUTH_REQUIRED", "请重新登录管理员账号。", 401);
    const instance = this.registry.getInternal(session.instanceId);
    if (this.now() - session.lastInputAt >= this.idleMs || this.now() - session.createdAt >= this.maxSessionMs || !instance?.enabled || digest(instance) !== session.fingerprint) {
      this.revoke(token, "session-expired");
      throw manualError("MANUAL_SESSION_EXPIRED", "会话已过期或实例配置已变化，请重新登录。", 401);
    }
    return session;
  }

  revoke(token, reason = "logout") {
    const session = this.sessions.get(token);
    if (!session) return;
    this.sessions.delete(token);
    for (const [ticket, value] of this.tickets) if (value.token === token) this.tickets.delete(ticket);
    this.lifecycle?.releaseLease(`manual:${session.id}`);
    session.socket?.close(4001, "session closed");
    session.terminal?.close();
    try { this.audit(reason, session); } catch { /* revocation must complete even if storage is unavailable */ }
  }

  invalidateInstance(instanceId) {
    for (const [token, session] of this.sessions) if (session.instanceId === instanceId) this.revoke(token, "instance-changed");
  }

  prune() {
    for (const [token] of this.sessions) {
      try { this.keepAlive(this.getSession(token)); } catch { /* getSession revokes expired sessions */ }
    }
    for (const [ticket, value] of this.tickets) if (value.expiresAt <= this.now()) this.tickets.delete(ticket);
  }

  issueTicket(token) {
    const session = this.getSession(token);
    if (session.socket) throw manualError("MANUAL_TERMINAL_EXISTS", "此会话已有终端，请先断开。", 409);
    for (const [ticket, value] of this.tickets) if (value.token === token) this.tickets.delete(ticket);
    const ticket = randomBytes(32).toString("hex");
    this.tickets.set(ticket, { token, expiresAt: this.now() + 10_000 });
    return { ok: true, ticket };
  }

  consumeTicket(ticket) {
    const value = typeof ticket === "string" && this.tickets.get(ticket);
    if (!value) throw manualError("MANUAL_TICKET_INVALID", "终端授权无效。", 401);
    this.tickets.delete(ticket);
    if (value.expiresAt <= this.now()) throw manualError("MANUAL_TICKET_INVALID", "终端授权已过期。", 401);
    const session = this.getSession(value.token);
    if (session.socket) throw manualError("MANUAL_TERMINAL_EXISTS", "此会话已有终端。", 409);
    return { session, token: value.token };
  }

  async start() {
    if (this.closing) throw manualError("MANUAL_STOPPING", "工作台正在关闭。", 503);
    if (this.starting) return this.starting;
    this.starting = this.listen().catch((error) => { this.starting = null; throw error; });
    return this.starting;
  }

  async listen() {
    const app = express();
    app.disable("x-powered-by");
    app.use((request, response, next) => {
      response.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
        "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Resource-Policy": "same-origin",
        "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
      if (request.headers.host !== this.authority || (request.headers.origin !== undefined && request.headers.origin !== this.origin) ||
          (["POST", "PUT", "DELETE"].includes(request.method) && request.headers.origin !== this.origin)) {
        return response.status(403).json({ ok: false, error: { code: "MANUAL_ORIGIN_REJECTED", message: "请求来源无效。" } });
      }
      next();
    });
    app.use(express.json({ limit: "8kb", strict: true }));
    app.get("/", (_request, response) => response.sendFile(path.join(moduleDirectory, "public", "manual.html")));
    app.get("/assets/{*asset}", (request, response) => {
      const asset = request.params.asset.join("/");
      if (!ASSETS.has(asset)) return response.sendStatus(404);
      response.sendFile(path.join(moduleDirectory, "public", asset));
    });
    app.post("/api/login", route(async (request, response) => response.json(await this.login(request.body))));
    const authorize = (request) => this.getSession(this.bearer(request));
    app.get("/api/session", route((request, response) => {
      const session = authorize(request);
      response.json({ ok: true, target: target(this.instance(session.instanceId)) });
    }));
    app.post("/api/logout", route((request, response) => { authorize(request); this.revoke(this.bearer(request)); response.json({ ok: true }); }));
    app.post("/api/terminal-ticket", route((request, response) => response.json(this.issueTicket(this.bearer(request)))));
    app.use((_request, response) => response.sendStatus(404));
    app.use(sendError);
    this.server = http.createServer(app);
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
    this.server.on("upgrade", (request, socket, head) => {
      if (request.url !== "/terminal" || request.headers.host !== this.authority || request.headers.origin !== this.origin || this.wss.clients.size >= 16) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return;
      }
      this.wss.handleUpgrade(request, socket, head, (ws) => this.attachTerminal(ws));
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
    this.authority = `127.0.0.1:${this.server.address().port}`;
    this.origin = `http://${this.authority}`;
    this.timer = setInterval(() => this.prune(), 5000);
    this.timer.unref();
    return this.origin;
  }

  bearer(request) {
    const header = request.headers.authorization;
    return typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
  }

  attachTerminal(ws) {
    let session, token, terminal, ready = false, missedPong = false;
    let pendingOutputBytes = 0;
    let inputBytes = 0, inputWindow = this.now();
    const send = (value) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); };
    const authenticationTimer = setTimeout(() => ws.close(4003, "authentication timeout"), 5000);
    const heartbeat = setInterval(() => {
      if (missedPong) { ws.terminate(); return; }
      missedPong = true;
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 15_000);
    const drain = setInterval(() => {
      if (pendingOutputBytes < 128 * 1024 && ws.bufferedAmount < 256 * 1024) terminal?.resume();
    }, 50);
    heartbeat.unref(); drain.unref(); authenticationTimer.unref();
    ws.on("pong", () => { missedPong = false; });
    ws.on("error", () => ws.terminate());
    ws.on("close", () => {
      clearTimeout(authenticationTimer); clearInterval(heartbeat); clearInterval(drain);
      terminal?.close();
      if (session && session.socket === ws) {
        session.socket = null; session.terminal = null;
        try { this.audit("terminal-disconnected", session); } catch { this.revoke(token, "audit-unavailable"); }
      }
    });
    ws.on("message", (raw, binary) => {
      try {
        if (binary) throw manualError("MANUAL_REQUEST_INVALID", "终端协议无效。");
        const message = JSON.parse(raw.toString("utf8"));
        if (!session) {
          assertFields(message, ["type", "ticket", "cols", "rows"]);
          if (message.type !== "authenticate") throw manualError("MANUAL_AUTH_REQUIRED", "终端尚未授权。", 401);
          const size = terminalSize(message.cols, message.rows);
          ({ session, token } = this.consumeTicket(message.ticket));
          clearTimeout(authenticationTimer);
          this.audit("terminal-opening", session);
          session.socket = ws;
          terminal = this.openTerminal(this.instance(session.instanceId), {
            ...size,
            onData: (data) => {
              if (ws.readyState !== WebSocket.OPEN) return;
              const bytes = Buffer.byteLength(data);
              if (!bytes) return;
              pendingOutputBytes += bytes;
              if (pendingOutputBytes > 8 * 1024 * 1024 || ws.bufferedAmount > 8 * 1024 * 1024) { ws.close(4008, "output overflow"); terminal?.close(); return; }
              ws.send(data, { binary: true });
              if (pendingOutputBytes > 512 * 1024 || ws.bufferedAmount > 1024 * 1024) terminal?.pause();
            },
            onReady: () => {
              try { this.getSession(token); this.audit("terminal-ready", session); ready = true; send({ type: "ready" }); }
              catch { ws.close(4001, "session expired"); }
            },
            onError: (code) => send({ type: "error", code, message: SSH_MESSAGES[code] || SSH_MESSAGES.MANUAL_SSH_FAILED }),
            onClose: () => { ready = false; if (ws.readyState === WebSocket.OPEN) ws.close(1000, "SSH closed"); },
          });
          session.terminal = terminal;
          return;
        }
        this.getSession(token);
        if (message.type === "input") {
          assertFields(message, ["type", "data"]);
          if (!ready || typeof message.data !== "string" || Buffer.byteLength(message.data) > 32 * 1024) throw manualError("MANUAL_INPUT_INVALID", "终端输入无效。");
          if (this.now() - inputWindow >= 1000) { inputWindow = this.now(); inputBytes = 0; }
          inputBytes += Buffer.byteLength(message.data);
          if (inputBytes > 256 * 1024) throw manualError("MANUAL_INPUT_LIMITED", "终端输入过快，请分批粘贴。");
          session.lastInputAt = this.now();
          terminal.write(message.data);
        } else if (message.type === "output-ack") {
          assertFields(message, ["type", "bytes"]);
          if (!Number.isInteger(message.bytes) || message.bytes <= 0 || message.bytes > pendingOutputBytes) throw manualError("MANUAL_ACK_INVALID", "终端输出确认无效。");
          pendingOutputBytes -= message.bytes;
          if (pendingOutputBytes < 128 * 1024 && ws.bufferedAmount < 256 * 1024) terminal.resume();
        } else if (message.type === "resize") {
          assertFields(message, ["type", "cols", "rows"]);
          const size = terminalSize(message.cols, message.rows);
          terminal.resize(size.cols, size.rows);
        } else throw manualError("MANUAL_REQUEST_INVALID", "终端协议无效。");
      } catch (error) {
        send({ type: "error", code: "MANUAL_TERMINAL_REJECTED", message: error.code?.startsWith("MANUAL_") ? error.message : "终端请求无效。" });
        ws.close(4003, "request rejected");
      }
    });
  }

  async open(instanceId) {
    this.instance(instanceId);
    const origin = await this.start();
    return { ok: true, url: `${origin}/?instanceId=${encodeURIComponent(instanceId)}` };
  }

  async close() {
    this.closing = true;
    this.ownerVerification.cancel?.();
    if (this.starting) await this.starting.catch(() => {});
    clearInterval(this.timer);
    for (const [token] of this.sessions) this.revoke(token, "manager-stopped");
    this.tickets.clear();
    for (const socket of this.wss?.clients || []) socket.terminate();
    this.wss?.close();
    if (this.server?.listening) {
      this.server.closeIdleConnections();
      await new Promise((resolve) => this.server.close(resolve));
    }
  }
}

export function installManualManagerRoutes(app, workbench) {
  app.get("/api/manual/status", route((_request, response) => response.json(workbench.status())));
  app.post("/api/manual/register", route(async (request, response) => response.status(201).json(await workbench.register(request.body))));
  app.post("/api/manual/reset", route(async (request, response) => response.json(await workbench.resetAdmin(request.body))));
  app.post("/api/manual/open", route(async (request, response) => {
    assertFields(request.body, ["instanceId"]);
    response.json(await workbench.open(request.body.instanceId));
  }));
  // Keep fixed errors local to these routes, without changing existing handlers.
  app.use("/api/manual", sendError);
}
