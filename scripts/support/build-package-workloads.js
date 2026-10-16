import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, relative, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const fixtures = [
  'packages/loaders/tests/fixtures/dolphins.ply',
  'packages/loaders/tests/fixtures/decimated-knight.off',
  'packages/loaders/tests/fixtures/bunny.pcd',
  'packages/ifc/tests/fixtures/wall.ifc',
  'examples/package-benchmarks/fixtures/triangle.fbx',
  'packages/blender/tests/fixtures/triangle.margo',
  'packages/decoders/tests/fixtures/Avocado.gltf',
  'packages/decoders/tests/fixtures/Avocado.bin',
  'examples/assets/robot-expressive.glb',
  'node_modules/web-ifc/web-ifc.wasm',
  'packages/decoders/dist/draco/draco_wasm_wrapper.js',
  'packages/decoders/dist/draco/draco_decoder.wasm',
];
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function filesIn(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesIn(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

/** Assemble the unchanged real workload page from official dist entries, including actual assets and codecs. */
export async function buildPackageWorkloads(
  name = `package-workloads-built-${new Date().toISOString().replace(/[^0-9TZ]/g, '')}`,
) {
  assert.match(name, /^package-workloads-built-[a-zA-Z0-9-]{1,80}$/);
  const directory = resolve('test-results', name),
    workspace = resolve('.');
  assert.equal(
    dirname(directory),
    resolve('test-results'),
    'Build output must be one direct test-results child before Vite clears it',
  );
  const { build } = await import('vite');
  const outputs = await build({
    configFile: false,
    root: resolve('examples/package-benchmarks'),
    base: './',
    publicDir: false,
    assetsInclude: ['**/*.ply', '**/*.off', '**/*.pcd', '**/*.ifc', '**/*.fbx', '**/*.margo', '**/*.gltf', '**/*.bin'],
    worker: { format: 'es' },
    build: {
      outDir: directory,
      emptyOutDir: true,
      target: 'es2022',
      minify: true,
      sourcemap: false,
      assetsInlineLimit: 0,
      manifest: 'build-manifest.json',
    },
  });
  const chunks = (Array.isArray(outputs) ? outputs : [outputs])
    .flatMap((output) => output.output)
    .filter((output) => output.type === 'chunk');
  const modules = [...new Set(chunks.flatMap((chunk) => Object.keys(chunk.modules)))];
  assert.ok(
    modules.some((path) => path.replaceAll('\\', '/').includes('/packages/core/dist/')),
    'Actual Core dist was not bundled',
  );
  assert.ok(
    modules.some((path) => path.replaceAll('\\', '/').includes('/packages/decoders/dist/')),
    'Actual decoder dist was not bundled',
  );
  assert.ok(
    modules.every((path) => !/\/packages\/[^/]+\/src\//.test(path.replaceAll('\\', '/'))),
    'Package source fallback leaked into dist fixture build',
  );
  const assets = [];
  for (const path of await filesIn(directory)) {
    const bytes = await readFile(path);
    assets.push({
      path: relative(directory, path).replaceAll('\\', '/'),
      bytes: bytes.length,
      gzipBytes: gzipSync(bytes).length,
      sha256: sha(bytes),
    });
  }
  const requiredAssets = [];
  for (const path of fixtures) {
    const source = await readFile(path),
      hash = sha(source),
      matches = assets.filter((asset) => asset.sha256 === hash);
    assert.ok(matches.length > 0, `Actual asset bytes were not emitted unchanged: ${path}`);
    requiredAssets.push({
      source: path,
      bytes: source.length,
      sha256: hash,
      emitted: matches.map((asset) => asset.path),
    });
  }
  assert.ok(
    assets.some((asset) => /decoder\.worker.*\.js$/.test(asset.path)),
    'Actual decoder worker bundle is missing',
  );
  // Hardware discovery does not initialize or render a substitute scene.
  await writeFile(
    join(directory, 'hardware.html'),
    '<!doctype html><meta charset="utf-8"><title>Package benchmark hardware probe</title>',
  );
  await writeFile(join(directory, 'README.md'), await readFile('examples/package-benchmarks/README.md'));
  const manifest = {
    builtAt: new Date().toISOString(),
    directory: relative(workspace, directory).replaceAll('\\', '/'),
    entry: 'index.html',
    productionPackages: true,
    sourceFallback: false,
    kernelWasm: 'Actual embedded Core dist Wasm; no replacement kernel',
    workloadSource: 'Unchanged examples/package-benchmarks/index.html and real factories; no simplified/fake assets',
    modules: modules.map((path) => relative(workspace, path).replaceAll('\\', '/')),
    requiredAssets,
    assets,
  };
  await writeFile(join(directory, 'workload-build.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { directory, manifest };
}
