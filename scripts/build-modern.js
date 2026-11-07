import { execFileSync, spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { build } from 'vite';
import { resolve, dirname } from 'node:path';
import assert from 'node:assert/strict';
import { gzipSync, deflateRawSync, inflateRawSync } from 'node:zlib';
import { compactPackage } from './compact-package.js';
import { compactOutput, external, measureCoreStage } from './measure-size.js';
import { buildInDependencyOrder, packageDependencies, packageOrder } from './package-order.js';
import { buildWorkers, restoreWorkerUrls } from './build-workers.js';
import { packageDeclarations, packageRuntime } from './package-declarations.js';
import { writeServerEntries } from './react-server-entries.js';
import { importMap } from './umbrella.mjs';
import { copyLegal } from './package-legal.js';
import { recordJob, recordScope } from './support/record-reads.mjs';
const precompiled = process.argv.includes('--precompiled');
// --only=post,lines rebuilds just those packages (their dependencies must already be built) and skips the size records.
const only = process.argv
  .find((arg) => arg.startsWith('--only='))
  ?.slice('--only='.length)
  .split(',');
const wasmPath = 'packages/kernel/target/wasm32-unknown-unknown/release/margoengine_kernel.wasm',
  optimizedPath = wasmPath.replace('.wasm', '.optimized.wasm');
if (!precompiled)
  execFileSync(
    'cargo',
    ['build', '--manifest-path', 'packages/kernel/Cargo.toml', '--target', 'wasm32-unknown-unknown', '--release'],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        CARGO_TARGET_DIR: resolve('packages/kernel/target'),
        RUSTFLAGS: '-C target-feature=+simd128',
      },
    },
  );
// -ocimfs 300: keep the kernel's recompute path out of line so the per-entity unchanged path stays small (parts assembly, 100k entities: 3.5 vs 4.8 ms per tick).
if (!precompiled)
  execFileSync(
    process.execPath,
    [
      'node_modules/binaryen/bin/wasm-opt',
      wasmPath,
      '-Oz',
      '-ocimfs',
      '300',
      '--enable-simd',
      '--enable-bulk-memory',
      '--enable-bulk-memory-opt',
      '--enable-nontrapping-float-to-int',
      '--strip-debug',
      '--strip-producers',
      '--strip-target-features',
      '--converge',
      '-o',
      optimizedPath,
    ],
    { stdio: 'inherit' },
  );
// The physics kernel has its own blueprint, built the same way; --precompiled keeps the committed one.
if (!precompiled) execFileSync(process.execPath, ['packages/physics/scripts/build-kernel.mjs'], { stdio: 'inherit' });
const wasm = precompiled
  ? inflateRawSync(
      Buffer.from(
        /wasmBase64(?::\s*string)?\s*=\s*'([^']+)'/.exec(await readFile('packages/core/src/wasm.ts', 'utf8'))[1],
        'base64',
      ),
    )
  : await readFile(optimizedPath);
assert.ok(wasm.length < 30 * 1024, `Kernel exceeds 30 KiB: ${wasm.length}`);
assert.ok(WebAssembly.validate(wasm), 'Invalid Wasm artifact');
// -Oz and raw deflate measured smallest for core + stage, with identical kernel output and speed (test-results/wasm-opt-bench.mjs).
const compressedWasm = deflateRawSync(wasm, { level: 9, memLevel: 6, windowBits: 12 });
assert.deepEqual(inflateRawSync(compressedWasm), wasm, 'Kernel compression must be lossless');
if (!precompiled)
  await writeFile(
    'packages/core/src/wasm.ts',
    `// Generated raw-deflate blueprint; consumers need no Rust toolchain.\nexport const wasmBase64: string = '${compressedWasm.toString('base64')}';\n`,
  );
// Build every workspace package in dependency order (scripts/package-order.js reads package.json; a package that needs
// another's dist at build time must declare it). A package with its own `build` script runs it; the rest use the
// pipeline below: tsc + compaction for core and the stage facade, tsc for react, a Vite library build + tsc otherwise.
// Packages that do not depend on each other build side by side (MARGOENGINE_BUILD_JOBS, default: the CPU count up to 8;
// 1 builds one at a time as before). A child process's output is printed whole when it ends, so lines never interleave.
const jobs = Math.max(1, Number(process.env.MARGOENGINE_BUILD_JOBS) || Math.min(8, availableParallelism()));
const runChild = (command, args, options) =>
  new Promise((done, fail) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] }),
      chunks = [];
    child.stdout.on('data', (data) => chunks.push([process.stdout, data]));
    child.stderr.on('data', (data) => chunks.push([process.stderr, data]));
    child.on('error', fail);
    child.on('close', (code) => {
      for (const [stream, data] of chunks) stream.write(data);
      code === 0 ? done() : fail(new Error(`${command} ${args.join(' ')} exited with ${code}`));
    });
  });
