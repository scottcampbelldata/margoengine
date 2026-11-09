param([Parameter(Mandatory=$true)][string]$IdentitiesBase64)
$ErrorActionPreference = 'Stop'
# Keep handles open until termination finishes. A PID cannot be reused while its process object is pinned.
$identities = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($IdentitiesBase64)) | ConvertFrom-Json
$pinned = @()
try {
  foreach ($identity in $identities) {
    try { $process = [Diagnostics.Process]::GetProcessById([int]$identity.pid) }
    catch [ArgumentException] { continue }
    try {
      $null = $process.Handle
      # CIM_DATETIME carries six fractional digits. Canonicalize FILETIME to that
      # same microsecond representation, rather than comparing a truncated CIM
      # identity to a native timestamp with a seventh fractional digit.
      $nativeBirth = $process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()
      $canonicalBirth = $nativeBirth.Substring(0, $nativeBirth.Length - 1) + '0'
      if ($canonicalBirth -ne $identity.birth) {
        $process.Dispose()
        continue
      }
      $pinned += $process
    } catch [InvalidOperationException] { $process.Dispose() }
  }
  # Parents precede descendants in the reducer snapshot. /T also ends children born after that snapshot.
  foreach ($process in $pinned) {
    if (-not $process.HasExited) {
      $null = & taskkill.exe /PID $process.Id /T /F 2>&1
    }
  }
  $end = [DateTime]::UtcNow.AddSeconds(10)
  foreach ($process in $pinned) {
    $left = [int][Math]::Max(0, ($end - [DateTime]::UtcNow).TotalMilliseconds)
    if (-not $process.WaitForExit($left)) { throw "Process $($process.Id) survived idle termination" }
  }
  @{ ok = $true } | ConvertTo-Json -Compress
} catch {
  @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
} finally {
  foreach ($process in $pinned) { $process.Dispose() }
}
