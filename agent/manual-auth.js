import fs from "node:fs";
import path from "node:path";
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import localAuth from "../plugins/remote-debug-agent/local-auth.cjs";

const scrypt = promisify(scryptCallback);
const USERNAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const HASH_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function manualError(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}

export function validateAdminCredentials(username, password) {
  if (typeof username !== "string" || !USERNAME.test(username)) {
    throw manualError("ADMIN_USERNAME_INVALID", "账号须为 3–64 位字母、数字、下划线、点或短横线，并以字母或数字开头。");
  }
  if (typeof password !== "string" || password.length < 12 || Buffer.byteLength(password) > 256) {
    throw manualError("ADMIN_PASSWORD_INVALID", "管理员密码至少 12 个字符，最多 256 字节。");
  }
}

// Single Manager owns this file. No passwords or session tokens are persisted.
export class ManualAdminStore {
  constructor(directory) {
    this.directory = directory;
    this.filePath = path.join(directory, "accounts.json");
  }

  protectDirectory() {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    localAuth.protectOrCheck(this.directory, true, true);
  }

  read() {
    if (!fs.existsSync(this.directory)) return [];
    localAuth.protectOrCheck(this.directory, true, false);
    if (!fs.existsSync(this.filePath)) return [];
    localAuth.protectOrCheck(this.filePath, false, false);
    const stat = fs.lstatSync(this.filePath);
    if (stat.nlink !== 1 || stat.size > 64 * 1024) throw manualError("ADMIN_STORAGE_INVALID", "管理员存储无效。", 503);
    const value = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    if (value.version !== 1 || !Array.isArray(value.accounts) || value.accounts.length > 10 ||
        new Set(value.accounts.map((a) => a?.username)).size !== value.accounts.length ||
        value.accounts.some((a) => !USERNAME.test(a?.username || "") || !HEX64.test(a.salt || "") || !/^[a-f0-9]{128}$/.test(a.hash || ""))) {
      throw manualError("ADMIN_STORAGE_INVALID", "管理员存储无效。", 503);
    }
    return value.accounts;
  }

  async verify(username, password) {
    if (typeof username !== "string" || typeof password !== "string" || Buffer.byteLength(password) > 256) return false;
    const account = this.read().find((item) => item.username === username);
    // Unknown accounts incur the same password hashing work.
    const actual = await scrypt(password, account?.salt || "0".repeat(64), 64, HASH_OPTIONS);
    const expected = Buffer.from(account?.hash || "0".repeat(128), "hex");
    return timingSafeEqual(actual, expected) && Boolean(account);
  }

  async register(username, password) {
    validateAdminCredentials(username, password);
    const salt = randomBytes(32).toString("hex");
    const hash = (await scrypt(password, salt, 64, HASH_OPTIONS)).toString("hex");
    const accounts = this.read();
    if (accounts.some((account) => account.username === username)) throw manualError("ADMIN_EXISTS", "管理员账号已存在。", 409);
    if (accounts.length >= 10) throw manualError("ADMIN_LIMIT", "最多注册 10 个管理员。", 409);
    this.save([...accounts, { username, salt, hash, createdAt: new Date().toISOString() }]);
  }

  async reset(username, password) {
    validateAdminCredentials(username, password);
    const salt = randomBytes(32).toString("hex");
    const hash = (await scrypt(password, salt, 64, HASH_OPTIONS)).toString("hex");
    const accounts = this.read();
    if (!accounts.some((account) => account.username === username)) throw manualError("ADMIN_NOT_FOUND", "管理员账号不存在。", 404);
    this.save(accounts.map((account) => account.username === username ? { ...account, salt, hash, updatedAt: new Date().toISOString() } : account));
  }

  save(accounts) {
    this.protectDirectory();
    const temporaryPath = path.join(this.directory, `.accounts-${randomBytes(16).toString("hex")}.tmp`);
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify({ version: 1, accounts }) + "\n", { flag: "wx", mode: 0o600 });
      localAuth.protectOrCheck(temporaryPath, false, true);
      fs.renameSync(temporaryPath, this.filePath);
    } finally {
      fs.rmSync(temporaryPath, { force: true });
    }
  }
}

export class ManualLoginLimiter {
  constructor(now = Date.now) {
    this.now = now;
    this.failures = 0;
    this.windowStart = now();
    this.inFlight = 0;
  }

  async run(action) {
    if (this.now() - this.windowStart >= 5 * 60_000) { this.failures = 0; this.windowStart = this.now(); }
    if (this.failures >= 5 || this.inFlight >= 2) throw manualError("ADMIN_LOGIN_LIMITED", "尝试过于频繁，请稍后重试。", 429);
    this.inFlight++;
    try {
      const result = await action();
      if (!result) this.failures++;
      return result;
    } finally { this.inFlight--; }
  }
}
