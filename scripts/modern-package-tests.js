// The packed-package test (`npm run modern:test:packages`): builds every package once, packs them all, installs the
// tarballs into a clean consumer project and checks them there: licence and notice files, the strict consumer
// declarations and run, every README example, the React docs, the React unit tests and the packed browser lifecycle.
//   npm run modern:test:packages                          everything
//   npm run modern:test:packages -- --packages=dof,react  only those packages' README examples (check:merge passes the
//                                                         affected ones); packing, install, licences and the umbrella
//                                                         smoke test always run; `react` also switches on the React
//                                                         docs, the React unit tests and the packed browser
//   npm run modern:test:packages -- --consumer            the end-user steps only, for the packages' oldest Node (22.12,
//                                                         CI's node-compat job): everything above except the React
//                                                         unit tests, which are repository tests (node:test
//                                                         mock.module) and need the contributors' Node (root
//                                                         package.json engines, 24.18 or newer). Below that Node the
//                                                         flag is required, so they are never left out silently.
// MARGOENGINE_PACKAGE_TEST_PREBUILT=1 skips the build (check:merge: `verify` or the build after a failed verify just built, and planted stale files).
// The consumer project is kept between runs (os.tmpdir()/margoengine-consumer-cache/<key>) with its third-party
// node_modules; only our tarballs are extracted again. The key covers the lock file, the dependency declarations of
// every package, the Node version and the ISO week, so a new dependency or a new week installs afresh.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile, readFile, copyFile, readdir, rm, realpath, stat } from 'node:fs/promises';
import { resolve, join, dirname, basename } from 'node:path';
import { cpus, tmpdir } from 'node:os';
import { openBrowser } from './browser.js';
import { waitForPageReady } from './support/page-ready.js';
import { pages } from './support/doc-snippets.mjs';
import {
  packageMarkdown,
  readmeExamples,
  README_BINDING,
  README_GLOBALS,
  README_PROJECT,
} from './support/readme-types.mjs';
import { BUNDLED } from './supply-chain.mjs';

const names = [
    'core',
    'gltf',
    'react',
    'creative',
    'scenery',
    'gltf-pro',
    'animation',
    'post',
    'shadows',
    'clustered',
    'vfx',
    'animator',
    'taa',
    'splats',
    'terrain',
    'environment',
    'controls',
    'exporters',
    'stage',
    'margoengine',
  ],
  npm = process.env.npm_execpath;
const packedNames = JSON.parse(await readFile('package.json', 'utf8'))
  .workspaces.filter((path) => path.startsWith('packages/'))
  .map((path) => path.slice('packages/'.length));
// Top-level notice files the supply-chain list (scripts/supply-chain.mjs BUNDLED) says a package ships; dist/ notices
// are covered by the dist/ rule below. One list, so a new notice can't pass one check and fail this one.
const noticeFiles = new Map(
  BUNDLED.flatMap((b) =>
    b.package
      .split(', ')
      .flatMap((pkg) =>
        b.notices.filter((n) => !n.startsWith('dist/')).map((n) => [pkg.replace('@margoengine/', ''), n]),
      ),
  ),
);
const packageDocuments = new Map([...noticeFiles, ['blender', 'FORMAT.md']]);
const packageName = (name) => (name === 'margoengine' ? 'margoengine' : `@margoengine/${name}`);
assert.ok(npm, 'Run this check through npm run modern:test:packages');
// --packages=a,b: only those packages' README examples (the umbrella's always); absent: every package.
const packagesArg = process.argv.find((arg) => arg.startsWith('--packages='));
const selected = packagesArg
  ? new Set([...packagesArg.slice('--packages='.length).split(',').filter(Boolean), 'margoengine'])
  : null;
for (const name of selected ?? [])
  assert.ok(
    packedNames.includes(name),
    `--packages names ${name}, which is not a package directory (${packedNames.join(', ')})`,
  );
const inScope = (name) => !selected || selected.has(name);
// The React docs, the React unit tests and the packed browser lifecycle belong to the React package.
const reactScope = inScope('react');
// --consumer: what end users run, on any Node the packages support; the React unit tests need the contributors' Node.
const consumerOnly = process.argv.includes('--consumer');
const contributorNode = JSON.parse(await readFile('package.json', 'utf8')).engines.node.replace(/^>=\s*/, '');
const atLeast = (have, want) => {
  const [a, b] = [have, want].map((v) => v.replace(/^v/, '').split('.').map(Number));
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
};
assert.ok(
  consumerOnly || atLeast(process.version, contributorNode) >= 0,
  `Node ${process.version} is below the contributors' Node ${contributorNode} (root package.json engines), which the ` +
    'React unit tests need; on an end-user Node run `npm run modern:test:packages -- --consumer`',
);
const reactUnitTests = reactScope && !consumerOnly;
if (reactScope && consumerOnly)
  console.log(`--consumer: the React unit tests are not run here; they run on Node ${contributorNode} or newer`);
