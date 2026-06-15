# Live write flow against the deployed Constitutional DAO on studionet.
# Funds the treasury, then submits a compliant and a non-compliant proposal so
# the validators judge each against the constitution on-chain.

$ErrorActionPreference = "Continue"
$PSNativeCommandUseErrorActionPreference = $false

$addr = "0x0B2460cbB579Cd6854101C8cC7568903a22Ac75E"
$passFile = Join-Path $PSScriptRoot ".keystore-pass"
$pw = (Get-Content $passFile -Raw).Trim()

function GLWrite {
    param([string]$Method, [object[]]$ArgList)
    Write-Host "==> write $Method $($ArgList -join ' | ')"
    $cmd = @("write", $addr, $Method, "--args") + $ArgList
    $pw | & genlayer @cmd 2>&1 | Out-Host
    Write-Host "    (exit $LASTEXITCODE)"
}

# Treasury in atto-units: fund 100 GEN = 100 * 10^18.
GLWrite "fund_treasury" @("100000000000000000000")

# Compliant proposal: open-source privacy tool, reward 10 * 10^18.
GLWrite "submit_proposal" @("p-live-1", "Encrypted local backups for the wallet", "Open-source MIT module adding client-side encrypted backups, with tests and documentation.", "10000000000000000000")

# Non-compliant proposal: marketing — should be rejected under principle 2.
GLWrite "submit_proposal" @("p-live-2", "Twitter ad campaign for token launch", "Pay influencers to promote our token price and run paid advertising placements.", "5000000000000000000")

Write-Host "==> Flow submitted."
