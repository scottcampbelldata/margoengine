// The Harrow Head gallery and the voxel sandbox as margoengine.com serves them (/gallery/ and /voxel/), built into one
// folder. scripts/build-site.js builds them into site/dist with the rest of the site; scripts/test-gallery-browser.mjs
// builds them into its own folder from this checkout's sources, so the check needs no earlier `npm run build:site` and
// never reads an older one. Run `npm run build:packages` first.
import { cp, readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'vite';

const repo = resolve(import.meta.dirname, '..'),
  from = (path) => resolve(repo, path);
// Ten-character hashes renamed every asset once: without site/404.html, Pages answered a request that reached a
// deployment without the new file with index.html (200) under a year-long cache rule, and browsers kept it
// (2026-10-15). site/404.html makes such answers 404 + no-store, and site/_headers no longer caches for a year.
export const names = {
  entryFileNames: 'assets/[name]-[hash:10].js',
  chunkFileNames: 'assets/[name]-[hash:10].js',
  assetFileNames: 'assets/[name]-[hash:10][extname]',
};
// Demo pages import their own code only once examples/needs-webgpu.js finds WebGPU. Rollup drops a dynamically
// imported module whose exports go unused when its package says "sideEffects": false (dof, tonemap, animator and
// creative's earth demo left a 20-277 B main chunk), so demo sources keep their side effects.
export const demoSources = {
  name: 'margo-site-demo-sources',
  transform: (code, id) =>
    id.includes('/examples/') && !id.includes('/node_modules/') ? { code, map: null, moduleSideEffects: true } : null,
};
/** One site section built by Vite with the site's asset names, demo sources kept, its output folder emptied first. */
export const site = (config) =>
  build({
    ...config,
    plugins: [...(config.plugins ?? []), demoSources],
    logLevel: 'warn',
    worker: { rollupOptions: { output: names } },
    build: { ...config.build, emptyOutDir: true, rollupOptions: { ...config.build.rollupOptions, output: names } },
  });

/** The voxel sandbox into `<out>/voxel`. */
export const buildVoxel = (out) =>
  site({ root: from('examples/voxel-sandbox'), base: './', build: { outDir: `${out}/voxel` } });

/**
 * The Harrow Head gallery (examples/gallery/DIRECTION.md) into `<out>/gallery`: every html page there. The model
 * cabinet's models are the ones its section buttons name, copied without their reference screenshots.
 */
export async function buildGallery(out) {
  const galleryPages = (await readdir(from('examples/gallery'))).filter((name) => name.endsWith('.html'));
  await site({
    configFile: false,
    root: from('examples/gallery'),
    base: './',
    publicDir: false,
    plugins: [demoSources],
    build: {
      outDir: `${out}/gallery`,
      target: 'es2022',
      rollupOptions: {
        input: Object.fromEntries(galleryPages.map((page) => [page.slice(0, -5), from(`examples/gallery/${page}`)])),
      },
    },
  });
  const cabinet = await readFile(from('examples/gallery/khronos.html'), 'utf8'),
    published = [...cabinet.matchAll(/data-section="(\w+)"/g)].map((match) => match[1]),
    khronos = JSON.parse(await readFile(from('examples/assets/khronos/manifest.json'), 'utf8'));
  for (const model of published)
    await cp(from(`examples/assets/khronos/${model}`), `${out}/gallery/models/${model}`, {
      recursive: true,
      filter: (source) => !/screenshot\.\w+$/.test(source),
    });
  await writeFile(
    `${out}/gallery/models/manifest.json`,
    JSON.stringify({ models: khronos.models.filter((model) => published.includes(model.name)) }),
  );
  await cp(from('examples/assets/khronos/README.md'), `${out}/gallery/models/README.md`);
  await cp(from('examples/gallery/khronos.ts'), `${out}/gallery/khronos.ts`);
}
