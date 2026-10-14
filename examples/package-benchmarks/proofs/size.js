// Byte cost of each proven optimization: minified + gzip size of a package entry at the baseline ref and now.
// Run: node examples/package-benchmarks/proofs/size.js [ref]
import {execFileSync} from 'node:child_process';
import {readdir, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {isAbsolute, resolve} from 'node:path';
import {gzipSync} from 'node:zlib';
import {build} from 'vite';

const root = resolve(import.meta.dirname, '../../..'), slash = value => value.replaceAll('\\', '/'), ref = process.argv[2] ?? 'f05414a';
const bare = id => !id.startsWith('.') && !isAbsolute(id) && !/^[a-z]:[\\/]/i.test(id);
async function size(name, from) {
  const source = slash(resolve(root, 'packages', name, 'src')) + '/';
  const plugins = from ? [{name: 'git-source', enforce: 'pre', load(id) {
    const file = slash(id.split('?')[0]); if (!file.startsWith(source) || id.includes('?')) return;
    try {return execFileSync('git', ['show', `${from}:${file.slice(slash(root).length + 1)}`], {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26});} catch {return;}
  }}] : [];
  const result = await build({root: resolve(root, 'packages', name), configFile: false, publicDir: false, logLevel: 'silent', plugins,
    build: {write: false, minify: true, target: 'es2022', lib: {entry: resolve(source, 'index.ts'), formats: ['es']}, rollupOptions: {external: bare}}});
  const code = result[0].output.filter(item => item.type === 'chunk').map(item => item.code).join('\n');
  return {raw: Buffer.byteLength(code), gzip: gzipSync(code).length};
}
const names = (await readdir(resolve(import.meta.dirname, 'results'))).filter(file => file.endsWith('.json') && file !== 'sizes.json').map(file => file.slice(0, -5));
const report = {baseline: ref, packages: {}};
for (const name of names) {
  if (!existsSync(resolve(root, 'packages', name, 'src/index.ts'))) continue;
  try {const before = await size(name, ref), after = await size(name); report.packages[name] = {before, after, gzipDelta: after.gzip - before.gzip};}
  catch (error) {report.packages[name] = {error: String(error.message ?? error).slice(0, 160)};}
  console.log(name, JSON.stringify(report.packages[name]));
}
await writeFile(resolve(import.meta.dirname, 'results/sizes.json'), JSON.stringify(report, null, 2) + '\n');
