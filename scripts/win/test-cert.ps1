# A throwaway code-signing certificate whose subject is the Store publisher, to sign the test
# copy of the MSIX (pack-msix.mjs --sign) and install it: in the release's check-win job and on a test PC. Never the
# Store identity: the Store signs the real package itself. Exports the certificate with its key to -Out (a pfx
# protected by the password in the variable named by -PasswordEnv), trusts its public part in
# LocalMachine\TrustedPeople (needs an elevated shell) and leaves no key in the user's store.
#   powershell -ExecutionPolicy Bypass -File scripts\win\test-cert.ps1 -Out C:\t\test.pfx -PasswordEnv PFX_PASSWORD
param([Parameter(Mandatory)] [string] $Out, [Parameter(Mandatory)] [string] $PasswordEnv)
$ErrorActionPreference = 'Stop'
$publisher = 'CN=F5719CFD-083A-4791-AA97-9440062FF386'
$password = [Environment]::GetEnvironmentVariable($PasswordEnv)
if (-not $password) { throw "$PasswordEnv is empty: it must hold the pfx password" }

# Code signing (EKU 1.3.6.1.5.5.7.3.3), not a CA (basic constraints empty): what signtool and Add-AppxPackage expect.
$cert = New-SelfSignedCertificate -Type Custom -Subject $publisher -KeyUsage DigitalSignature `
  -FriendlyName 'Atelier IDE throwaway test certificate (not the Store identity)' -CertStoreLocation Cert:\CurrentUser\My `
  -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}') -NotAfter (Get-Date).AddDays(30)
$cer = Join-Path ([IO.Path]::GetTempPath()) "atl-cert-$PID.cer"
try {
  New-Item -ItemType Directory -Force (Split-Path -Parent ([IO.Path]::GetFullPath($Out))) | Out-Null
  Export-PfxCertificate -Cert $cert -FilePath $Out -Password (ConvertTo-SecureString $password -AsPlainText -Force) | Out-Null
  Export-Certificate -Cert $cert -FilePath $cer | Out-Null
  Import-Certificate -FilePath $cer -CertStoreLocation Cert:\LocalMachine\TrustedPeople | Out-Null
} finally {
  Remove-Item -Force $cer -ErrorAction SilentlyContinue
  # The key lives on only in the pfx (-Path first: Windows PowerShell 5.1 binds -DeleteKey only from an explicit path).
  Remove-Item -Path "Cert:\CurrentUser\My\$($cert.Thumbprint)" -DeleteKey -Force
}
"test certificate $($cert.Thumbprint) ($publisher): $Out, trusted in LocalMachine\TrustedPeople until $($cert.NotAfter.ToString('yyyy-MM-dd'))"
