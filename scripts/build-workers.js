import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'vite';

// Parser workers: each src/<name>.worker.ts becomes a self-contained classic worker, dist/workers/<name>.js. A package
// starts it with new URL('./workers/<name>.js?no-inline', import.meta.url), which the app's bundler copies as an asset,
// so the worker's code is never part of the app's own bundle.
export async function buildWorkers(root) {
  const src = resolve(root, 'src'),
    dist = resolve(root, 'dist');
  if (!existsSync(src)) return;
  for (const file of (await readdir(src)).filter((file) => file.endsWith('.worker.ts')))
    await build({
      configFile: false,
      publicDir: false,
      logLevel: 'warn',
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
  // Vite leaves a URL it cannot resolve at build time as new URL(x, '' + import.meta.url); restore the analyzable form.
  for (const file of (await readdir(dist)).filter((file) => file.endsWith('.js'))) {
    const path = resolve(dist, file),
      code = await readFile(path, 'utf8'),
      fixed = code.replace(/(?:''|""|``)\s*\+\s*import\.meta\.url/g, 'import.meta.url');
    if (fixed !== code) await writeFile(path, fixed);
  }
}
