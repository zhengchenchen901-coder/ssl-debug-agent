$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
try {
  $inputJson = [Console]::In.ReadToEnd()
  if ($inputJson.Length -gt 65536) { throw 'oversized request' }
  $request = $inputJson | ConvertFrom-Json
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Diagnostics;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public sealed class RdaPrivacyException : Exception {
  public string Code { get; private set; }
  public RdaPrivacyException(string code) : base(code) { Code = code; }
}
public static class RdaWindowsPrivacy {
  const string PathError = "BUSINESS_STORAGE_PATH_INVALID";
  const string KeyError = "BUSINESS_KEYSTORE_UNAVAILABLE";
  const string ContextError = "BUSINESS_CONTEXT_DENIED";
  static SecurityIdentifier Sid { get { return WindowsIdentity.GetCurrent().User; } }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct Credential {
    public uint Flags, Type;
    public string TargetName, Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist, AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias, UserName;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct FileInformation {
    public uint Attributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CredWriteW(ref Credential credential, uint flags);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr buffer);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInformation info);

  static void Reject(string code) { throw new RdaPrivacyException(code); }
  static DirectorySecurity DirectoryAcl() {
    var acl = new DirectorySecurity(); acl.SetOwner(Sid); acl.SetAccessRuleProtection(true, false);
    acl.AddAccessRule(new FileSystemAccessRule(Sid, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
    return acl;
  }
  static FileSecurity FileAcl(bool setOwner = true) {
    var acl = new FileSecurity(); if (setOwner) acl.SetOwner(Sid); acl.SetAccessRuleProtection(true, false);
    acl.AddAccessRule(new FileSystemAccessRule(Sid, FileSystemRights.FullControl, AccessControlType.Allow)); return acl;
  }
  static void CheckAcl(FileSystemSecurity acl, string code, bool protectedAcl) {
    if (acl.GetOwner(typeof(SecurityIdentifier)).Value != Sid.Value || protectedAcl && !acl.AreAccessRulesProtected) Reject(code);
    bool full = false;
    foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier))) {
      if (rule.AccessControlType != AccessControlType.Allow) continue;
      if (rule.IdentityReference.Value != Sid.Value) Reject(code);
      if ((rule.FileSystemRights & FileSystemRights.FullControl) == FileSystemRights.FullControl) full = true;
    }
    if (!full) Reject(code);
  }
  public static string ValidatePath(string value) {
    string full = Path.GetFullPath(value), root = Path.GetPathRoot(full);
    if (String.IsNullOrEmpty(root) || root.StartsWith(@"\\") || full.Substring(root.Length).Contains(":")) Reject(PathError);
    if (Regex.IsMatch(full, @"[\\/](CloudStorage|Mobile Documents|Dropbox|OneDrive)([\\/]|$)|[\\/]plugins[\\/]cache([\\/]|$)", RegexOptions.IgnoreCase)) Reject(PathError);
    foreach (string name in new string[] { "OneDrive", "OneDriveConsumer", "OneDriveCommercial" }) {
      string sync = Environment.GetEnvironmentVariable(name);
      if (!String.IsNullOrEmpty(sync)) {
        sync = Path.GetFullPath(sync).TrimEnd('\\');
        if (String.Equals(full, sync, StringComparison.OrdinalIgnoreCase) || full.StartsWith(sync + "\\", StringComparison.OrdinalIgnoreCase)) Reject(PathError);
      }
    }
    var drive = new DriveInfo(root);
    if (drive.DriveType != DriveType.Fixed || !(String.Equals(drive.DriveFormat, "NTFS", StringComparison.OrdinalIgnoreCase) || String.Equals(drive.DriveFormat, "ReFS", StringComparison.OrdinalIgnoreCase))) Reject(PathError);
    for (string entry = full; entry != null; entry = Path.GetDirectoryName(entry)) {
      if ((Directory.Exists(entry) || File.Exists(entry)) && (File.GetAttributes(entry) & FileAttributes.ReparsePoint) != 0) Reject(PathError);
      if (entry == root) break;
    }
    return full;
  }
  public static void PrepareDirectory(string directory) {
    directory = ValidatePath(directory);
    if (!Directory.Exists(directory)) Directory.CreateDirectory(directory, DirectoryAcl());
    var item = new DirectoryInfo(directory);
    var existing = item.GetAccessControl(AccessControlSections.Access | AccessControlSections.Owner);
    if (existing.GetOwner(typeof(SecurityIdentifier)).Value != Sid.Value) Reject(PathError);
    if (Directory.GetFileSystemEntries(directory).Length != 0) CheckAcl(existing, PathError, false);
    // Same owner only; protect the private leaf before any sensitive file is created.
    item.SetAccessControl(DirectoryAcl());
    CheckAcl(item.GetAccessControl(AccessControlSections.Access | AccessControlSections.Owner), PathError, true);
  }
  static void CheckHandle(FileStream stream, string code, bool protect) {
    FileInformation info;
    if (!GetFileInformationByHandle(stream.SafeFileHandle, out info) || info.Links != 1 || (info.Attributes & ((uint)FileAttributes.ReparsePoint | (uint)FileAttributes.Directory)) != 0) Reject(code);
    var acl = stream.GetAccessControl();
    CheckAcl(acl, code, false);
    if (protect) { stream.SetAccessControl(FileAcl(false)); CheckAcl(stream.GetAccessControl(), code, true); }
  }
  static bool HasDatabase(string directory) {
    foreach (string suffix in new string[] { "", "-wal", "-shm" }) if (File.Exists(Path.Combine(directory, "privacy.sqlite" + suffix))) return true;
    return false;
  }
  public static bool PrepareStore(string directory) {
    PrepareDirectory(directory); ProtectStore(directory); return HasDatabase(directory);
  }
  public static void ProtectStore(string directory) {
    directory = ValidatePath(directory);
    CheckAcl(new DirectoryInfo(directory).GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access), PathError, true);
    foreach (string suffix in new string[] { "", "-wal", "-shm" }) {
      string file = Path.Combine(directory, "privacy.sqlite" + suffix);
      if (!File.Exists(file)) { if (Directory.Exists(file)) Reject(PathError); continue; }
      ValidatePath(file);
      using (var stream = new FileStream(file, FileMode.Open, FileSystemRights.ReadData | FileSystemRights.ReadAttributes | FileSystemRights.ReadPermissions | FileSystemRights.ChangePermissions, FileShare.ReadWrite | FileShare.Delete, 4096, FileOptions.None)) CheckHandle(stream, PathError, true);
    }
  }
  static FileStream OpenExclusive(string file, bool create) {
    var timeout = Stopwatch.StartNew();
    while (true) {
      try {
        ValidatePath(file);
        if (create) return new FileStream(file, FileMode.CreateNew, FileSystemRights.FullControl, FileShare.None, 4096, FileOptions.WriteThrough, FileAcl());
        return new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.None, 4096, FileOptions.None);
      } catch (IOException error) {
        int code = error.HResult & 0xffff;
        if ((code != 32 && code != 33) || timeout.ElapsedMilliseconds > 10000) throw;
        Thread.Sleep(50);
      }
    }
  }
  static byte[] ReadCredential(string target, out bool missing) {
    IntPtr buffer = IntPtr.Zero; missing = false;
    if (!CredReadW(target, 1, 0, out buffer)) {
      int error = Marshal.GetLastWin32Error();
      if (error == 1168) { missing = true; return null; }
      Reject(KeyError);
    }
    Credential value = new Credential();
    try {
      value = (Credential)Marshal.PtrToStructure(buffer, typeof(Credential));
      if (value.Type != 1 || value.Persist != 2 || value.CredentialBlobSize != 32 || value.CredentialBlob == IntPtr.Zero) Reject(KeyError);
      byte[] key = new byte[32]; Marshal.Copy(value.CredentialBlob, key, 0, 32); return key;
    } finally {
      if (value.CredentialBlob != IntPtr.Zero && value.CredentialBlobSize <= 2560) for (int i = 0; i < value.CredentialBlobSize; i++) Marshal.WriteByte(value.CredentialBlob, i, 0);
      if (buffer != IntPtr.Zero) CredFree(buffer);
    }
  }
  static FileStream KeyLock(string directory) {
    string file = Path.Combine(directory, ".key-init.lock"); var timer = Stopwatch.StartNew();
    while (true) {
      try {
        ValidatePath(file);
        var stream = new FileStream(file, FileMode.OpenOrCreate, FileSystemRights.FullControl, FileShare.None, 4096, FileOptions.WriteThrough, FileAcl());
        try { CheckHandle(stream, PathError, true); return stream; } catch { stream.Dispose(); throw; }
      } catch (IOException error) {
        int code = error.HResult & 0xffff;
        if ((code != 32 && code != 33) || timer.ElapsedMilliseconds > 10000) Reject("BUSINESS_KEYSTORE_BUSY");
        Thread.Sleep(50);
      }
    }
  }
  public static byte[] LoadKey(string directory, string target, bool existing) {
    PrepareStore(directory);
    if (!Regex.IsMatch(target, @"^RemoteDebugAgent/business-privacy/v1/[a-f0-9]{64}$")) Reject(KeyError);
    using (var fileLock = KeyLock(directory)) {
      bool missing; byte[] key = ReadCredential(target, out missing);
      if (!missing) return key;
      if (existing || HasDatabase(directory)) Reject("BUSINESS_KEYSTORE_MISSING");
      key = new byte[32]; using (var random = RandomNumberGenerator.Create()) random.GetBytes(key);
      IntPtr blob = Marshal.AllocCoTaskMem(32);
      try {
        Marshal.Copy(key, 0, blob, 32);
        var value = new Credential { Type = 1, TargetName = target, CredentialBlobSize = 32, CredentialBlob = blob, Persist = 2, UserName = Sid.Value };
        if (!CredWriteW(ref value, 0)) Reject(KeyError);
        return ReadCredential(target, out missing);
      } finally { Array.Clear(key, 0, key.Length); for (int i = 0; i < 32; i++) Marshal.WriteByte(blob, i, 0); Marshal.FreeCoTaskMem(blob); }
    }
  }
  public static string ReadContext(string filename) {
    filename = ValidatePath(filename);
    using (var stream = OpenExclusive(filename, false)) {
      CheckHandle(stream, ContextError, false);
      if (stream.Length > 16384) Reject(ContextError);
      using (var reader = new StreamReader(stream, new UTF8Encoding(false, true), false, 4096, true)) return reader.ReadToEnd();
    }
  }
  public static bool CreateContext(string filename, string content) {
    filename = ValidatePath(filename);
    if (Encoding.UTF8.GetByteCount(content) > 16384) Reject(ContextError);
    try {
      using (var stream = OpenExclusive(filename, true)) {
        CheckHandle(stream, ContextError, true);
        byte[] bytes = Encoding.UTF8.GetBytes(content);
        try { stream.Write(bytes, 0, bytes.Length); stream.Flush(true); }
        finally { Array.Clear(bytes, 0, bytes.Length); }
      }
      return true;
    } catch (IOException error) { if ((error.HResult & 0xffff) == 80 || (error.HResult & 0xffff) == 183) return false; throw; }
  }
}
'@
  $result = @{ ok = $true }
  switch ($request.action) {
    'prepare-store' { $result.existing = [RdaWindowsPrivacy]::PrepareStore([string]$request.directory) }
    'protect-store' { [RdaWindowsPrivacy]::ProtectStore([string]$request.directory) }
    'prepare-context' { [RdaWindowsPrivacy]::PrepareDirectory([string]$request.directory) }
    'read-context' { $result.content = [RdaWindowsPrivacy]::ReadContext([string]$request.filename) }
    'create-context' { $result.created = [RdaWindowsPrivacy]::CreateContext([string]$request.filename, [string]$request.content) }
    'key' {
      $key = [RdaWindowsPrivacy]::LoadKey([string]$request.directory, [string]$request.target, [bool]$request.existing)
      try { $result.key = [BitConverter]::ToString($key).Replace('-', '').ToLowerInvariant() }
      finally { [Array]::Clear($key, 0, $key.Length) }
    }
    default { throw 'invalid action' }
  }
  [Console]::WriteLine(($result | ConvertTo-Json -Compress))
} catch {
  $code = 'BUSINESS_STORAGE_UNAVAILABLE'
  if ($request.action -eq 'key') { $code = 'BUSINESS_KEYSTORE_UNAVAILABLE' }
  elseif ($request.action -like '*context') { $code = 'BUSINESS_CONTEXT_DENIED' }
  elseif ($request.action -in @('prepare-store', 'protect-store')) { $code = 'BUSINESS_STORAGE_PATH_INVALID' }
  for ($errorValue = $_.Exception; $null -ne $errorValue; $errorValue = $errorValue.InnerException) {
    if ($errorValue.Code -match '^BUSINESS_[A-Z_]+$') { $code = $errorValue.Code; break }
  }
  [Console]::WriteLine((@{ ok = $false; code = $code } | ConvertTo-Json -Compress))
}
