param(
  [int]$Parallel = 20,
  [int]$Rps = 20,
  [int]$HeartbeatSec = 300,
  [int]$GcSec = 60,
  [int]$FsyncEvery = 500,
  [string]$LogPath = "E:\paperfate\data\_pmc_aws_s3.log",
  [switch]$OaOnly
)

$ErrorActionPreference = "Continue"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $RepoRoot

if (-not $env:DATA_ROOT) {
  $env:DATA_ROOT = "E:\paperfate\data"
}

$logDir = Split-Path -Parent $LogPath
if ($logDir -and -not (Test-Path $logDir)) {
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

function Write-Log {
  param([string]$Line)
  Write-Output $Line
  $Line | Add-Content -Path $LogPath -Encoding UTF8
}

function Tee-Utf8Log {
  process {
    $line = $_.ToString()
    Write-Output $line
    $line | Add-Content -Path $LogPath -Encoding UTF8
  }
}

while ($true) {
  $started = Get-Date -Format o
  Write-Log "[WRAPPER $started] starting PMC S3 collector parallel=$Parallel rps=$Rps data_root=$env:DATA_ROOT"

  $extra = @()
  if ($OaOnly) { $extra += "--oa-only" }
  & node --expose-gc scripts\collect-pmc-aws-s3.mjs `
    --parallel=$Parallel `
    --rps=$Rps `
    --heartbeat-sec=$HeartbeatSec `
    --gc-sec=$GcSec `
    --fsync-every=$FsyncEvery `
    @extra 2>&1 |
    Tee-Utf8Log

  $exitCode = $LASTEXITCODE
  $stopped = Get-Date -Format o
  Write-Log "[WRAPPER $stopped] collector exited code=$exitCode; restarting in 30s"

  Start-Sleep -Seconds 30
}
