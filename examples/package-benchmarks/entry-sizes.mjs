// Min+gzip size of every package `exports` entry and bundled worker script, so README size claims for subpath and
// worker entries have a committed record (build-modern and docs/api-surface.md cover root entries only).
// Method: build-modern's (the dist file bundled by Vite, minify es2022 with its compactOutput), bare imports external
// (other packages are shared with the app), relative imports (packages/shared included) inlined; zlib default gzip.
// Root entries therefore match docs/api-surface.md.
// Also records core + stage (`npm run measure:size`'s figure), every lazily loaded file in scripts/lazy-files.js (raw,
// gzip and brotli) and the commit measured; `dirty` means packages/ had uncommitted changes. scripts/build-sizes.js
// turns this file into margoengine.com/sizes.html (`npm run build:site`).
// Run from the repo root (after npm run build:packages): node examples/package-benchmarks/entry-sizes.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { build } from 'vite';
import { CORE_STAGE_GZIP_LIMIT } from '../../scripts/core-budget.js';
import { LAZY_FILES } from '../../scripts/lazy-files.js';
import { compactOutput, measureCoreStage } from '../../scripts/measure-size.js';

const root = resolve(import.meta.dirname, '../..');
const bare = (id) => !id.startsWith('.') && !isAbsolute(id) && !/^[a-z]:[\\/]/i.test(id) && !id.startsWith('\0');
async function bundle(entry, external = bare) {
  const output = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: true,
      target: 'es2022',
      lib: { entry, formats: ['es'] },
      rollupOptions: { external, output: compactOutput },
    },
  });
  return Buffer.from(
    (Array.isArray(output) ? output[0] : output).output
      .filter((item) => item.type === 'chunk')
      .map((item) => item.code)
      .join('\n'),
  );
}
const size = async (entry) => ((code) => ({ raw: code.length, gzip: gzipSync(code).length }))(await bundle(entry));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const commit = git('rev-parse', '--short', 'HEAD'),
  dirty = git('status', '--porcelain', '--', 'packages') !== '';
const { raw, gzip } = await measureCoreStage();
const report = {
  commit,
  dirty,
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
    const js = typeof target === 'string' ? target : (target.import ?? target.default);
    if (!js?.endsWith('.js') || !existsSync(resolve(root, 'packages', dir, js))) continue;
    entries[path] = await size(resolve(root, 'packages', dir, js));
  }
  const workers = resolve(root, 'packages', dir, 'dist/workers');
  if (existsSync(workers))
    for (const name of readdirSync(workers).filter((n) => n.endsWith('.js') && !n.startsWith('occt-import-js')))
      entries[`dist/workers/${name}`] = await size(resolve(workers, name));
  if (Object.keys(entries).length) report.packages[pkg.name] = entries;
  console.log(
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
  console.log(file, report.lazyFiles[file].gzip);
}
await writeFile(resolve(import.meta.dirname, 'results/entry-sizes.json'), JSON.stringify(report, null, 2) + '\n');
