# Verifies global hotkey registration against the packaged build.
#
#   powershell -ExecutionPolicy Bypass -File scripts\verify-hotkey.ps1
#
# Covers three cases by seeding the packaged app's own config.json, so the
# developer's settings in the repo data/ folder are never touched:
#
#   1. a custom binding is honoured
#   2. a malformed accelerator falls back instead of leaving no hotkey
#   3. the default is registered when nothing is configured
#
# The interactive capture flow (clicking Change and pressing keys) still needs a
# human; this covers the registration logic underneath it.

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$appDir = Join-Path $repo 'release\win-arm64-unpacked'
$exe = Join-Path $appDir 'Typist.exe'
$dataDir = Join-Path $appDir 'data'
$config = Join-Path $dataDir 'config.json'
$log = Join-Path $dataDir 'typist.log'

if (-not (Test-Path $exe)) { throw "Not built: $exe" }

function Invoke-Case {
    param([string]$Name, [string]$Hotkey, [string]$ExpectPattern)

    Get-Process Typist -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 2

    New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
    Remove-Item $log -ErrorAction SilentlyContinue

    if ($null -eq $Hotkey) {
        Remove-Item $config -ErrorAction SilentlyContinue
    } else {
        $json = @{ hotkey = $Hotkey; engine = 'cloud'; saveHistory = $false } | ConvertTo-Json
        # WriteAllText, not Set-Content -Encoding utf8: PowerShell 5.1 emits a
        # UTF-8 BOM, which used to make the app fail to parse its own config.
        [IO.File]::WriteAllText($config, $json, (New-Object Text.UTF8Encoding($false)))
    }

    Start-Process -FilePath $exe | Out-Null

    $deadline = (Get-Date).AddSeconds(30)
    $matched = $false
    while ((Get-Date) -lt $deadline) {
        if (Test-Path $log) {
            $content = Get-Content $log -Raw -ErrorAction SilentlyContinue
            if ($content -and $content -match $ExpectPattern) { $matched = $true; break }
        }
        Start-Sleep -Milliseconds 500
    }

    Get-Process Typist -ErrorAction SilentlyContinue | Stop-Process -Force

    if ($matched) {
        Write-Host "PASS  $Name"
        return 0
    }

    Write-Host "FAIL  $Name (expected /$ExpectPattern/)"
    if (Test-Path $log) {
        # Write-Host, not bare strings: emitting to the pipeline would make this
        # function return an array instead of the exit count.
        Get-Content $log | Select-Object -Last 6 | ForEach-Object { Write-Host "        $_" }
    }
    return 1
}

$failures = 0
$failures += Invoke-Case -Name 'custom binding honoured' `
                         -Hotkey 'Control+Alt+J' `
                         -ExpectPattern 'Global shortcut registered: Control\+Alt\+J'

$failures += Invoke-Case -Name 'malformed accelerator falls back' `
                         -Hotkey 'Control+Shift+NotARealKey' `
                         -ExpectPattern 'Fell back to|Invalid accelerator'

$failures += Invoke-Case -Name 'default used when unconfigured' `
                         -Hotkey $null `
                         -ExpectPattern 'Global shortcut registered: CommandOrControl\+Shift\+D'

# Leave the packaged build without a stray config.
Remove-Item $config -ErrorAction SilentlyContinue

Write-Host ''
if ($failures -eq 0) {
    Write-Host 'HOTKEY OK'
    exit 0
}
Write-Host "HOTKEY FAILED - $failures case(s)"
exit 1
