// Assembles margoengine.com into site/dist: the landing page from site/, the package
// catalog from docs/ under /catalog/, and the live demos (Night Citadel, the gameplay sandbox, the
// voxel sandbox under /voxel/ and the example pages) each under their own folder.
// Run `npm run build:packages` first. Deploy the folder with `npx wrangler pages deploy site/dist`.
// `npm run build:site` measures every package (entry-sizes.mjs) and a basic glTF scene's network log
// (basic-scene-network.mjs, which takes the GPU lock only around its browser) first, for /sizes.html.
import { execFileSync } from 'node:child_process';
import { cp, rm, mkdir, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readSizesInputs, sizesPage } from './build-sizes.js';
import { writeSitePages } from './build-llms.mjs';
import { buildGallery, buildVoxel, site } from './site-gallery.mjs';

const out = resolve('site/dist');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const name of await readdir('site'))
  if (name !== 'dist') await cp(`site/${name}`, `${out}/${name}`, { recursive: true });
await cp('docs', `${out}/catalog`, { recursive: true, filter: (source) => !source.endsWith('.md') });
// The pages that site/llms.txt links to: one README and one API page per package, the docs and the example list.
writeSitePages(out);
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
await buildVoxel(out);
const pages = [
  'character-animation',
  'robot-expressive',
  'flight-helmet',
  'windy-meadow',
  'tokyo-diorama',
  'split-screen',
  'minimap',
  'batched-mesh',
  'clipping-planes',
  'scene-targets',
  'depth-texture',
  'animation-formats',
  'texture-formats',
  'compute-lab',
  'sciviz-volume',
  'sciviz-points',
  'sciviz-surface',
  'ui-game',
  'weather',
  'dual-viewport',
];
await site({
  configFile: false,
  root: 'examples',
  base: './',
  publicDir: false,
  build: {
    outDir: `${out}/demos`,
    target: 'es2022',
    rollupOptions: { input: Object.fromEntries(pages.map((page) => [page, resolve(`examples/${page}.html`)])) },
  },
});
// The Harrow Head gallery under /gallery/ (scripts/site-gallery.mjs; its browser check builds the same itself).
await buildGallery(out);
await site({
  configFile: false,
  root: 'packages/creative/examples/earth',
  base: './',
  build: { outDir: `${out}/demos/earth`, target: 'es2022' },
});
for (const name of ['dof', 'tonemap', 'animator'])
  await site({
    configFile: false,
    root: `packages/${name}/examples`,
    base: './',
    publicDir: false,
    build: { outDir: `${out}/demos/${name}`, target: 'es2022' },
  });
for (const name of ['molten-words', 'cathedral-light', 'biomes'])
  await site({
    configFile: false,
    root: `examples/${name}`,
    base: './',
    publicDir: false,
    build: { outDir: `${out}/demos/${name}`, target: 'es2022' },
  });
// The in-browser benchmark (bench/): the CLI's scene page and harness behind a runner page, with the models its glTF
// scenes open (copied unhashed: the scenes name them).
await site({
  configFile: false,
  root: 'bench',
  base: './',
  publicDir: false,
  build: {
    outDir: `${out}/bench`,
    target: 'es2022',
    rollupOptions: { input: { index: resolve('bench/index.html'), page: resolve('bench/scenes/page.html') } },
  },
});
for (const name of ['scifi-helmet.glb', 'flight-helmet.glb', 'robot-expressive.glb', 'ATTRIBUTION.md'])
  await cp(`examples/assets/${name}`, `${out}/bench/assets/${name}`);
for (const name of ['ATTRIBUTION.md', 'robot-CREDITS.md', 'tokyo-diorama-CREDITS.md'])
  await cp(`examples/assets/${name}`, `${out}/demos/assets/${name}`);
// Boulder keeps its audited optional-package build and local asset paths intact.
execFileSync(process.execPath, [resolve('scripts/build-boulder.mjs')], { stdio: 'inherit' });
await cp('test-results/boulder-site', `${out}/demos/boulder`, { recursive: true });
await cp('packages/creative/examples/earth/assets/ATTRIBUTION.md', `${out}/demos/earth/assets/ATTRIBUTION.md`);
// Licence notices for the third-party code the demos bundle (Draco, Basis, Rapier); scripts/supply-chain.mjs.
await cp('THIRD-PARTY-NOTICES.md', `${out}/THIRD-PARTY-NOTICES.md`);
console.log(out);
