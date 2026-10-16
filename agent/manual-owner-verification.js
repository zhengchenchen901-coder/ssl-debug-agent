import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import localAuth from "../plugins/remote-debug-agent/local-auth.cjs";
import { manualError } from "./manual-auth.js";

const execute = promisify(execFile);
const moduleDirectory = typeof __dirname === "string" ? __dirname : path.dirname(fileURLToPath(import.meta.url));

export class ManualOwnerVerification {
  constructor(directory, options = {}) {
    this.directory = directory;
    this.platform = options.platform || process.platform;
    this.execute = options.execute || execute;
    this.nativeDirectory = options.nativeDirectory || path.join(moduleDirectory, "native");
  }

  status() {
    const supported = ["darwin", "win32"].includes(this.platform);
    return { supported, method: this.platform === "darwin" ? "macos-local-authentication" : this.platform === "win32" ? "windows-credentials" : "unavailable",
      message: supported ? "注册时会弹出系统身份验证窗口；电脑密码不会提交到网页。" : "此平台暂未接入本机身份验证，暂不能注册管理员。" };
  }

  async macHelper() {
    const source = path.join(this.nativeDirectory, "verify-owner.swift");
    const hash = createHash("sha256").update(fs.readFileSync(source)).update(process.arch).digest("hex").slice(0, 24);
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    localAuth.protectOrCheck(this.directory, true, true);
    const helper = path.join(this.directory, `verify-owner-${hash}`);
    if (!fs.existsSync(helper)) {
      const temporary = `${helper}-${randomBytes(8).toString("hex")}`;
      try {
        await this.execute("/usr/bin/xcrun", ["swiftc", source, "-O", "-o", temporary], { timeout: 60_000, maxBuffer: 64 * 1024, signal: this.controller?.signal });
        fs.chmodSync(temporary, 0o700);
        fs.renameSync(temporary, helper);
      } catch {
        throw manualError("OWNER_HELPER_UNAVAILABLE", "无法准备系统认证组件。macOS 首次使用需要已安装 Xcode Command Line Tools。", 503);
      } finally { fs.rmSync(temporary, { force: true }); }
    }
    const stat = fs.lstatSync(helper);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) {
      throw manualError("OWNER_HELPER_UNSAFE", "系统认证组件的权限无效。", 503);
    }
    return helper;
  }

  async verify() {
    if (!this.status().supported) throw manualError("OWNER_VERIFICATION_UNSUPPORTED", this.status().message, 503);
    const nonce = randomBytes(32).toString("hex");
    const controller = new AbortController();
    this.controller = controller;
    let result;
    try {
      if (this.platform === "darwin") {
        result = await this.execute(await this.macHelper(), [nonce], { timeout: 120_000, maxBuffer: 4096, signal: controller.signal });
      } else {
        const windowsRoot = process.env.SystemRoot || "C:\\Windows";
        result = await this.execute(path.join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
          ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(this.nativeDirectory, "verify-owner.ps1"), "-Nonce", nonce],
          { timeout: 120_000, maxBuffer: 4096, windowsHide: true, signal: controller.signal });
      }
    } catch (error) {
      if (error.code === "OWNER_HELPER_UNAVAILABLE" || error.code === "OWNER_HELPER_UNSAFE") throw error;
      throw manualError("OWNER_VERIFICATION_FAILED", "系统身份验证未通过或已取消。", 403);
    } finally { if (this.controller === controller) this.controller = null; }
    let proof;
    try { proof = JSON.parse(result.stdout.trim()); } catch { /* fixed error below */ }
    if (proof?.verified !== true || proof.nonce !== nonce || (this.platform === "darwin" && proof.uid !== process.getuid())) {
      throw manualError("OWNER_VERIFICATION_FAILED", "系统身份验证未通过。", 403);
    }
  }

  cancel() { this.controller?.abort(); }
}
