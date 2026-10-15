// Bytes an app adds for a walkthrough controller (HANDOFF 5l.t point 4): WalkControls (Wasm-free, on the bvh trees)
// against @margoengine/physics + Rapier. Method as entry-sizes.mjs (vite minify es2022 + compactOutput, zlib default
// gzip); Rapier is measured as installed (@dimforge/rapier3d-compat, whose module inlines the Wasm as base64).
// Run (after npm run build:packages): node examples/package-benchmarks/walk-size.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build } from 'vite';
import { compactOutput } from '../../scripts/measure-size.js';

const root = resolve(import.meta.dirname, '../..'),
  temp = resolve(root, 'test-results/walk-size');
await mkdir(temp, { recursive: true });
const bare = (keep) => (id) =>
  !id.startsWith('.') &&
  !isAbsolute(id) &&
  !/^[a-z]:[\\/]/i.test(id) &&
  !id.startsWith('\0') &&
  !keep.some((k) => id === k || id.startsWith(k + '/'));
async function size(name, code, inline = []) {
  const entry = resolve(temp, `${name.replace(/\W+/g, '-')}.js`);
  await writeFile(entry, code);
  const output = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    resolve: {
      alias: [{ find: /^@margoengine\/controls\/walk$/, replacement: resolve(root, 'packages/controls/dist/walk.js') }],
    },
    build: {
      write: false,
      minify: true,
      target: 'es2022',
      lib: { entry, formats: ['es'] },
      rollupOptions: { external: bare(inline), output: compactOutput },
    },
  });
  const out = (Array.isArray(output) ? output[0] : output).output
    .filter((item) => item.type === 'chunk')
    .map((item) => item.code)
    .join('\n');
  return { raw: Buffer.byteLength(out), gzip: gzipSync(out).length };
}
const file = (path) => {
  const bytes = readFileSync(resolve(root, path));
  return { raw: bytes.length, gzip: gzipSync(bytes).length };
};
const rapier = JSON.parse(
  readFileSync(resolve(root, 'node_modules/@dimforge/rapier3d-compat/package.json'), 'utf8'),
).version;
const report = {
  commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  method:
    'vite minify es2022 + compactOutput, other packages external unless inlined, zlib default gzip; Rapier files as installed',
  walk: await size('walk', "export {WalkControls} from '@margoengine/controls/walk';\n", ['@margoengine/controls']),
  walkWithBvh: await size('walk-bvh', "export {WalkControls} from '@margoengine/controls/walk';\n", [
    '@margoengine/controls',
    '@margoengine/bvh',
  ]),
  physics: await size('physics', "export {Physics} from '@margoengine/physics';\n", ['@margoengine/physics']),
  [`rapier3d-compat ${rapier} dist/rapier.mjs (Wasm inlined as base64)`]: file(
    'node_modules/@dimforge/rapier3d-compat/dist/rapier.mjs',
  ),
  [`rapier3d-compat ${rapier} rapier_wasm3d_bg.wasm (the Wasm alone)`]: file(
    'node_modules/@dimforge/rapier3d-compat/dist/rapier_wasm3d_bg.wasm',
  ),
};
await rm(temp, { recursive: true, force: true });
await writeFile(resolve(import.meta.dirname, 'results/walk-size.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
