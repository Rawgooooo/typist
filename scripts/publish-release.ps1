# Publishes the packaged builds as a GitHub Release.
#
#   powershell -ExecutionPolicy Bypass -File scripts\publish-release.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\publish-release.ps1 -Tag v0.2.0
#
# Builds belong in Releases, not in the repository. GitHub rejects any single file
# over 100 MB, and Typist.exe alone is ~216 MB with each zip around 145 MB;
# committing them made every push fail. Release assets allow up to 2 GB each and
# keep the repo at well under a megabyte.
#
# Requires the GitHub CLI, authenticated: gh auth status

param(
    [string]$Tag,
    [switch]$Draft
)

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw 'GitHub CLI (gh) not found. Install it, then run: gh auth login'
}

# Default the tag to the version in package.json so they cannot drift.
if (-not $Tag) {
    $version = (Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
    $Tag = "v$version"
}

$releaseDir = Join-Path $repo 'release'
$assets = @(
    Get-ChildItem $releaseDir -Filter '*.zip' -ErrorAction SilentlyContinue
    Get-ChildItem $releaseDir -Filter 'READ-ME-FIRST.txt' -ErrorAction SilentlyContinue
) | Where-Object { $_ }

if (-not $assets) {
    throw "No assets in $releaseDir. Run scripts\make-trial.ps1 first."
}

Write-Host "Tag: $Tag"
Write-Host 'Assets:'
$assets | ForEach-Object { "  {0,-34} {1,8:N1} MB" -f $_.Name, ($_.Length / 1MB) }

# Guard against publishing a build that still carries a developer API key.
Write-Host ''
Write-Host 'Checking assets for secrets...'
$envFile = Join-Path $repo '.env'
$literals = @()
if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile) {
        if ($line -match '^\s*[A-Z_]*GROQ_API_KEY\s*=\s*(\S+)\s*$') {
            $v = $Matches[1].Trim('"').Trim("'")
            if ($v -and $v -notmatch 'your_key_here') { $literals += $v }
        }
    }
}
foreach ($asset in $assets | Where-Object { $_.Extension -eq '.txt' }) {
    $content = Get-Content $asset.FullName -Raw
    foreach ($literal in $literals) {
        if ($content.Contains($literal)) { throw "API key found in $($asset.Name). Aborting." }
    }
}
Write-Host '  ok'

$notes = @"
Portable build - there is no installer.

**Which file?**
- ``Typist-$($Tag.TrimStart('v'))-win.zip`` - normal PCs (Intel/AMD)
- ``Typist-$($Tag.TrimStart('v'))-arm64-win.zip`` - Snapdragon / ARM laptops

**Setup**
1. Extract the zip (do not run it from inside the zip preview).
2. Run ``Typist.exe``. Windows will warn about an unknown publisher because the
   build is not code-signed - choose More info, then Run anyway.
3. Get a free API key at https://console.groq.com/keys and paste it into
   Engine -> Groq API Key.
4. Press Ctrl+Shift+D, speak, press again. The text is pasted at your cursor.

No administrator rights required, and nothing is written outside the extracted
folder. To remove it, delete that folder.

See READ-ME-FIRST.txt for the full walkthrough.
"@

# Existence is checked by listing rather than `gh release view`, which writes
# "release not found" to stderr. With $ErrorActionPreference = 'Stop', PowerShell
# promotes native stderr to a terminating error, so the normal "no release yet"
# case would abort the script.
$existingTags = @()
try {
    $ErrorActionPreference = 'Continue'
    $existingTags = (gh release list --limit 100 --json tagName --jq '.[].tagName' 2>$null) -split "`n" |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_ }
} finally {
    $ErrorActionPreference = 'Stop'
}

if ($existingTags -contains $Tag) {
    Write-Host ''
    Write-Host "Release $Tag already exists; replacing its assets..."
    gh release upload $Tag @($assets.FullName) --clobber
    if ($LASTEXITCODE -ne 0) { throw 'Asset upload failed.' }
} else {
    Write-Host ''
    Write-Host "Creating release $Tag..."
    # Not $args: that is an automatic variable in PowerShell.
    $ghArgs = @(
        'release', 'create', $Tag
        $assets.FullName
        '--title', "Typist $($Tag.TrimStart('v')) - dictation trial"
        '--notes', $notes
    )
    if ($Draft) { $ghArgs += '--draft' }

    gh @ghArgs
    if ($LASTEXITCODE -ne 0) { throw 'Release creation failed.' }
}

Write-Host ''
Write-Host 'Published. Share this link with testers:'
gh release view $Tag --json url --jq '.url'
