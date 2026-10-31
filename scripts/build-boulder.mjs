// Builds the Boulder demo into test-results/boulder-site. scripts/build-site.js copies it to /demos/boulder/. Audits that
// no third-party runtime enters the bundle, and writes build-report.json with the bytes the page loads.
import assert from 'node:assert/strict';
import { copyFile, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  outDir = resolve(root, 'test-results/boulder-site'),
  moduleIds = new Set();
// Vite empties only this dedicated folder.
assert.ok(outDir.startsWith(root + sep) && relative(root, outDir) === `test-results${sep}boulder-site`);
const normalize = (id) => id.replaceAll('\\', '/');
const audit = () => ({
  name: 'boulder-runtime-audit',
  generateBundle(_options, bundle) {
    for (const output of Object.values(bundle))
      if (output.type === 'chunk') for (const id of Object.keys(output.modules)) moduleIds.add(id);
  },
});
const output = await build({
  configFile: false,
  logLevel: 'warn',
  root: resolve(root, 'examples'),
  base: './',
  publicDir: false,
  plugins: [audit()],
  worker: { plugins: () => [audit()] },
  build: {
    outDir,
    emptyOutDir: true,
    target: 'es2022',
    assetsInlineLimit: 0,
    rollupOptions: {
      input: resolve(root, 'examples/boulder.html'),
      output: {
        entryFileNames: 'assets/[name]-[hash:10].js',
        chunkFileNames: 'assets/[name]-[hash:10].js',
        assetFileNames: 'assets/[name]-[hash:10][extname]',
      },
    },
  },
});
const unexpected = [...moduleIds].filter((id) =>
  /\/node_modules\/(?!@margoengine\/|margoengine\/)/.test(normalize(id)),
);
assert.deepEqual(unexpected, [], 'The demo must bundle Margo packages only');

await rename(resolve(outDir, 'boulder.html'), resolve(outDir, 'index.html'));
await copyFile(
  resolve(root, 'examples/assets/boulder-robot-LICENSE.md'),
  resolve(outDir, 'assets/boulder-robot-LICENSE.md'),
);
await copyFile(resolve(root, 'LICENSE'), resolve(outDir, 'LICENSE'));
await copyFile(resolve(root, 'NOTICE'), resolve(outDir, 'NOTICE'));

// Eager JavaScript: the page's entry chain through static imports. The page's own inline script holds a dynamic import,
// so the first real chunk is main; everything main imports statically loads with it.
const chunks = (Array.isArray(output) ? output : [output]).flatMap((r) => r.output).filter((c) => c.type === 'chunk'),
  byName = new Map(chunks.map((c) => [c.fileName, c])),
  main = chunks.find((c) => c.facadeModuleId?.endsWith('boulder/main.ts')),
  eager = new Set();
const visit = (name) => {
  if (eager.has(name) || !byName.has(name)) return;
  eager.add(name);
  for (const dep of byName.get(name).imports) visit(dep);
};
assert.ok(main, 'main.ts must be its own chunk');
visit(main.fileName);
const gzip = async (file) => gzipSync(await readFile(resolve(outDir, file))).length,
  files = (await readdir(outDir, { recursive: true })).map(normalize);
let eagerBytes = 0,
  lazyBytes = 0;
for (const file of files.filter((f) => f.endsWith('.js'))) {
  if (eager.has(file)) eagerBytes += await gzip(file);
  else lazyBytes += await gzip(file);
}
const report = {
  entry: 'index.html',
  eagerJavascriptGzipBytes: eagerBytes,
  lazyJavascriptGzipBytes: lazyBytes,
  assets: await Promise.all(
    files
      .filter((f) => f.endsWith('.glb'))
      .map(async (f) => ({ file: f, bytes: (await readFile(resolve(outDir, f))).length })),
  ),
  packages: [
    ...new Set([...moduleIds].flatMap((id) => normalize(id).match(/\/packages\/([^/]+)\//)?.[1] ?? [])),
  ].sort(),
};
await writeFile(resolve(outDir, 'build-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ outDir, ...report, packages: report.packages.length }, null, 2));
