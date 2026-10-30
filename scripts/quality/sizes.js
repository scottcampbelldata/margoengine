// Gate 1, sizes: the min+gzip size of every package entry and bundled worker (entry-sizes.json's method, bare imports
// external) stays within its budget, and no entry statically pulls in another package's heavy entry.
// Items: `<specifier>` -> gzip budget (measured + HEADROOM), `<package> dist/workers/<file>` -> same, and
// `leak <entry> -> <target>` -> 1 for each heavy entry of another package (gzip >= HEAVY) that loading <entry> loads,
// following static imports through dist files and other packages' entries (dynamic import() is lazy and allowed).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { parseSync } from 'rolldown/utils';
import { LAZY_SPLITS } from '../lazy-files.js';
import { bundleBytes, bundleSplit } from '../measure-size.js';
import { slash } from './packages.js';

/** Budget headroom: 3% or 256 bytes, whichever is larger. */
export const headroom = (bytes) => bytes + Math.max(256, Math.ceil(bytes * 0.03));
/** A target this big (gzip bytes) counts as a leak when another package's entry imports it statically. */
export const HEAVY = 10_000;
/** Every package builds on these (math by docs/conventions.md: one shared copy), so importing them is not a leak. */
const FOUNDATION = new Set(['@margoengine/core', '@margoengine/core/extension', '@margoengine/math']);

async function pool(jobs, size) {
  const results = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      results[i] = await jobs[i]();
    }
  };
  await Promise.all(Array.from({ length: size }, worker));
  return results;
}

export async function sizesGate({ root, packages }) {
  const jobs = [];
  for (const pkg of packages) {
    for (const entry of pkg.entries)
      if (existsSync(join(root, entry.dist))) jobs.push({ key: entry.specifier, file: entry.dist });
    const workers = join(root, 'packages', pkg.dir, 'dist/workers');
    if (existsSync(workers))
      for (const name of readdirSync(workers).filter((n) => n.endsWith('.js')))
        jobs.push({ key: `${pkg.name} dist/workers/${name}`, file: `packages/${pkg.dir}/dist/workers/${name}` });
  }
  const missing = packages.flatMap((p) => p.entries).filter((e) => !existsSync(join(root, e.dist)));
  if (missing.length) throw new Error(`${missing[0].dist} missing; run npm run build:packages first`);
  const sizes = await pool(
    jobs.map((job) => async () => gzipSync(await bundleBytes(join(root, job.file))).length),
    Math.max(2, Math.min(8, cpus().length)),
  );
  const items = {};
  jobs.forEach((job, i) => {
    items[job.key] = sizes[i];
  });

  // Entries with a lazy part: the base without it and the lazy part alone, each against its own budget. The joined
  // entry above stays a budget too, so neither number can grow behind the other.
  for (const split of LAZY_SPLITS) {
    const part = await bundleSplit(join(root, split.dist), split.chunk);
    if (part.staticLazy.length)
      throw new Error(
        `${split.specifier}: lazy chunk imported statically (${part.staticLazy.join(', ')}); keep it behind import()`,
      );
    items[`${split.specifier} base (without ${split.lazyLabel})`] = gzipSync(part.base).length;
    items[`${split.specifier} lazy ${split.lazyLabel}`] = gzipSync(part.lazy).length;
  }

  // Leaks: static import graph over dist files.
  const bySpecifier = new Map(packages.flatMap((p) => p.entries.map((e) => [e.specifier, e])));
  const imports = new Map(); // dist file -> { files: [relative dist files], entries: [specifiers] }
  const scan = (file) => {
    if (imports.has(file)) return imports.get(file);
    const found = { files: [], entries: [] };
    imports.set(file, found);
    if (!existsSync(join(root, file))) return found;
    const { program } = parseSync(file, readFileSync(join(root, file), 'utf8'));
    for (const node of program.body) {
      if (!node.source || !/^(Import|ExportAll|ExportNamed)Declaration$/.test(node.type)) continue;
      if (node.importKind === 'type' || node.exportKind === 'type') continue;
      const spec = node.source.value;
      if (spec.startsWith('.')) found.files.push(slash(join(dirname(file), spec)));
      else if (bySpecifier.has(spec)) found.entries.push(spec);
    }
    return found;
  };
  const reach = new Map(); // specifier -> Set(specifiers it loads statically, transitively)
  const reachOf = (specifier) => {
    if (reach.has(specifier)) return reach.get(specifier);
    const out = new Set();
    reach.set(specifier, out);
    const seen = new Set();
    const walk = (file) => {
      if (seen.has(file)) return;
      seen.add(file);
      const { files, entries } = scan(file);
      files.forEach(walk);
      for (const target of entries) {
        out.add(target);
        for (const t of reachOf(target)) out.add(t);
      }
    };
    walk(bySpecifier.get(specifier).dist);
    return out;
  };
  const leaks = {};
  // margoengine's kits re-export other packages by design; tests/umbrella.test.js shows an unused name costs nothing.
  for (const pkg of packages.filter((p) => p.name !== 'margoengine'))
    for (const entry of pkg.entries) {
      const heavy = [...reachOf(entry.specifier)].filter(
        (t) => !FOUNDATION.has(t) && bySpecifier.get(t) && !t.startsWith(pkg.name + '/') && t !== pkg.name,
      );
      for (const target of heavy)
        if ((items[target] ?? 0) >= HEAVY) {
          items[`leak ${entry.specifier} -> ${target}`] = 1;
          (leaks[entry.specifier] ??= []).push([target, items[target]]);
        }
    }
  return {
    items,
    allowance: (value, key) => (key.startsWith('leak ') ? value : headroom(value)),
    details: { leaks },
    summary() {
      const rows = Object.entries(leaks)
        .map(([entry, targets]) => [entry, targets.reduce((a, [, b]) => a + b, 0), targets])
        .sort((a, b) => b[1] - a[1]);
      return rows
        .slice(0, 10)
        .map(
          ([e, total, t]) => `  ${e} statically loads ${total} B gzip of: ${t.map(([n, b]) => `${n} ${b}`).join(', ')}`,
        );
    },
  };
}
