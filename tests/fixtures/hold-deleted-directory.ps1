$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class DeletedDirectory {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetFileInformationByHandle(SafeFileHandle file, int infoClass, ref int delete, uint size);
}
'@
$held = [DeletedDirectory]::CreateFile($args[0], 0x10000, 7, [IntPtr]::Zero, 3, 0x02000000, [IntPtr]::Zero)
if ($held.IsInvalid) { throw "CreateFile failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
try {
    [Console]::WriteLine('ready')
    [Console]::Out.Flush()
    if ([Console]::ReadLine() -ne 'delete') { throw 'Expected delete command' }
    $delete = 1
    if (-not [DeletedDirectory]::SetFileInformationByHandle($held, 4, [ref]$delete, 4)) {
        throw "SetFileInformationByHandle failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }
    [Console]::WriteLine('pending')
    [Console]::Out.Flush()
    [void][Console]::ReadLine()
} finally { $held.Dispose() }
