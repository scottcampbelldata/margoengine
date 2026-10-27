// Feature JS of the three.js parity report: gzip bytes of the scripts one engine's page fetched that the other
// engine's page did not (the feature's own JavaScript).
import { existsSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

/**
 * Sizes come from the run (info.scriptGzip, measured when the page ran: bench/lib/browser.mjs). Runs older than that
 * record are measured from the build folders now (`fileOf(name)` gives the file), which only works while they still
 * hold that run's files: the scene build is replaced by every bench run (hashed names), so a missing file would make
 * the sum short. Such a sum is null ("n/a"), never a smaller number (p-morph once read 52 KB that way against 117 KB
 * measured at run time). Those runs also listed only .js scripts, so an engine-bench page (its .mjs chunks unlisted,
 * three.js's side was its 5 KB entry alone) is null too.
 */
export function featureGzip(entry, other, fileOf) {
  const mine = entry?.info?.scripts ?? [],
    shared = new Set(other?.info?.scripts ?? []),
    recorded = entry?.info?.scriptGzip;
  if (!recorded && mine.some((name) => /^\/ext\//.test(name)) && !mine.some((name) => name.endsWith('.mjs')))
    return null;
  let total = 0;
  for (const name of mine) {
    if (shared.has(name)) continue;
    if (recorded) {
      if (!(name in recorded)) return null;
      total += recorded[name];
      continue;
    }
    const path = fileOf(name);
    if (!path || !existsSync(path)) return null;
    total += gzipSync(readFileSync(path), { level: 9 }).length;
  }
  return total;
}

/** A Feature JS cell value: bytes with separators, or n/a when unknown. */
export const featureCell = (bytes) => (Number.isFinite(bytes) ? bytes.toLocaleString('en-US') : 'n/a');
