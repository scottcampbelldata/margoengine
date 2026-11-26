import { execFileSync, spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { build } from 'vite';
import { resolve, dirname } from 'node:path';
import assert from 'node:assert/strict';
import { gzipSync, inflateRawSync } from 'node:zlib';
import { compactPackage } from './compact-package.js';
import { compactOutput, external, measureCoreStage } from './measure-size.js';
import { buildInDependencyOrder, packageDependencies, packageOrder } from './package-order.js';
import { buildWorkers, restoreWorkerUrls } from './build-workers.js';
import { packageDeclarations, packageRuntime } from './package-declarations.js';
import { writeServerEntries } from './react-server-entries.js';
import { importMap, isInstallKit } from './umbrella.mjs';
import { copyLegal } from './package-legal.js';
import { declarePackageCore } from './core-requirements.mjs';
import { stripPackageShaderComments } from './shader-comments.mjs';
import { recordJob, recordScope } from './support/record-reads.mjs';
import { clearStamp, packageStamps, writeStamp } from './package-stamps.mjs';
import { buildCoreKernel, deflateKernel } from './build-core-kernel.mjs';
import { committedBlueprint } from './committed-blueprint.mjs';
import { BLUEPRINTS, blueprintBytes } from './wasm-blueprints.mjs';
import { acquireBuildLock } from './support/build-lock.mjs';
import { removeStalePackageOutputs } from './support/stale-packages.mjs';
import { DIST_DIR_ENV, STAGING_DIR, stagingDir, swapDist, tsconfigFor } from './support/dist-dir.mjs';
import { missingPackageTargets } from './package-export-targets.mjs';
import { SIZES_FILE, sizeReport, wantsFullSizes } from './support/size-report.mjs';
// One package build at a time in this checkout: two at once would swap their output into the same dist folders (KB-RM4).
// Released when the process exits, whatever the outcome. Each package is built into packages/<name>/dist-next and moved
// into dist file by file once it is complete, so a process reading the checkout never finds a dist file missing or half
// written (KB-BUILD-ATOMIC1, scripts/support/dist-dir.mjs).
const releaseBuild = acquireBuildLock(process.cwd());
process.on('exit', releaseBuild);
const precompiled = process.argv.includes('--precompiled');
// --only=post,lines rebuilds just those packages (their dependencies must already be built) and skips the size records.
const only = process.argv
  .find((arg) => arg.startsWith('--only='))
  ?.slice('--only='.length)
  .split(',');
// Every Rust crate that ships as Wasm has a committed blueprint (scripts/wasm-blueprints.mjs), so --precompiled needs no
// Rust toolchain. Without it, the core kernel, the physics kernel and the decoders' native modules are rebuilt from
// source first; the package builds read MARGOENGINE_WASM_FROM_SOURCE.
if (!precompiled) process.env.MARGOENGINE_WASM_FROM_SOURCE = '1';
if (!precompiled) buildCoreKernel();
// The physics kernel has its own blueprint, built the same way; --precompiled keeps the committed one.
if (!precompiled) execFileSync(process.execPath, ['packages/physics/scripts/build-kernel.mjs'], { stdio: 'inherit' });
const wasm = blueprintBytes(BLUEPRINTS.find((entry) => entry.name === 'core-kernel'));
assert.ok(wasm.length < 30 * 1024, `Kernel exceeds 30 KiB: ${wasm.length}`);
assert.ok(WebAssembly.validate(wasm), 'Invalid Wasm artifact');
// -Oz and raw deflate measured smallest for core + stage, with identical kernel output and speed (test-results/wasm-opt-bench.mjs).
// The committed blueprint's own bytes, never a fresh deflate: the host's zlib would change them (KB-SIZE-PLATFORM1).
const compressedWasm = committedBlueprint(
  resolve('packages/core/src/wasm.ts'),
  'wasmBase64',
  wasm,
  inflateRawSync,
  deflateKernel,
);
assert.deepEqual(inflateRawSync(compressedWasm), wasm, 'Kernel compression must be lossless');
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
const tsc = async (name, output) => {
  await runChild(process.execPath, ['node_modules/typescript/bin/tsc', '-p', tsconfigFor(`packages/${name}`, output)]);
  await packageDeclarations(resolve(`packages/${name}`), output);
};
const manifests = new Map();
for (const dir of JSON.parse(await readFile('package.json', 'utf8')).workspaces.filter((dir) =>
  dir.startsWith('packages/'),
))
  manifests.set(dir.slice('packages/'.length), JSON.parse(await readFile(`${dir}/package.json`, 'utf8')));
// A package that left the workspace (renamed or folded into another) leaves its ignored dist, LICENSE and NOTICE behind;
// a full build removes them so nothing reads its dead entries (KB-IMPORTMAP-STALE1, scripts/support/stale-packages.mjs).
if (!only)
  for (const { dir, removed, folderRemoved } of removeStalePackageOutputs(
    process.cwd(),
    JSON.parse(await readFile('package.json', 'utf8')).workspaces,
  ))
    console.error(
      `${dir}: not in the workspace; removed ${removed.join(', ')}${folderRemoved ? ' and the empty folder' : ''}`,
    );
// What each package is built from, read before any build starts (scripts/package-stamps.mjs). A package's stamp is
// cleared before its build and written after it succeeds, so the API report can tell a stale dist from a current one.
const stamps = packageStamps(process.cwd(), manifests);
// Writes the package's build into `output` (its dist-next folder); the caller swaps it into dist.
async function buildPackage(name, output) {
  const manifest = manifests.get(name);
  if (manifest.scripts?.build) {
    // The script resolves its output folder through scripts/support/dist-dir.mjs, which reads this variable.
    await runChild(manifest.scripts.build, [], {
      cwd: `packages/${name}`,
      shell: true,
      env: { ...process.env, [DIST_DIR_ENV]: STAGING_DIR },
    });
    await packageDeclarations(resolve(`packages/${name}`), output);
    return;
  }
  await copyLegal(resolve(`packages/${name}`));
  if (name === 'core' || name === 'stage') {
    await tsc(name, output);
    await compactPackage(name, `packages/${name}`, output);
    return;
  }
  // margoengine is the one-install package: generated re-exports of every package (scripts/umbrella.mjs).
  if (name === 'margoengine' || isInstallKit(manifest.name)) {
    await tsc(name, output);
    // For pages without a bundler: every entry of every package on a CDN (docs/guides/imports.md).
    if (name === 'margoengine')
      await writeFile(resolve(output, 'importmap.json'), `${JSON.stringify(importMap(), null, 2)}\n`);
    return;
  }
  if (name === 'react') {
    await tsc(name, output);
    await packageRuntime(resolve('packages/react'), output);
    await writeServerEntries(resolve('packages/react'), output);
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
    // Match optional-package builds: emitted assets travel with their installed module.
    base: './',
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
          '@margoengine/audio',
          '@margoengine/animation/sampling',
          '@margoengine/animation/skeleton-utils',
          '@margoengine/clustered',
          '@margoengine/clustered/directional',
          '@margoengine/gltf/pbr',
          '@margoengine/gltf/pbr-model',
          '@margoengine/gltf/interactivity',
          '@margoengine/selection',
          '@margoengine/gltf/pbr-instancing',
          '@margoengine/lightmap/imported',
          '@margoengine/loaders',
          '@margoengine/lines',
          '@margoengine/decoders',
          '@margoengine/exporters/ktx2',
          '@margoengine/exporters/meshopt',
          '@margoengine/decoders/brotli',
          '@margoengine/decoders/bzip2',
          '@margoengine/decoders/xz',
          '@margoengine/decoders/meshopt',
          '@margoengine/decoders/texture',
          '@margoengine/decoders/ktx2-stream',
          '@margoengine/text',
          '@margoengine/bvh',
          '@margoengine/bvh/gpu-scene',
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
  await buildWorkers(resolve(`packages/${name}`), output);
  await tsc(name, output);
  await restoreWorkerUrls(output);
  if (Object.values(manifest.exports).some((value) => value['react-server']))
    await writeServerEntries(resolve(`packages/${name}`), output);
}
await buildInDependencyOrder(
  packageOrder(manifests).filter((name) => !only || only.includes(name)),
  packageDependencies(manifests),
  jobs,
  // Under verify's recorder each package's reads form one job, so its build has its own content key, side by side too.
  (name) =>
    recordJob(`package:${name}`, async () => {
      clearStamp(process.cwd(), name);
      const root = resolve(`packages/${name}`),
        output = stagingDir(root);
      assert.equal(dirname(output), root, 'Output escaped its package');
      // A build that failed part way leaves its dist-next behind; dist itself still holds the last complete build.
      await rm(output, { recursive: true, force: true });
      await buildPackage(name, output);
      await declarePackageCore(root, output);
      // A package with its own build script strips its shader comments there (scripts/shader-comments.mjs).
      if (!manifests.get(name).scripts?.build) await stripPackageShaderComments(root, output);
      await swapDist(root);
      writeStamp(process.cwd(), name, stamps.get(name));
    }),
);
// Every file each built package's `exports` promises must exist now. A run that ends with a package missing its dist
// stops here instead of failing forty minutes later in whatever reads it first (KB-RM4: no packages/kit-web/dist).
const missingTargets = packageOrder(manifests)
  .filter((name) => !only || only.includes(name))
  .flatMap((name) => missingPackageTargets(resolve(`packages/${name}`)));
assert.deepEqual(missingTargets, [], 'build:packages finished without these declared export targets');
// A partial build (--only) ends here; a full one writes the size records (KB-OWN-EXIT2: by the event loop, not process.exit).
if (!only) await sizeRecords();

async function sizeRecords() {
  recordScope('size-records');
  // Size records and leak checks only; build order comes from package.json above.
  const featurePackages = [
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
    'ifc',
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
              !['creative', 'sky', 'loaders', 'exporters', 'gltf', ...featurePackages].some((pack) =>
                id.includes(`/packages/${pack}/`),
              ),
          ),
        ),
        'Domain pack leaked into core',
      );
    sizes[name] = { raw: Buffer.byteLength(code), gzip: gzipSync(code).length };
  }
  // 21,587 B, one over core's measured 21,586 B because the check is strict. Scott ruled on 2026-11-07 that a core bug fix
  // may pass the cap by what it measures: the failed-allocation rollback took core from 21,487 B to 21,541 B, a restore
  // that configures the canvas last, so a failed one cannot strand it on a dead device, took it to 21,561 B, and CSS `#rgb`
  // colours (`hexColor` in packages/shared/clear-color.js) took it to 21,586 B. The 21,504 B this
  // comment named before was a slip of arithmetic: `21 * 1024 + 512` enforced 22,016 B from 2026-10-27 until this line.
  // 2026-11-07: CADCameraControls moved to @margoengine/stage (core 21,586 -> 20,672 B), which made room under this same cap
  // for stable instance rows with changed-row uploads (+382 B) and Engine.writePoses (+231 B): core 21,285 B. Not raised.
  // Scott's later 2026-11-09 version-guard ruling keeps this ratchet: 21584 -> 21775 B (+191 B),
  // shrunk from the 238 B draft. Strict ceiling is one byte above the final measured core, with no growth headroom.
  // 2026-11-10, approved by Scott (see docs/core-version-guard.md) under his 2026-11-07 ruling (a core bug fix passes the
  // cap by what it measures) and his 2026-11-10 ruling (the approved core fixes keep their measured cost): the batch 132
  // audit's three core fixes in e8f3decf6 (pitch +-90 degree Euler lanes, an aspect-keeping 4096 backbuffer clamp,
  // fitToBoundingBox past near) took core 21,775 -> 21,828 B (+53 B). e8f3decf6 recorded 21,812 B, a figure no build of
  // its sources gives: this build of packages/core and packages/shared at e8f3decf6^ measures 21,775 B and at e8f3decf6
  // 21,828 B (Node 26.12.0, zlib 1.3.2.1-motley, rolldown 1.2.13), and nothing core bundles changed after it.
  // 2026-11-10: Scott approved these core bug fixes (camera validate-before-publish, outward-rounded bounds, restore
  // budget) under the same rulings; they took core 21,828 -> 22,031 B (+203 B with the rebuilt kernel
  // Wasm), shrunk from the 22,041 B draft. Strict ceiling one byte above it. The 7b core shrink pass wins it back.
  // 2026-11-10, Scott's approved core scale change 1 (requestDevice asks for the adapter's buffer limits): core 22,031 ->
  // 22,059 B (+28 B). Strict ceiling one byte above it.
  // 2026-11-10, Scott's approved core scale change 2 (Geometry vertex cap 11,184,810): core 22,059 -> 22,063 B (+4 B).
  // Strict ceiling one byte above it.
  // 2026-11-10, Scott's approved core scale change 4 (backbuffer cap from the device's maxTextureDimension2D): core
  // 22,063 -> 22,083 B (+20 B). Strict ceiling one byte above it.
  // 2026-11-11, Scott's approved bug-sweep core rows: KB0378 (uploadRows reads the dirty-row words 16 bits at a time, so
  // no tier boxes a full word): core 22,125 -> 22,145 B (+20 B). Strict ceiling one byte above it.
  // 2026-11-11, Scott's approved bug-sweep core rows: KB6434a (an out-of-memory uncaptured error is reported once and
  // rebuilds the device instead of failing every later frame): core 22,145 -> 22,211 B (+66 B). Strict ceiling one byte
  // above it.
  // 2026-11-11, KB5875a (height-correlated Smith in core's direct light, a shorter expression): core 22,211 -> 22,207 B
  // (-4 B). Strict ceiling one byte above it.
  // 2026-11-11, Scott's approved KB6016c ("fix C the core": GGX D denominator written |n x h|^2 + a2 nh^2 so float32 does
  // not cancel it at low roughness): core 22,207 -> 22,215 B (+8 B). Strict ceiling one byte above it.
  // 2026-11-15, core's colour vertex declares its clip position @invariant (WGSL 12.10), so the passes that redraw core
  // meshes with depthCompare 'equal' (TAA object velocity, SSAO, SSGI and SSR replays, the selection mask) match its depth
  // bit for bit: core 22,220 -> 22,226 B (+6 B). Strict ceiling one byte above it.
  const CORE_ONLY_CEILING = 22_227;
  assert.ok(sizes.core.gzip < CORE_ONLY_CEILING, `Core exceeds ${CORE_ONLY_CEILING} B gzip: ${sizes.core.gzip}`);
  assert.ok(sizes.core.gzip + sizes.gltf.gzip < 30 * 1024, 'Core + glTF exceed 30 KiB gzip');
  const { modules, ...baseSize } = await measureCoreStage();
  sizes.base = baseSize;
  assert.ok(
    modules.every(
      (id) => !['loaders', 'exporters', 'gltf', ...featurePackages].some((pack) => id.includes(`/packages/${pack}/`)),
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
  await writeFile(SIZES_FILE, JSON.stringify(sizes, null, 2));
  console.error(sizeReport(sizes, { full: wantsFullSizes(process.argv, process.env) }));
  // The catalog reads every built dist, so it is regenerated here and can never trail the packages.
  execFileSync(process.execPath, ['scripts/build-catalog.js'], { stdio: 'inherit' });
}
