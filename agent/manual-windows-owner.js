import path from "node:path";
import { manualError } from "./manual-auth.js";

function proofFrom(stdout, nonce) {
  try {
    const proof = JSON.parse(stdout.trim());
    return proof?.nonce === nonce ? proof : null;
  } catch { return null; }
}

function verificationError(proof) {
  const nativeCode = Number.isInteger(proof?.nativeError) && proof.nativeError > 0 ? `（Windows 错误 ${proof.nativeError}）` : "";
  switch (proof?.reason) {
    case "cancelled": return manualError("OWNER_VERIFICATION_CANCELLED", "已取消 Windows 身份验证，请重试。", 403);
    case "prompt-error": return manualError("OWNER_WINDOWS_PROMPT_FAILED", `无法打开 Windows 身份验证窗口${nativeCode}，请在已登录的本机桌面重试。`, 503);
    case "unpack-error": return manualError("OWNER_WINDOWS_UNPACK_FAILED", `无法解析 Windows 返回的凭据${nativeCode}，请选择当前 Windows 账户的密码登录方式后重试。`, 503);
    case "logon-error": return manualError("OWNER_WINDOWS_LOGON_FAILED", `Windows 拒绝了账户登录${nativeCode}。请确认系统窗口中的账户是当前 Windows 用户，并输入该账户的登录密码（不是 PIN 或新管理员密码）。`, 403);
    case "identity-mismatch": return manualError("OWNER_WINDOWS_IDENTITY_MISMATCH", "验证的账户与运行插件的 Windows 用户不一致，请使用当前 Windows 用户的账户。", 403);
    case "unavailable": return manualError("OWNER_WINDOWS_DESKTOP_UNAVAILABLE", "Windows 本机验证需要已登录的交互式桌面，请从当前用户的桌面启动插件。", 503);
    default: return manualError("OWNER_VERIFICATION_FAILED", "Windows 系统身份验证未通过，请重试。", 403);
  }
}

async function invoke(execute, nativeDirectory, args, signal, timeout) {
  const root = process.env.SystemRoot || "C:\\Windows";
  return execute(path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", path.join(nativeDirectory, "verify-owner.ps1"), ...args],
    { timeout, maxBuffer: 4096, windowsHide: true, signal });
}

export async function prepareWindowsOwner(execute, nativeDirectory, signal) {
  let result;
  try { result = JSON.parse((await invoke(execute, nativeDirectory, ["-Check"], signal, 20000)).stdout.trim()); }
  catch { throw manualError("OWNER_WINDOWS_HELPER_UNAVAILABLE", "Windows 身份验证组件无法启动，请检查系统 Windows PowerShell 和本机桌面环境。", 503); }
  if (result?.available !== true || result?.verified === true) throw manualError("OWNER_WINDOWS_HELPER_UNAVAILABLE", "Windows 身份验证组件不可用，请在已登录的本机桌面重试。", 503);
}

export async function verifyWindowsOwner(execute, nativeDirectory, nonce, signal) {
  let result;
  try { result = await invoke(execute, nativeDirectory, ["-Nonce", nonce], signal, 120000); }
  catch (error) {
    if (error.name === "AbortError") throw manualError("OWNER_VERIFICATION_CANCELLED", "已取消 Windows 身份验证，请重试。", 403);
    if (error.killed) throw manualError("OWNER_VERIFICATION_TIMEOUT", "Windows 身份验证超时，请重试。", 403);
    const proof = proofFrom(error.stdout || "", nonce);
    if (proof?.verified === false) throw verificationError(proof);
    throw manualError("OWNER_WINDOWS_HELPER_FAILED", "Windows 身份验证组件执行失败，请关闭注册窗口后重试。", 503);
  }
  const proof = proofFrom(result.stdout, nonce);
  if (proof?.verified !== true) throw verificationError(proof);
  return result;
}
