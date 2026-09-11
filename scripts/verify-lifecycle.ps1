# Verifies that closing the window fully exits, and that the app relaunches after.
#
#   powershell -ExecutionPolicy Bypass -File scripts\verify-lifecycle.ps1
#
# Regression guard. Previously the recorder and overlay windows kept the process
# alive after the settings window closed, so `window-all-closed` never fired.
# Relaunching then hit the single-instance lock, the new instance exited, and the
# survivor had no window to show - the app was unlaunchable until killed from Task
# Manager.

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$exe = Join-Path $repo 'release\win-arm64-unpacked\Typist.exe'
if (-not (Test-Path $exe)) { throw "Not built: $exe" }

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public class TypistWin {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  delegate bool EnumProc(IntPtr h, IntPtr p);
  const uint WM_CLOSE = 0x0010;

  static List<IntPtr> Find(int[] pids) {
    var hits = new List<IntPtr>();
    EnumWindows((h, p) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (Array.IndexOf(pids, (int)pid) < 0) return true;
      if (!IsWindowVisible(h)) return true;
      var t = new StringBuilder(256); GetWindowText(h, t, 256);
      if (t.ToString() == "Typist") hits.Add(h);
      return true;
    }, IntPtr.Zero);
    return hits;
  }

  public static int CountVisible(int[] pids) { return Find(pids).Count; }

  public static int CloseAll(int[] pids) {
    var hits = Find(pids);
    foreach (var h in hits) PostMessage(h, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
    return hits.Count;
  }
}
"@

function Get-TypistPids {
    @((Get-Process Typist -ErrorAction SilentlyContinue).Id)
}

function Wait-Window([int]$timeoutSec) {
    for ($i = 0; $i -lt $timeoutSec * 2; $i++) {
        $pids = Get-TypistPids
        if ($pids.Count -gt 0 -and [TypistWin]::CountVisible([int[]]$pids) -gt 0) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Wait-Exit([int]$timeoutSec) {
    for ($i = 0; $i -lt $timeoutSec * 2; $i++) {
        if ((Get-TypistPids).Count -eq 0) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

# Start from a known-clean state.
Get-Process Typist -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

$failures = 0

Write-Host '1. Launching...'
Start-Process -FilePath $exe | Out-Null
if (Wait-Window 30) {
    Write-Host "   PASS window visible ($((Get-TypistPids).Count) processes)"
} else {
    Write-Host '   FAIL no visible window'; $failures++
}

Write-Host '2. Closing the window (WM_CLOSE, same as clicking X)...'
$pids = Get-TypistPids
$closed = [TypistWin]::CloseAll([int[]]$pids)
Write-Host "   sent WM_CLOSE to $closed window(s)"

if (Wait-Exit 30) {
    Write-Host '   PASS all processes exited'
} else {
    Write-Host "   FAIL $((Get-TypistPids).Count) process(es) still running"; $failures++
    Get-Process Typist -ErrorAction SilentlyContinue | Stop-Process -Force
}

Write-Host '3. Relaunching after close...'
Start-Process -FilePath $exe | Out-Null
if (Wait-Window 30) {
    Write-Host '   PASS window visible again'
} else {
    Write-Host '   FAIL relaunch produced no window'; $failures++
}

Write-Host '4. Cleaning up...'
$pids = Get-TypistPids
if ($pids.Count -gt 0) { [TypistWin]::CloseAll([int[]]$pids) | Out-Null }
$null = Wait-Exit 20
Get-Process Typist -ErrorAction SilentlyContinue | Stop-Process -Force

Write-Host ''
if ($failures -eq 0) {
    Write-Host 'LIFECYCLE OK - close exits fully and relaunch works'
    exit 0
}
Write-Host "LIFECYCLE FAILED - $failures check(s) failed"
exit 1
