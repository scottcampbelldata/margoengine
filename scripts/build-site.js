// Assembles margoengine.com into site/dist: the landing page from site/, the package
// catalog from docs/ under /catalog/, and the live demos (Night Citadel, the gameplay sandbox, the
// voxel sandbox under /voxel/ and the example pages) each under their own folder.
// Run `npm run build:packages` first. Deploy the folder with `npx wrangler pages deploy site/dist`.
// `npm run build:site` measures every package (entry-sizes.mjs) and a basic glTF scene's network log
// (basic-scene-network.mjs, under the GPU lock) first, for /sizes.html.
import { execFileSync } from 'node:child_process';
import { cp, rm, mkdir, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'vite';
import { readSizesInputs, sizesPage } from './build-sizes.js';

const out = resolve('site/dist');
// Ten-character hashes renamed every asset once: without site/404.html, Pages answered a request that reached a
// deployment without the new file with index.html (200) under a year-long cache rule, and browsers kept it
// (2026-10-15). site/404.html makes such answers 404 + no-store, and site/_headers no longer caches for a year.
const names = {
  entryFileNames: 'assets/[name]-[hash:10].js',
  chunkFileNames: 'assets/[name]-[hash:10].js',
  assetFileNames: 'assets/[name]-[hash:10][extname]',
};
// Demo pages import their own code only once examples/needs-webgpu.js finds WebGPU. Rollup drops a dynamically
// imported module whose exports go unused when its package says "sideEffects": false (dof, tonemap, animator and
// creative's earth demo left a 20-277 B main chunk), so demo sources keep their side effects.
const demoSources = {
  name: 'margo-site-demo-sources',
  transform: (code, id) =>
    id.includes('/examples/') && !id.includes('/node_modules/') ? { code, map: null, moduleSideEffects: true } : null,
};
const site = (config) =>
  build({
    ...config,
    plugins: [...(config.plugins ?? []), demoSources],
    logLevel: 'warn',
    worker: { rollupOptions: { output: names } },
    build: { ...config.build, emptyOutDir: true, rollupOptions: { ...config.build.rollupOptions, output: names } },
  });
// The stage facade (`margoengine`) imports @margoengine/machinery lazily for STEP/IGES/STL/OBJ in `load()`, so every
// demo built on it shipped the 7.6 MB OCCT .wasm and the CAD chunks (never downloaded: no demo loads CAD). Those builds
// get a stand-in that rejects instead; demos that need CAD must not use `noCAD`.
const noCAD = {
  name: 'margo-site-no-cad',
  enforce: 'pre',
  resolveId: (id) => (/^@margoengine\/machinery(\/|$)/.test(id) ? '\0margo-no-cad' : null),
  load: (id) =>
    id === '\0margo-no-cad'
      ? `throw new Error('This margoengine.com demo build leaves out @margoengine/machinery (scripts/build-site.js)');`
      : null,
};
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const name of await readdir('site'))
  if (name !== 'dist') await cp(`site/${name}`, `${out}/${name}`, { recursive: true });
await cp('docs', `${out}/catalog`, { recursive: true, filter: (source) => !source.endsWith('.md') });
// Sizes come only from measurements of this commit. `npm run build:site` measures first (entry sizes, then the basic
// scene's network log); a direct run (visual:check) with older records leaves the page out rather than publish another
// commit's numbers.
const sizes = readSizesInputs(),
  head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
const stale = [
  ['entry-sizes.json', sizes.sizes],
  ['basic-scene-network.json', sizes.network],
].filter(([, record]) => record.commit !== head);
if (!stale.length) await writeFile(`${out}/sizes.html`, sizesPage(sizes));
else
  console.warn(
    `sizes.html left out: ${stale.map(([file, record]) => `${file} measured ${record.commit}`).join(', ')}, HEAD is ${head} (npm run build:site measures first)`,
  );
// A relative base lets the showcase run from its subfolder.
await site({ root: 'apps/showcase-night-citadel', base: './', build: { outDir: `${out}/night-citadel` } });
await site({ root: 'examples/gameplay-sandbox', base: './', build: { outDir: `${out}/gameplay-sandbox` } });
await site({ root: 'examples/voxel-sandbox', base: './', build: { outDir: `${out}/voxel` } });
const pages = [
  'character-animation',
  'robot-expressive',
  'flight-helmet',
  'windy-meadow',
  'tokyo-diorama',
  'cad-views',
  'split-screen',
  'minimap',
  'batched-mesh',
  'clipping-planes',
  'scene-targets',
  'depth-texture',
  'animation-formats',
  'texture-formats',
];
await site({
  configFile: false,
  root: 'examples',
  base: './',
  publicDir: false,
  plugins: [noCAD],
  build: {
    outDir: `${out}/demos`,
    target: 'es2022',
    rollupOptions: { input: Object.fromEntries(pages.map((page) => [page, resolve(`examples/${page}.html`)])) },
  },
});
await site({
  configFile: false,
  root: 'packages/creative/examples/earth',
  base: './',
  plugins: [noCAD],
  build: { outDir: `${out}/demos/earth`, target: 'es2022' },
});
for (const name of ['dof', 'tonemap', 'animator'])
  await site({
    configFile: false,
    root: `packages/${name}/examples`,
    base: './',
    publicDir: false,
    plugins: [noCAD],
    build: { outDir: `${out}/demos/${name}`, target: 'es2022' },
  });
// The in-browser benchmark (bench/): the CLI's scene page and harness behind a runner page, with the models its glTF
// scenes open (copied unhashed: the scenes name them).
await site({
  configFile: false,
  root: 'bench',
  base: './',
  publicDir: false,
  plugins: [noCAD],
  build: {
    outDir: `${out}/bench`,
    target: 'es2022',
    rollupOptions: { input: { index: resolve('bench/index.html'), page: resolve('bench/scenes/page.html') } },
  },
});
for (const name of ['damaged-helmet.glb', 'flight-helmet.glb', 'robot-expressive.glb', 'ATTRIBUTION.md'])
  await cp(`examples/assets/${name}`, `${out}/bench/assets/${name}`);
for (const name of ['ATTRIBUTION.md', 'robot-CREDITS.md', 'tokyo-diorama-CREDITS.md'])
  await cp(`examples/assets/${name}`, `${out}/demos/assets/${name}`);
// Keep the workshop's audited optional-package build and local asset paths intact.
execFileSync(process.execPath, [resolve('scripts/build-skinning-ik.mjs')], { stdio: 'inherit' });
await cp('test-results/skinning-ik-site', `${out}/demos/light-keeper`, { recursive: true });
await cp('packages/creative/examples/earth/assets/ATTRIBUTION.md', `${out}/demos/earth/assets/ATTRIBUTION.md`);
// Licence notices for the third-party code the demos bundle (Draco, Basis, OCCT, Rapier); scripts/supply-chain.mjs.
await cp('THIRD-PARTY-NOTICES.md', `${out}/THIRD-PARTY-NOTICES.md`);
console.log(out);
