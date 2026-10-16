import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const decoderStub = fileURLToPath(new URL('./worker-decoder-stub.js', import.meta.url));

// Parser workers: each src/<name>.worker.ts becomes a self-contained classic worker, dist/workers/<name>.js. A package
// starts it with new URL('./workers/<name>.js?no-inline', import.meta.url), which the app's bundler copies as an asset,
// so the worker's code is never part of the app's own bundle. Draco and KTX2 are not part of that script: an IIFE has no
// import.meta.url, and those codecs run on the thread that can see the decoder package's own assets.
export async function buildWorkers(root) {
  const src = resolve(root, 'src'),
    dist = resolve(root, 'dist');
  if (!existsSync(src)) return;
  for (const file of (await readdir(src)).filter((file) => file.endsWith('.worker.ts')))
    await build({
      configFile: false,
      publicDir: false,
      logLevel: 'warn',
      resolve: { alias: [{ find: /^@margoengine\/decoders$/, replacement: decoderStub }] },
      build: {
        outDir: resolve(dist, 'workers'),
        emptyOutDir: false,
        minify: true,
        target: 'es2022',
        lib: {
          entry: resolve(src, file),
          name: 'MargoWorker',
          formats: ['iife'],
          fileName: () => file.replace(/\.worker\.ts$/, '.js'),
        },
      },
    });
  // Inlining the decoder package also copied its worker here. Parser jobs never request that copy.
  await rm(resolve(dist, 'workers/decoder.worker.js'), { force: true });
  await restoreWorkerUrls(dist);
}

// Drop the package-build ignore comment and restore import.meta.url. tsc may copy the comment back into dist.
export async function restoreWorkerUrls(dist) {
  if (!existsSync(dist)) return;
  for (const file of (await readdir(dist)).filter((file) => file.endsWith('.js'))) {
    const path = resolve(dist, file),
      code = await readFile(path, 'utf8'),
      fixed = code
        .replace(/\/\*\s*@vite-ignore\s*\*\/\s*/g, '')
        .replace(/(?:''|""|``)\s*\+\s*import\.meta\.url/g, 'import.meta.url');
    if (fixed !== code) await writeFile(path, fixed);
  }
}
