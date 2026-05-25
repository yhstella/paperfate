# PaperFate · SSD migration step 1 — pre-shutdown
# Run this just before powering off (e.g. ~7:00 AM, before 7:30 SSD install).
# Stops all background collectors gracefully, flushes SQLite WAL, prints a
# summary of what was collected.

$ErrorActionPreference = 'Continue'
$proj = 'C:\Users\R\paperfate'
Set-Location $proj

Write-Host "=== PaperFate SSD migration · pre-shutdown ===" -ForegroundColor Cyan
Write-Host ""

# 1) Stop all node.exe processes running our collectors
Write-Host "[1/4] Stopping background collectors …" -ForegroundColor Yellow
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue
$killed = 0
foreach ($p in $procs) {
  if ($p.CommandLine -match 'scripts[/\\](collect-|scrape-|verify-|ingest-)') {
    $script = if ($p.CommandLine -match 'scripts[/\\]([\w-]+\.mjs)') { $Matches[1] } else { '?' }
    Write-Host "  killing PID=$($p.ProcessId) $script"
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    $killed++
  }
}
Write-Host "  killed $killed processes"
Start-Sleep -Seconds 2

# 2) WAL checkpoint — fold .db-wal/.db-shm into the main .db file
Write-Host ""
Write-Host "[2/4] SQLite WAL checkpoint …" -ForegroundColor Yellow
$dbPath = Join-Path $proj 'data\paperfate.db'
if (Test-Path $dbPath) {
  $beforeSize = (Get-Item $dbPath).Length
  & node -e "const db=require('better-sqlite3')('$($dbPath.Replace('\','/'))'); const r=db.pragma('wal_checkpoint(TRUNCATE)'); console.log('wal_checkpoint:', JSON.stringify(r)); db.close()"
  $afterSize = (Get-Item $dbPath).Length
  Write-Host "  paperfate.db: $([math]::Round($beforeSize/1MB,1)) MB -> $([math]::Round($afterSize/1MB,1)) MB"

  # Check there's no remaining WAL file
  $walExists = Test-Path "$dbPath-wal"
  $shmExists = Test-Path "$dbPath-shm"
  if ($walExists -or $shmExists) {
    Write-Host "  WARN: WAL/SHM still present (wal=$walExists shm=$shmExists)" -ForegroundColor Red
  } else {
    Write-Host "  WAL/SHM cleared. Safe to copy paperfate.db as single file."
  }
} else {
  Write-Host "  paperfate.db not found at $dbPath"
}

# 3) Quick data summary
Write-Host ""
Write-Host "[3/4] Data summary …" -ForegroundColor Yellow
$dataDir = Join-Path $proj 'data'
Get-ChildItem $dataDir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
  $size = (Get-ChildItem $_.FullName -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
  if ($size -gt 0) {
    $files = (Get-ChildItem $_.FullName -Recurse -File -ErrorAction SilentlyContinue).Count
    Write-Host ("  {0,-22} {1,8} MB  {2,5} files" -f $_.Name, [math]::Round($size/1MB,1), $files)
  }
}
$totalSize = (Get-ChildItem $dataDir -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
Write-Host ("  TOTAL                  {0,8} MB" -f [math]::Round($totalSize/1MB,1))

# 4) Save a manifest snapshot
Write-Host ""
Write-Host "[4/4] Writing manifest …" -ForegroundColor Yellow
$manifest = @{
  pre_shutdown_at = Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz'
  total_size_mb   = [math]::Round($totalSize/1MB, 2)
  data_root       = $dataDir
  paperfate_db_mb = if (Test-Path $dbPath) { [math]::Round((Get-Item $dbPath).Length/1MB, 2) } else { 0 }
  jsonl_counts    = @{}
}
Get-ChildItem $dataDir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
  $jsonls = Get-ChildItem $_.FullName -Filter '*.jsonl' -ErrorAction SilentlyContinue
  if ($jsonls) {
    $manifest.jsonl_counts[$_.Name] = $jsonls.Count
  }
}
$manifestPath = Join-Path $dataDir '_pre_shutdown_manifest.json'
$manifest | ConvertTo-Json -Depth 4 | Out-File -FilePath $manifestPath -Encoding utf8
Write-Host "  $manifestPath"

Write-Host ""
Write-Host "===========================================" -ForegroundColor Green
Write-Host " READY TO SHUTDOWN. Install SSD, then run:" -ForegroundColor Green
Write-Host "   .\scripts\ssd-2-post-migration.ps1 <new SSD path>" -ForegroundColor Green
Write-Host "===========================================" -ForegroundColor Green
