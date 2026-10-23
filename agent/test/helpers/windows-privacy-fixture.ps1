# Test-only native fault injection. Never shipped in the plugin runtime.
$ErrorActionPreference = 'Stop'
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
if ($request.target -notmatch '^RemoteDebugAgent/business-privacy/v1/[a-f0-9]{64}$' -or
    [IO.Path]::GetFileName([string]$request.directory) -notlike 'rda-win-privacy-test-*') { throw 'Test fixture scope required' }
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Runtime.InteropServices;
public static class RdaCredentialFixture {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct Credential {
    public uint Flags, Type; public string TargetName, Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize; public IntPtr CredentialBlob;
    public uint Persist, AttributeCount; public IntPtr Attributes; public string TargetAlias, UserName;
  }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredDeleteW(string target, uint type, uint flags);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredReadW(string target, uint type, uint flags, out IntPtr value);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredWriteW(ref Credential value, uint flags);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr value);
  public static bool Exists(string target) {
    IntPtr value; if (CredReadW(target, 1, 0, out value)) { CredFree(value); return true; }
    if (Marshal.GetLastWin32Error() == 1168) return false; throw new Exception("Credential fixture unavailable");
  }
  public static void Delete(string target) { if (!CredDeleteW(target, 1, 0) && Marshal.GetLastWin32Error() != 1168) throw new Exception("Test credential cleanup failed"); }
  public static void Corrupt(string target) {
    IntPtr blob = Marshal.AllocCoTaskMem(1);
    try { Marshal.WriteByte(blob, 0); var value = new Credential { Type=1, TargetName=target, CredentialBlobSize=1, CredentialBlob=blob, Persist=2 }; if (!CredWriteW(ref value, 0)) throw new Exception("Test credential injection failed"); }
    finally { Marshal.FreeCoTaskMem(blob); }
  }
  public static void Broaden(string file) {
    var info = new FileInfo(file); var acl = info.GetAccessControl();
    acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.WorldSid, null), FileSystemRights.Read, AccessControlType.Allow)); info.SetAccessControl(acl);
  }
  public static void Hold(string directory) {
    using (var stream = new FileStream(Path.Combine(directory, ".key-init.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None)) {
      Console.WriteLine("ready"); Console.Out.Flush(); System.Threading.Thread.Sleep(60000);
    }
  }
}
'@
switch ($request.action) {
  'delete' { [RdaCredentialFixture]::Delete($request.target); [Console]::WriteLine('true') }
  'exists' { [Console]::WriteLine(([RdaCredentialFixture]::Exists($request.target)).ToString().ToLowerInvariant()) }
  'corrupt' { [RdaCredentialFixture]::Corrupt($request.target); [Console]::WriteLine('true') }
  'broaden' { [RdaCredentialFixture]::Broaden($request.filename); [Console]::WriteLine('true') }
  'hold' { [RdaCredentialFixture]::Hold($request.directory) }
  default { throw 'Invalid fixture action' }
}
