import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID, scrypt, createCipheriv, createDecipheriv } from "node:crypto";
import { promisify } from "node:util";
import express from "express";
import localAuth from "../plugins/remote-debug-agent/local-auth.cjs";
import { normalizeInstance } from "./instance-registry.js";
import { MemoryStore, MEMORY_VERSION, sanitizeMemoryValue, targetFingerprint } from "./memory-store.js";

const derive = promisify(scrypt);
const FORMAT = "remote-debug-instance";
const AAD = Buffer.from(`${FORMAT}:1:scrypt:32768:8:1:aes-256-gcm`);
export const MAX_TRANSFER_BYTES = 8 * 1024 * 1024;
const MAX_KEY_BYTES = 1024 * 1024;
const INSTANCE_FIELDS = ["id", "name", "enabled", "host", "port", "username", "privateKeyPath", "hostKeyFingerprints", "passphrase", "auditLog", "preferredWorkerPort", "approvedCommands", "mongodb", "manualMongo", "sourceRoots", "logProjects", "serviceProfiles", "createdAt", "updatedAt"];
const MESSAGES = {
  TRANSFER_INVALID: "导出包格式或实例配置无效。",
  TRANSFER_VERSION_UNSUPPORTED: "不支持此导出包版本，请使用兼容版本的插件。",
  TRANSFER_PASSWORD_INVALID: "导出口令需要包含 12–256 个字符。",
  TRANSFER_DECRYPT_FAILED: "口令错误或导出包已损坏。",
  TRANSFER_TOO_LARGE: "导出包超过大小限制（明文最多 8 MiB，私钥最多 1 MiB）。",
  TRANSFER_SOURCE_UNREADABLE: "无法读取实例私钥或记忆，请检查文件与权限。",
  TRANSFER_MEMORY_INVALID: "实例记忆损坏或与远端目标不匹配。",
  TRANSFER_ID_INVALID: "实例 ID 需为 1–64 位字母、数字、短横线或下划线，且不能使用 Windows 保留名称。",
  TRANSFER_ID_CONFLICT: "实例 ID 或目录已存在（包括仅大小写不同），请修改 ID 后新建。",
  TRANSFER_STORAGE_UNSAFE: "无法建立或核验私有存储权限，请检查目录、Windows ACL 及文件占用。",
  TRANSFER_BUSY: "实例配置迁移正在进行，请稍后重试。",
  INSTANCE_NOT_FOUND: "实例不存在。",
};
function failure(code, statusCode = 400) {
  return Object.assign(new Error(MESSAGES[code] || MESSAGES.TRANSFER_INVALID), { code, statusCode });
}
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function fields(value, names) {
  if (!object(value) || Object.keys(value).some(key => !names.includes(key))) throw failure("TRANSFER_INVALID");
}
function safeTree(value, depth = 0) {
  if (depth > 30) throw failure("TRANSFER_INVALID");
  if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) throw failure("TRANSFER_INVALID");
    safeTree(child, depth + 1);
  }
}
function passwordCheck(password) {
  if (typeof password !== "string" || [...password].length < 12 || [...password].length > 256 || /\0/.test(password)) throw failure("TRANSFER_PASSWORD_INVALID");
}
function base64(value, max, exact) {
  if (typeof value !== "string" || value.length > Math.ceil(max / 3) * 4 || value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)) throw failure("TRANSFER_INVALID");
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length || bytes.length > max || (exact && bytes.length !== exact) || bytes.toString("base64") !== value) throw failure("TRANSFER_INVALID");
  return bytes;
}
export async function encryptTransfer(payload, password) {
  passwordCheck(password);
  const plain = Buffer.from(JSON.stringify(payload));
  if (plain.length > MAX_TRANSFER_BYTES) { plain.fill(0); throw failure("TRANSFER_TOO_LARGE", 413); }
  const salt = randomBytes(16), iv = randomBytes(12);
  let key;
  try {
    key = await derive(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const cipher = createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(AAD);
    const data = Buffer.concat([cipher.update(plain), cipher.final()]);
    return { format: FORMAT, version: 1, kdf: { name: "scrypt", N: 32768, r: 8, p: 1, salt: salt.toString("base64") },
      cipher: { name: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") }, data: data.toString("base64") };
  } finally { plain.fill(0); key?.fill(0); }
}
export async function decryptTransfer(bundle, password) {
  passwordCheck(password);
  fields(bundle, ["format", "version", "kdf", "cipher", "data"]);
  if (bundle.format !== FORMAT) throw failure("TRANSFER_INVALID");
  if (bundle.version !== 1) throw failure("TRANSFER_VERSION_UNSUPPORTED");
  fields(bundle.kdf, ["name", "N", "r", "p", "salt"]); fields(bundle.cipher, ["name", "iv", "tag"]);
  const { kdf, cipher } = bundle;
  if (kdf.name !== "scrypt" || kdf.N !== 32768 || kdf.r !== 8 || kdf.p !== 1 || cipher.name !== "aes-256-gcm") throw failure("TRANSFER_INVALID");
  const salt = base64(kdf.salt, 16, 16), iv = base64(cipher.iv, 12, 12), tag = base64(cipher.tag, 16, 16);
  if (typeof bundle.data === "string" && bundle.data.length > Math.ceil(MAX_TRANSFER_BYTES / 3) * 4) throw failure("TRANSFER_TOO_LARGE", 413);
  const encrypted = base64(bundle.data, MAX_TRANSFER_BYTES);
  let key, plain;
  try {
    key = await derive(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const decipher = createDecipheriv("aes-256-gcm", key, iv); decipher.setAAD(AAD); decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    const value = JSON.parse(plain.toString("utf8")); safeTree(value); return value;
  } catch { throw failure("TRANSFER_DECRYPT_FAILED"); }
  finally { key?.fill(0); plain?.fill(0); }
}
export function assertPortableId(id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(id)) throw failure("TRANSFER_ID_INVALID");
}
function regular(file, max) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink()) throw failure("TRANSFER_STORAGE_UNSAFE");
  if (info.size > max) throw failure("TRANSFER_TOO_LARGE", 413);
  // An open descriptor and a bounded read also handle file replacement/growth.
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) throw failure("TRANSFER_STORAGE_UNSAFE");
    const bytes = Buffer.alloc(max + 1); let length = 0, count;
    do { count = fs.readSync(fd, bytes, length, bytes.length - length, null); length += count; } while (count && length < bytes.length);
    if (length > max) { bytes.fill(0); throw failure("TRANSFER_TOO_LARGE", 413); }
    return bytes.subarray(0, length);
  } finally { fs.closeSync(fd); }
}
function validateMemory(memory, instance) {
  if (memory === null) return null;
  if (!object(memory) || memory.version !== MEMORY_VERSION || memory.instanceId !== instance.id || memory.targetFingerprint !== targetFingerprint(instance) || !object(memory.sections)) throw failure("TRANSFER_MEMORY_INVALID");
  return sanitizeMemoryValue(memory);
}
function validatePayload(payload) {
  fields(payload, ["version", "exportedAt", "instance", "privateKey", "memory", "manager"]);
  if (payload.version !== 1) throw failure("TRANSFER_VERSION_UNSUPPORTED");
  fields(payload.instance, INSTANCE_FIELDS); safeTree(payload);
  const i = payload.instance;
  for (const field of ["id", "name", "host", "username", "privateKeyPath"]) {
    if (typeof i[field] !== "string" || !i[field].trim() || i[field].length > 4096 || /[\0\r\n]/.test(i[field])) throw failure("TRANSFER_INVALID");
  }
  if (i.passphrase !== undefined && (typeof i.passphrase !== "string" || i.passphrase.length > 4096)) throw failure("TRANSFER_INVALID");
  if (typeof i.enabled !== "boolean" || !Number.isInteger(i.port) || i.port < 1 || i.port > 65535) throw failure("TRANSFER_INVALID");
  try { normalizeInstance(payload.instance); } catch { throw failure("TRANSFER_INVALID"); }
  if (!object(payload.manager)) throw failure("TRANSFER_INVALID");
  const bytes = base64(payload.privateKey, MAX_KEY_BYTES); bytes.fill(0);
  validateMemory(payload.memory, payload.instance);
  return payload;
}
function safeDirectory(directory, protect) {
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw failure("TRANSFER_STORAGE_UNSAFE");
  localAuth.protectOrCheck(directory, true, protect);
}

