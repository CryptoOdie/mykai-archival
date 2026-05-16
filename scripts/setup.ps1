# MyKAI setup — fetches kaspad binaries from official releases if missing.
# Reproducible: pinned versions + SHA-256 verification.
#
# Run from project root: powershell -ExecutionPolicy Bypass -File scripts\setup.ps1

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Pinned upstream versions. Bump deliberately; do NOT auto-update.
$KASPAD_VERSION = '1.1.0'
$KASPAD_URL = "https://github.com/kaspanet/rusty-kaspa/releases/download/v$KASPAD_VERSION/rusty-kaspa-v$KASPAD_VERSION-windows-x64.zip"
$KASPAD_SHA256 = '02d40a0f6c8e19b905e0af2275b628ab565d2214d30cb2482744dcff3cfb528c'

# ks_bridge.exe is from kaspa-stratum-bridge. Optional — only needed for
# mining. Skip if not present.
$BRIDGE_VERSION = '1.1.7'
$BRIDGE_URL = "https://github.com/onemorebsmith/kaspa-stratum-bridge/releases/download/v$BRIDGE_VERSION/kaspa-bridge-windows-amd64.exe.zip"
$BRIDGE_SHA256 = '67c3fe531bdbf6d630cd1f9518d7e0ee4458f3f1682c2f850fd23b1fccfb7469'

$root = Split-Path -Parent $PSScriptRoot
$resources = Join-Path $root 'src\resources'
New-Item -ItemType Directory -Force -Path $resources | Out-Null

function Test-FileSha256 {
    param([string]$Path, [string]$Expected)
    if (-not (Test-Path $Path)) { return $false }
    $h = (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLower()
    return ($h -eq $Expected.ToLower())
}

function Fetch-Binary {
    param(
        [string]$Name,
        [string]$Url,
        [string]$ExpectedSha,
        [string]$OutPath
    )
    if (Test-FileSha256 -Path $OutPath -Expected $ExpectedSha) {
        Write-Host "[ok] $Name already present + checksum matches"
        return
    }
    Write-Host "[fetch] $Name from $Url"
    $tmpZip = Join-Path $env:TEMP "mykai-$Name-$(Get-Random).zip"
    $tmpDir = Join-Path $env:TEMP "mykai-extract-$(Get-Random)"
    try {
        Invoke-WebRequest -Uri $Url -OutFile $tmpZip
        New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
        Expand-Archive -Path $tmpZip -DestinationPath $tmpDir -Force
        # Find $Name anywhere in the extracted tree — releases sometimes
        # include a top-level subdirectory we don't want to depend on.
        $found = Get-ChildItem -Path $tmpDir -Recurse -Filter $Name -File `
                   | Select-Object -First 1
        if (-not $found) {
            throw "[fail] $Name not found in extracted archive"
        }
        Copy-Item -Force -Path $found.FullName -Destination $OutPath
    } finally {
        if (Test-Path $tmpZip) { Remove-Item -Force $tmpZip }
        if (Test-Path $tmpDir) { Remove-Item -Force -Recurse $tmpDir }
    }
    if (-not (Test-FileSha256 -Path $OutPath -Expected $ExpectedSha)) {
        $actual = (Get-FileHash -Algorithm SHA256 -Path $OutPath).Hash.ToLower()
        throw "[fail] $Name SHA256 mismatch — expected $ExpectedSha got $actual"
    }
    Write-Host "[ok] $Name fetched + verified"
}

Fetch-Binary -Name 'kaspad.exe' `
             -Url $KASPAD_URL `
             -ExpectedSha $KASPAD_SHA256 `
             -OutPath (Join-Path $resources 'kaspad.exe')

# ks_bridge.exe optional — mining is off by default
try {
    Fetch-Binary -Name 'ks_bridge.exe' `
                 -Url $BRIDGE_URL `
                 -ExpectedSha $BRIDGE_SHA256 `
                 -OutPath (Join-Path $resources 'ks_bridge.exe')
} catch {
    Write-Host "[skip] ks_bridge.exe (mining bridge) — $($_.Exception.Message)"
}

Write-Host ''
Write-Host 'Setup complete. Next:'
Write-Host '  cd src'
Write-Host '  npm install'
Write-Host '  npm start'
