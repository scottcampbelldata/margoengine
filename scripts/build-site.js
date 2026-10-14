// Assembles margoengine.com into site/dist: the landing page from site/, the package
// catalog from docs/ under /catalog/, and the live demos (Night Citadel, the gameplay sandbox and
// the example pages) each under their own folder.
// Run `npm run build:packages` first. Deploy the folder with `npx wrangler pages deploy site/dist`.
import {cp, rm, mkdir, readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {build} from 'vite';

const out = resolve('site/dist');
await rm(out, {recursive: true, force: true});
await mkdir(out, {recursive: true});
for (const name of await readdir('site')) if (name !== 'dist') await cp(`site/${name}`, `${out}/${name}`, {recursive: true});
await cp('docs', `${out}/catalog`, {recursive: true, filter: source => !source.endsWith('.md')});
// A relative base lets the showcase run from its subfolder.
await build({root: 'apps/showcase-night-citadel', base: './', logLevel: 'warn', build: {outDir: `${out}/night-citadel`, emptyOutDir: true}});
await build({root: 'examples/gameplay-sandbox', base: './', logLevel: 'warn', build: {outDir: `${out}/gameplay-sandbox`, emptyOutDir: true}});
const pages = ['character-animation', 'robot-expressive', 'damaged-helmet', 'windy-meadow'];
await build({configFile: false, root: 'examples', base: './', publicDir: false, logLevel: 'warn',
  build: {outDir: `${out}/demos`, emptyOutDir: true, target: 'es2022', rollupOptions: {input: Object.fromEntries(pages.map(page => [page, resolve(`examples/${page}.html`)]))}}});
await build({configFile: false, root: 'packages/creative/examples/earth', base: './', logLevel: 'warn', build: {outDir: `${out}/demos/earth`, emptyOutDir: true, target: 'es2022'}});
for (const name of ['dof', 'tonemap']) await build({configFile: false, root: `packages/${name}/examples`, base: './', publicDir: false, logLevel: 'warn',
  build: {outDir: `${out}/demos/${name}`, emptyOutDir: true, target: 'es2022'}});
for (const name of ['ATTRIBUTION.md', 'helmet-CREDITS.md', 'robot-CREDITS.md']) await cp(`examples/assets/${name}`, `${out}/demos/assets/${name}`);
await cp('packages/creative/examples/earth/assets/ATTRIBUTION.md', `${out}/demos/earth/assets/ATTRIBUTION.md`);
console.log(out);
