$ErrorActionPreference = 'Stop'
# Complete raw snapshot, no Select-Object -First. Preserve uint64 values as strings.
$processes = @(Get-CimInstance Win32_Process | ForEach-Object {
  @{ pid = [int]$_.ProcessId; parent = [int]$_.ParentProcessId; birth = $_.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString() }
})
$engines = @(Get-CimInstance Win32_PerfRawData_GPUPerformanceCounters_GPUEngine | ForEach-Object {
  $match = [regex]::Match($_.Name, '(^|_)pid_(\d+)_')
  if ($match.Success) {
    @{ pid = [int]$match.Groups[2].Value; name = $_.Name; running = $_.RunningTime.ToString(); timestamp = $_.Timestamp_Sys100NS.ToString() }
  }
})
@{ ok = $true; processes = $processes; engines = $engines; engineCount = $engines.Count } | ConvertTo-Json -Depth 5 -Compress
