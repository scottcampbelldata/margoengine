// Builds gltf-pro's src/index.ts at a git ref (default 15c87f1) into test-results/gltf-before/ for pixproof.mjs.
import {execFileSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {build} from 'vite';
const root = resolve(import.meta.dirname, '../../..'), slash = v => v.replaceAll('\\', '/'), ref = process.argv[2] ?? '15c87f1';
const out = resolve(root, 'test-results/gltf-before'); mkdirSync(out, {recursive: true});
const source = slash(resolve(root, 'packages')) + '/';
const result = await build({root, configFile: false, publicDir: false, logLevel: 'silent', plugins: [{name: 'git', enforce: 'pre', load(id) {const file = slash(id.split('?')[0]); if (!file.startsWith(source)) return;
  try {return execFileSync('git', ['show', `${ref}:${file.slice(slash(root).length + 1)}`], {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26});} catch {return;}}}],
  build: {write: false, minify: false, target: 'es2022', lib: {entry: resolve(root, 'packages/gltf-pro/src/index.ts'), formats: ['es']}, rollupOptions: {external: id => id.startsWith('@margoengine/')}}});
const chunks = result[0].output.filter(o => o.type === 'chunk');
for (const chunk of chunks) writeFileSync(resolve(out, chunk.fileName), chunk.code);
console.log('wrote', chunks.map(c => c.fileName), chunks[0].code.includes('margoFaceTest') ? 'NEW CODE (wrong ref?)' : 'baseline gltf-pro');
