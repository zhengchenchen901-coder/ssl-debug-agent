param([Parameter(Mandatory=$true)][string]$Helper)
$ErrorActionPreference = 'Stop'
$source = [IO.File]::ReadAllText($Helper)
$match = [regex]::Match($source, "(?s)Add-Type -TypeDefinition @'\r?\n(.*?)\r?\n'@")
if (-not $match.Success) { throw 'Native helper definition missing' }
Add-Type -TypeDefinition $match.Groups[1].Value
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Reflection;
using System.Runtime.InteropServices;
public static class RemoteDebugOwnerFixture {
  [DllImport("credui.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern bool CredPackAuthenticationBufferW(uint flags, string user, string password, IntPtr buffer, ref uint size);
  [DllImport("credui.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern bool CredUnPackAuthenticationBufferW(uint flags, IntPtr buffer, uint size, StringBuilder user, ref uint userSize, StringBuilder domain, ref uint domainSize, StringBuilder password, ref uint passwordSize);
  public static bool RoundTrip(bool protect, bool legacy) {
    const string password = "synthetic-offline-password-123";
    uint size = 0;
    CredPackAuthenticationBufferW(protect ? 1u : 0u, "fixture-user", password, IntPtr.Zero, ref size);
    if (size == 0 || size > 65536) throw new Exception("Invalid fixture buffer size");
    IntPtr buffer = Marshal.AllocCoTaskMem((int)size);
    try {
      if (!CredPackAuthenticationBufferW(protect ? 1u : 0u, "fixture-user", password, buffer, ref size)) throw new Exception("Fixture packing failed");
      Type owner = null;
      foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies()) {
        owner = assembly.GetType("RemoteDebugOwnerVerification");
        if (owner != null) break;
      }
      var user = new StringBuilder(512); var domain = new StringBuilder(512); var secret = new StringBuilder(512);
      object[] args = new object[] { buffer, size, user, 512u, domain, 512u, secret, 512u };
      uint u = 512, d = 512, p = 512;
      bool result = legacy ? CredUnPackAuthenticationBufferW(0, buffer, size, user, ref u, domain, ref d, secret, ref p) :
        (bool)owner.GetMethod("Unpack", BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, args);
      bool matches = result && secret.ToString() == password && user.ToString() == "fixture-user";
      for (int i = 0; i < secret.Length; i++) secret[i] = '\0';
      return matches;
    } finally {
      for (int i = 0; i < size; i++) Marshal.WriteByte(buffer, i, 0);
      Marshal.FreeCoTaskMem(buffer);
    }
  }
}
'@
$local = [RemoteDebugOwnerVerification]::NormalizeIdentity('fixture-user', '', 'MACHINE')
$qualified = [RemoteDebugOwnerVerification]::NormalizeIdentity('DOMAIN\fixture-user', '', 'MACHINE')
$upn = [RemoteDebugOwnerVerification]::NormalizeIdentity('fixture@example.test', 'DOMAIN', 'MACHINE')
$microsoft = [RemoteDebugOwnerVerification]::NormalizeIdentity('MicrosoftAccount\fixture@example.test', '', 'MACHINE')
$identityForms = $local[0] -eq 'fixture-user' -and $local[1] -eq 'MACHINE' -and $qualified[0] -eq 'fixture-user' -and $qualified[1] -eq 'DOMAIN' -and $null -eq $upn[1] -and $microsoft[1] -eq 'MicrosoftAccount'
@{
  protectedRoundTrip = [RemoteDebugOwnerFixture]::RoundTrip($true, $false)
  unprotectedRoundTrip = [RemoteDebugOwnerFixture]::RoundTrip($false, $false)
  legacyProtectedRoundTrip = [RemoteDebugOwnerFixture]::RoundTrip($true, $true)
  identityForms = $identityForms
} | ConvertTo-Json -Compress
