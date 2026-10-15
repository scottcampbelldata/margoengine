import { execFileSync, execSync } from 'node:child_process';
import { readFile, writeFile, mkdir, copyFile, rm, readdir } from 'node:fs/promises';
import { build } from 'vite';
import { resolve, dirname } from 'node:path';
import assert from 'node:assert/strict';
import { gzipSync, deflateRawSync, inflateRawSync } from 'node:zlib';
import { compactInternals } from './compact-internals.js';
import { compactOutput, external, measureCoreStage } from './measure-size.js';
import { packageOrder } from './package-order.js';
import { buildWorkers } from './build-workers.js';
import { staticEmbind } from './static-embind.js';
async function compactPackage(name) {
  const root = `packages/${name}/dist`,
    files = (await readdir(root)).filter((file) => file.endsWith('.js'));
  for (const file of files)
    await writeFile(
      `${root}/${file}`,
      compactInternals(
        await readFile(`packages/${name}/src/${file.replace(/\.js$/, '.ts')}`, 'utf8'),
        await readFile(`${root}/${file}`, 'utf8'),
      ),
    );
  // Keep module paths and identities intact, including the extension entry point.
  const output = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'warn',
    build: {
      write: false,
      minify: true,
      target: 'es2022',
      lib: {
        entry: Object.fromEntries(files.map((file) => [file.slice(0, -3), `${root}/${file}`])),
        formats: ['es'],
        fileName: (_, name) => `${name}.js`,
      },
      rollupOptions: { external: (_id, importer) => !!importer, output: compactOutput },
    },
  });
  for (const chunk of output[0].output) {
    assert.equal(chunk.type, 'chunk');
    assert.ok(files.includes(chunk.fileName), 'Unexpected library chunk');
    await writeFile(`${root}/${chunk.fileName}`, chunk.code);
  }
}

const precompiled = process.argv.includes('--precompiled');
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
// -ocimfs 300: keep the kernel's recompute path out of line so the per-entity unchanged path stays small (CAD, 100k entities: 3.5 vs 4.8 ms per tick).
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
const machineryPath =
  'packages/machinery/kernel/target/wasm32-unknown-unknown/release/margoengine_machinery_kernel.wasm';
if (!precompiled) {
  execFileSync(
    'cargo',
    [
      'build',
      '--manifest-path',
      'packages/machinery/kernel/Cargo.toml',
      '--target',
      'wasm32-unknown-unknown',
      '--release',
    ],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        CARGO_TARGET_DIR: resolve('packages/machinery/kernel/target'),
        RUSTFLAGS: '-C target-feature=+simd128',
      },
    },
  );
  execFileSync(
    process.execPath,
    [
      'node_modules/binaryen/bin/wasm-opt',
      machineryPath,
      '-O3',
      '--enable-simd',
      '--enable-bulk-memory',
      '--enable-nontrapping-float-to-int',
      '--strip-debug',
      '--strip-producers',
      '-o',
      machineryPath + '.optimized',
    ],
    { stdio: 'inherit' },
  );
  await writeFile(
    'packages/machinery/src/wasm.ts',
    `// Generated machinery kernel; consumers need no Rust toolchain.\nexport const machineryWasm: string = '${gzipSync(await readFile(machineryPath + '.optimized')).toString('base64')}';\n`,
  );
}
// Build every workspace package in dependency order (scripts/package-order.js reads package.json; a package that needs
// another's dist at build time must declare it). A package with its own `build` script runs it; the rest use the
// pipeline below: tsc + compaction for core and the stage facade, tsc for react, a Vite library build + tsc otherwise.
const tsc = (name) =>
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', `packages/${name}/tsconfig.json`], {
    stdio: 'inherit',
  });
const manifests = new Map();
for (const dir of JSON.parse(await readFile('package.json', 'utf8')).workspaces.filter((dir) =>
  dir.startsWith('packages/'),
))
  manifests.set(dir.slice('packages/'.length), JSON.parse(await readFile(`${dir}/package.json`, 'utf8')));
