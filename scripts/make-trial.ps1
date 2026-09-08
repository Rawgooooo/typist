# Builds the installers to hand to trial testers, then writes a plain-text
# instruction sheet beside them and checks the artifacts for leaked secrets.
#
#   powershell -ExecutionPolicy Bypass -File scripts\make-trial.ps1
#
# The trial build runs as a normal user (asInvoker) rather than requesting
# administrator. Elevation is only needed to paste into elevated windows, and
# demanding admin would give every tester a UAC prompt on each launch on top of
# the SmartScreen warning an unsigned installer already triggers. Not worth it for
# a short trial.

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

Write-Host '=== Building trial installers (x64 + arm64, no elevation) ==='
npm run package:trial
if ($LASTEXITCODE -ne 0) { throw "electron-builder failed with exit code $LASTEXITCODE" }

$releaseDir = Join-Path $repo 'release'
$installers = Get-ChildItem $releaseDir -Filter '*.exe' -ErrorAction SilentlyContinue

if (-not $installers) { throw "No installers found in $releaseDir" }

Write-Host ''
Write-Host '=== Built ==='
$installers | ForEach-Object { "  {0}  ({1:N1} MB)" -f $_.Name, ($_.Length / 1MB) }

# --- Secret scan -----------------------------------------------------------
# The packaged app must never carry the developer's Groq key. `.env` and `data/`
# are outside electron-builder's file whitelist, but verify rather than trust:
# a leaked key would be billed to whoever built this.
Write-Host ''
Write-Host '=== Scanning artifacts for secrets ==='

# Matching on the bare "gsk_" prefix produces false positives: the settings UI
# carries placeholder="gsk_..." which legitimately ends up in the bundle. So look
# for a real key shape (prefix plus a long alphanumeric run) and, if a local .env
# exists, for that exact key value.
$patterns = @('gsk_[A-Za-z0-9]{40,}')

$envFile = Join-Path $repo '.env'
if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile) {
        if ($line -match '^\s*[A-Z_]*GROQ_API_KEY\s*=\s*(\S+)\s*$') {
            $literal = $Matches[1].Trim('"').Trim("'")
            if ($literal -and $literal -notmatch 'your_key_here') {
                $patterns += [regex]::Escape($literal)
            }
        }
    }
}

$scanRoots = @(
    (Join-Path $releaseDir 'win-unpacked'),
    (Join-Path $releaseDir 'win-arm64-unpacked')
) | Where-Object { Test-Path $_ }

$leaks = @()
foreach ($root in $scanRoots) {
    $candidates = Get-ChildItem $root -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Length -lt 80MB }

    foreach ($file in $candidates) {
        $hits = Select-String -Path $file.FullName -Pattern $patterns -List -ErrorAction SilentlyContinue
        if ($hits) { $leaks += $file.FullName }
    }
}

if ($leaks.Count -gt 0) {
    Write-Host 'FAILED: possible secret found in build output:' -ForegroundColor Red
    $leaks | Select-Object -Unique | ForEach-Object { Write-Host "  $_" }
    throw 'Refusing to continue. Remove the secret and rebuild.'
}
Write-Host '  clean - no API key found in build output'

# --- Tester instructions ---------------------------------------------------
$instructions = @'
Typist - 3 day dictation trial
==============================

Thanks for helping. This takes about five minutes to set up.

WHAT IT DOES
Press a hotkey, speak, and your words get typed into whatever window you were
using - email, chat, documents, anything.


1. INSTALL
   Run "Typist Setup 0.1.0.exe". One installer covers both normal (Intel/AMD)
   and ARM machines, so there is nothing to choose.

   Windows will warn that the publisher is unknown, because the app is not
   code-signed. Click "More info" then "Run anyway". It installs for your user
   only and does not ask for administrator rights.


2. GET A FREE API KEY
   a. Go to  https://console.groq.com/keys
   b. Sign in (Google login works).
   c. Click "Create API Key", give it any name, and copy the key.
      It starts with  gsk_
   d. The key is free to create. Keep it private - do not share it or send it
      to anyone, including me.


3. ADD THE KEY
   Open Typist -> "Engine" tab -> paste the key into "Groq API Key".
   That is the only setup needed.


4. USE IT
   Press  Ctrl + Shift + D  to start recording, speak, then press it again to
   stop. The text appears wherever your cursor is.

   Try it in Notepad first to confirm it works.

   Tip: a wired or built-in laptop microphone gives noticeably better accuracy
   than Bluetooth earbuds. If accuracy is poor, switch the microphone in the
   "General" tab.


5. AFTER THREE DAYS - SEND THE RESULTS
   a. Open Typist -> "History" tab.
   b. Type your name or initials in "Your Name or Initials".
   c. Click "Export to Desktop".
   d. A file appears on your Desktop called
        typist-corpus-<yourname>-<date>.json
      Send me that ONE file.


WHAT IS AND IS NOT COLLECTED
   Collected:     the text of what you dictated, with timestamps.
   NOT collected: audio. No recording is ever saved - the audio is converted to
                  text and deleted immediately.
   NOT collected: your API key. It stays on your machine and is not part of the
                  export file.
   Nothing is uploaded automatically. Nothing leaves your machine unless you
   click Export and send the file yourself.

   You can read the export file in Notepad before sending it, and you can delete
   anything you would rather not share. If you dictate something private, open
   the History tab and click "Clear" - that wipes the log.


TO STOP EARLY
   Uninstall from Windows Settings -> Apps, or just stop using it. No hard
   feelings, and thanks either way.
'@

$instructionsPath = Join-Path $releaseDir 'READ-ME-FIRST.txt'
Set-Content -Path $instructionsPath -Value $instructions -Encoding utf8

Write-Host ''
Write-Host '=== Ready to send ==='
Write-Host "  Folder: $releaseDir"
Write-Host "  Instructions: $instructionsPath"
Write-Host ''
Write-Host 'Send each tester: their installer + READ-ME-FIRST.txt'