const tsc = async (name) => {
  await runChild(process.execPath, ['node_modules/typescript/bin/tsc', '-p', `packages/${name}/tsconfig.json`]);
  await packageDeclarations(resolve(`packages/${name}`));
};
const manifests = new Map();
for (const dir of JSON.parse(await readFile('package.json', 'utf8')).workspaces.filter((dir) =>
  dir.startsWith('packages/'),
))
  manifests.set(dir.slice('packages/'.length), JSON.parse(await readFile(`${dir}/package.json`, 'utf8')));
async function buildPackage(name) {
  const manifest = manifests.get(name);
  if (manifest.scripts?.build) {
    await runChild(manifest.scripts.build, [], { cwd: `packages/${name}`, shell: true });
    await packageDeclarations(resolve(`packages/${name}`));
    return;
  }
  const output = resolve(`packages/${name}/dist`);
  assert.equal(dirname(output), resolve(`packages/${name}`), 'Output escaped its package');
  await rm(output, { recursive: true, force: true });
  await copyLegal(resolve(`packages/${name}`));
  if (name === 'core' || name === 'stage') {
    await tsc(name);
    await compactPackage(name);
    return;
  }
  // margoengine is the one-install package: generated re-exports of every package (scripts/umbrella.mjs).
  if (name === 'margoengine') {
    await tsc(name);
    // For pages without a bundler: every entry of every package on a CDN (docs/guides/imports.md).
    await writeFile(`packages/${name}/dist/importmap.json`, `${JSON.stringify(importMap(), null, 2)}\n`);
    return;
  }
  if (name === 'react') {
    await tsc(name);
    await packageRuntime(resolve('packages/react'));
    await writeServerEntries(resolve('packages/react'));
    return;
  }
  const entry = Object.fromEntries(
    Object.values(manifest.exports).map(({ import: target }) => {
      assert.ok(/^\.\/dist\/[\w-]+\.js$/.test(target), 'Unsupported package entry: ' + target);
      const module = target.slice('./dist/'.length, -'.js'.length);
      return [module, `packages/${name}/src/${module}.ts`];
    }),
  );
  await build({
    configFile: false,
    publicDir: false,
    logLevel: 'warn',
    build: {
      outDir: output,
      emptyOutDir: true,
      target: 'es2022',
      lib: { entry, formats: ['es'], fileName: (_, entryName) => entryName + '.js' },
      rollupOptions: {
        external: [
          '@margoengine/core',
          '@margoengine/core/extension',
          '@margoengine/animation',
          '@margoengine/animation/sampling',
          '@margoengine/animation/skeleton-utils',
          '@margoengine/clustered',
          '@margoengine/clustered/directional',
          '@margoengine/gltf-pro',
          '@margoengine/gltf-pro/model',
          '@margoengine/gltf-pro/interactivity',
          '@margoengine/selection',
          '@margoengine/gltf-pro/instancing',
          '@margoengine/loaders',
          '@margoengine/lines',
          '@margoengine/decoders',
          '@margoengine/decoders/brotli',
          '@margoengine/decoders/meshopt',
          '@margoengine/decoders/texture',
          '@margoengine/decoders/ktx2-stream',
          '@margoengine/text',
          '@margoengine/bvh',
          '@margoengine/splines',
          '@margoengine/splines/frames',
          '@margoengine/vfx',
          '@margoengine/sky',
          '@margoengine/geometry',
          '@margoengine/geometry/shapes',
          '@margoengine/geometry/nurbs',
          '@margoengine/geometry/triangulate',
          '@margoengine/geometry/extrude',
          '@margoengine/geometry/primitives',
          '@margoengine/geometry/utils',
          /^@margoengine\/(sky|vfx)\//,
          /^@margoengine\/splats(\/|$)/,
          /^@margoengine\/environment$/,
          /^@margoengine\/physics$/,
          '@margoengine/clustered/ies',
          '@margoengine/decoders/png',
          '@margoengine/decoders/image',
        ],
        output: compactOutput,
      },
    },
  });
  await buildWorkers(resolve(`packages/${name}`));
  await tsc(name);
  await restoreWorkerUrls(output);
}
await buildInDependencyOrder(
  packageOrder(manifests).filter((name) => !only || only.includes(name)),
  packageDependencies(manifests),
  jobs,
  // Under verify's recorder each package's reads form one job, so its build has its own content key, side by side too.
  (name) => recordJob(`package:${name}`, () => buildPackage(name)),
);
if (only) process.exit(0);
recordScope('size-records');
// Size records and leak checks only; build order comes from package.json above.
const featurePackages = [
  'gltf-pro',
  'blender',
  'animation',
  'post',
  'shadows',
  'clustered',
  'animator',
  'taa',
  'splats',
  'geometry',
  'terrain',
  'xr',
  'usdz',
  'dof',
  'tonemap',
  'lines',
  'stats',
  'inspector',
  'environment',
  'controls',
];
const packages = [
  'core',
  'gltf',
  'react',
  'loaders',
  'exporters',
  'vfx',
  'sky',
  'creative',
  'scenery',
  ...featurePackages,
  'stage',
];
const sizes = { kernel: { raw: wasm.length, gzip: compressedWasm.length } };
for (const name of packages) {
  let output = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: true,
      target: 'es2022',
      lib: { entry: `packages/${name}/dist/index.js`, formats: ['es'] },
      rollupOptions: { external, output: compactOutput },
    },
  });
  output = Array.isArray(output) ? output[0] : output;
  const chunks = output.output.filter((item) => item.type === 'chunk'),
    code = chunks.map((chunk) => chunk.code).join('\n');
  assert.ok(
    chunks.every((chunk) =>
      Object.keys(chunk.modules).every((id) => !id.includes('/src/scene.js') && !id.includes('/src/engine.js')),
    ),
    'Legacy scene/engine leaked into modern packages',
  );
  if (name === 'core')
    assert.ok(
      chunks.every((chunk) =>
        Object.keys(chunk.modules).every(
          (id) =>
            !['creative', 'scenery', 'loaders', 'exporters', ...featurePackages].some((pack) =>
              id.includes(`/packages/${pack}/`),
            ),
        ),
      ),
      'Domain pack leaked into core',
    );
  sizes[name] = { raw: Buffer.byteLength(code), gzip: gzipSync(code).length };
}
// 21,542 B, one over core's measured 21,541 B because the check is strict: the failed-allocation rollback took core from
// 21,487 B, and Scott ruled on 2026-11-07 that a core bug fix may pass the cap by what it measures. The 21,504 B this
// comment named before was a slip of arithmetic: `21 * 1024 + 512` enforced 22,016 B from 2026-10-27 until this line.
const CORE_ONLY_CEILING = 21_542;
assert.ok(sizes.core.gzip < CORE_ONLY_CEILING, `Core exceeds ${CORE_ONLY_CEILING} B gzip: ${sizes.core.gzip}`);
assert.ok(sizes.core.gzip + sizes.gltf.gzip < 30 * 1024, 'Core + glTF exceed 30 KiB gzip');
const { modules, ...baseSize } = await measureCoreStage();
sizes.base = baseSize;
assert.ok(
  modules.every(
    (id) => !['loaders', 'exporters', ...featurePackages].some((pack) => id.includes(`/packages/${pack}/`)),
  ),
  'Optional feature package leaked into core + stage',
);
const shake = await build({
  configFile: false,
  publicDir: false,
  logLevel: 'silent',
  build: {
    write: false,
    minify: true,
    target: 'es2022',
    lib: { entry: 'tests/modern-particle-consumer.js', formats: ['es'] },
    rollupOptions: { external: ['@margoengine/core', '@margoengine/core/extension'] },
  },
});
const shaken = (Array.isArray(shake) ? shake[0] : shake).output
  .filter((item) => item.type === 'chunk')
  .map((chunk) => chunk.code)
  .join('\n');
assert.ok(
  !shaken.includes('post-processing') && !shaken.includes('toon-shading') && !shaken.includes('rgba16float'),
  'Unused creative effects leaked into a particle-only consumer',
);
sizes.particlesOnly = { raw: Buffer.byteLength(shaken), gzip: gzipSync(shaken).length };
await mkdir('test-results', { recursive: true });
await writeFile('test-results/modern-bundle-sizes.json', JSON.stringify(sizes, null, 2));
console.error(JSON.stringify(sizes, null, 2));
// The catalog reads every built dist, so it is regenerated here and can never trail the packages.
execFileSync(process.execPath, ['scripts/build-catalog.js'], { stdio: 'inherit' });
