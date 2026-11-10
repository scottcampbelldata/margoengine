// Min+gzip size of every package `exports` entry and bundled worker script, so README size claims for subpath and
// worker entries have a committed record (build-modern and docs/api-surface.md cover root entries only).
// Method: build-modern's (the dist file bundled by Vite, minify es2022 with its compactOutput), bare imports external
// (other packages are shared with the app), relative imports (packages/shared included) inlined; zlib default gzip.
// Root entries therefore match docs/api-surface.md.
// Also records core + stage (`npm run measure:size`'s figure), every lazily loaded file in scripts/lazy-files.js (raw,
// gzip and brotli) and the commit measured; `dirty` means packages/ had uncommitted changes. scripts/build-sizes.js
// turns this file into margoengine.com/sizes.html (`npm run build:site`).
// Run from the repo root (after npm run build:packages): node examples/package-benchmarks/entry-sizes.mjs
// `npm run bench -- size` measures the same entries through measureEntries() without writing this record.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { CORE_STAGE_GZIP_LIMIT } from '../../scripts/core-budget.js';
import { LAZY_FILES, LAZY_SPLITS } from '../../scripts/lazy-files.js';
import { refreshApiSurfaceGzip } from '../../scripts/api-report-scope.mjs';
import { bundleBytes as bundle, bundleSplit, measureCoreStage } from '../../scripts/measure-size.js';

const root = resolve(import.meta.dirname, '../..');

const size = async (entry) => ((code) => ({ raw: code.length, gzip: gzipSync(code).length }))(await bundle(entry));

/** Core + stage, every package entry and worker, and every lazily loaded file, measured as described above. */
export async function measureEntries({ log = console.log } = {}) {
  const { raw, gzip } = await measureCoreStage();
  const report = {
    method: 'vite minify es2022 + compactOutput (as build-modern), bare imports external, gzip default level',
    coreStage: { raw, gzip, limit: CORE_STAGE_GZIP_LIMIT },
    packages: {},
  };
  for (const dir of readdirSync(resolve(root, 'packages')).sort()) {
    const file = resolve(root, 'packages', dir, 'package.json');
    if (!existsSync(file)) continue;
    const pkg = JSON.parse(readFileSync(file, 'utf8')),
      entries = {};
    for (const [path, target] of Object.entries(pkg.exports ?? {})) {
      // margoengine/<x> is a one-line re-export of @margoengine/<x>, measured there.
      if (pkg.name === 'margoengine' && path !== '.') continue;
      const js = typeof target === 'string' ? target : (target.import ?? target.default);
      if (!js?.endsWith('.js') || !existsSync(resolve(root, 'packages', dir, js))) continue;
      entries[path] = await size(resolve(root, 'packages', dir, js));
    }
    const workers = resolve(root, 'packages', dir, 'dist/workers');
    if (existsSync(workers))
      for (const name of readdirSync(workers).filter((n) => n.endsWith('.js')))
        entries[`dist/workers/${name}`] = await size(resolve(workers, name));
    if (Object.keys(entries).length) report.packages[pkg.name] = entries;
    log(
      pkg.name,
      Object.entries(entries)
        .map(([k, v]) => `${k} ${v.gzip}`)
        .join(', '),
    );
  }
  // Served as is ('file') or bundled by the app ('bundle'); gzip at zlib's default level, brotli at its default (11).
  report.lazyFiles = {};
  for (const { file, measure, external } of LAZY_FILES) {
    const bytes =
      measure === 'file'
        ? readFileSync(resolve(root, file))
        : await bundle(resolve(root, file), (id) => external.some((pattern) => pattern.test(id)));
    report.lazyFiles[file] = {
      raw: bytes.length,
      gzip: gzipSync(bytes).length,
      brotli: brotliCompressSync(bytes).length,
    };
    log(file, report.lazyFiles[file].gzip);
  }
  // An entry with a lazy chunk inside it, measured in two numbers: `base` is everything the entry loads without the
  // lazy chunk, `lazy` the chunk alone (scripts/lazy-files.js, LAZY_SPLITS). The entry's own record above joins both.
  report.splits = {};
  for (const split of LAZY_SPLITS) {
    const part = await bundleSplit(resolve(root, split.dist), split.chunk),
      measure = (bytes) => ({ raw: bytes.length, gzip: gzipSync(bytes).length });
    if (part.staticLazy.length)
      throw new Error(`${split.specifier}: lazy chunk imported statically: ${part.staticLazy.join(', ')}`);
    report.splits[split.specifier] = {
      entry: split.entry,
      base: { ...measure(part.base), target: split.baseTarget },
      lazy: { name: split.lazyLabel, ...measure(part.lazy), loadedBy: split.when },
    };
    log(
      split.specifier,
      'base',
      report.splits[split.specifier].base.gzip,
      'lazy',
      report.splits[split.specifier].lazy.gzip,
    );
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const commit = git('rev-parse', '--short', 'HEAD'),
    dirty = git('status', '--porcelain', '--', 'packages') !== '';
  const report = { commit, dirty, ...(await measureEntries()) };
  await writeFile(resolve(import.meta.dirname, 'results/entry-sizes.json'), JSON.stringify(report, null, 2) + '\n');
  // docs/api-surface.md's Gzip column is this record's root-entry figures: rewrite it with the record, never in a later
  // step a lane can skip (scripts/api-report-scope.mjs).
  refreshApiSurfaceGzip(root);
}
