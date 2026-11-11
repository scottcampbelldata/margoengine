# Prints what an NVIDIA / Microsoft report needs about GPU driver resets on this PC: the nvlddmkm event 153 entries with their times,
# the TDR (watchdog) reports of Windows (WER LiveKernelEvent 141 files) for comparison, the adapters, and the hardware scheduling mode.
# powershell -NoProfile -File collect-evidence.ps1
"Now: $(Get-Date -Format s)"
Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion, DriverDate | Format-Table -AutoSize | Out-String
"HwSchMode (2 = hardware-accelerated GPU scheduling on): " + ((Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\GraphicsDrivers' -ErrorAction SilentlyContinue).HwSchMode)
$e = Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'nvlddmkm'; Id = 153 } -ErrorAction SilentlyContinue
"nvlddmkm event 153 entries in the System log: $($e.Count)"
$e | ForEach-Object { '{0:s}  {1}' -f $_.TimeCreated, ($_.Properties[0].Value + " " + $_.Properties[1].Value) }
"WER LiveKernelEvent 141 reports (Windows watchdog resets, a different kind):"
Get-ChildItem 'C:\ProgramData\Microsoft\Windows\WER\ReportArchive' -Directory -ErrorAction SilentlyContinue | Where-Object Name -like '*LiveKernelEvent*' | Select-Object -First 10 Name, LastWriteTime | Format-Table -AutoSize | Out-String
