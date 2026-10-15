// Min+gzip size of every package `exports` entry and bundled worker script, so README size claims for subpath and
// worker entries have a committed record (build-modern and docs/api-surface.md cover root entries only).
// Method: build-modern's (the dist file bundled by Vite, minify es2022 with its compactOutput), bare imports external
// (other packages are shared with the app), relative imports (packages/shared included) inlined; zlib default gzip.
// Root entries therefore match docs/api-surface.md.
// Run (after npm run build:packages): node examples/package-benchmarks/entry-sizes.mjs
import {execFileSync} from 'node:child_process';
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import {isAbsolute, resolve} from 'node:path';
import {gzipSync} from 'node:zlib';
import {build} from 'vite';
import {compactOutput} from '../../scripts/measure-size.js';

const root = resolve(import.meta.dirname, '../..');
const bare = id => !id.startsWith('.') && !isAbsolute(id) && !/^[a-z]:[\\/]/i.test(id) && !id.startsWith('\0');
async function size(entry) {
  const output = await build({configFile: false, publicDir: false, logLevel: 'silent',
    build: {write: false, minify: true, target: 'es2022', lib: {entry, formats: ['es']}, rollupOptions: {external: bare, output: compactOutput}}});
  const code = (Array.isArray(output) ? output[0] : output).output.filter(item => item.type === 'chunk').map(item => item.code).join('\n');
  return {raw: Buffer.byteLength(code), gzip: gzipSync(code).length};
}
const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim();
const report = {commit, method: 'vite minify es2022 + compactOutput (as build-modern), bare imports external, gzip default level', packages: {}};
for (const dir of readdirSync(resolve(root, 'packages')).sort()) {
  const file = resolve(root, 'packages', dir, 'package.json');
  if (!existsSync(file)) continue;
  const pkg = JSON.parse(readFileSync(file, 'utf8')), entries = {};
  for (const [path, target] of Object.entries(pkg.exports ?? {})) {
    const js = typeof target === 'string' ? target : target.import ?? target.default;
    if (!js?.endsWith('.js') || !existsSync(resolve(root, 'packages', dir, js))) continue;
    entries[path] = await size(resolve(root, 'packages', dir, js));
  }
  const workers = resolve(root, 'packages', dir, 'dist/workers');
  if (existsSync(workers)) for (const name of readdirSync(workers).filter(n => n.endsWith('.js') && !n.startsWith('occt-import-js')))
    entries[`dist/workers/${name}`] = await size(resolve(workers, name));
  if (Object.keys(entries).length) report.packages[pkg.name] = entries;
  console.log(pkg.name, Object.entries(entries).map(([k, v]) => `${k} ${v.gzip}`).join(', '));
}
await writeFile(resolve(import.meta.dirname, 'results/entry-sizes.json'), JSON.stringify(report, null, 2) + '\n');
