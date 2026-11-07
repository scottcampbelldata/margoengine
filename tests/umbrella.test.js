// margoengine, the one-install package (scripts/umbrella.mjs): its generated files are current, every alias serves the
// same bindings as the entry it names, and an import through it bundles exactly what the direct import bundles.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build } from 'vite';
import { KITS, umbrellaEntries, aliasSources } from '../scripts/umbrella.mjs';

const root = join(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(join(root, 'packages/margoengine/package.json'), 'utf8'));

test('the generated margoengine entries and package.json are current', () => {
  execFileSync(process.execPath, ['scripts/umbrella.mjs', '--check'], { cwd: root, stdio: 'pipe' });
});

test('margoengine depends on every engine package and only optionally on third-party libraries', () => {
  for (const name of Object.keys(manifest.dependencies)) assert.match(name, /^@margoengine\//);
  for (const name of Object.keys(manifest.peerDependencies ?? {}))
    assert.equal(manifest.peerDependenciesMeta[name]?.optional, true, name);
  assert.equal(manifest.sideEffects, false);
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    assert.deepEqual(Object.keys(target), ['types', 'import'], subpath);
    for (const file of Object.values(target)) assert.ok(existsSync(join(root, 'packages/margoengine', file)), file);
  }
});

test('margoengine is the stage, and every margoengine/<x> is the same module as @margoengine/<x>', async () => {
  const [umbrella, stage] = await Promise.all([import('margoengine'), import('@margoengine/stage')]);
  assert.deepEqual(Object.keys(umbrella).sort(), Object.keys(stage).sort());
  for (const name of Object.keys(stage)) assert.equal(umbrella[name], stage[name], name);
  const entries = umbrellaEntries(root);
  assert.ok(entries.length > 250);
  for (const { subpath, source } of entries) {
    const [alias, ...sources] = await Promise.all([
      import(`margoengine${subpath.slice(1)}`),
      ...aliasSources(entries, source).map((name) => import(name)),
    ]);
    const entry = Object.assign({}, ...sources);
    assert.deepEqual(Object.keys(alias).sort(), Object.keys(entry).sort(), subpath);
    for (const name of Object.keys(entry)) assert.equal(alias[name], entry[name], `${subpath} ${name}`);
  }
});

async function bundle(code) {
  const out = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: true,
      target: 'es2022',
      lib: { entry: 'app', formats: ['es'] },
      rollupOptions: { input: 'app' },
    },
    plugins: [
      { name: 'app', resolveId: (id) => (id === 'app' ? id : null), load: (id) => (id === 'app' ? code : null) },
    ],
  });
  // The entry chunk and what it imports statically; lazy chunks load on first use.
  const byName = new Map(
    out[0].output.filter((chunk) => chunk.type === 'chunk').map((chunk) => [chunk.fileName, chunk]),
  );
  const chunks = [],
    queue = [[...byName.values()].find((chunk) => chunk.isEntry)];
  for (const chunk of queue)
    if (chunk && !chunks.includes(chunk)) {
      chunks.push(chunk);
      queue.push(...chunk.imports.map((name) => byName.get(name)));
    }
  return {
    code: chunks.map((chunk) => chunk.code).join('\n'),
    // Modules that contributed code (tree-shaken ones render nothing).
    modules: chunks
      .flatMap((chunk) => Object.entries(chunk.modules).filter(([, module]) => module.renderedLength > 0))
      .map(([id]) => id.replaceAll('\\', '/')),
  };
}

test('margoengine/react puts no Wasm in a build, and a model page gets it from its own entry', async () => {
  // An app build, not the library mode of bundle(): library mode inlines assets instead of emitting them.
  const emitted = async (code) => {
    const out = await build({
      configFile: false,
      publicDir: false,
      logLevel: 'silent',
      build: { write: false, target: 'es2022', rollupOptions: { input: 'app', preserveEntrySignatures: 'strict' } },
      plugins: [
        { name: 'app', resolveId: (id) => (id === 'app' ? id : null), load: (id) => (id === 'app' ? code : null) },
      ],
    });
    return out.output.map((file) => file.fileName).filter((file) => /\.wasm$|draco|basis/i.test(file));
  };
  assert.deepEqual(await emitted("import { Canvas } from 'margoengine/react'; export { Canvas };"), []);
  assert.deepEqual(await emitted("export * from 'margoengine/react';"), []);
  assert.notDeepEqual(await emitted("import { Model } from 'margoengine/react/gltf-pro'; export { Model };"), []);
  // The kits, and the packages that only draw models: gltf-pro's root alone names the decoders.
  for (const kit of ['game', 'web', 'viz'])
    assert.deepEqual(await emitted(`import { createStage } from 'margoengine/${kit}'; export { createStage };`), [], kit);
  assert.deepEqual(await emitted("import { createMesh } from 'margoengine/materials'; export { createMesh };"), []);
  assert.deepEqual(await emitted("import { Animation } from 'margoengine/animation'; export { Animation };"), []);
  assert.deepEqual(await emitted("import { PBRModel } from 'margoengine/gltf-pro/model'; export { PBRModel };"), []);
  assert.notDeepEqual(await emitted("import { loadGLTF } from 'margoengine/gltf-pro'; export { loadGLTF };"), []);
});

