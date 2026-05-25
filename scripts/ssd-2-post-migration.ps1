# PaperFate · SSD migration step 2 — post-install
# Run after the new SSD is installed and Windows can see it.
#   Usage:  .\scripts\ssd-2-post-migration.ps1 "D:\paperfate\data"
# Copies data/ to the new SSD via robocopy, verifies DB integrity, sets
# DATA_ROOT env var, and prints next steps.

param(
  [Parameter(Mandatory=$true)]
  [string]$NewDataRoot
)

$ErrorActionPreference = 'Continue'
$proj = 'C:\Users\R\paperfate'
$oldDataRoot = Join-Path $proj 'data'
Set-Location $proj

Write-Host "=== PaperFate SSD migration · post-install ===" -ForegroundColor Cyan
Write-Host "  Source:      $oldDataRoot"
Write-Host "  Destination: $NewDataRoot"
Write-Host ""

# 0) Verify destination drive exists
$destRoot = Split-Path -Qualifier $NewDataRoot
if (-not (Test-Path $destRoot)) {
  Write-Host "ERROR: destination drive $destRoot does not exist" -ForegroundColor Red
  exit 1
}
$destFree = (Get-PSDrive ($destRoot.TrimEnd(':'))).Free
$srcSize = (Get-ChildItem $oldDataRoot -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
Write-Host "  Source size:     $([math]::Round($srcSize/1MB,1)) MB"
Write-Host "  Destination free: $([math]::Round($destFree/1GB,1)) GB"
if ($destFree -lt ($srcSize * 1.2)) {
  Write-Host "WARN: destination has < 20% headroom over source size" -ForegroundColor Yellow
}

# 1) robocopy with mirror + multi-thread
Write-Host ""
Write-Host "[1/4] robocopy data/ -> $NewDataRoot …" -ForegroundColor Yellow
$rcStart = Get-Date
& robocopy $oldDataRoot $NewDataRoot /MIR /MT:8 /R:2 /W:5 /NDL /NJH /NJS /NP | Out-Host
$rcEnd = Get-Date
Write-Host "  robocopy duration: $([math]::Round(($rcEnd-$rcStart).TotalSeconds,1))s"

# 2) Verify file count + total size match
Write-Host ""
Write-Host "[2/4] Verifying copy …" -ForegroundColor Yellow
$srcFiles = (Get-ChildItem $oldDataRoot -Recurse -File -ErrorAction SilentlyContinue).Count
$dstFiles = (Get-ChildItem $NewDataRoot -Recurse -File -ErrorAction SilentlyContinue).Count
$dstSize  = (Get-ChildItem $NewDataRoot -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
Write-Host "  files: src=$srcFiles  dst=$dstFiles"
Write-Host "  bytes: src=$srcSize  dst=$dstSize"
if ($srcFiles -ne $dstFiles -or $srcSize -ne $dstSize) {
  Write-Host "  WARN: counts/sizes differ. Investigate before proceeding!" -ForegroundColor Red
  exit 2
}
Write-Host "  match OK."

# 3) DB integrity check on new copy
Write-Host ""
Write-Host "[3/4] SQLite integrity_check on new DB …" -ForegroundColor Yellow
$newDb = Join-Path $NewDataRoot 'paperfate.db'
if (Test-Path $newDb) {
  & node -e "const db=require('better-sqlite3')('$($newDb.Replace('\','/'))', {readonly:true}); console.log('integrity:', JSON.stringify(db.prepare('PRAGMA integrity_check').get())); console.log('papers:', JSON.stringify(db.prepare('SELECT COUNT(*) c FROM papers').get())); console.log('journals:', JSON.stringify(db.prepare('SELECT COUNT(*) c FROM journals').get())); db.close()"
} else {
  Write-Host "  paperfate.db not in destination (no-DB scenario, OK if intentional)"
}

# 4) Set DATA_ROOT env var (User scope, persistent)
Write-Host ""
Write-Host "[4/4] Setting DATA_ROOT env var …" -ForegroundColor Yellow
[Environment]::SetEnvironmentVariable('DATA_ROOT', $NewDataRoot, 'User')
$env:DATA_ROOT = $NewDataRoot
$check = [Environment]::GetEnvironmentVariable('DATA_ROOT', 'User')
Write-Host "  DATA_ROOT (User scope) = $check"

Write-Host ""
Write-Host "=====================================================" -ForegroundColor Green
Write-Host " SSD migration complete." -ForegroundColor Green
Write-Host ""
Write-Host " Next steps:" -ForegroundColor Green
Write-Host "  1) Open a NEW PowerShell so DATA_ROOT loads"
Write-Host "  2) Resume OpenAlex enrichment from where it stopped:"
Write-Host "       node scripts/collect-openalex.mjs"
Write-Host "  3) Rebuild unified DB on new SSD:"
Write-Host "       node scripts/build-unified-db.mjs"
Write-Host "  4) (optional) Ingest JIF supplements:"
Write-Host "       node scripts/ingest-jif-supplements.mjs"
Write-Host ""
Write-Host " Once everything verified, you can delete the OLD copy:" -ForegroundColor Yellow
Write-Host "   Remove-Item -Recurse -Force '$oldDataRoot'" -ForegroundColor Yellow
Write-Host "=====================================================" -ForegroundColor Green
