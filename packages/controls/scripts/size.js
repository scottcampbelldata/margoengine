// Gzip size of the full bundle and of each control on its own (tree-shaken, core externalized).
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'vite';
import { minifySync } from 'rolldown/experimental';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = resolve(root, 'test-results/size');
await mkdir(temp, { recursive: true });
const entries = {
  'dist/index.js (everything)': null,
  OrbitControls: 'OrbitControls',
  'OrbitControls + SOLIDWORKS': 'OrbitControls, SOLIDWORKS',
  'OrbitControls + PROFILES': 'OrbitControls, PROFILES',
  MapControls: 'MapControls',
  TrackballControls: 'TrackballControls',
  FlyControls: 'FlyControls',
  FirstPersonControls: 'FirstPersonControls',
  PointerLockControls: 'PointerLockControls',
  TransformControls: 'TransformControls',
  DragControls: 'DragControls',
  // `name@entry`: from another package entry; `+bvh` also bundles the @margoengine/bvh code it uses (an app without bvh yet).
  'WalkControls (/walk)': 'WalkControls@walk',
  'WalkControls (/walk) + bvh': 'WalkControls@walk+bvh',
};
const rows = [];
for (const [label, name] of Object.entries(entries)) {
  const entry = resolve(temp, `${label.replace(/\W+/g, '-')}.js`),
    [exported, file = 'index'] = name?.split('@') ?? [],
    bvh = file.endsWith('+bvh');
  await writeFile(
    entry,
    name
      ? `export {${exported}} from '../../dist/${file.replace('+bvh', '')}.js';\n`
      : `export * from '../../dist/index.js';\n`,
  );
  const output = await build({
    root,
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      target: 'es2022',
      lib: { entry, formats: ['es'], fileName: 'bundle' },
      rollupOptions: {
        external: ['@margoengine/core', '@margoengine/core/extension', ...(bvh ? [] : ['@margoengine/bvh'])],
      },
    },
  });
  const code = (Array.isArray(output) ? output[0] : output).output.find((chunk) => chunk.type === 'chunk').code;
  // Vite keeps whitespace in ES library builds, so minify separately with the oxc minifier rolldown ships.
  const minified = minifySync('bundle.js', code).code;
  rows.push({
    bundle: label,
    raw: code.length,
    'raw gzip': gzipSync(code, { level: 9 }).length,
    minified: minified.length,
    'minified gzip': gzipSync(minified, { level: 9 }).length,
  });
}
await rm(temp, { recursive: true, force: true });
console.table(rows);
