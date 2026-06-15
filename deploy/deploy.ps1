# Deploy the Constitutional DAO to GenLayer.
#
# Reads the private key from ../.env (git-ignored), imports the wallet into a
# CLI account, sets the network, and deploys with the constitution from
# constitution.txt. The private key is never printed.
#
# No keystore password is required from the user: the CLI needs *some* password
# to encrypt its local account store, so this script generates a random one and
# uses it non-interactively. It is written to deploy/.keystore-pass (git-ignored)
# only so re-runs can reuse the same imported account.
#
# Usage (from repo root):  pwsh ./deploy/deploy.ps1

$ErrorActionPreference = "Stop"
# The genlayer CLI writes normal status output to stderr. Under Windows
# PowerShell, redirecting that with 2>&1 while ErrorActionPreference=Stop turns
# benign status lines into terminating errors. We therefore call the CLI via a
# helper that ignores the stderr-as-error behavior and checks the real exit code.
$PSNativeCommandUseErrorActionPreference = $false

function Invoke-GL {
    param([Parameter(ValueFromRemainingArguments = $true)] $GLArgs)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & genlayer @GLArgs 2>&1 | Out-Host
    $code = $LASTEXITCODE
    $ErrorActionPreference = $prev
    if ($code -ne 0) { throw "genlayer $($GLArgs -join ' ') failed (exit $code)" }
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $repoRoot ".env"
$constitutionFile = Join-Path $PSScriptRoot "constitution.txt"
$contract = Join-Path $repoRoot "contracts/constitutional_dao.py"
$passFile = Join-Path $PSScriptRoot ".keystore-pass"

if (-not (Test-Path $envFile)) { throw ".env not found at $envFile" }

# --- Parse .env (KEY=VALUE lines, ignore comments/blank) ---
$envVars = @{}
foreach ($line in Get-Content $envFile) {
    $t = $line.Trim()
    if ($t -eq "" -or $t.StartsWith("#")) { continue }
    $idx = $t.IndexOf("=")
    if ($idx -lt 1) { continue }
    $key = $t.Substring(0, $idx).Trim()
    $val = $t.Substring($idx + 1).Trim()
    $envVars[$key] = $val
}

$pk = $envVars["GENLAYER_PRIVATE_KEY"]
$network = $envVars["GENLAYER_NETWORK"]
if ([string]::IsNullOrWhiteSpace($network)) { $network = "studionet" }
if ([string]::IsNullOrWhiteSpace($pk)) { throw "GENLAYER_PRIVATE_KEY is empty in .env" }
if (-not $pk.StartsWith("0x")) { $pk = "0x$pk" }

# --- Keystore password: reuse if present, else generate a random one ---
if (Test-Path $passFile) {
    $pw = (Get-Content $passFile -Raw).Trim()
} else {
    $pw = [guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N")
    Set-Content -Path $passFile -Value $pw -NoNewline
}

$accountName = "dao-deployer"

Write-Host "==> Setting network to $network"
Invoke-GL network set $network

Write-Host "==> Importing wallet into account '$accountName'"
$prev = $ErrorActionPreference
$ErrorActionPreference = "Continue"
& genlayer account import --name $accountName --private-key $pk --password $pw --overwrite 2>&1 |
    Where-Object { $_ -notmatch [regex]::Escape($pk) } | Out-Host
$importCode = $LASTEXITCODE
$ErrorActionPreference = $prev
if ($importCode -ne 0) { throw "account import failed (exit $importCode)" }

Invoke-GL account use $accountName

Write-Host "==> Active account:"
Invoke-GL account

Write-Host "==> Deploying contract"
$constitution = Get-Content $constitutionFile -Raw
$ErrorActionPreference = "Continue"
$pw | & genlayer deploy --contract $contract --args $constitution 2>&1 | Out-Host
$deployCode = $LASTEXITCODE
$ErrorActionPreference = "Stop"
if ($deployCode -ne 0) { throw "deploy failed (exit $deployCode)" }

Write-Host "==> Done. Copy the deployed address above into ui/app.js if wiring the frontend."
