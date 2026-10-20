# Laptop evaluation queue runner (Satya_Development.md §11: 4 systems × 3 datasets + ablations + τ tuning).
# Resumable: re-running the script skips finished items. Keeps Windows awake only while it runs
# (SetThreadExecutionState; no power settings are changed). Logs (UTF-8): results\eval-logs\
#   Start detached:
#   Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','scripts\full-eval.ps1','-QueueFile','scripts\eval-queues\full.txt'
param([string]$QueueFile = "scripts/eval-queues/full.txt")
$ErrorActionPreference = "Continue"
Set-Location (Split-Path -Parent $PSScriptRoot)
New-Item -ItemType Directory -Force results\eval-logs | Out-Null
$log = "results\eval-logs\full-eval.log"

Add-Type -Namespace Satya -Name Power -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll")]
public static extern uint SetThreadExecutionState(uint esFlags);
'@
# ES_CONTINUOUS | ES_SYSTEM_REQUIRED: no sleep while this process runs; the display may still turn off.
[Satya.Power]::SetThreadExecutionState(0x80000001) | Out-Null

function Write-Log($text) { Add-Content -Encoding utf8 -Path $log -Value "$(Get-Date -Format s)  $text" }

# Queue file: one job per line — "dataset system split [sample]", "TUNE [datasets]" or "REPORT"; # = comment.
$queue = Get-Content -Encoding utf8 $QueueFile | Where-Object { $_.Trim() -and -not $_.Trim().StartsWith("#") }

Write-Log "=== evaluation started (pid $PID, queue $QueueFile) ==="
foreach ($job in $queue) {
  $parts = $job.Trim() -split "\s+"
  if ($parts[0] -eq "TUNE") { $cmd = if ($parts.Count -gt 1) { "tune --datasets $($parts[1])" } else { "tune" } }
  elseif ($parts[0] -eq "REPORT") { $cmd = "report" }
  else {
    $cmd = "eval --dataset $($parts[0]) --system $($parts[1]) --split $($parts[2]) --resume --concurrency 3"
    if ($parts.Count -gt 3) { $cmd += " --sample $($parts[3])" }
  }
  Write-Log "START $cmd"
  $started = Get-Date
  # cmd.exe redirection keeps Node's UTF-8 output byte-for-byte (PowerShell 5.1 would re-encode to UTF-16).
  cmd /c "npx satya $cmd 1>>results\eval-logs\full-eval.out.log 2>>results\eval-logs\progress.log"
  $code = $LASTEXITCODE
  $minutes = [math]::Round(((Get-Date) - $started).TotalMinutes, 1)
  Write-Log "END   $cmd (exit $code, $minutes min)"
}
Write-Log "=== evaluation finished ==="
[Satya.Power]::SetThreadExecutionState(0x80000000) | Out-Null
