"use strict";
// Windows-only adapter. Keep PowerShell modules and POSIX permission handling separate.
const path = require("path");
const { execFileSync } = require("child_process");

const aclScript = `
$ErrorActionPreference = 'Stop'
$target = $env:RDA_AUTH_ACL_TARGET
$attributes = [IO.File]::GetAttributes($target)
if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point rejected' }
$directory = ($attributes -band [IO.FileAttributes]::Directory) -ne 0
if ($directory) { $item = New-Object IO.DirectoryInfo($target) }
else { $item = New-Object IO.FileInfo($target) }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
if ($env:RDA_AUTH_ACL_ACTION -eq 'protect') {
  if ($directory) {
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  } else {
    $acl = New-Object Security.AccessControl.FileSecurity
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')
  }
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  $acl.AddAccessRule($rule)
  # Persist only the modified owner/DACL sections. Set-Acl can request SACL privileges.
  $item.SetAccessControl($acl)
}
# Do not autoload PowerShell.Security from an inherited PowerShell 7 module path.
$sections = [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Access
$actual = $item.GetAccessControl($sections)
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

function protectOrCheckWindows(target, protect) {
  const root = process.env.SystemRoot || process.env.WINDIR;
  if (!root || !path.isAbsolute(root)) throw new Error("Windows system directory is unavailable");
  const executable = path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  execFileSync(executable, ["-NoProfile", "-NonInteractive", "-Command", aclScript], {
    env: { ...process.env, RDA_AUTH_ACL_TARGET: target, RDA_AUTH_ACL_ACTION: protect ? "protect" : "check" },
    stdio: "pipe", windowsHide: true, timeout: 15_000,
  });
}

module.exports = { protectOrCheckWindows };
