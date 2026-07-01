# MailGo Release Script - bump version, commit, tag, and push
# Usage:
#   .\push-release.ps1                   # bump patch, e.g. 0.2.0 -> 0.2.1
#   .\push-release.ps1 -Level minor      # bump minor, e.g. 0.2.0 -> 0.3.0
#   .\push-release.ps1 -Level major      # bump major, e.g. 0.2.0 -> 1.0.0
#   .\push-release.ps1 -Version 0.3.0    # set exact version
#   .\push-release.ps1 -Message "release: v0.3.0"
#   .\push-release.ps1 -NoPush           # commit and tag locally only

param(
    [ValidateSet("patch", "minor", "major")]
    [string]$Level = "patch",
    [string]$Version = "",
    [string]$Message = "",
    [string]$Branch = "main",
    [switch]$NoPush
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)

function Read-Utf8File {
    param([string]$Path)
    [System.IO.File]::ReadAllText(
        [System.IO.Path]::GetFullPath($Path),
        [System.Text.Encoding]::UTF8
    )
}

function Write-Utf8File {
    param(
        [string]$Path,
        [string]$Content
    )
    [System.IO.File]::WriteAllText(
        [System.IO.Path]::GetFullPath($Path),
        $Content.TrimEnd("`r", "`n") + "`n",
        $Utf8NoBom
    )
}

function Assert-SemVer {
    param([string]$Value)
    if ($Value -notmatch '^\d+\.\d+\.\d+$') {
        throw "Version must be SemVer without leading v, for example: 0.2.1"
    }
}

function Get-CurrentVersion {
    if (Test-Path "VERSION") {
        $fromFile = (Read-Utf8File "VERSION").Trim()
        if ($fromFile) {
            Assert-SemVer $fromFile
            return $fromFile
        }
    }

    if (Test-Path "frontend\package.json") {
        $pkg = Get-Content "frontend\package.json" -Raw | ConvertFrom-Json
        if ($pkg.version) {
            Assert-SemVer $pkg.version
            return $pkg.version
        }
    }

    $latestTag = git tag --sort=-version:refname --list "v*" | Select-Object -First 1
    if ($latestTag) {
        $fromTag = $latestTag -replace '^v', ''
        Assert-SemVer $fromTag
        return $fromTag
    }

    return "0.0.0"
}

function Bump-Version {
    param(
        [string]$Current,
        [string]$Level
    )
    $parts = $Current -split '\.'
    $major = [int]$parts[0]
    $minor = [int]$parts[1]
    $patch = [int]$parts[2]

    switch ($Level) {
        "major" {
            $major++
            $minor = 0
            $patch = 0
        }
        "minor" {
            $minor++
            $patch = 0
        }
        "patch" {
            $patch++
        }
    }

    return "$major.$minor.$patch"
}

function Update-JsonVersion {
    param(
        [string]$Path,
        [string]$NewVersion
    )
    if (-not (Test-Path $Path)) {
        Write-Warning "File not found: $Path, skipping"
        return
    }
    $content = Read-Utf8File $Path
    $content = $content -replace '"version"\s*:\s*"[^"]*"', "`"version`": `"$NewVersion`""
    Write-Utf8File $Path $content
    Write-Host "[OK] Updated $Path -> $NewVersion" -ForegroundColor Green
}

function Update-PackageLockVersion {
    param(
        [string]$Path,
        [string]$NewVersion
    )
    if (-not (Test-Path $Path)) {
        Write-Warning "File not found: $Path, skipping"
        return
    }

    $content = Read-Utf8File $Path
    $content = [regex]::Replace(
        $content,
        '("name"\s*:\s*"mailgo-frontend",\s*[\r\n]+\s*"version"\s*:\s*")[^"]+(")',
        { param($m) $m.Groups[1].Value + $NewVersion + $m.Groups[2].Value },
        1
    )
    $content = [regex]::Replace(
        $content,
        '(""\s*:\s*\{\s*[\r\n]+\s*"name"\s*:\s*"mailgo-frontend",\s*[\r\n]+\s*"version"\s*:\s*")[^"]+(")',
        { param($m) $m.Groups[1].Value + $NewVersion + $m.Groups[2].Value },
        1
    )
    Write-Utf8File $Path $content
    Write-Host "[OK] Updated $Path -> $NewVersion" -ForegroundColor Green
}