for (const name of packageOrder(manifests)) {
  const manifest = manifests.get(name);
  if (manifest.scripts?.build) {
    execSync(manifest.scripts.build, { cwd: `packages/${name}`, stdio: 'inherit' });
    continue;
  }
  const output = resolve(`packages/${name}/dist`);
  assert.equal(dirname(output), resolve(`packages/${name}`), 'Output escaped its package');
  await rm(output, { recursive: true, force: true });
  await copyFile('LICENSE', `packages/${name}/LICENSE`);
  if (name === 'core' || name === 'margoengine') {
    tsc(name);
    await compactPackage(name);
    continue;
  }
  if (name === 'react') {
    tsc(name);
    continue;
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
          '@margoengine/gltf-pro',
          '@margoengine/loaders',
          '@margoengine/lines',
          '@margoengine/text',
          '@margoengine/bvh',
          '@margoengine/vfx',
          '@margoengine/sky',
          '@margoengine/geometry',
          /^@margoengine\/(sky|vfx)\//,
        ],
        output: compactOutput,
      },
    },
  });
  if (name === 'machinery') {
    // Retain analyzable asset URLs for the consuming app's bundler.
    for (const file of (await readdir(output)).filter((file) => file.endsWith('.js'))) {
      const entry = resolve(output, file);
      await writeFile(
        entry,
        (await readFile(entry, 'utf8')).replace(/(?:''|""|``)\s*\+\s*import\.meta\.url/g, 'import.meta.url'),
      );
    }
    await build({
      configFile: false,
      publicDir: false,
      logLevel: 'warn',
      build: {
        outDir: resolve(output, 'workers'),
        emptyOutDir: true,
        target: 'es2022',
        lib: {
          entry: 'packages/machinery/src/workers/cad-worker.ts',
          name: 'CADWorker',
          formats: ['iife'],
          fileName: () => 'cad-runtime.js',
        },
      },
    });
    // occt-import-js's embind wrappers would need 'unsafe-eval'; ship the closure form (scripts/static-embind.js). Wasm unchanged.
    await writeFile(
      resolve(output, 'workers/occt-import-js.js'),
      staticEmbind(await readFile('node_modules/occt-import-js/dist/occt-import-js.js', 'utf8'), 'occt-import-js.js'),
    );
    await copyFile(
      'node_modules/occt-import-js/dist/occt-import-js.wasm',
      resolve(output, 'workers/occt-import-js.wasm'),
    );
    await copyFile('node_modules/occt-import-js/LICENSE.md', resolve(output, 'workers/OCCT-LICENSE.txt'));
    await copyFile('packages/machinery/src/workers/OCCT-NOTICE.txt', resolve(output, 'workers/OCCT-NOTICE.txt'));
  }
  await buildWorkers(resolve(`packages/${name}`));
  tsc(name);
}
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
  'machinery',
  'vfx',
  'sky',
  'creative',
  'scenery',
  ...featurePackages,
  'margoengine',
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
            !['machinery', 'creative', 'scenery', 'loaders', 'exporters', ...featurePackages].some((pack) =>
              id.includes(`/packages/${pack}/`),
            ),
        ),
      ),
      'Domain pack leaked into core',
    );
  sizes[name] = { raw: Buffer.byteLength(code), gzip: gzipSync(code).length };
}
assert.ok(sizes.core.gzip < 20 * 1024, 'Core exceeds 20 KiB gzip');
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
const isolation = await build({
  configFile: false,
  publicDir: false,
  logLevel: 'silent',
  build: { write: false, target: 'es2022', lib: { entry: 'tests/modern-machinery-consumer.js', formats: ['es'] } },
});
for (const chunk of (Array.isArray(isolation) ? isolation[0] : isolation).output.filter(
  (item) => item.type === 'chunk',
))
  assert.ok(
    Object.keys(chunk.modules).every((id) => !id.includes('/creative/') && !id.includes('/scenery/')),
    'Creative/scenery code leaked into a machinery consumer',
  );
console.error(JSON.stringify(sizes, null, 2));
// The catalog reads every built dist, so it is regenerated here and can never trail the packages.
execFileSync(process.execPath, ['scripts/build-catalog.js'], { stdio: 'inherit' });
