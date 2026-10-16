// Builds only the local IK demo. Production site files and the Tokyo demo are outside this output directory.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'vite';
import { measureCoreStage } from './measure-size.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  outDir = resolve(root, 'test-results/skinning-ik-site'),
  moduleIds = new Set();
// Vite empties only this dedicated folder; never allow a CLI argument or cwd to redirect that operation.
assert.ok(outDir.startsWith(root + sep) && relative(root, outDir) === `test-results${sep}skinning-ik-site`);
const normalize = (id) => id.replaceAll('\\', '/');
const isThree = (id) =>
  /(?:^|\/)node_modules\/(?:@types\/)?three(?:\/|$)/.test(normalize(id)) || /^three(?:\/|$)/.test(id);
const auditModules = () => ({
  name: 'margo-ik-runtime-audit',
  resolveId(id) {
    assert.ok(!isThree(id), `Three.js must not enter the Margo IK runtime: ${id}`);
    return null;
  },
  generateBundle(_options, bundle) {
    for (const output of Object.values(bundle))
      if (output.type === 'chunk') for (const id of Object.keys(output.modules)) moduleIds.add(id);
  },
});
// The stage's unused CAD loader would otherwise emit its large optional codec. This demo loads only local GLB assets.
const noCAD = {
  name: 'margo-ik-no-cad',
  enforce: 'pre',
  resolveId: (id) => (/^@margoengine\/machinery(?:\/|$)/.test(id) ? '\0margo-ik-no-cad' : null),
  load: (id) =>
    id === '\0margo-ik-no-cad' ? `throw new Error('CAD loading is outside this standalone IK demo');` : null,
};
const output = await build({
  configFile: false,
  root: resolve(root, 'examples'),
  base: './',
  publicDir: false,
  plugins: [noCAD, auditModules()],
  worker: { plugins: () => [auditModules()] },
  build: {
    outDir,
    emptyOutDir: true,
    target: 'es2022',
    assetsInlineLimit: 0,
    rollupOptions: {
      input: resolve(root, 'examples/skinning-ik.html'),
      output: {
        entryFileNames: 'assets/[name]-[hash:10].js',
        chunkFileNames: 'assets/[name]-[hash:10].js',
        assetFileNames: 'assets/[name]-[hash:10][extname]',
      },
    },
  },
});

const modules = [...moduleIds].sort(),
  unexpected = modules.filter((id) => {
    const path = normalize(id);
    return isThree(id) || /\/node_modules\/(?!@margoengine\/|margoengine\/)/.test(path);
  });
assert.deepEqual(
  unexpected,
  [],
  'The demo must bundle Margo packages without third-party renderer/runtime dependencies',
);
for (const name of ['animation', 'animator', 'kinematics-constraints'])
  assert.ok(
    modules.some((id) => normalize(id).includes(`/packages/${name}/`)),
    `Missing optional @margoengine/${name}`,
  );
await rename(resolve(outDir, 'skinning-ik.html'), resolve(outDir, 'index.html'));
await copyFile(
  resolve(root, 'examples/assets/skinning-ik-LICENSE.md'),
  resolve(outDir, 'assets/skinning-ik-LICENSE.md'),
);
await copyFile(resolve(root, 'LICENSE'), resolve(outDir, 'LICENSE'));
const bundles = (Array.isArray(output) ? output : [output]).flatMap((result) => result.output),
  javascript = bundles.filter((item) => item.type === 'chunk'),
  emittedFiles = (await readdir(outDir, { recursive: true })).map(normalize).sort(),
  // Read emitted files, including worker JavaScript that Vite can represent as an asset rather than a Rollup chunk.
  measureFiles = async (paths, gzip = false) =>
    Promise.all(
      paths.map(async (path) => {
        const bytes = await readFile(resolve(outDir, path));
        return {
          path,
          bytes: bytes.length,
          ...(gzip ? { gzipBytes: gzipSync(bytes).length } : {}),
          sha256: createHash('sha256').update(bytes).digest('hex'),
        };
      }),
    ),
  javascriptFiles = await measureFiles(
    emittedFiles.filter((path) => /\.m?js$/i.test(path)),
    true,
  ),
  assets = await measureFiles(emittedFiles.filter((path) => /\.(?:glb|hdr)$/i.test(path)));
// The shared measurement helper enforces the frozen core + stage budget using the same production bundling as CI.
const previousCwd = process.cwd();
let coreStage;
try {
  process.chdir(root);
  coreStage = await measureCoreStage();
} finally {
  process.chdir(previousCwd);
}
const report = {
  builtAt: new Date().toISOString(),
  entry: 'index.html',
  renderer: 'Margo Engine',
  threeJsRuntime: false,
  margoPackages: [...new Set(modules.flatMap((id) => normalize(id).match(/\/packages\/([^/]+)\//)?.[1] ?? []))].sort(),
  coreStageBytes: coreStage.raw,
  coreStageGzipBytes: coreStage.gzip,
  coreStageMeasurement: 'scripts/measure-size.js measureCoreStage: frozen core + stage baseline',
  javascriptBytes: javascriptFiles.reduce((total, item) => total + item.bytes, 0),
  javascriptGzipBytes: javascriptFiles.reduce((total, item) => total + item.gzipBytes, 0),
  javascriptChunkCount: javascriptFiles.length,
  runtimeModuleCount: modules.length,
  runtimeImportCount: new Set(javascript.flatMap((item) => [...item.imports, ...item.dynamicImports])).size,
  javascriptFiles,
  sceneAssetBytes: assets.reduce((total, item) => total + item.bytes, 0),
  sceneAssetFormats: ['glb', 'hdr'],
  assets,
  modules: modules.map((id) => normalize(isAbsolute(id) ? relative(root, id) : id).replaceAll('\0', 'virtual:')),
  files: [
    ...bundles.map((item) => (item.fileName === 'skinning-ik.html' ? 'index.html' : item.fileName)),
    'assets/skinning-ik-LICENSE.md',
    'LICENSE',
    'build-report.json',
  ].sort(),
};
await writeFile(resolve(outDir, 'build-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify(
    {
      outDir,
      renderer: report.renderer,
      threeJsRuntime: false,
      modules: modules.length,
      javascriptBytes: report.javascriptBytes,
      javascriptGzipBytes: report.javascriptGzipBytes,
      coreStageGzipBytes: report.coreStageGzipBytes,
      sceneAssetBytes: report.sceneAssetBytes,
    },
    null,
    2,
  ),
);
