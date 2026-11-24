// Windows enumeration already supplies file size and modification time. Node's Dirent discards both, so a
// readdirSync/statSync loop repeats a native metadata lookup for every archive. Read the enumeration metadata
// with the system .NET runtime instead. Every eviction gets a fresh snapshot; nothing is cached between writes.
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const script = join(import.meta.dirname, 'archive-metadata.ps1');

/** Match Node's seconds plus fractional nanoseconds conversion, including pre-epoch timestamps. */
function milliseconds(ticks) {
  const unix = BigInt(ticks) - 621355968000000000n,
    seconds = unix >= 0n ? unix / 10000000n : (unix - 9999999n) / 10000000n;
  return Number(seconds) * 1000 + Number(unix - seconds * 10000000n) / 10000;
}

/** Current archive metadata in Node's directory listing order (also the stable eviction tie order). */
export function archiveMetadata(folder, { platform = process.platform } = {}) {
  const names = readdirSync(folder).filter((name) => name.endsWith('.gz'));
  let native;
  if (platform === 'win32' && names.length) {
    const text = execFileSync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, folder],
      { encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 256 * 1024 ** 2 },
    );
    native = new Map(
      text.split(/\r?\n/).filter(Boolean).map((line) => {
        const [name, size, ticks] = line.split('\t');
        return [name, ticks === undefined ? undefined : { size: Number(size), at: milliseconds(ticks) }];
      }),
    );
  }
  return names.flatMap((name) => {
    const path = join(folder, name),
      cached = native?.get(name);
    if (cached) return [{ path, ...cached }];
    // Portable path, reparse points/directories, or an entry removed between the two listings. Missing is still
    // the only ignored stat error; permissions and I/O failures must end verify rather than hide a bad cache.
    const stat = statSync(path, { throwIfNoEntry: false });
    return stat ? [{ path, size: stat.size, at: stat.mtimeMs }] : [];
  });
}