export class InstanceTransfer {
  constructor({ registry, memoryStore, cwd = registry.cwd || process.cwd(), protect = localAuth.protectOrCheck }) {
    this.registry = registry; this.memoryStore = memoryStore; this.protect = protect; this.busy = false;
    const baseCwd = path.resolve(cwd);
    this.cwd = baseCwd;
    this.base = path.basename(baseCwd).toLowerCase() === "agent" ? path.dirname(baseCwd) : baseCwd;
  }
  checkStorageParents() {
    // Resolve only the trusted project/data directory. Reject redirection in any
    // descendants, including .remote-debug, before recursive mkdir or chmod.
    const relative = path.relative(this.base, this.memoryStore.root);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw failure("TRANSFER_STORAGE_UNSAFE");
    let current = fs.realpathSync(this.base);
    for (const part of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try {
        const info = fs.lstatSync(current);
        if (!info.isDirectory() || info.isSymbolicLink()) throw failure("TRANSFER_STORAGE_UNSAFE");
      } catch (error) { if (error.code === "ENOENT") return; throw error; }
    }
  }
  async exclusive(action) {
    if (this.busy) throw failure("TRANSFER_BUSY", 409);
    this.busy = true;
    try { return await action(); }
    catch (error) { if (MESSAGES[error.code]) throw error; throw failure("TRANSFER_STORAGE_UNSAFE", 500); }
    finally { this.busy = false; }
  }
  async export(id, password) {
    return this.exclusive(async () => {
      passwordCheck(password);
      const current = this.registry.getInternal(id);
      if (!current) throw failure("INSTANCE_NOT_FOUND", 404);
      const instance = structuredClone(current); let bytes, memory = null;
      try {
        this.checkStorageParents();
        bytes = regular(path.resolve(this.cwd, instance.privateKeyPath), MAX_KEY_BYTES);
        const file = this.memoryStore.memoryPath(id);
        try { memory = JSON.parse(regular(file, MAX_TRANSFER_BYTES).toString("utf8")); }
        catch (error) { if (error.code !== "ENOENT") throw failure("TRANSFER_MEMORY_INVALID"); }
        const payload = validatePayload({ version: 1, exportedAt: new Date().toISOString(), instance,
          privateKey: bytes.toString("base64"), memory, manager: structuredClone(this.registry.managerConfig()) });
        return await encryptTransfer(payload, password);
      } catch (error) { if (MESSAGES[error.code]) throw error; throw failure("TRANSFER_SOURCE_UNREADABLE"); }
      finally { bytes?.fill(0); }
    });
  }
  conflict(id) {
    assertPortableId(id);
    this.checkStorageParents();
    if (this.registry.listInternal().some(item => item.id.toLowerCase() === id.toLowerCase())) return true;
    const root = this.memoryStore.root;
    try {
      if (fs.lstatSync(root).isSymbolicLink()) throw failure("TRANSFER_STORAGE_UNSAFE");
      return fs.readdirSync(root).some(name => name.toLowerCase() === id.toLowerCase());
    } catch (error) { if (error.code === "ENOENT") return false; throw error; }
  }
  async preview(bundle, password) {
    return this.exclusive(async () => {
      const payload = validatePayload(await decryptTransfer(bundle, password)), i = payload.instance;
      // A portable ID can be chosen at import even when the source ID is not portable.
      let idConflict = true;
      try { idConflict = this.conflict(i.id); } catch (error) { if (error.code !== "TRANSFER_ID_INVALID") throw error; }
      return { id: i.id, name: i.name, enabled: i.enabled, target: { host: i.host, port: i.port, username: i.username },
        hostKeyFingerprints: i.hostKeyFingerprints, approvedCommands: i.approvedCommands,
        mongodb: i.mongodb ? { enabled: i.mongodb.enabled, writeEnabled: Boolean(i.mongodb.writeEnabled), mutationsEnabled: Boolean(i.mongodb.mutationsEnabled), bulkEnabled: Boolean(i.mongodb.bulkEnabled), allowedDatabases: i.mongodb.allowedDatabases || [], allowedCollections: i.mongodb.allowedCollections || [], hasSandboxManagementPassword: Boolean(i.mongodb.sandboxManagementPassword) } : null,
        manualMongoEnabled: Boolean(i.manualMongo?.enabled), serviceIds: Object.keys(i.serviceProfiles || {}),
        hasPassphrase: Boolean(i.passphrase), hasPrivateKey: true, hasMemory: payload.memory !== null, idConflict,
        managerSettingsDiffer: JSON.stringify(payload.manager) !== JSON.stringify(this.registry.managerConfig()),
        notices: ["仅创建新实例；本机私钥和审计路径将重新生成，Worker 端口将重新分配。", "Manager 全局配置沿用本机；导入后需手动启动实例。"] };
    });
  }
  async import(bundle, password, id, name) {
    return this.exclusive(async () => {
      const payload = validatePayload(await decryptTransfer(bundle, password));
      assertPortableId(id);
      if (this.conflict(id)) throw failure("TRANSFER_ID_CONFLICT", 409);
      if (typeof name !== "string" || !name.trim() || name.length > 256) throw failure("TRANSFER_INVALID");
      let staged, published = false, keyBytes;
      const root = path.resolve(this.memoryStore.root), directory = path.join(root, id);
      try {
        fs.mkdirSync(root, { recursive: true, mode: 0o700 }); safeDirectory(root, true);
        // Canonicalize the trusted root, then only create generated immediate children.
        const canonicalRoot = fs.realpathSync(root);
        staged = path.join(canonicalRoot, `.import-${randomUUID()}`);
        fs.mkdirSync(staged, { mode: 0o700 }); this.protect(staged, true, true);
        const instance = structuredClone(payload.instance);
        instance.id = id; instance.name = name.trim(); instance.privateKeyPath = path.join(directory, "imported-ssh-key");
        delete instance.auditLog; delete instance.preferredWorkerPort; delete instance.createdAt; delete instance.updatedAt;
        for (const profile of Object.values(instance.serviceProfiles || {})) profile.instanceId = id;
        let normalized;
        try { normalized = normalizeInstance(instance); } catch { throw failure("TRANSFER_INVALID"); }
        const write = (file, bytes) => {
          const target = path.join(staged, file);
          // Create empty and protect before writing any plaintext secret (including on Windows).
          const fd = fs.openSync(target, "wx", 0o600);
          try { this.protect(target, false, true); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
          finally { fs.closeSync(fd); }
          this.protect(target, false, false);
        };
        keyBytes = base64(payload.privateKey, MAX_KEY_BYTES); write("imported-ssh-key", keyBytes);
        if (payload.memory) {
          const memory = validateMemory(payload.memory, payload.instance);
          memory.instanceId = id;
          // Keep failed/stale observations out of the ready state; refresh them on first start.
          if (memory.status === "initializing") memory.status = "stale";
          write("memory.json", JSON.stringify(memory, null, 2) + "\n");
        }
        // Existing HTTP create/edit requests may have run while scrypt was pending.
        if (this.conflict(id)) throw failure("TRANSFER_ID_CONFLICT", 409);
        safeDirectory(root, false);
        fs.renameSync(staged, directory); staged = undefined; published = true;
        // create() publishes registry state only after its atomic save succeeds.
        this.memoryStore.records.delete(id);
        return this.registry.create(normalized);
      } catch (error) {
        try { if (staged) fs.rmSync(staged, { recursive: true, force: true }); if (published) fs.rmSync(directory, { recursive: true, force: true }); }
        catch { throw failure("TRANSFER_STORAGE_UNSAFE", 500); }
        throw error;
      } finally { keyBytes?.fill(0); }
    });
  }
}

export function installInstanceTransferRoutes(app, { registry, workerManager, cwd }) {
  const memoryStore = workerManager.memoryStore || new MemoryStore({ cwd });
  const transfer = new InstanceTransfer({ registry, memoryStore, cwd: registry.cwd || cwd });
  app.locals.instanceTransfer = transfer;
  const sendError = (response, error) => {
    const known = MESSAGES[error.code];
    response.status(known ? error.statusCode || 400 : 500).json({ ok: false, error: { code: known ? error.code : "TRANSFER_STORAGE_UNSAFE", message: known || MESSAGES.TRANSFER_STORAGE_UNSAFE } });
  };
  const handler = action => (request, response) => {
    Promise.resolve().then(() => action(request, response)).catch(error => sendError(response, error));
  };
  const routes = ["/api/instances/import", "/api/instances/:id/export"];
  app.use(routes, express.json({ limit: "12mb" }));
  app.use(routes, (error, _request, response, _next) => sendError(response,
    failure(error.type === "entity.too.large" ? "TRANSFER_TOO_LARGE" : "TRANSFER_INVALID", error.type === "entity.too.large" ? 413 : 400)));
  app.post("/api/instances/:id/export", handler(async (request, response) => {
    const bundle = await transfer.export(request.params.id, request.body?.password);
    const filename = `instance-${request.params.id.replace(/[^A-Za-z0-9_-]/g, "_")}.rda-instance.json`;
    response.set("Content-Disposition", `attachment; filename="${filename}"`).json(bundle);
  }));
  app.post("/api/instances/import/preview", handler(async (request, response) => {
    const body = request.body || {};
    response.json({ ok: true, preview: await transfer.preview(body.bundle, body.password) });
  }));
  app.post("/api/instances/import", handler(async (request, response) => {
    const body = request.body || {};
    const instance = await transfer.import(body.bundle, body.password, body.id, body.name);
    response.status(201).json({ ok: true, instance, runtime: workerManager.runtimeFor(instance.id) });
  }));
}
