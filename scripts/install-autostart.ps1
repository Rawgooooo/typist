# Registers Typist to start at logon, elevated, without a UAC prompt each time.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Uninstall
#
# Why a scheduled task rather than a Startup shortcut or a Run registry key:
#   Release builds of Typist carry a `requireAdministrator` manifest, because
#   Windows UIPI will not let a medium-integrity process inject the synthetic
#   Ctrl+V that auto-paste depends on into an elevated window. A manifest alone
#   means a UAC prompt on every single launch. A scheduled task registered with
#   "run with highest privileges" starts the app elevated with no prompt, and
#   doubles as the autostart entry.
#
# Requires elevation to register a highest-privileges task; it re-launches
# itself through UAC if needed.

param(
    [switch]$Elevated,
    [switch]$Uninstall,

    # Explicit path to Typist.exe. Auto-detected when omitted.
    [string]$ExePath,

    # Optional .env to copy into %APPDATA%\com.typist.app so the installed build
    # picks up the Groq key. A task-launched process has no useful working
    # directory, so a repo-root .env would not otherwise be found.
    [string]$EnvFile
)

$ErrorActionPreference = 'Stop'

$TaskName = 'Typist'

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Find-TypistExe {
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\Typist\Typist.exe')
        'C:\Program Files\Typist\Typist.exe'
        (Join-Path $env:ProgramFiles 'Typist\Typist.exe')
    )
    foreach ($c in $candidates) {
        if ($c -and (Test-Path $c)) { return $c }
    }
    return $null
}

if (-not (Test-Admin)) {
    if ($Elevated) {
        Write-Host 'Elevation requested but process is still not admin. Aborting.'
        exit 740
    }
    Write-Host 'Requesting elevation. Approve the UAC prompt.'

    $selfArgs = @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass'
        '-File', $PSCommandPath
        '-Elevated'
    )
    if ($Uninstall) { $selfArgs += '-Uninstall' }
    if ($ExePath)   { $selfArgs += @('-ExePath', $ExePath) }
    if ($EnvFile)   { $selfArgs += @('-EnvFile', $EnvFile) }

    $p = Start-Process powershell -ArgumentList $selfArgs `
                       -WorkingDirectory $env:USERPROFILE `
                       -Verb RunAs -Wait -PassThru
    exit $p.ExitCode
}

if ($Uninstall) {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed the '$TaskName' scheduled task."
    } else {
        Write-Host "No '$TaskName' scheduled task found; nothing to do."
    }
    exit 0
}

if (-not $ExePath) {
    $ExePath = Find-TypistExe
}

if (-not $ExePath -or -not (Test-Path $ExePath)) {
    Write-Host 'Could not find Typist.exe. Install Typist first, or pass -ExePath.'
    Write-Host 'Looked in:'
    Write-Host "  $(Join-Path $env:LOCALAPPDATA 'Programs\Typist\Typist.exe')"
    Write-Host '  C:\Program Files\Typist\Typist.exe'
    exit 1
}

Write-Host "Typist executable: $ExePath"

# Copy the .env next to the app data directory if asked.
if ($EnvFile) {
    if (-not (Test-Path $EnvFile)) {
        Write-Host "Warning: -EnvFile '$EnvFile' does not exist; skipping."
    } else {
        $appDir = Join-Path $env:APPDATA 'com.typist.app'
        New-Item -ItemType Directory -Force -Path $appDir | Out-Null
        $dest = Join-Path $appDir '.env'
        Copy-Item $EnvFile $dest -Force
        Write-Host "Copied environment file to $dest"
    }
}

$workingDir = Split-Path -Parent $ExePath

$action = New-ScheduledTaskAction -Execute $ExePath -WorkingDirectory $workingDir

$trigger = New-ScheduledTaskTrigger -AtLogOn

# InteractiveToken keeps the app on the user's desktop (it has a GUI), while
# RunLevel Highest gives it the elevated token without a consent prompt.
$principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType InteractiveToken `
    -RunLevel Highest

# A dictation app should keep running on battery and has no meaningful time
# limit, so the power-related defaults are overridden.
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable

Register-ScheduledTask -TaskName $TaskName `
                       -Action $action `
                       -Trigger $trigger `
                       -Principal $principal `
                       -Settings $settings `
                       -Description 'Starts Typist elevated at logon so auto-paste can reach elevated windows.' `
                       -Force | Out-Null

Write-Host ""
Write-Host "Registered the '$TaskName' scheduled task."
Write-Host 'Typist will start elevated at logon with no UAC prompt.'
Write-Host ''
Write-Host 'Start it now without logging out:'
Write-Host "  Start-ScheduledTask -TaskName $TaskName"
Write-Host ''
Write-Host 'Remove it later with:'
Write-Host "  powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Uninstall"
