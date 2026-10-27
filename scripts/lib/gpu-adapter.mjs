import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir, uptime } from 'node:os';
import { join } from 'node:path';

/**
 * Which GPU a Chromium-family browser uses on a Windows PC with more than one, decided at launch (bug 33).
 *
 * Headless Chromium runs on DXGI adapter 0 and WebGPU offers only that adapter. Windows puts the adapter that carries the
 * current session's display output first, so on a PC with an integrated and a discrete GPU the answer changes with
 * whether a Remote Desktop session is connected. requestAdapter powerPreference, --force_high_performance_gpu and the
 * Windows per-app GPU preference do not change it. `--use-adapter-luid=<high>,<low>` (decimal) does. A LUID changes at
 * every boot and driver restart, so it is looked up here, never written down.
 *
 *   MARGO_GPU=default            add no flag: whichever adapter Windows and the browser pick
 *   MARGO_GPU=nvidia|amd|intel   prefer that vendor's hardware adapter (largest video memory when there are several)
 *   MARGO_GPU_LUID=high,low      use exactly this adapter (decimal, as Chromium reads it); wins over MARGO_GPU
 *   (unset)                      the hardware adapter with the most dedicated video memory; no flag with only one
 */

const VENDORS = { nvidia: 0x10de, amd: 0x1002, intel: 0x8086 };
const MICROSOFT = 0x1414;
/** DXGI_ADAPTER_FLAG_SOFTWARE */
const SOFTWARE_FLAG = 2;
const CACHE_FILE = 'margo-gpu-adapters.json';
/** A cached lookup older than this is repeated, in case a driver restart changed the LUIDs without a reboot. */
const CACHE_MAX_AGE_MS = 30 * 60_000;

const SOURCE = String.raw`
$src = @'
using System;
using System.Runtime.InteropServices;
public static class Dxgi {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DESC1 {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Description;
    public uint VendorId, DeviceId, SubSysId, Revision;
    public UIntPtr DedicatedVideoMemory, DedicatedSystemMemory, SharedSystemMemory;
    public uint LuidLow; public int LuidHigh; public uint Flags;
  }
  [DllImport("dxgi.dll")] static extern int CreateDXGIFactory1(ref Guid riid, out IntPtr f);
  delegate int EnumAdapters1D(IntPtr self, uint i, out IntPtr a);
  delegate int GetDesc1D(IntPtr self, out DESC1 d);
  static T V<T>(IntPtr obj, int slot) { IntPtr vt = Marshal.ReadIntPtr(obj); return Marshal.GetDelegateForFunctionPointer<T>(Marshal.ReadIntPtr(vt, slot * IntPtr.Size)); }
  public static string Run() {
    var sb = new System.Text.StringBuilder();
    Guid f1 = new Guid("770aae78-f26f-4dba-a829-253c83d1b387");
    IntPtr f; int hr = CreateDXGIFactory1(ref f1, out f);
    if (hr != 0) return "ERROR CreateDXGIFactory1 hr=" + hr.ToString("x");
    IntPtr a;
    for (uint i = 0; V<EnumAdapters1D>(f, 12)(f, i, out a) == 0; i++) {
      DESC1 d; V<GetDesc1D>(a, 10)(a, out d);
      sb.AppendLine(string.Format("ADAPTER|{0}|{1}|{2}|{3}|{4}|{5}|{6}", d.Description.Replace('|', ' '), d.VendorId, d.DeviceId, (ulong)d.DedicatedVideoMemory, d.LuidHigh, d.LuidLow, d.Flags));
      Marshal.Release(a);
    }
    Marshal.Release(f);
    return sb.ToString();
  }
}
'@
Add-Type -TypeDefinition $src
[Console]::Out.Write([Dxgi]::Run())
`;

/**
 * Parses the lookup script's output into adapters: { name, vendorId, deviceId, memory, high, low, software }.
 * `high` and `low` are decimal strings, the form Chromium's --use-adapter-luid reads. Lines that are not adapters are ignored.
 */
export function parseAdapters(text) {
  const adapters = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const parts = line.trim().split('|');
    if (parts[0] !== 'ADAPTER' || parts.length < 8) continue;
    const [, name, vendor, device, memory, high, low, flags] = parts;
    adapters.push({
      name,
      vendorId: Number(vendor),
      deviceId: Number(device),
      memory: Number(memory),
      high: String(Number(high)),
      low: String(Number(low)),
      software: (Number(flags) & SOFTWARE_FLAG) !== 0 || Number(vendor) === MICROSOFT,
    });
  }
  return adapters;
}

/** The vendor name for reports. */
export function vendorName(vendorId) {
  return Object.entries(VENDORS).find(([, id]) => id === vendorId)?.[0] ?? `0x${vendorId.toString(16)}`;
}

