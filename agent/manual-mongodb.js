import { Client } from "ssh2";
import { randomUUID } from "node:crypto";
import { SshConnectionSupervisor } from "./ssh-connection-supervisor.js";
import { manualError } from "./manual-auth.js";
import { normalizeManualMongo } from "./manual-mongodb-config.js";
import { manualMongoRemote } from "./manual-mongodb-runtime.js";

const MESSAGES = {
  MANUAL_DB_REQUEST_INVALID: "数据库请求无效，请检查目标名称、JSON 格式与每页数量（1–100）。",
  MANUAL_DB_BUSY: "数据库正在处理上一项操作，请等待完成后重试。",
  MANUAL_DB_PLAN_INVALID: "文档替换确认已失效或目标不匹配，请重新准备。",
  MANUAL_DB_NOT_CONNECTED: "数据库连接已失效，请重新连接并核对目标。",
  MANUAL_DB_CLOSED: "数据库连接已关闭，请重新连接。",
  MANUAL_DB_HOST_KEY_MISMATCH: "SSH 主机指纹不匹配，数据库连接已拒绝。",
  MANUAL_DB_SSH_CONFIG_INVALID: "SSH 私钥或已核验主机指纹不可用，请检查实例连接配置。",
  MANUAL_DB_BSON_INVALID: "BSON / Extended JSON 无效，请保留规范的类型标记并检查字段值。",
  MANUAL_DB_AUTH_FAILED: "数据库身份验证失败，请检查远端人工连接 profile 中的凭据与 authSource。",
  MANUAL_DB_NOT_CONFIGURED: "请在实例管理中配置并启用“人工数据库管理连接”。",
  MANUAL_DB_PROFILE_REQUIRED: "远端配置分组或 MongoDB URI 无效，请检查人工连接配置。",
  MANUAL_DB_DRIVER_REQUIRED: "远端需要支持 BSON EJSON 的 MongoDB Node 驱动（建议 4.x 或更新版）。",
  MANUAL_DB_IDENTITY_REQUIRED: "数据库账户无法读取 connectionStatus，不能核验 GUI 与 shell 身份。",
  MANUAL_DB_TARGET_CHANGED: "远端数据库配置已变化，请断开并重新连接数据库。",
  MANUAL_DB_PERMISSION_DENIED: "数据库账户拒绝此操作，请核对数据库权限。",
  MANUAL_DB_WRITE_CONFLICT: "文档已被修改或删除。本次未覆盖，请重新查询后编辑。",
  MANUAL_DB_WRITE_UNKNOWN: "无法确认写入结果。请重新查询核对，切勿直接重复执行。",
  MANUAL_DB_ID_IMMUTABLE: "替换文档必须保留原始 _id（包括 BSON 类型）。",
  MANUAL_DB_DOCUMENT_LIMIT: "单文档超过 GUI 384 KiB 上限，请使用数据库 shell 处理。",
  MANUAL_DB_CURSOR_EXPIRED: "分页游标已关闭，请重新查询。",
  MANUAL_DB_REMOTE_FAILED: "远端数据库操作失败。请检查配置文件、驱动、网络及数据库账户；写入中断后需查询核对结果。",
  MANUAL_DB_TIMEOUT: "数据库连接或操作超时；写入超时不代表未执行，请重新查询核对。",
};
export function databaseError(code, status = 400) { return manualError(code, MESSAGES[code] || "数据库请求无效或连接已关闭。", status); }
function object(value) { return value && typeof value === "object" && !Array.isArray(value); }
function name(value, database = false) {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > 128 || /[\0\r\n]/.test(value) || database && /[/\\. "$]/.test(value)) throw databaseError("MANUAL_DB_REQUEST_INVALID");
  return value;
}
export function normalizeManualQuery(body) {
  const allowed = ["operation", "connectionId", "database", "collection", "filter", "sort", "pageSize", "cursor", "after"];
  if (!object(body) || Object.keys(body).some((key) => !allowed.includes(key)) || !["databases", "collections", "indexes", "find", "next"].includes(body.operation)) throw databaseError("MANUAL_DB_REQUEST_INVALID");
  const result = { operation: body.operation, pageSize: body.pageSize ?? 30 };
  if (!Number.isInteger(result.pageSize) || result.pageSize < 1 || result.pageSize > 100) throw databaseError("MANUAL_DB_REQUEST_INVALID");
  if (body.operation === "next") {
    if (typeof body.cursor !== "string" || !/^[a-f0-9]{48}$/.test(body.cursor)) throw databaseError("MANUAL_DB_CURSOR_EXPIRED");
    result.cursor = body.cursor;
  } else if (body.operation === "databases") {
    if (body.after !== undefined && body.after !== "") result.after = name(body.after, true);
  } else {
    result.database = name(body.database, true);
    if (["find", "indexes"].includes(body.operation)) result.collection = name(body.collection);
  }
  if (body.operation === "find") {
    if (!object(body.filter ?? {}) || !object(body.sort ?? {}) || Buffer.byteLength(JSON.stringify(body.filter || {})) > 64 * 1024) throw databaseError("MANUAL_DB_REQUEST_INVALID");
    result.filter = body.filter || {}; result.sort = body.sort || {};
    if (Object.keys(result.sort).length > 16 || Object.entries(result.sort).some(([key, direction]) => !key || key.startsWith("$") || ["__proto__", "constructor", "prototype"].includes(key) || ![1, -1].includes(direction))) throw databaseError("MANUAL_DB_REQUEST_INVALID");
  }
  return result;
}
export function validateReplacement(body) {
  if (!object(body) || Object.keys(body).some((key) => !["connectionId", "database", "collection", "original", "replacement"].includes(key))) throw databaseError("MANUAL_DB_REQUEST_INVALID");
  const database = name(body.database, true), collection = name(body.collection);
  for (const document of [body.original, body.replacement]) {
    if (!object(document) || !Object.hasOwn(document, "_id") || Object.keys(document).some((key) => key.startsWith("$")) || Buffer.byteLength(JSON.stringify(document)) > 384 * 1024) throw databaseError("MANUAL_DB_REQUEST_INVALID");
  }
  return { database, collection, original: body.original, replacement: body.replacement };
}
const quote = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";
export function manualMongoCommand(instance, fingerprint) {
  const config = normalizeManualMongo(instance.manualMongo);
  if (!config?.enabled) throw databaseError("MANUAL_DB_NOT_CONFIGURED", 409);
  const script = `(${manualMongoRemote.toString()})(${JSON.stringify(config)},${JSON.stringify(fingerprint || null)})`;
  return `${quote(config.nodePath)} -e ${quote(script)}`;
}

// Private to ManualWorkbench; not exported through MCP, Worker, runSSH or automatic policy.
export function openManualDatabase(instance, { ClientClass = Client } = {}) {
  const client = new ClientClass();
  const supervisor = new SshConnectionSupervisor({ ssh: { ...instance, readyTimeout: 15000 } });
  let stream, closed = false, buffer = Buffer.alloc(0), pending;
  const id = randomUUID();
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  ready.catch(() => {});
  const fail = (error = databaseError("MANUAL_DB_REMOTE_FAILED", 502)) => {
    if (closed) return;
    closed = true; clearTimeout(openTimer);
    rejectReady(error); pending?.reject(error); pending = null;
    stream?.destroy(); client.destroy();
  };
  const openTimer = setTimeout(() => fail(databaseError("MANUAL_DB_TIMEOUT", 504)), 20000);
  client.on("error", () => fail(databaseError(supervisor.hostVerificationError?.code === "SSH_HOST_KEY_MISMATCH" ? "MANUAL_DB_HOST_KEY_MISMATCH" : "MANUAL_DB_REMOTE_FAILED", 502)));
  client.on("close", () => fail());
  client.on("ready", () => {
    if (closed) return;
    client.exec(manualMongoCommand(instance), (error, channel) => {
      if (closed) { channel?.destroy(); return; }
      if (error) { fail(); return; }
      stream = channel;
      channel.stderr.on("data", () => { /* No raw remote errors: config/URI may be sensitive. */ });
      channel.on("error", () => fail()); channel.on("close", () => fail());
      channel.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > 600 * 1024) { fail(); return; }
        let index;
        while ((index = buffer.indexOf(10)) !== -1) {
          const line = buffer.subarray(0, index); buffer = buffer.subarray(index + 1);
          try {
            const message = JSON.parse(line.toString("utf8"));
            if (!pending || message.id !== pending.id) { fail(); return; }
            const waiter = pending; pending = null;
            if (message.ok === true) waiter.resolve(message.result);
            else waiter.reject(Object.assign(databaseError(Object.hasOwn(MESSAGES, message.error?.code || "") ? message.error.code : "MANUAL_DB_REMOTE_FAILED", 502), { serverCode: message.error?.serverCode }));
          } catch { fail(); }
        }
      });
      clearTimeout(openTimer); resolveReady();
    });
  });
  // Validate before asynchronous connection setup, so malformed settings never open SSH.
  try { manualMongoCommand(instance); }
  catch (error) { fail(error); }
  if (!closed) supervisor.connectionOptions().then((settings) => { if (!closed) client.connect(settings); }).catch(() => fail(databaseError("MANUAL_DB_SSH_CONFIG_INVALID", 503)));
  return {
    id, close: () => fail(databaseError("MANUAL_DB_CLOSED", 409)), get closed() { return closed; },
    async request(request) {
      await ready;
      if (closed) throw databaseError("MANUAL_DB_CLOSED", 409);
      if (pending) throw databaseError("MANUAL_DB_BUSY", 409);
      return new Promise((resolve, reject) => {
        const requestId = randomUUID();
        const timer = setTimeout(() => fail(databaseError("MANUAL_DB_TIMEOUT", 504)), 25000);
        const done = (callback) => (value) => { clearTimeout(timer); callback(value); };
        pending = { id: requestId, resolve: done(resolve), reject: done(reject) };
        stream.write(JSON.stringify({ ...request, id: requestId }) + "\n");
      });
    },
  };
}
