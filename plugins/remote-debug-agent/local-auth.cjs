"use strict";
// Shared by the bundled manager and the dependency-free MCP/diagnostic launchers.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

function authError(message, code = "LOCAL_AUTH_STORAGE_UNSAFE", statusCode = 503) {
  const error = new Error(message);
  Object.assign(error, { code, statusCode, retriable: false });
  return error;
}

function resolveAuthFile(dataDir, env = process.env) {
  return path.resolve(dataDir, env.REMOTE_DEBUG_AUTH_FILE || path.join(".runtime", "http-auth.json"));
}

const aclScript = `
$ErrorActionPreference = 'Stop'
$target = $env:RDA_AUTH_ACL_TARGET
$item = Get-Item -LiteralPath $target -Force
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point rejected' }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
if ($env:RDA_AUTH_ACL_ACTION -eq 'protect') {
  if ($item.PSIsContainer) {
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  } else {
    $acl = New-Object Security.AccessControl.FileSecurity
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')
  }
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $target -AclObject $acl
}
$actual = Get-Acl -LiteralPath $target
if (-not $actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Unsafe owner or inheritance' }
$rules = $actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
$full = $false
foreach ($rule in $rules) {
  if ($rule.AccessControlType -eq 'Allow') {
    if ($rule.IdentityReference.Value -ne $sid.Value) { throw 'Other principal can access credential' }
    if (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl) { $full = $true }
  }
}
if (-not $full) { throw 'Owner lacks access' }
`;

function protectOrCheck(target, directory, protect) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
    throw authError("authentication storage must be a regular file in a protected directory");
  }
  if (process.platform === "win32") {
    try {
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", aclScript], {
        env: { ...process.env, RDA_AUTH_ACL_TARGET: target, RDA_AUTH_ACL_ACTION: protect ? "protect" : "check" },
        stdio: "pipe", windowsHide: true, timeout: 15_000,
      });
    } catch {
      throw authError("could not establish or verify owner-only authentication storage ACL");
    }
  } else {
    if (stat.uid !== process.getuid()) throw authError("authentication storage is owned by another user");
    if (protect) fs.chmodSync(target, directory ? 0o700 : 0o600);
    if ((fs.statSync(target).mode & 0o777) !== (directory ? 0o700 : 0o600)) {
      throw authError("authentication storage requires owner-only permissions");
    }
  }
}

function readAuthToken(filePath) {
  try {
    protectOrCheck(path.dirname(filePath), true, false);
    protectOrCheck(filePath, false, false);
    const stat = fs.statSync(filePath);
    if (stat.size > 1024) throw authError("authentication credential file is invalid");
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.token)) throw authError("authentication credential file is invalid");
    return value.token;
  } catch (error) {
    if (error.code === "LOCAL_AUTH_STORAGE_UNSAFE") throw error;
    throw authError("authentication credential file is missing or invalid");
  }
}

function ensureAuthToken(filePath) {
  const directory = path.dirname(filePath);
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    protectOrCheck(directory, true, true);
    if (fs.existsSync(filePath)) return readAuthToken(filePath);
    const token = crypto.randomBytes(32).toString("hex");
    const temporaryPath = path.join(directory, `.http-auth-${process.pid}-${crypto.randomBytes(16).toString("hex")}.tmp`);
    try {
      const fd = fs.openSync(temporaryPath, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify({ version: 1, token }) + "\n", "utf8");
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      protectOrCheck(temporaryPath, false, true);
      try { fs.linkSync(temporaryPath, filePath); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
    } finally { try { fs.unlinkSync(temporaryPath); } catch {} }
    return readAuthToken(filePath);
  } catch (error) {
    if (error.code === "LOCAL_AUTH_STORAGE_UNSAFE") throw error;
    throw authError("could not initialize protected authentication storage");
  }
}

function tokenMatches(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function healthProof(token, nonce, origin) {
  return crypto.createHmac("sha256", token).update("remote-debug-health-v1\n" + nonce + "\n" + origin).digest("hex");
}

function verifyHealthProof(token, nonce, origin, health) {
  if (!tokenMatches(health && health.authProof, healthProof(token, nonce, origin))) {
    throw authError("Agent did not prove ownership of the configured local credential", "LOCAL_AUTH_INVALID", 401);
  }
}

function validateAgentUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw authError("invalid Agent URL", "LOCAL_AUTH_INVALID", 400); }
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.hash || url.search || !["http:", "https:"].includes(url.protocol) || (!local && url.protocol !== "https:")) {
    throw authError("Agent URL requires HTTPS outside loopback and cannot contain credentials", "LOCAL_AUTH_INVALID", 400);
  }
  if (url.protocol === "http:" && url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url;
}

module.exports = { authError, resolveAuthFile, readAuthToken, ensureAuthToken, tokenMatches, validateAgentUrl, healthProof, verifyHealthProof };
