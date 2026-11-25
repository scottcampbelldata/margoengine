// Native thread stacks of a process that should have exited (KB-OWN-EXIT1): what each of its threads is waiting in,
// read from outside the process, so it works when the process's own JavaScript has already finished and no Node
// diagnostic report (process.report, --report-on-signal, the inspector) can answer any more.
//
// Windows only, with no new dependency and no admin rights: Windows PowerShell compiles a small C# helper that opens the
// user's own process for query and read access, suspends each thread in turn, reads its registers and walks its stack
// with the system dbghelp.dll (StackWalk64, the process's unwind tables), naming each frame by the nearest exported
// symbol of its module (no symbol server, no download). ntdll, KERNELBASE and ucrtbase frames name the exact waiting
// call; node.exe frames are given as module offsets too, which Node's published PDB for that version resolves offline.
// It also writes a small minidump (MiniDumpNormal with thread info: every stack and register set, the module list, no
// heap; about 100 KB for Node) for a debugger. Bounded in time (`timeoutMs`), frames per thread and dump count; any
// failure is returned as a line of text, never thrown, so capturing can never change what the caller does next.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';

/** At most this many dumps are kept beside one log; past it the stacks are still read and the dump is skipped. */
export const maxDumps = 5;

const helper = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
public static class MargoNativeStacks {
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenThread(uint access, bool inherit, int tid);
  [DllImport("kernel32.dll")] static extern uint SuspendThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetThreadContext(IntPtr thread, IntPtr context);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr LoadLibrary(string name);
  [DllImport("kernel32.dll", CharSet = CharSet.Ansi)] static extern IntPtr GetProcAddress(IntPtr module, string name);
  [DllImport("dbghelp.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool SymInitializeW(IntPtr process, string path, bool invade);
  [DllImport("dbghelp.dll")] static extern bool SymCleanup(IntPtr process);
  [DllImport("dbghelp.dll")] static extern uint SymSetOptions(uint options);
  [DllImport("dbghelp.dll", SetLastError = true)] static extern bool StackWalk64(uint machine, IntPtr process, IntPtr thread, IntPtr frame, IntPtr context, IntPtr readMemory, IntPtr functionTable, IntPtr moduleBase, IntPtr translate);
  [DllImport("dbghelp.dll", SetLastError = true)] static extern bool SymFromAddr(IntPtr process, ulong address, out ulong displacement, IntPtr symbol);
  [DllImport("dbghelp.dll", SetLastError = true)] static extern bool MiniDumpWriteDump(IntPtr process, int pid, IntPtr file, uint type, IntPtr exception, IntPtr user, IntPtr callback);

  public static List<string> Read(int pid, bool walk, string dump) {
    var lines = new List<string>();
    // PROCESS_QUERY_INFORMATION | PROCESS_VM_READ: granted on the user's own processes without admin rights.
    IntPtr process = OpenProcess(0x0400 | 0x0010, false, pid);
    if (process == IntPtr.Zero) { lines.Add("open process failed: error " + Marshal.GetLastWin32Error()); return lines; }
    bool sym = false;
    IntPtr raw = Marshal.AllocHGlobal(1232 + 16), context = new IntPtr((raw.ToInt64() + 15) & ~15L);
    IntPtr frame = Marshal.AllocHGlobal(512), symbol = Marshal.AllocHGlobal(88 + 512);
    try {
      var target = Process.GetProcessById(pid);
      var modules = new List<Tuple<ulong, ulong, string>>();
      try { foreach (ProcessModule m in target.Modules) modules.Add(Tuple.Create((ulong)m.BaseAddress.ToInt64(), (ulong)m.ModuleMemorySize, m.ModuleName)); }
      catch (Exception e) { lines.Add("modules: " + e.Message); }
      if (walk) {
        SymSetOptions(0x2 | 0x4); // SYMOPT_UNDNAME | SYMOPT_DEFERRED_LOADS: module exports only
        sym = SymInitializeW(process, null, true);
        IntPtr dbghelp = LoadLibrary("dbghelp.dll");
        IntPtr tableAccess = GetProcAddress(dbghelp, "SymFunctionTableAccess64"), moduleBase = GetProcAddress(dbghelp, "SymGetModuleBase64");
        int count = 0;
        foreach (ProcessThread t in target.Threads) {
          if (++count > 64) { lines.Add("more threads not read"); break; }
          string head = "thread " + t.Id + " " + t.ThreadState + (t.ThreadState == System.Diagnostics.ThreadState.Wait ? "/" + t.WaitReason : "");
          // THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT | THREAD_QUERY_INFORMATION
          IntPtr thread = OpenThread(0x0002 | 0x0008 | 0x0040, false, t.Id);
          if (thread == IntPtr.Zero) { lines.Add(head + ": open failed: error " + Marshal.GetLastWin32Error()); continue; }
          var frames = new List<string>();
          SuspendThread(thread);
          try {
            for (int i = 0; i < 1232; i++) Marshal.WriteByte(context, i, 0);
            Marshal.WriteInt32(context, 0x30, 0x10000B); // ContextFlags = CONTEXT_FULL (AMD64)
            if (!GetThreadContext(thread, context)) frames.Add("context failed: error " + Marshal.GetLastWin32Error());
            else {
              for (int i = 0; i < 512; i++) Marshal.WriteByte(frame, i, 0);
              Marshal.WriteInt64(frame, 0, Marshal.ReadInt64(context, 0xF8)); Marshal.WriteInt32(frame, 12, 3); // AddrPC = Rip, flat
              Marshal.WriteInt64(frame, 32, Marshal.ReadInt64(context, 0xA0)); Marshal.WriteInt32(frame, 44, 3); // AddrFrame = Rbp
              Marshal.WriteInt64(frame, 48, Marshal.ReadInt64(context, 0x98)); Marshal.WriteInt32(frame, 60, 3); // AddrStack = Rsp
              for (int depth = 0; depth < 48 && StackWalk64(0x8664, process, thread, frame, context, IntPtr.Zero, tableAccess, moduleBase, IntPtr.Zero); depth++) {
                ulong pc = (ulong)Marshal.ReadInt64(frame, 0);
                if (pc == 0) break;
                string module = "?"; ulong start = 0;
                foreach (var m in modules) if (pc >= m.Item1 && pc < m.Item1 + m.Item2) { module = m.Item3; start = m.Item1; break; }
                for (int i = 0; i < 88; i++) Marshal.WriteByte(symbol, i, 0);
                Marshal.WriteInt32(symbol, 0, 88); Marshal.WriteInt32(symbol, 80, 500); // SizeOfStruct, MaxNameLen
                ulong displacement;
                string near = sym && SymFromAddr(process, pc, out displacement, symbol)
                  ? " " + Marshal.PtrToStringAnsi(new IntPtr(symbol.ToInt64() + 84), Marshal.ReadInt32(symbol, 76)) + "+0x" + displacement.ToString("x")
                  : "";
                frames.Add(module + "+0x" + (pc - start).ToString("x") + near);
              }
            }
          } finally { ResumeThread(thread); CloseHandle(thread); }
          lines.Add(head + ": " + string.Join(" < ", frames));
        }
      }
      if (!String.IsNullOrEmpty(dump)) {
        using (var file = new FileStream(dump, FileMode.CreateNew, FileAccess.Write)) {
          // MiniDumpNormal | MiniDumpWithThreadInfo
          bool ok = MiniDumpWriteDump(process, pid, file.SafeFileHandle.DangerousGetHandle(), 0x1000, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
          lines.Add(ok ? "minidump " + dump + " " + file.Length + " B" : "minidump failed: error " + Marshal.GetLastWin32Error());
        }
      }
    } catch (Exception e) {
      lines.Add("native stacks failed: " + e.Message);
    } finally {
      if (sym) SymCleanup(process);
      Marshal.FreeHGlobal(raw); Marshal.FreeHGlobal(frame); Marshal.FreeHGlobal(symbol);
      CloseHandle(process);
    }
    return lines;
  }
}`;

const quote = (text) => `'${String(text).replaceAll("'", "''")}'`;

/**
 * Every thread of `pid` with its native stack, innermost frame first ("thread <id> <state>[/<wait reason>]: frame <
 * frame ..."), and, given `log`, a minidump beside it named after `token` (see dumpPath) while fewer than `maxDumps`
 * are there. Never throws: a failure is a line of the result. Off Windows it says so (the process report's `ps` rows
 * already name each thread's wait channel there).
 */
export function nativeStacks(pid, { log, token = pid, timeoutMs = 30_000 } = {}) {
  if (process.platform !== 'win32') return [`native stacks: not read on ${process.platform}`];
  try {
    const lines = [];
    let dump = log && dumpPath(log, token);
    if (dump) {
      const prefix = `${basename(log, '.log')}-`;
      let kept = 0;
      try {
        kept = readdirSync(dirname(log)).filter((name) => name.startsWith(prefix) && name.endsWith('.dmp')).length;
      } catch {}
      if (kept >= maxDumps) {
        lines.push(
          `minidump skipped: ${kept} dumps already beside the log (at most ${maxDumps}; remove them once read)`,
        );
        dump = undefined;
      }
    }
    const script = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${helper}
'@
[MargoNativeStacks]::Read(${Number(pid)}, $${process.arch === 'x64'}, ${dump ? quote(dump) : "''"}) | ForEach-Object { $_ }`;
    const out = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 4 << 20 },
    );
    if (out.error || out.status !== 0)
      return [...lines, `native stacks failed: ${out.error?.message ?? (out.stderr?.trim() || `exit ${out.status}`)}`];
    if (process.arch !== 'x64') lines.push(`native stacks: no stack walk on ${process.arch}; see the minidump`);
    return [...lines, ...out.stdout.split(/\r?\n/).filter(Boolean)];
  } catch (error) {
    return [`native stacks failed: ${error.message}`];
  }
}

/** The dump file for one stall: beside `log`, named after the holder's token. */
export const dumpPath = (log, token) =>
  join(dirname(log), `${basename(log, '.log')}-${String(token).replace(/[^\w.-]/g, '_')}.dmp`);
