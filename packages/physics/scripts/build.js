import { declarePackageCore } from '../../../scripts/core-requirements.mjs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'vite';
import { packageDeclarations } from '../../../scripts/package-declarations.js';
import { copyLegal } from '../../../scripts/package-legal.js';
import { interfaceHash } from '../../shared/rapier-wasm.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const repository = resolve(root, '../..');
await copyLegal(root);
// Rapier's JavaScript is bundled from @dimforge/rapier3d into the lazy solver chunk; its Wasm is copied beside it as
// dist/rapier3d.wasm. Rapier's glue imports the Wasm as an ES module, which needs bundler set-up an app should not
// need, so that import becomes an empty module and src/rapier-solver.ts instantiates the file itself.
const rapierDir = dirname(createRequire(import.meta.url).resolve('@dimforge/rapier3d/package.json'));
const rapierGlue = resolve(rapierDir, 'rapier_wasm3d.js');
const rapierVersion = JSON.parse(await readFile(resolve(rapierDir, 'package.json'), 'utf8')).version;
// The same hash src/rapier-solver.ts takes of a Wasm it is given, so it can tell this build from any other.
const rapierInterface = interfaceHash(new WebAssembly.Module(readFileSync(resolve(rapierDir, 'rapier_wasm3d_bg.wasm'))));
const wasmStub = '\0rapier-wasm-stub';
const rapierWasm = {
  name: 'rapier-wasm',
  enforce: 'pre',
  resolveId(source, importer) {
    if (source === './rapier_wasm3d_bg.wasm' && importer && resolve(importer) === rapierGlue) return wasmStub;
    return null;
  },
  load(id) {
    return id === wasmStub ? 'export {};' : null;
  },
  renderChunk(code) {
    if (!code.includes('__RAPIER_VERSION__')) return null;
    return {
      code: code
        .replaceAll('__RAPIER_VERSION__', JSON.stringify(rapierVersion))
        // The source marks the Wasm URL @vite-ignore so this build leaves it alone; the app's bundler must see it.
        .replace(/\/\*\s*@vite-ignore\s*\*\/\s*(?=["']\.\/rapier3d\.wasm\?no-inline["'])/, '')
        .replaceAll('__RAPIER_INTERFACE__', String(rapierInterface)),
      map: null,
    };
  },
};
await build({
  root,
  configFile: false,
  publicDir: false,
  logLevel: 'warn',
  plugins: [rapierWasm],
  build: {
    outDir: resolve(root, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    lib: {
      entry: {
        index: resolve(root, 'src/index.ts'),
        next: resolve(root, 'src/next.ts'),
        decomposition: resolve(root, 'src/decomposition.ts'),
      },
      formats: ['es'],
      fileName: (_, entry) => `${entry}.js`,
    },
    rollupOptions: { external: ['@margoengine/core', '@margoengine/core/extension'] },
  },
});
await copyFile(resolve(rapierDir, 'rapier_wasm3d_bg.wasm'), resolve(root, 'dist/rapier3d.wasm'));
// Rapier ships inside this package, so its licence and a notice of what was taken ship beside it.
await copyFile(resolve(rapierDir, 'LICENSE'), resolve(root, 'dist/LICENSE-Apache-2.0.txt'));
await writeFile(
  resolve(root, 'dist/THIRD-PARTY-NOTICE.md'),
  `# Third-party notice

This package bundles Rapier (\`@dimforge/rapier3d\` ${rapierVersion}, https://rapier.rs, by Dimforge),
licensed under the Apache License 2.0 (\`LICENSE-Apache-2.0.txt\` beside this file).

- \`rapier3d.wasm\` is Rapier's \`rapier_wasm3d_bg.wasm\`, unmodified.
- \`rapier-solver-*.js\` holds Rapier's JavaScript, bundled and minified. One change: its import of the Wasm as an ES
  module resolves to an empty module, and this package instantiates \`rapier3d.wasm\` itself.
`,
);
execFileSync(
  process.execPath,
  [resolve(repository, 'node_modules/typescript/bin/tsc'), '-p', resolve(root, 'tsconfig.json')],
  { stdio: 'inherit' },
);
// Copy the shared declarations the emitted .d.ts files reference into dist, so the packed package type-checks.
await packageDeclarations(root);

await declarePackageCore(root);
