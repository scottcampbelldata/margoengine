// Which package entry points does no web demo import? Run: node scripts/web-demos/coverage.mjs [--json]
// Reads the `exports` of every packages/*/package.json and the imports under demos/*/source, and prints each entry no demo
// uses, sorted, with unused and total counts per package. The list is where the next demos (and the packages' showcases)
// are missing; demos/README.md says how to read it.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..', '..');
const SOURCE_EXT = /\.(?:js|mjs|ts)$/;

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules') return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : SOURCE_EXT.test(name) ? [path] : [];
  });
}

/** `{ package: [entry specifier, ...] }` from each packages/*\/package.json `exports` (the manifest, ./package.json left out). */
export function packageEntries(packagesDir = join(root, 'packages')) {
  const result = {};
  for (const dir of readdirSync(packagesDir).sort()) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(packagesDir, dir, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    if (!manifest.name?.startsWith('@margoengine/')) continue;
    const exp = manifest.exports;
    const keys = exp && typeof exp === 'object' && !Array.isArray(exp) ? Object.keys(exp).filter((k) => k.startsWith('.')) : ['.'];
    result[manifest.name] = keys
      .filter((k) => k !== './package.json' && !k.includes('*'))
      .map((k) => (k === '.' ? manifest.name : `${manifest.name}/${k.slice(2)}`))
      .sort();
  }
  return result;
}

/** The `@margoengine/*` specifiers (static and dynamic imports) any demo source imports, with how many demos use each. */
export function demoImports(demosDir = join(root, 'demos')) {
  const used = new Map();
  const re = /(?:[\s}]from\s*|\bimport\s*\(\s*|^\s*import\s+)['"`](@margoengine\/[^'"`\s]+)['"`]/gm;
  for (const name of readdirSync(demosDir)) {
    const source = join(demosDir, name, 'source');
    try {
      if (!statSync(source).isDirectory()) continue;
    } catch {
      continue;
    }
    const seen = new Set();
    for (const file of walk(source)) for (const m of readFileSync(file, 'utf8').matchAll(re)) seen.add(m[1]);
    for (const spec of seen) used.set(spec, (used.get(spec) ?? 0) + 1);
  }
  return used;
}

/** `[{ name, total, unused: [specifier] }]` per package, packages with the most unused entries first. */
export function coverage() {
  const used = demoImports();
  return Object.entries(packageEntries())
    .map(([name, entries]) => ({ name, total: entries.length, unused: entries.filter((e) => !used.has(e)) }))
    .sort((a, b) => b.unused.length - a.unused.length || a.name.localeCompare(b.name));
}

function main(argv) {
  const rows = coverage();
  if (argv.includes('--json')) {
    console.log(JSON.stringify(rows, null, 1));
    return;
  }
  const unused = rows.reduce((n, r) => n + r.unused.length, 0);
  const total = rows.reduce((n, r) => n + r.total, 0);
  console.log(`Package entries no demo imports: ${unused} of ${total} in ${rows.length} packages.\n`);
  for (const r of rows) if (r.unused.length) console.log(`${r.name}  ${r.unused.length} of ${r.total} unused`);
  console.log('');
  for (const entry of rows.flatMap((r) => r.unused).sort()) console.log(entry);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2));