/**
 * Chooses the adapter for `env`. Returns { arg, adapter, why } where `arg` is the Chromium switch or undefined (no flag)
 * and `why` is one line for the log. `warn` is called with a line for each setting that cannot be honoured.
 */
export function chooseAdapter(adapters, env = process.env, warn = () => {}) {
  const luid = env.MARGO_GPU_LUID?.trim(),
    pref = env.MARGO_GPU?.trim().toLowerCase();
  if (luid) {
    if (/^-?\d+,\d+$/.test(luid))
      return { arg: `--use-adapter-luid=${luid}`, adapter: undefined, why: `MARGO_GPU_LUID=${luid}` };
    warn(`MARGO_GPU_LUID="${luid}" is not "high,low" in decimal (for example 0,79477); ignored`);
  }
  if (pref === 'default') return { arg: undefined, adapter: undefined, why: 'MARGO_GPU=default, no adapter flag' };
  const hardware = adapters.filter((a) => !a.software).sort((a, b) => b.memory - a.memory);
  if (pref && !(pref in VENDORS)) warn(`MARGO_GPU="${pref}" is not default, nvidia, amd or intel; ignored`);
  let adapter;
  if (pref in VENDORS) {
    adapter = hardware.find((a) => a.vendorId === VENDORS[pref]);
    if (!adapter) warn(`MARGO_GPU=${pref}: no ${pref} hardware adapter found; using the largest one instead`);
  }
  if (!adapter) {
    if (hardware.length < 2)
      return { arg: undefined, adapter: hardware[0], why: 'one hardware adapter, no adapter flag' };
    adapter = hardware[0];
  }
  return {
    arg: `--use-adapter-luid=${adapter.high},${adapter.low}`,
    adapter,
    why: `${vendorName(adapter.vendorId)} ${adapter.name}`,
  };
}

function readCache(key, now, dir) {
  try {
    const cache = JSON.parse(readFileSync(join(dir, CACHE_FILE), 'utf8'));
    if (cache.key === key && now - cache.at < CACHE_MAX_AGE_MS && Array.isArray(cache.adapters)) return cache.adapters;
  } catch {
    /* no cache yet, or an unreadable one: look up again */
  }
  return undefined;
}

/** Runs the DXGI lookup through PowerShell (about 2 s). Returns the adapters; throws with a short message on failure. */
export function runLookup(spawn = spawnSync) {
  const encoded = Buffer.from(SOURCE, 'utf16le').toString('base64'),
    result = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    });
  if (result.error) throw result.error;
  const out = String(result.stdout ?? '');
  if (result.status !== 0 || out.startsWith('ERROR'))
    throw new Error(out.trim() || String(result.stderr ?? '').split('\n')[0] || `exit ${result.status}`);
  return parseAdapters(out);
}

let processCache;

/**
 * The adapter list for this PC: once per process, and in a small file in the temp folder keyed by host name and boot
 * time (30 minute limit) so the next check does not pay the 2 s again. Throws if the lookup fails.
 */
export function listAdapters({
  spawn = spawnSync,
  dir = tmpdir(),
  now = Date.now(),
  useProcessCache = true,
  bootAt = Math.round((Date.now() - uptime() * 1000) / 120_000),
} = {}) {
  if (useProcessCache && processCache) return processCache;
  const key = `${hostname()}|${bootAt}`;
  let adapters = readCache(key, now, dir);
  if (!adapters) {
    adapters = runLookup(spawn);
    try {
      writeFileSync(join(dir, CACHE_FILE), JSON.stringify({ key, at: now, adapters }));
    } catch {
      /* a read-only temp folder only costs the next check 2 s */
    }
  }
  if (useProcessCache) processCache = adapters;
  return adapters;
}

let lastChoice;

/** What the last {@link gpuAdapterArg} chose, for the log line ("nvidia NVIDIA RTX A6000"), or undefined. */
export function lastAdapterChoice() {
  return lastChoice;
}

/**
 * The `--use-adapter-luid=<high>,<low>` switch for this launch, or undefined for no switch. Never throws: if the
 * lookup fails it prints one warning line and returns undefined (the browser then takes whatever adapter Windows gives).
 */
export function gpuAdapterArg({ env = process.env, list = listAdapters, warn = (line) => console.warn(line) } = {}) {
  let adapters = [];
  const needsList = !env.MARGO_GPU_LUID?.trim() && env.MARGO_GPU?.trim().toLowerCase() !== 'default';
  if (needsList) {
    try {
      adapters = list();
    } catch (error) {
      warn(`GPU lookup failed (${String(error?.message ?? error).split('\n')[0]}); launching without an adapter flag`);
      lastChoice = 'lookup failed, no adapter flag';
      return undefined;
    }
  }
  const choice = chooseAdapter(adapters, env, warn);
  lastChoice = choice.why;
  return choice.arg;
}
