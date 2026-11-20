# Registers the "Margo Shot Runner" scheduled task on a Windows render machine (docs/shots.md, Render queue): at the
# signed-in user's logon, and every 5 minutes while they stay signed in, it starts the shot queue runner
# (tools/shot/queue.mjs run --watch) in their desktop session, where Edge's GPU process gets a WebGPU adapter every time.
# Runs only while the user is logged on: logon type Interactive, so no password is asked for or stored. One runner at a
# time (the task ignores a new start while one runs, and the runner's pid file stops a second). Changes nothing else.
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\shot\runner-task.ps1 [-User <domain\name>] [-Repo <dir>] [-Remove]
# -User is the account whose desktop session runs the renders (default the account running this); naming another
# account needs an administrator, as Windows asks for any task registered for someone else.
param(
  [string]$User = "$env:USERDOMAIN\$env:USERNAME",
  [string]$Repo = (Resolve-Path "$PSScriptRoot\..\..").Path,
  # The ffmpeg for --encode jobs (MARGO_FFMPEG), kept outside the repository; empty: ffmpeg on the PATH.
  [string]$FFmpeg = '',
  [switch]$Remove
)
$ErrorActionPreference = 'Stop'
$Name = 'Margo Shot Runner'
if ($Remove) {
  Unregister-ScheduledTask -TaskName $Name -Confirm:$false
  Write-Output "removed $Name"
  exit 0
}
$node = (Get-Command node -ErrorAction Stop).Source
$queue = Join-Path $Repo '.lane\queue'
New-Item -ItemType Directory -Force -Path $queue | Out-Null
$ff = if ($FFmpeg) { "`$env:MARGO_FFMPEG = '$FFmpeg'; " } else { '' }
$run = "${ff}Set-Location -LiteralPath '$Repo'; & '$node' tools\shot\queue.mjs run --watch --queue '$queue' *>> '$queue\runner.log'"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command `"$run`"" -WorkingDirectory $Repo
$user = $User
$logon = New-ScheduledTaskTrigger -AtLogOn -User $user
# A runner that stopped (a crash, a reboot of node) is started again within 5 minutes while the user is signed in.
$again = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $Name -Action $action -Trigger @($logon, $again) -Principal $principal -Settings $settings `
  -Description 'Runs queued Margo shot renders (tools/shot/queue.mjs) in the signed-in session; docs/shots.md' -Force | Out-Null
Write-Output "registered $Name for $user (runs only while $user is signed in): queue $queue, node $node"
