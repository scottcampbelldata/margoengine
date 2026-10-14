// Minified + gzip bytes of each @margoengine/vfx entry at a baseline ref and in the working tree (same method as
// proofs/size.js: vite library build, bare imports external). Feature entries are also measured together with base,
// which is what an app importing `base` plus that feature ships.
// Run: node examples/package-benchmarks/vfx-size.mjs [ref] -> results/vfx-size.json
import {execFileSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, isAbsolute, resolve} from 'node:path';
import {gzipSync} from 'node:zlib';
import {build} from 'vite';

const root = resolve(import.meta.dirname, '../..'), ref = process.argv[2] ?? 'a5f1e94', slash = v => v.replaceAll('\\', '/'), source = slash(resolve(root, 'packages/vfx/src')) + '/';
const bare = id => !id.startsWith('.') && !isAbsolute(id) && !/^[a-z]:[\\/]/i.test(id);
async function size(code, from) {
  const git = from ? [{name: 'git-source', enforce: 'pre', load(id) {const file = slash(id.split('?')[0]); if (!file.startsWith(source)) return;
    return execFileSync('git', ['show', `${from}:${file.slice(slash(root).length + 1)}`], {cwd: root, encoding: 'utf8'});}}] : [];
  const entry = resolve(root, 'test-results/vfx-size-entry.js'); mkdirSync(dirname(entry), {recursive: true}); writeFileSync(entry, code);
  const out = await build({root, configFile: false, publicDir: false, logLevel: 'silent', plugins: git,
    build: {write: false, minify: true, target: 'es2022', lib: {entry, formats: ['es'], fileName: 'entry'}, rollupOptions: {external: bare}}});
  const js = out[0].output.filter(item => item.type === 'chunk').map(item => item.code).join('\n');
  return {raw: Buffer.byteLength(js), gzip: gzipSync(js).length};
}
const file = name => JSON.stringify(source + name + '.ts');
const entries = {root: `export * from ${file('index')};`, base: `export * from ${file('base')};`};
for (const feature of ['obstacles', 'wrap', 'sort', 'texture']) {entries[feature] = `export * from ${file(feature)};`; entries['base+' + feature] = `export * from ${file('base')};export * from ${file(feature)};`;}
const report = {baseline: ref, head: execFileSync('git', ['rev-parse', '--short', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(), entries: {}};
for (const [name, code] of Object.entries(entries)) {
  const before = await size(code, ref), after = await size(code);
  report.entries[name] = {before, after, gzipDelta: after.gzip - before.gzip}; console.log(name, JSON.stringify(report.entries[name]));
}
writeFileSync(resolve(import.meta.dirname, 'results/vfx-size.json'), JSON.stringify(report, null, 1) + '\n');