test('importing through margoengine bundles the same code as importing the package', async () => {
  for (const [alias, direct] of [
    [
      "import { Shadows } from 'margoengine/shadows'; export { Shadows };",
      "import { Shadows } from '@margoengine/shadows'; export { Shadows };",
    ],
    [
      "import { OrbitControls } from 'margoengine/controls/orbit'; export { OrbitControls };",
      "import { OrbitControls } from '@margoengine/controls/orbit'; export { OrbitControls };",
    ],
  ]) {
    const [a, b] = await Promise.all([bundle(alias), bundle(direct)]);
    assert.equal(a.code, b.code, alias);
  }
  // The root is the stage: core + stage and nothing else, however many packages margoengine depends on.
  const { modules } = await bundle("import { createStage } from 'margoengine'; export { createStage };");
  const packages = new Set(modules.map((id) => /\/packages\/([^/]+)\//.exec(id)?.[1]).filter(Boolean));
  for (const name of packages) assert.ok(['core', 'margoengine', 'shared', 'stage'].includes(name), name);
  assert.ok(packages.has('core') && packages.has('stage'));
});

test('each kit re-exports exactly the names it lists, as the same bindings', async () => {
  const kits = {
    game: await import('margoengine/game'),
    viz: await import('margoengine/viz'),
    web: await import('margoengine/web'),
  };
  assert.deepEqual(Object.keys(kits).sort(), Object.keys(KITS).sort());
  for (const [kit, { from }] of Object.entries(KITS)) {
    const names = from.flatMap(([, list]) => list);
    assert.deepEqual(Object.keys(kits[kit]).sort(), [...names].sort(), kit);
    for (const [source, list] of from) {
      const module = await import(source);
      for (const name of list) assert.equal(kits[kit][name], module[name], `margoengine/${kit} ${name} from ${source}`);
    }
  }
});

test('a kit costs only what the app uses, and its full size is what docs/guides/kits.md states', async () => {
  const docs = readFileSync(join(root, 'docs/guides/kits.md'), 'utf8');
  for (const [kit, { from }] of Object.entries(KITS)) {
    // One name from the kit bundles the same code as importing it from its package.
    const [source, [name]] = from[1];
    const [a, b] = await Promise.all([
      bundle(`import { ${name} } from 'margoengine/${kit}'; export { ${name} };`),
      bundle(`import { ${name} } from '${source}'; export { ${name} };`),
    ]);
    // Same modules; the bytes may differ by the bundler's ordering and naming only.
    assert.deepEqual(a.modules.sort(), b.modules.sort(), `margoengine/${kit} ${name}`);
    assert.ok(Math.abs(gzipSync(a.code).length - gzipSync(b.code).length) <= 64, `margoengine/${kit} ${name}`);
    // Everything in the kit, the size an app pays when it uses all of it at startup.
    const all = gzipSync((await bundle(`export * from 'margoengine/${kit}';`)).code).length;
    const row = new RegExp(String.raw`\| \x60margoengine/${kit}\x60 \|[^\n]*?\| ([\d,]+) B \|`);
    const stated = Number(row.exec(docs)?.[1].replaceAll(',', ''));
    assert.ok(stated > 0, `docs/guides/kits.md states no size for margoengine/${kit}`);
    assert.ok(
      Math.abs(all - stated) <= Math.max(256, stated * 0.03),
      `margoengine/${kit}: ${all} B, docs/guides/kits.md says ${stated} B`,
    );
  }
});

test('dist/importmap.json maps every margoengine and @margoengine entry to its file on the CDN', () => {
  const { imports } = JSON.parse(readFileSync(join(root, 'packages/margoengine/dist/importmap.json'), 'utf8'));
  for (const subpath of Object.keys(manifest.exports))
    assert.equal(
      imports[`margoengine${subpath.slice(1)}`],
      `https://cdn.jsdelivr.net/npm/margoengine@${manifest.version}/${manifest.exports[subpath].import.slice(2)}`,
    );
  for (const name of Object.keys(manifest.dependencies))
    assert.match(imports[name], /^https:\/\/cdn\.jsdelivr\.net\/npm\/@margoengine\//);
});