function Update-TextVersion {
    param(
        [string]$Path,
        [string]$Pattern,
        [string]$Replacement,
        [string]$Label
    )
    if (-not (Test-Path $Path)) {
        Write-Warning "File not found: $Path, skipping"
        return
    }
    $content = Read-Utf8File $Path
    $content = $content -replace $Pattern, $Replacement
    Write-Utf8File $Path $content
    Write-Host "[OK] Updated $Label" -ForegroundColor Green
}

if (-not (Test-Path ".git")) {
    throw "Not a git repository"
}

$currentBranch = (git branch --show-current).Trim()
if ($currentBranch -ne $Branch) {
    Write-Warning "Current branch is '$currentBranch', expected '$Branch'."
    $confirmBranch = Read-Host "Continue anyway? (y/n)"
    if ($confirmBranch -ne "y") {
        exit 0
    }
}

$currentVersion = Get-CurrentVersion
if ($Version) {
    $newVersion = $Version.TrimStart("v")
    Assert-SemVer $newVersion
} else {
    $newVersion = Bump-Version -Current $currentVersion -Level $Level
}

$newTag = "v$newVersion"

$tagRef = "refs/tags/$newTag"
$existingTag = git rev-parse --verify --quiet $tagRef
if ($LASTEXITCODE -eq 0 -and $existingTag) {
    throw "Tag already exists: $newTag"
}
$global:LASTEXITCODE = 0

Write-Host "Current version: v$currentVersion" -ForegroundColor Cyan
Write-Host "New version:     $newTag" -ForegroundColor Green
Write-Host ""
Write-Host "This will update:" -ForegroundColor Yellow
Write-Host "  - VERSION"
Write-Host "  - frontend/package.json"
Write-Host "  - frontend/package-lock.json"
Write-Host "  - frontend/src/lib/version.ts"
Write-Host "  - stage all current repository changes with git add -A"
Write-Host ""
Write-Host "Then it will commit, create git tag $newTag, and push branch/tag."
Write-Host "GitHub Actions will publish:"
Write-Host "  - ghcr.io/mengmengcode/mailgo:$newTag"
Write-Host "  - ghcr.io/mengmengcode/mailgo:$newVersion"
Write-Host "  - ghcr.io/mengmengcode/mailgo:latest"
Write-Host "  - GitHub Release binary assets"
Write-Host ""

$confirm = Read-Host "Confirm release? (y/n)"
if ($confirm -ne "y") {
    Write-Host "Cancelled" -ForegroundColor Gray
    exit 0
}

Write-Utf8File "VERSION" $newVersion
Write-Host "[OK] Updated VERSION -> $newVersion" -ForegroundColor Green

Update-JsonVersion -Path "frontend\package.json" -NewVersion $newVersion
Update-PackageLockVersion -Path "frontend\package-lock.json" -NewVersion $newVersion
Update-TextVersion `
    -Path "frontend\src\lib\version.ts" `
    -Pattern 'APP_VERSION\s*=\s*"[^"]*"' `
    -Replacement "APP_VERSION = `"$newVersion`"" `
    -Label "frontend/src/lib/version.ts -> APP_VERSION = `"$newVersion`""

git add -A

$changed = git diff --cached --name-only
if (-not $changed) {
    throw "No changes staged. Aborting."
}

if (-not $Message) {
    $Message = "release: $newTag"
}

git commit -m $Message
Write-Host "[OK] git commit: $Message" -ForegroundColor Green

git tag -a $newTag -m $newTag
Write-Host "[OK] git tag: $newTag" -ForegroundColor Green

if ($NoPush) {
    Write-Host "[OK] NoPush enabled. Local release commit/tag created only." -ForegroundColor Yellow
    exit 0
}

git push origin $Branch
git push origin $newTag

Write-Host ""
Write-Host "Release pushed: $newTag" -ForegroundColor Green
Write-Host "Watch GitHub Actions for Docker image and binary release publishing." -ForegroundColor Green