// bsdtar ships with Windows; a GNU tar earlier on PATH would read `C:` as a host name.
const tarBin =
  process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const seconds = (since) => `${Math.round((performance.now() - since) / 100) / 10} s`;
const timings = [];
const timed = async (label, work) => {
  const since = performance.now();
  try {
    return await work();
  } finally {
    timings.push(`${label} ${seconds(since)}`);
  }
};
// Reuse a verified archive set while concurrent source edits are in progress.
// This mode never packs, rebuilds, or injects markers into shared dist.
const reuseTarballs = process.env.MARGOENGINE_PACKAGE_TEST_REUSE_TARBALLS === '1';
const archives = resolve(reuseTarballs ? 'test-results/margo-packages' : 'test-results/modern-packages');
if (reuseTarballs) await realpath(archives);
else await mkdir(archives, { recursive: true });
const tarballs = [];
const dependencies = {
  react: '18.3.1',
  'react-dom': '18.3.1',
  '@types/react': '^18.3.0',
  '@types/react-dom': '^18.3.0',
  '@types/node': JSON.parse(await readFile('node_modules/@types/node/package.json', 'utf8')).version,
  '@testing-library/react': '16.3.3',
  '@playwright/test': JSON.parse(await readFile('package.json', 'utf8')).devDependencies['@playwright/test'],
  jsdom: '26.1.0',
  vite: JSON.parse(await readFile('package.json', 'utf8')).devDependencies.vite,
  '@dimforge/rapier3d-compat': JSON.parse(await readFile('node_modules/@dimforge/rapier3d-compat/package.json', 'utf8'))
    .version,
};
// One build for all packages (every package's prepack is that same build, so packing with scripts ran it once per
// package). A stale file planted in two dist folders must not survive the build into a tarball. When check:merge's
// `verify` has just built, it planted the files before its build and this run packs that result.
const prebuilt = process.env.MARGOENGINE_PACKAGE_TEST_PREBUILT === '1';
if (!reuseTarballs && !prebuilt) {
  for (const name of ['core', 'react']) {
    await mkdir(`packages/${name}/dist`, { recursive: true });
    await writeFile(`packages/${name}/dist/__stale-package-test.js`, 'throw new Error("Stale build artifact");');
  }
  await timed('build', async () =>
    execFileSync(process.execPath, [npm, 'run', 'build:packages'], { stdio: 'inherit' }),
  );
}
// One npm process packs every workspace; the build already ran, so no prepack.
const packs = new Map();
if (!reuseTarballs) {
  // npm pack prints the prepack scripts' output before its JSON, and a warning may precede it.
  const fromArray = (text) => text.slice(Math.max(0, text.search(/^\[/m)));
  const out = await timed('pack', async () =>
    execFileSync(
      process.execPath,
      [
        npm,
        'pack',
        ...packedNames.flatMap((name) => ['--workspace', packageName(name)]),
        '--pack-destination',
        archives,
        '--json',
        '--ignore-scripts',
      ],
      { encoding: 'utf8', maxBuffer: 1 << 28 },
    ),
  );
  for (const pack of JSON.parse(fromArray(out))) packs.set(pack.name, pack);
  // The build runs packages side by side (scripts/build-modern.js); the tarball set must still be exactly one per
  // workspace package, each named after its manifest, so a package that was skipped or built twice shows up here.
  assert.deepEqual(
    [...packs.values()].map((pack) => pack.filename).sort(),
    (
      await Promise.all(
        packedNames.map(async (name) => {
          const { version } = JSON.parse(await readFile(`packages/${name}/package.json`, 'utf8'));
          return packageName(name).replace(/^@/, '').replace('/', '-') + '-' + version + '.tgz';
        }),
      )
    ).sort(),
    'npm pack must write exactly one tarball per workspace package',
  );
}
for (const name of packedNames) {
  let pack, manifest;
  if (reuseTarballs) {
    const workspaceManifest = JSON.parse(await readFile(`packages/${name}/package.json`, 'utf8'));
    const filename = packageName(name).replace(/^@/, '').replace('/', '-') + '-' + workspaceManifest.version + '.tgz',
      archive = join(archives, filename);
    const members = execFileSync(tarBin, ['-tf', archive], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
    assert.ok(
      members.length && members.every((member) => member.startsWith('package/') && !member.split('/').includes('..')),
      `Invalid cached package archive: ${filename}`,
    );
    pack = {
      filename,
      files: members
        .filter((member) => !member.endsWith('/'))
        .map((member) => ({ path: member.slice('package/'.length) })),
    };
    manifest = JSON.parse(execFileSync(tarBin, ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' }));
    assert.equal(manifest.name, packageName(name), `Wrong cached package: ${filename}`);
    assert.equal(manifest.version, workspaceManifest.version, `Wrong cached version: ${filename}`);
  } else {
    pack = packs.get(packageName(name));
    assert.ok(pack, `npm pack did not report ${packageName(name)}`);
    manifest = JSON.parse(await readFile(`packages/${name}/package.json`, 'utf8'));
  }
  const files = new Set(pack.files.map((file) => file.path));
  const unexpected = pack.files
    .filter(
      (file) =>
        ![
          'package.json',
          'README.md',
          'LICENSE',
          'NOTICE',
          ...(packageDocuments.has(name) ? [packageDocuments.get(name)] : []),
          // A command the package installs (bin in its manifest), such as margoengine-mcp.
          ...Object.values(manifest.bin ?? {}).map((path) => path.replace(/^\.\//, '')),
        ].includes(file.path) && !file.path.startsWith('dist/'),
    )
    .map((file) => file.path);
  assert.deepEqual(unexpected, [], `${packageName(name)} contains unexpected packed files: ${unexpected.join(', ')}`);
  if (noticeFiles.has(name))
    assert.ok(files.has(noticeFiles.get(name)), `${packageName(name)} must retain its third-party notices`);
  if (name === 'blender')
    assert.ok(files.has('FORMAT.md'), '@margoengine/blender must retain its format specification');
  assert.ok(files.has('README.md') && files.has('LICENSE') && files.has('NOTICE'));
  assert.ok(!files.has('dist/__stale-package-test.js'));
  assert.notEqual(manifest.private, true);
  assert.equal(manifest.license, 'Apache-2.0');
  assert.equal(manifest.publishConfig.access, 'public');
  for (const entry of Object.values(manifest.exports))
    for (const target of Object.values(entry))
      assert.ok(files.has(target.slice(2)), `Missing packed export: ${manifest.name} ${target}`);
  dependencies[packageName(name)] = `file:${join(archives, pack.filename).replaceAll('\\', '/')}`;
  tarballs.push({ name: packageName(name), file: join(archives, pack.filename) });
}
// The consumer project. A warm one (same key) keeps its third-party node_modules and gets our tarballs extracted
// again; a cold one, or one another run holds, is installed with npm as a fresh temporary project.
const week = (() => {
  const d = new Date();
  const jan1 = Date.UTC(d.getUTCFullYear(), 0, 1);
  return `${d.getUTCFullYear()}-w${Math.floor((Date.now() - jan1) / 604_800_000)}`;
})();
const key = createHash('sha256')
  .update(
    JSON.stringify({
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      week,
      lock: createHash('sha256')
        .update(await readFile('package-lock.json'))
        .digest('hex'),
      external: Object.entries(dependencies).filter(([, version]) => !version.startsWith('file:')),
      packages: await Promise.all(
        packedNames.map(async (name) => {
          const { version, dependencies, peerDependencies, optionalDependencies, peerDependenciesMeta } = JSON.parse(
            await readFile(`packages/${name}/package.json`, 'utf8'),
          );
          return [name, version, dependencies, peerDependencies, optionalDependencies, peerDependenciesMeta];
        }),
      ),
    }),
  )
  .digest('hex')
  .slice(0, 16);
const cacheBase = join(tmpdir(), 'margoengine-consumer-cache'),
  cacheDir = join(cacheBase, key),
  lockDir = `${cacheDir}.lock`;
let holdsLock = false;
if (!process.env.MARGOENGINE_PACKAGE_TEST_NO_CACHE) {
  await mkdir(cacheBase, { recursive: true });
  for (let attempt = 0; attempt < 2 && !holdsLock; attempt++)
    try {
      await mkdir(lockDir);
      holdsLock = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // A run that died holding the lock leaves it behind; nothing here takes more than twenty minutes.
      if (Date.now() - (await stat(lockDir)).mtimeMs < 20 * 60_000) break;
      await rm(lockDir, { recursive: true, force: true });
    }
}
const fixture = holdsLock ? cacheDir : await mkdtemp(join(tmpdir(), 'margoengine-consumer-'));
const ready = join(cacheDir, '.ready');
const warm = holdsLock && existsSync(ready);
let browser;
const browserErrors = [];
try {
  await timed(warm ? 'fixture (warm cache)' : 'fixture (npm install)', async () => {
    if (warm) {
      // Everything of ours goes; the third-party packages stay.
      for (const entry of await readdir(fixture))
        if (entry !== 'node_modules' && entry !== '.ready')
          await rm(join(fixture, entry), { recursive: true, force: true });
      for (const entry of ['@margoengine', 'margoengine', 'docs'])
        await rm(join(fixture, 'node_modules', entry), { recursive: true, force: true });
      await writeFile(join(fixture, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies }));
      let next = 0;
      const extract = async () => {
        while (next < tarballs.length) {
          const { name, file } = tarballs[next++],
            target = join(fixture, 'node_modules', name);
          await mkdir(target, { recursive: true });
          await new Promise((done, fail) =>
            spawn(tarBin, ['-xzf', file, '-C', target, '--strip-components=1'], { stdio: 'inherit' })
              .on('error', fail)
              .on('close', (code) => (code === 0 ? done() : fail(new Error(`tar failed for ${file}`)))),
          );
        }
      };
      await Promise.all(Array.from({ length: Math.min(8, cpus().length) }, extract));
      return;
    }
    if (holdsLock) {
      await rm(cacheDir, { recursive: true, force: true });
      await mkdir(cacheDir, { recursive: true });
    }
    await writeFile(join(fixture, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies }));
    execFileSync(process.execPath, [npm, 'install', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: fixture,
      stdio: 'inherit',
    });
    // A package that npm nested inside ours cannot be restored by extracting the tarballs again.
    const nested = [];
    for (const { name } of tarballs)
      if (existsSync(join(fixture, 'node_modules', name, 'node_modules'))) nested.push(name);
    if (holdsLock && !nested.length) await writeFile(ready, new Date().toISOString());
  });
  for (const [name, file] of packageDocuments)
    assert.equal(
      await readFile(join(fixture, `node_modules/${packageName(name)}/${file}`), 'utf8'),
      await readFile(`packages/${name}/${file}`, 'utf8'),
      `${packageName(name)} must preserve its installed ${file} verbatim`,
    );
  for (const name of names) {
    assert.equal(
      await readFile(join(fixture, `node_modules/${packageName(name)}/LICENSE`), 'utf8'),
      await readFile('LICENSE', 'utf8'),
    );
    // Apache-2.0 s. 4(d): the NOTICE travels with every installed package.
    assert.ok(
      (await readFile(join(fixture, `node_modules/${packageName(name)}/NOTICE`), 'utf8')).startsWith(
        await readFile('NOTICE', 'utf8'),
      ),
      `${packageName(name)} must ship Margo's NOTICE`,
    );
    if (!inScope(name)) continue;
    // The README, then the package's guides (packages/<name>/docs/*.md, kept in the repository, not packed): each
    // guide's `ts` blocks are checked like the README's, so moving a section out of a README keeps its check.
    const documents = [
      {
        document: 'readme',
        markdown: await readFile(join(fixture, `node_modules/${packageName(name)}/README.md`), 'utf8'),
      },
      ...packageMarkdown(`packages/${name}`).filter(({ document }) => document !== 'readme'),
    ];
    for (const { document, markdown } of documents) {
      const prefix = document === 'readme' ? name : `${name}-${document}`;
      for (const [index, code] of readmeExamples(markdown).entries())
        await writeFile(join(fixture, `${prefix}-${index}-readme.tsx`), code);
    }
  }
  // The README quickstart and the task guides (docs/guides) are one program each; their `ts` blocks are type-checked
  // like a package README, against the packed umbrella. scripts/docs-browser-test.mjs runs the same programs.
  for (const page of pages()) await writeFile(join(fixture, `docs-${page.slug}-readme.tsx`), page.all ?? page.program);
  // The React cookbook and the react-three-fiber guide are checked like a README. A snippet whose first line is
  // `// path/file.tsx` is written to that path so a second snippet can import it.
  for (const doc of reactScope ? ['react-cookbook', 'react-from-r3f'] : []) {
    const examples = [];
    for (const [, code] of (await readFile(`docs/${doc}.md`, 'utf8')).matchAll(/```tsx?\r?\n([\s\S]*?)```/g)) {
      if (!examples.length || /^\s*(?:\/\/ [\w/.-]+\.tsx\r?\n)?\s*import\s/m.test(code)) examples.push(code);
      else examples[examples.length - 1] += '\n' + code;
    }
    for (const [index, code] of examples.entries()) {
      const path = /^\/\/ ([\w/.-]+\.tsx)\r?\n/.exec(code)?.[1],
        file = join(fixture, 'docs', doc, path ?? `${index}.tsx`);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, code);
    }
  }
  if (reactScope)
    await writeFile(
      join(fixture, 'docs/tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          jsx: 'react-jsx',
          types: [],
          lib: ['ES2022', 'DOM'],
          noEmit: true,
        },
        include: ['**/*.tsx'],
      }),
    );
  // The consumer program emits and runs; the README examples are only type-checked, in shards that run side by side.
  const consumerOptions = {
    strict: true,
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    jsx: 'react-jsx',
    types: [],
    lib: ['ES2022', 'DOM'],
  };
  await writeFile(
    join(fixture, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { ...consumerOptions, outDir: 'out' }, include: ['consumer.tsx'] }),
  );
  const readmeFiles = (await readdir(fixture)).filter((file) => file.endsWith('-readme.tsx')).sort(),
    shardCount = Math.max(1, Math.min(8, cpus().length >> 2, readmeFiles.length)),
    shards = Array.from({ length: shardCount }, (_, shard) =>
      readmeFiles.filter((_, index) => index % shardCount === shard),
    );
  // The fixture installs the published packages only; the React README's Playwright example reads the repository's types.
  const readmeProject = {
    ...README_PROJECT,
    paths: { ...README_PROJECT.paths, playwright: [resolve('node_modules/playwright/index.d.ts')] },
  };
  await writeFile(join(fixture, 'readme-binding.d.ts'), README_BINDING);
  await writeFile(join(fixture, 'readme-globals.d.ts'), README_GLOBALS);
  for (const [shard, include] of shards.entries())
    await writeFile(
      join(fixture, `tsconfig.readme-${shard}.json`),
      JSON.stringify({ compilerOptions: readmeProject, include: [...include, 'readme-globals.d.ts'] }),
    );
  await writeFile(
    join(fixture, 'consumer.tsx'),
    `import {TransformStore,type PassContext} from '@margoengine/core/extension';
import {EngineKernel,type Mesh as MeshHandle} from '@margoengine/core';
import {loadGLTF} from '@margoengine/gltf';
import { Canvas, Mesh, BoxGeometry, PbrMaterial, useMargo, useMargoStage, type MeshRef } from '@margoengine/react';
import { Animation } from '@margoengine/react/animation';
import { OrbitControls } from '@margoengine/react/controls';
import { Environment } from '@margoengine/react/environment';
import { Box } from '@margoengine/react/geometry';
import { Gltf, Model } from '@margoengine/react/gltf-pro';
import { MeshTransmissionMaterial } from '@margoengine/react/materials';
import { Shadows } from '@margoengine/react/shadows';
import {GPUParticles,PostProcessing,ToonShading,HDRRenderTarget} from '@margoengine/creative';
import {PostStack,Bloom} from '@margoengine/post';
import {SkyMoon,type SkyMoonConfig} from '@margoengine/scenery';
import {Stage,createStage,sphere,type LoadedModel} from 'margoengine';
import {renderToString} from 'react-dom/server';
const device=(pass:PassContext)=>pass.backend==='webgpu'?pass.device:null;
const store=await TransformStore.create(3);store.dispose();
if(typeof createStage!=='function'||typeof Stage!=='function'||sphere().indices.length===0)throw new Error('Stage exports failed');
function loaded(model:LoadedModel){model.position.set(1,2,3);model.rotation.set(0,0.5,0);model.scale.setAll(2);model.visible=false;const bounds:Float32Array=model.bounds;const buffer:GPUBuffer|undefined=model.raw?.[0].vertex;
// @ts-expect-error bounds cannot be replaced
model.bounds=new Float32Array(6);
model.destroy();return {bounds,buffer};}
const html=renderToString(<Canvas><Mesh><BoxGeometry/><PbrMaterial/></Mesh></Canvas>);
const afterScene=renderToString(<Canvas><Box color="#84d6bd"/><Mesh><BoxGeometry/><MeshTransmissionMaterial factor={0}/></Mesh><Gltf src="/character.glb"><Animation clip="Walk" blend={0.2}/></Gltf></Canvas>);if(!afterScene.includes('<canvas'))throw new Error('Root scene exports failed');
const declarative=renderToString(<Canvas onCreated={stage=>stage.engine.camera.position=[1,2,5]}><Model src="/model.glb" materials={{Upper:{baseColor:[0.2,0.8,0.3]}}} onLoad={mesh=>mesh.setPosition([1,0,0])}/><Environment src="/studio.hdr" exposure={1} background/><OrbitControls enableDamping minDistance={1} maxDistance={10}/><Shadows/></Canvas>);
if(!declarative.includes('<canvas')||typeof useMargo!=='function'||typeof useMargoStage!=='function')throw new Error('Declarative exports failed');
if(!html.includes('<canvas')||typeof loadGLTF!=='function'||new GPUParticles({count:32}).count!==32)throw new Error('Consumer failed');
new ToonShading();new PostStack([new Bloom({strength:0.5}),new PostProcessing({atmosphere:{density:0.01}})]);
if(!HDRRenderTarget)throw new Error('Domain exports failed');
const moonlit:SkyMoonConfig={moonDirection:[0,1,0],moonPhase:1};if(new SkyMoon(moonlit).config!==moonlit)throw new Error('Scenery exports failed');
function refs(engine:import('@margoengine/core').EngineKernel,node:MeshRef){
// @ts-expect-error useMargoStage uses the portable engine surface
engine.frameGraph;
// @ts-expect-error React mesh refs hide Wasm slot indices
node.id;
return <Canvas onCreated={stage=>{
const engine=stage.engine;
engine.gpu;
}}><Mesh ref={node=>{if(node){
// @ts-expect-error Mesh refs hide raw matrix views
node.matrix;
}}}/></Canvas>;
}
function frozen(canvas:HTMLCanvasElement){void EngineKernel.create(canvas).then(engine=>{const mesh=engine.createMesh();void loadGLTF(engine,'http://example.invalid/model.glb');
// @ts-expect-error runtime storage is confined to the extension entry
engine.store;
engine.gpu;
// @ts-expect-error attached geometry changes use setGeometry
mesh.geometry=null;
// @ts-expect-error slot-map indices are confined to the extension entry
mesh.id;
// @ts-expect-error Wasm matrix views are confined to the extension entry
mesh.matrix;
});}
console.log('Standalone package imports, WebGPU declarations, Wasm and React 18 SSR pass');
`,
  );
  const tsc = resolve('node_modules/typescript/bin/tsc'),
    failures = [];
  // A child process in the fixture; its output is kept and printed when it ends.
  const task = (label, args, env = process.env) =>
    new Promise((done) => {
      const started = performance.now(),
        chunks = [],
        child = spawn(process.execPath, args, { cwd: fixture, env, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', (chunk) => chunks.push(chunk));
      child.stderr.on('data', (chunk) => chunks.push(chunk));
      const end = (code, extra = '') => {
        const output = Buffer.concat(chunks).toString() + extra;
        timings.push(`${label} ${seconds(started)}`);
        if (output.trim()) console.log(`--- ${label}\n${output.trimEnd()}`);
        if (code !== 0) failures.push(label);
        done(code === 0);
      };
      child.on('error', (error) => end(-1, String(error)));
      child.on('close', (code) => end(code));
    });
  // Run against the installed tarball itself. Relative internal-module imports and
  // public package imports must share the same React contexts and asset caches.
  const reactRoot = join(fixture, 'node_modules/@margoengine/react'),
    supportRoot = join(fixture, 'node_modules'),
    reactTests = [];
  if (reactScope) {
    for (const directory of ['test', 'tests']) {
      await mkdir(join(reactRoot, directory), { recursive: true });
      for (const file of await readdir('packages/react/' + directory, { withFileTypes: true })) {
        // These packaging/bundler checks require the workspace and already run in
        // the full Node gate; all component lifecycle tests also run on React 18.
        if (!file.isFile() || !/\.(?:m?js)$/.test(file.name) || file.name === 'subpaths.test.js') continue;
        const relative = directory + '/' + file.name;
        await copyFile('packages/react/' + relative, join(reactRoot, relative));
        if (file.name.endsWith('.test.js')) reactTests.push(relative);
      }
    }
    reactTests.sort();
    await mkdir(join(supportRoot, '@margoengine/gltf-pro/src'), { recursive: true });
    await mkdir(join(supportRoot, 'docs'), { recursive: true });
    // Vite sets NODE_ENV while building. Keep that tool state out of the consumer/test child environment.
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        "import {writeFile} from 'node:fs/promises'; import {bundleBytes} from './scripts/measure-size.js'; await writeFile(process.argv[2], await bundleBytes(process.argv[1]));",
        resolve('packages/gltf-pro/src/shader.ts'),
        join(supportRoot, '@margoengine/gltf-pro/src/shader.js'),
      ],
      { stdio: 'inherit', timeout: 120000 },
    );
    await mkdir(join(supportRoot, '@margoengine/shared'), { recursive: true });
    await copyFile('packages/shared/aces.js', join(supportRoot, '@margoengine/shared/aces.js'));
    for (const file of ['react-integration.md', 'react-r3f.md'])
      await copyFile('docs/' + file, join(supportRoot, 'docs', file));
    for (const file of [
      'tests/support/optional-gpu.js',
      'tests/support/postfx-gpu.js',
      'examples/assets/kaykit/dungeon/pieces/dungeon_texture.png',
      'examples/assets/khronos-samples/CesiumMan.jpg',
    ]) {
      const target = join(supportRoot, file);
      await mkdir(dirname(target), { recursive: true });
      if (file.endsWith('postfx-gpu.js'))
        await writeFile(
          target,
          (await readFile(file, 'utf8')).replace(
            '../../packages/core/dist/extension.js',
            '@margoengine/core/extension',
          ),
        );
      else await copyFile(file, target);
    }
  }
  // The packed browser's first page load (a cold dev server transforming every package) is the slowest, most CPU-hungry
  // part. Started together with the type-check shards it missed the 30 s navigation limit twice in a row on a busy
  // machine, so it goes first and everything else starts once the page has loaded (or failed to).
  let pageLoaded;
  const loaded = new Promise((done) => (pageLoaded = done));
  const packedBrowser = async () => {
    const aliases = [],
      browserExport = (entry) =>
        typeof entry === 'string' ? entry : browserExport(entry.browser ?? entry.import ?? entry.default);
    for (const name of [...packedNames.map(packageName), 'react', 'react-dom']) {
      const directory = join(fixture, 'node_modules', name),
        manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      for (const [subpath, entry] of Object.entries(manifest.exports)) {
        const specifier = name + (subpath === '.' ? '' : subpath.slice(1));
        aliases.push({
          find: new RegExp('^' + specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'),
          replacement: join(directory, browserExport(entry)),
        });
      }
    }
    const started = performance.now();
    try {
      browser = await openBrowser({ startPath: '/tests/modern.html', aliases });
    } finally {
      pageLoaded();
    }
    const { page } = browser,
      errors = browserErrors;
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    // Ready when the dev server has served what the page imports, not after a fixed time (a cold server under load
    // took longer than the 30 s default); a hard limit of 10 minutes still fails a real hang, naming what hung.
    await waitForPageReady({
      what: 'packed browser page (window.modern)',
      ready: () => page.evaluate(() => Boolean(window.modern)).catch(() => false),
      idle: () => browser.server.waitForRequestsIdle(),
      describe: () => `url ${page.url()}, page errors: ${JSON.stringify(errors.slice(0, 5))}`,
    });
    await page.evaluate(() => window.modern.mount());
    await page.waitForFunction(
      () => window.modern.state.react?.meshes.size === 2 && window.modern.state.parent && window.modern.state.child,
    );
    assert.ok(
      await page.evaluate(() => {
        const s = window.modern.state;
        return s.react.store.parents[s.child.id] === s.parent.id;
      }),
    );
    const renders = await page.evaluate(() => window.modern.state.renders);
    await page.waitForFunction(() => window.modern.state.frames >= 20);
    assert.equal(await page.evaluate(() => window.modern.state.renders), renders);
    await page.evaluate(() => window.modern.mount({ position: 2 }));
    await page.waitForFunction(() => window.modern.state.parent?.position.x === 2);
    await page.evaluate(() => window.modern.mount({ show: false }));
    await page.waitForFunction(() => window.modern.state.react.meshes.size === 0);
    await page.evaluate(() => window.modern.mount({ suspend: true }));
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.modern.state.react.meshes.size), 0);
    await page.evaluate(() => window.modern.mount());
    await page.waitForFunction(() => window.modern.state.react.meshes.size === 2);
    await page.evaluate(() => window.modern.unmount());
    assert.ok(await page.evaluate(() => window.modern.state.react.disposed));
    assert.equal(await page.evaluate(() => window.modern.state.react.meshes.size), 0);
    assert.deepEqual(await page.evaluate(() => window.modern.state.errors), []);
    assert.deepEqual(errors, []);
    timings.push(`packed browser ${seconds(started)}`);
  };
  // Everything that only reads the installed packages runs side by side: the consumer program, the README examples in
  // shards, the React docs, the React unit tests and the packed browser (started first, see above).
  const browserRun = reactScope ? packedBrowser() : undefined;
  browserRun?.then(pageLoaded, pageLoaded); // a failure before the page opens must not leave the rest waiting
  if (reactScope) await loaded;
  const pipelines = [
    (async () => {
      if (await task('consumer tsc', [tsc, '-p', join(fixture, 'tsconfig.json')]))
        await task('consumer run', [join(fixture, 'out/consumer.js')]);
    })(),
    ...shards.flatMap((include, shard) =>
      include.length
        ? [
            task(`README tsc ${shard + 1}/${shards.length}`, [
              tsc,
              '-p',
              join(fixture, `tsconfig.readme-${shard}.json`),
            ]),
          ]
        : [],
    ),
  ];
  if (reactScope) pipelines.push(task('React docs tsc', [tsc, '-p', join(fixture, 'docs/tsconfig.json')]), browserRun);
  if (reactUnitTests)
    pipelines.push(
      task(
        'React unit tests',
        ['--experimental-test-module-mocks', '--test', ...reactTests.map((file) => join(reactRoot, file))],
        { ...process.env, MARGOENGINE_TEST_REPOSITORY: resolve('.') },
      ),
    );
  const settled = await Promise.allSettled(pipelines);
  console.log(`package test timings: ${timings.join(', ')}`);
  const rejected = settled.find((result) => result.status === 'rejected');
  if (rejected) throw rejected.reason;
  assert.deepEqual(failures, [], `Failed: ${failures.join(', ')}`);
  const react = JSON.parse(await readFile(join(fixture, 'node_modules/react/package.json'), 'utf8')).version;
  await writeFile(
    'test-results/modern-packages.json',
    JSON.stringify(
      {
        hardware: browser?.hardware ?? null,
        packages: packedNames.map(packageName),
        scope: selected ? [...selected].sort() : 'all',
        archiveSource: reuseTarballs ? 'cached-tarballs' : prebuilt ? 'verify build' : 'build',
        archiveDirectory: archives,
        node: process.version,
        consumerOnly,
        react,
        reactTests: reactUnitTests ? reactTests : [],
        timings,
        checks: [
          'standalone imports and Wasm',
          'strict consumer declarations without workspace ambient types',
          'React 18 SSR',
          ...(reactUnitTests ? ['React 18 declarative, kit, post, physics, XR and loader lifecycle unit tests'] : []),
          ...(reactScope ? ['React 18 StrictMode, nested refs, props, RAF, Suspense and teardown'] : []),
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    reactScope
      ? `React ${react} packaged browser lifecycle passes`
      : `packed packages pass (${[...selected].join(', ')})`,
  );
} catch (error) {
  if (browser) {
    const state = await browser.page
      .evaluate(() => {
        const state = window.modern?.state;
        return state
          ? {
              errors: state.errors,
              meshes: state.react?.meshes.size,
              disposed: state.react?.disposed,
              frames: state.frames,
              parent: !!state.parent,
              child: !!state.child,
            }
          : null;
      })
      .catch(() => null);
    console.error('Packed browser failure:', JSON.stringify({ state, errors: browserErrors }));
  }
  throw error;
} finally {
  await browser?.close();
  if (holdsLock) {
    // The warm project stays for the next run. Projects of other keys that nobody has touched for three days go.
    await rm(lockDir, { recursive: true, force: true });
    for (const entry of await readdir(cacheBase))
      if (entry !== key && !entry.endsWith('.lock'))
        if (
          Date.now() - (await stat(join(cacheBase, entry)).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs >
          3 * 86_400_000
        )
          await rm(join(cacheBase, entry), { recursive: true, force: true });
  } else {
    const target = await realpath(fixture);
    assert.equal(dirname(target).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
    assert.ok(basename(target).startsWith('margoengine-consumer-'));
    await rm(target, { recursive: true, force: true });
  }
}
