param([ValidatePattern('^[a-f0-9]{64}$')][string]$Nonce, [switch]$Check)
$ErrorActionPreference = 'Stop'
# Windows owns the credential dialog. Credentials never enter Node or the browser.
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Security.Principal;
public sealed class RemoteDebugOwnerResult {
  public bool verified;
  public string reason;
  public int nativeError;
}
public static class RemoteDebugOwnerVerification {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  private struct CredUiInfo {
    public int cbSize;
    public IntPtr hwndParent;
    public string pszMessageText;
    public string pszCaptionText;
    public IntPtr hbmBanner;
  }
  [DllImport("credui.dll", CharSet=CharSet.Unicode)]
  private static extern int CredUIPromptForWindowsCredentialsW(ref CredUiInfo info, int error, ref uint authPackage,
    IntPtr inBuffer, uint inSize, out IntPtr outBuffer, out uint outSize, ref bool save, uint flags);
  [DllImport("credui.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern bool CredUnPackAuthenticationBufferW(uint flags, IntPtr buffer, uint size,
    StringBuilder user, ref uint userSize, StringBuilder domain, ref uint domainSize, StringBuilder password, ref uint passwordSize);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern bool LogonUserW(string user, string domain, [In] StringBuilder password, int logonType, int provider, out IntPtr token);
  [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern IntPtr LoadLibraryW(string name);
  [DllImport("kernel32.dll", CharSet=CharSet.Ansi, ExactSpelling=true)] private static extern IntPtr GetProcAddress(IntPtr module, string name);
  [DllImport("kernel32.dll")] private static extern bool FreeLibrary(IntPtr module);
  public static bool Available() {
    if (!Environment.UserInteractive) return false;
    IntPtr module = LoadLibraryW("credui.dll");
    if (module == IntPtr.Zero) return false;
    try { return GetProcAddress(module, "CredUIPromptForWindowsCredentialsW") != IntPtr.Zero && GetProcAddress(module, "CredUnPackAuthenticationBufferW") != IntPtr.Zero; }
    finally { FreeLibrary(module); }
  }
  private static RemoteDebugOwnerResult Result(bool verified, string reason, int error) {
    return new RemoteDebugOwnerResult { verified = verified, reason = reason, nativeError = error };
  }
  public static string[] NormalizeIdentity(string user, string domain, string defaultDomain) {
    int slash = user.IndexOf((char)92);
    if (slash >= 0) { domain = user.Substring(0, slash); user = user.Substring(slash + 1); }
    if (user.IndexOf((char)64) >= 0 && !String.Equals(domain, "MicrosoftAccount", StringComparison.OrdinalIgnoreCase) && !String.Equals(domain, "AzureAD", StringComparison.OrdinalIgnoreCase)) domain = null;
    else if (String.IsNullOrEmpty(domain)) domain = String.IsNullOrEmpty(defaultDomain) ? "." : defaultDomain;
    return new string[] { user, domain };
  }
  private static bool Unpack(IntPtr buffer, uint size, StringBuilder user, ref uint u, StringBuilder domain, ref uint d, StringBuilder password, ref uint p) {
    return CredUnPackAuthenticationBufferW(1, buffer, size, user, ref u, domain, ref d, password, ref p);
  }
  public static RemoteDebugOwnerResult Verify() {
    if (!Available()) return Result(false, "unavailable", 0);
    var info = new CredUiInfo();
    info.cbSize = Marshal.SizeOf(info);
    info.pszCaptionText = "Remote Debug Agent";
    info.pszMessageText = "Verify the current Windows account to register or recover a server administrator.";
    uint package = 0, size = 0;
    bool save = false;
    IntPtr buffer = IntPtr.Zero, token = IntPtr.Zero;
    try {
      int prompt = CredUIPromptForWindowsCredentialsW(ref info, 0, ref package, IntPtr.Zero, 0, out buffer, out size, ref save, 0);
      if (prompt != 0) return Result(false, prompt == 1223 ? "cancelled" : "prompt-error", prompt);
      uint u = 512, d = 512, p = 512;
      var user = new StringBuilder((int)u);
      var domain = new StringBuilder((int)d);
      var password = new StringBuilder((int)p);
      try {
        // CRED_PACK_PROTECTED_CREDENTIALS decrypts credentials in this same logon session.
        if (!Unpack(buffer, size, user, ref u, domain, ref d, password, ref p)) return Result(false, "unpack-error", Marshal.GetLastWin32Error());
        string[] identity = NormalizeIdentity(user.ToString(), domain.ToString(), Environment.UserDomainName);
        if (!LogonUserW(identity[0], identity[1], password, 2, 0, out token)) return Result(false, "logon-error", Marshal.GetLastWin32Error());
        using (var verified = new WindowsIdentity(token)) {
          bool matches = verified.User.Equals(WindowsIdentity.GetCurrent().User);
          return Result(matches, matches ? "verified" : "identity-mismatch", 0);
        }
      } finally {
        for (int i = 0; i < password.Length; i++) password[i] = '\0';
        password.Clear();
      }
    } catch { return Result(false, "helper-error", 0); }
    finally {
      if (token != IntPtr.Zero) CloseHandle(token);
      if (buffer != IntPtr.Zero) {
        for (int i = 0; i < size; i++) Marshal.WriteByte(buffer, i, 0);
        Marshal.FreeCoTaskMem(buffer);
      }
    }
  }
}
'@
if ($Check) {
  @{ available = [RemoteDebugOwnerVerification]::Available(); verified = $false } | ConvertTo-Json -Compress
  exit 0
}
if ($Nonce -notmatch '^[a-f0-9]{64}$') { exit 2 }
$result = [RemoteDebugOwnerVerification]::Verify()
@{ verified = $result.verified; nonce = $Nonce; reason = $result.reason; nativeError = $result.nativeError } | ConvertTo-Json -Compress
if (-not $result.verified) { exit 1 }
