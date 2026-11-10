param([Parameter(Mandatory = $true)][string]$Directory)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
# Directory enumeration pre-populates Length and LastWriteTimeUtc. Do not Refresh:
# that would turn this into one extra filesystem metadata lookup per archive.
foreach ($entry in ([System.IO.DirectoryInfo]::new($Directory)).EnumerateFileSystemInfos()) {
    if (-not $entry.Name.EndsWith('.gz', [System.StringComparison]::Ordinal)) { continue }
    if (($entry.Attributes -band ([System.IO.FileAttributes]::ReparsePoint -bor [System.IO.FileAttributes]::Directory)) -ne 0) {
        # Node must follow links and handle directories exactly as statSync does.
        [Console]::WriteLine($entry.Name)
    } else {
        # Windows forbids tabs/newlines in a filename. Integers use invariant culture.
        [Console]::WriteLine("{0}`t{1}`t{2}", $entry.Name, $entry.Length, $entry.LastWriteTimeUtc.Ticks)
    }
}
