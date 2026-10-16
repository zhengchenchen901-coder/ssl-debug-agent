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
    this.preparing = null;
    this.architecture = options.architecture || process.arch;
    this.nativeArchitecture = null;
  }

  status() {
    const supported = ["darwin", "win32"].includes(this.platform);
    return { supported, method: this.platform === "darwin" ? "macos-local-authentication" : this.platform === "win32" ? "windows-credentials" : "unavailable",
      message: supported ? "注册时会弹出系统身份验证窗口；电脑密码不会提交到网页。" : "此平台暂未接入本机身份验证，暂不能注册管理员。" };
  }

  async macArchitecture() {
    if (this.nativeArchitecture) return this.nativeArchitecture;
    if (this.architecture === "arm64") return this.nativeArchitecture = "arm64";
    // A Rosetta Node process reports x64 even on Apple Silicon. The installed
    // Command Line Tools may only contain ARM slices, so inspect the hardware.
    try {
      const result = await this.execute("/usr/sbin/sysctl", ["-n", "hw.optional.arm64"], { timeout: 5000, maxBuffer: 4096, signal: this.controller?.signal });
      this.nativeArchitecture = result.stdout.trim() === "1" ? "arm64" : "x86_64";
    } catch (error) {
      if (error.name === "AbortError") throw error;
      this.nativeArchitecture = "x86_64";
    }
    return this.nativeArchitecture;
  }

  async executeMac(command, args, options) {
    if (await this.macArchitecture() === "arm64") {
      return this.execute("/usr/bin/arch", ["-arm64", command, ...args], options);
    }
    return this.execute(command, args, options);
  }

  async macHelper() {
    const source = path.join(this.nativeDirectory, "verify-owner.swift");
    const hash = createHash("sha256").update("macos-owner-helper-v2\0").update(fs.readFileSync(source)).update(await this.macArchitecture()).digest("hex").slice(0, 24);
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    localAuth.protectOrCheck(this.directory, true, true);
    const helper = path.join(this.directory, `verify-owner-${hash}`);
    if (!fs.existsSync(helper)) {
      const temporary = `${helper}-${randomBytes(8).toString("hex")}`;
      let stage = "compiler";
      try {
        await this.executeMac("/usr/bin/xcrun", ["--find", "swiftc"], { timeout: 10_000, maxBuffer: 4096, signal: this.controller?.signal });
        stage = "compile";
        await this.executeMac("/usr/bin/xcrun", ["swiftc", source, "-O", "-o", temporary], { timeout: 60_000, maxBuffer: 64 * 1024, signal: this.controller?.signal });
        stage = "install";
        fs.chmodSync(temporary, 0o700);
        fs.renameSync(temporary, helper);
      } catch (error) {
        if (error.name === "AbortError") throw manualError("OWNER_HELPER_CANCELLED", "系统认证组件准备已取消，请重试。", 503);
        if (stage === "compiler") {
          const code = Number.isInteger(error.code) || (typeof error.code === "string" && /^[A-Z_]{1,64}$/.test(error.code)) ? String(error.code) : "UNKNOWN";
          throw manualError("OWNER_COMPILER_UNAVAILABLE", `无法启动 Swift 编译器检查（${code}）。请检查 Xcode Command Line Tools、xcode-select 配置和插件进程权限。`, 503);
        }
        if (stage === "install") throw manualError("OWNER_HELPER_INSTALL_FAILED", "认证组件已编译，但无法写入缓存。请检查本地认证目录的所有权与权限。", 503);
        if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw manualError("OWNER_HELPER_COMPILE_FAILED", "Swift 编译器返回过多诊断信息，认证组件未生成。", 503);
        if (error.killed) throw manualError("OWNER_HELPER_COMPILE_TIMEOUT", "Swift 编译认证组件超时，请稍后重试。", 503);
        const exit = Number.isInteger(error.code) ? `（退出码 ${error.code}）` : "";
        throw manualError("OWNER_HELPER_COMPILE_FAILED", `Swift 编译认证组件失败${exit}。编译器已找到，请检查系统 SDK 与命令行工具是否匹配。`, 503);
      } finally { fs.rmSync(temporary, { force: true }); }
    }
    const stat = fs.lstatSync(helper);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) {
      throw manualError("OWNER_HELPER_UNSAFE", "系统认证组件的权限无效。", 503);
    }
    return helper;
  }

  async prepare() {
    if (!this.status().supported) throw manualError("OWNER_VERIFICATION_UNSUPPORTED", this.status().message, 503);
    if (this.preparing) return this.preparing;
    this.preparing = this.prepareOnce().finally(() => { this.preparing = null; });
    return this.preparing;
  }

  async prepareOnce() {
    if (this.platform !== "darwin") return { ...this.status(), prepared: true };
    const controller = new AbortController();
    this.controller = controller;
    try {
      const helper = await this.macHelper();
      let result;
      try { result = JSON.parse((await this.executeMac(helper, ["--check"], { timeout: 10_000, maxBuffer: 4096, signal: controller.signal })).stdout.trim()); }
      catch { throw manualError("OWNER_HELPER_CHECK_FAILED", "系统认证组件无法启动或系统身份验证暂不可用，请在已登录的本机桌面重试。", 503); }
      if (result?.available !== true) throw manualError("OWNER_HELPER_CHECK_FAILED", "系统身份验证暂不可用，请在已登录的本机桌面重试。", 503);
      return { ...this.status(), prepared: true, processArchitecture: this.architecture, nativeArchitecture: await this.macArchitecture() };
    } finally { if (this.controller === controller) this.controller = null; }
  }

  async verify() {
    if (!this.status().supported) throw manualError("OWNER_VERIFICATION_UNSUPPORTED", this.status().message, 503);
    const nonce = randomBytes(32).toString("hex");
    const controller = new AbortController();
    // Never let registration replace a still-running preparation controller.
    if (this.preparing) await this.preparing;
    this.controller = controller;
    let result;
    try {
      if (this.platform === "darwin") {
        result = await this.executeMac(await this.macHelper(), [nonce], { timeout: 120_000, maxBuffer: 4096, signal: controller.signal });
      } else {
        const windowsRoot = process.env.SystemRoot || "C:\\Windows";
        result = await this.execute(path.join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
          ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(this.nativeDirectory, "verify-owner.ps1"), "-Nonce", nonce],
          { timeout: 120_000, maxBuffer: 4096, windowsHide: true, signal: controller.signal });
      }
    } catch (error) {
      if (/^OWNER_(HELPER_|COMPILER_)/.test(error.code || "")) throw error;
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
