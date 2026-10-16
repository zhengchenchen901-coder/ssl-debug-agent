param([Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$Nonce)
$ErrorActionPreference = 'Stop'
# Windows owns the credential dialog. Credentials never enter Node or the browser.
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Security.Principal;
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
  private static extern bool LogonUserW(string user, string domain, string password, int logonType, int provider, out IntPtr token);
  [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
  public static bool Verify() {
    var info = new CredUiInfo();
    info.cbSize = Marshal.SizeOf(info);
    info.pszCaptionText = "Remote Debug Agent";
    info.pszMessageText = "Verify the current Windows account to register or recover a server administrator.";
    uint package = 0, size = 0;
    bool save = false;
    IntPtr buffer = IntPtr.Zero, token = IntPtr.Zero;
    try {
      // ENUMERATE_CURRENT_USER | AUTHPACKAGE_ONLY is intentionally not used:
      // the returned identity is checked against the actual process SID below.
      if (CredUIPromptForWindowsCredentialsW(ref info, 0, ref package, IntPtr.Zero, 0, out buffer, out size, ref save, 0) != 0) return false;
      uint u = 512, d = 512, p = 512;
      var user = new StringBuilder((int)u);
      var domain = new StringBuilder((int)d);
      var password = new StringBuilder((int)p);
      try {
        if (!CredUnPackAuthenticationBufferW(0, buffer, size, user, ref u, domain, ref d, password, ref p)) return false;
        string domainName = domain.Length == 0 ? null : domain.ToString();
        if (!LogonUserW(user.ToString(), domainName, password.ToString(), 2, 0, out token)) return false;
        using (var verified = new WindowsIdentity(token)) {
          return verified.User.Equals(WindowsIdentity.GetCurrent().User);
        }
      } finally {
        for (int i = 0; i < password.Length; i++) password[i] = '\0';
        password.Clear();
      }
    } finally {
      if (token != IntPtr.Zero) CloseHandle(token);
      if (buffer != IntPtr.Zero) {
        for (int i = 0; i < size; i++) Marshal.WriteByte(buffer, i, 0);
        Marshal.FreeCoTaskMem(buffer);
      }
    }
  }
}
'@
$verified = [RemoteDebugOwnerVerification]::Verify()
@{ verified = $verified; nonce = $Nonce } | ConvertTo-Json -Compress
if (-not $verified) { exit 1 }
