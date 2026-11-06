import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { addShadows } from 'margoengine/stage/shadows';
import { addEnvironment } from 'margoengine/stage/environment';
import { addSky } from 'margoengine/stage/sky';
import { addParticles } from 'margoengine/stage/particles';
import { addEffects } from 'margoengine/stage/effects';

const normalize = (path) => path.replaceAll('\\', '/');
const featureMarkers = {
  particles: 'gpu-particles',
  targets: 'HDR target size exceeds limits',
  toon: 'toon-shading',
  post: 'post-processing',
  grass: 'grass:instances',
  planet: 'planet:surface',
  sky: 'sky-moon',
  shadows: 'Invalid shadow options',
  environment: 'environment:lighting',
};
const cases = [
  // Wrappers load the one implementation they wrap: creative particles over vfx, scenery's SkyMoon over sky.
  {
    key: 'particles',
    pack: 'creative',
    entry: 'particles',
    exports: ['GPUParticles'],
    allowed: ['particles'],
    packs: ['vfx'],
  },
  { key: 'targets', pack: 'creative', entry: 'targets', exports: ['HDRRenderTarget'], allowed: ['targets'] },
  { key: 'toon', pack: 'creative', entry: 'toon', exports: ['ToonShading'], allowed: ['toon'] },
  { key: 'post', pack: 'creative', entry: 'post', exports: ['PostProcessing'], allowed: ['post', 'targets'] },
  { key: 'grass', pack: 'creative', entry: 'grass', exports: ['GrassField'], allowed: ['grass'] },
  { key: 'planet', pack: 'creative', entry: 'planet', exports: ['Planet'], allowed: ['planet'] },
  { key: 'sky', pack: 'scenery', entry: 'sky', exports: ['SkyMoon'], allowed: ['sky'], packs: ['sky'] },
];
const optionalPacks = [
  'creative',
  'scenery',
  'sky',
  'gltf',
  'gltf-pro',
  'blender',
  'animation',
  'environment',
  'post',
  'shadows',
  'clustered',
  'vfx',
  'animator',
  'taa',
  'splats',
  'terrain',
  'loaders',
  'exporters',
  'react',
  'controls',
  'input',
  'audio',
  'net',
  'ecs',
  'fsm',
  'cinematic',
  'stats',
  'inspector',
  'tween',
  'splines',
  'points',
  'lines',
  'text',
  'labels',
  'physics',
];
let graphPromise;

function productionGraph() {
  // One real multi-entry consumer build also exposes accidental duplication between
  // the eager facade, whole-pack helpers and narrow lazy entry points.
  graphPromise ??= build({
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    build: {
      write: false,
      target: 'es2022',
      minify: true,
      modulePreload: false,
      rollupOptions: {
        input: {
          stage: resolve('tests/fixtures/modular-stage.js'),
          bare: resolve('tests/fixtures/stage-only.js'),
          features: resolve('tests/fixtures/modular-features.js'),
        },
      },
    },
  }).then((result) => {
    const outputs = Array.isArray(result) ? result : [result];
    const chunks = outputs.flatMap((output) => output.output).filter((item) => item.type === 'chunk');
    assert.ok(chunks.length > 1, 'Consumer was flattened; lazy chunk isolation was not exercised');
    const byFile = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
    const closure = (start) => {
      const visited = new Map();
      const visit = (chunk) => {
        if (visited.has(chunk.fileName)) return;
        visited.set(chunk.fileName, chunk);
        for (const name of chunk.imports) {
          const dependency = byFile.get(name);
          assert.ok(dependency, 'Unexpected external import in the production consumer: ' + name);
          visit(dependency);
        }
      };
      visit(start);
      return [...visited.values()];
    };
    const entry = (path) => {
      const found = chunks.filter(
        (chunk) => chunk.facadeModuleId && normalize(chunk.facadeModuleId) === normalize(path),
      );
      assert.equal(found.length, 1, 'Missing/duplicated consumer entry for ' + path);
      return found[0];
    };
    return { chunks, closure, entry };
  });
  return graphPromise;
}

const moduleIds = (chunks) => chunks.flatMap((chunk) => Object.keys(chunk.modules).map(normalize));
const payload = (chunks) => chunks.map((chunk) => chunk.code).join('\n');
const packageName = (id) => /\/packages\/([^/]+)\//.exec(id)?.[1];
const featurePath = (feature) =>
  fileURLToPath(import.meta.resolve('@margoengine/' + feature.pack + '/' + feature.entry));

test('initial core + stage consumer keeps every optional pack behind a lazy boundary', async () => {
  const graph = await productionGraph();
  const stage = graph.entry(resolve('tests/fixtures/modular-stage.js'));
  const initial = graph.closure(stage),
    modules = moduleIds(initial);
  assert.ok(
    modules.some((id) => packageName(id) === 'core'),
    'Real core code was not retained',
  );
  assert.ok(
    modules.some((id) => packageName(id) === 'stage'),
    'Real stage facade was not retained',
  );
  for (const pack of optionalPacks)
    assert.ok(
      modules.every((id) => packageName(id) !== pack),
      pack + ' entered the initial stage payload',
    );
  const code = payload(initial);
  for (const marker of Object.values(featureMarkers))
    assert.ok(!code.includes(marker), 'Optional feature code entered the initial stage payload: ' + marker);
  // Each stage feature entry imports the narrow entry of its package on call, never the whole pack.
  const dynamic = new Set(initial.flatMap((chunk) => chunk.dynamicImports));
  for (const specifier of [
    '@margoengine/gltf',
    '@margoengine/creative/particles',
    '@margoengine/creative/post',
    '@margoengine/scenery/sky',
    '@margoengine/shadows',
    '@margoengine/environment',
    '@margoengine/xr',
    '@margoengine/gltf-pro',
    '@margoengine/staging',
    '@margoengine/tonemap',
  ]) {
    const entry = graph.entry(fileURLToPath(import.meta.resolve(specifier)));
    assert.ok(dynamic.has(entry.fileName), 'A stage feature entry lost its lazy import for ' + specifier);
  }
});

// Regression (2026-10-27): the Stage class held ten import()s of six optional packages in its methods. Class methods
// are never tree-shaken, so every app that built a Stage (React's Canvas included) put them in its module graph, and
// webpack and Turbopack, which resolve every import() they reach, failed on each optional peer not installed.
test('an app importing only the stage root reaches no optional package, not even through a lazy import', async () => {
  const graph = await productionGraph();
  const initial = graph.closure(graph.entry(resolve('tests/fixtures/stage-only.js')));
  assert.deepEqual(
    initial.flatMap((chunk) => chunk.dynamicImports),
    [],
    'the stage root holds an import(): move it into a feature entry',
  );
  for (const id of moduleIds(initial))
    assert.ok(['core', 'stage', 'margoengine', 'shared'].includes(packageName(id)) || !packageName(id), id);
});

test('each granular feature consumer excludes unrelated shaders and domain features', async (t) => {
  const graph = await productionGraph();
  for (const feature of cases)
    await t.test(feature.pack + '/' + feature.entry, () => {
      const entry = graph.entry(featurePath(feature)),
        closure = graph.closure(entry);
      const modules = moduleIds(closure),
        code = payload(closure);
      assert.ok(entry.isDynamicEntry, feature.key + ' is no longer lazy');
      assert.ok(code.includes(featureMarkers[feature.key]), 'Feature implementation was omitted: ' + feature.key);
      for (const [key, marker] of Object.entries(featureMarkers)) {
        if (!feature.allowed.includes(key))
          assert.ok(!code.includes(marker), key + ' leaked into ' + feature.key + ' through shared/static chunks');
      }
      for (const pack of optionalPacks.filter((pack) => pack !== feature.pack && !feature.packs?.includes(pack))) {
        assert.ok(
          modules.every((id) => packageName(id) !== pack),
          pack + ' leaked into ' + feature.key,
        );
      }
      assert.ok(
        modules.every((id) => !id.endsWith('/packages/' + feature.pack + '/dist/index.js')),
        'Whole-pack root retained by narrow ' + feature.key + ' import',
      );
    });
});

test('eager facade and lazy features retain one canonical core module graph', async () => {
  const { chunks } = await productionGraph();
  const geometry = normalize(resolve('packages/core/dist/geometry.js'));
  assert.equal(
    chunks.filter((chunk) => Object.keys(chunk.modules).some((id) => normalize(id) === geometry)).length,
    1,
    'Geometry was duplicated across consumer chunks',
  );
  const coreModules = moduleIds(chunks).filter((id) => packageName(id) === 'core');
  assert.equal(
    new Set(coreModules).size,
    coreModules.length,
    'Core module identity was split between initial and optional chunks',
  );
  for (const feature of cases) {
    const path = normalize(featurePath(feature));
    assert.equal(
      chunks.filter((chunk) => Object.keys(chunk.modules).some((id) => normalize(id) === path)).length,
      1,
      'Feature module was duplicated: ' + feature.key,
    );
  }
});

test('actual root/subpath imports share identities and facade helpers preserve returned features', async () => {
  const [facade, core, creative, scenery, gltf] = await Promise.all([
    import('margoengine'),
    import('@margoengine/core'),
    import('@margoengine/creative'),
    import('@margoengine/scenery'),
    import('@margoengine/gltf'),
  ]);
  assert.equal(facade.Geometry, core.Geometry, 'Facade has a different Geometry constructor');
  assert.equal(facade.Engine, core.Engine, 'Facade has a different Engine factory');
  const roots = { creative, scenery };
  for (const feature of cases) {
    const narrow = await import('@margoengine/' + feature.pack + '/' + feature.entry);
    assert.deepEqual(
      Object.keys(narrow).sort(),
      [...feature.exports].sort(),
      'Unexpected narrow runtime exports: ' + feature.key,
    );
    for (const name of feature.exports) {
      assert.equal(
        typeof narrow[name],
        feature.exportTypes?.[name] ?? 'function',
        'Missing narrow export: ' + feature.key + '.' + name,
      );
      assert.notEqual(narrow[name], null, 'Null narrow export: ' + feature.key + '.' + name);
      assert.equal(
        narrow[name],
        roots[feature.pack][name],
        'Root/subpath identity changed: ' + feature.key + '.' + name,
      );
    }
  }
  void gltf;
  // The whole-pack accessors are gone: an app imports the package itself.
  for (const name of ['load', 'gltf', 'creative', 'scenery', 'sky', 'particles', 'effects', 'environment', 'shadows'])
    assert.equal(facade.Stage.prototype[name], undefined, 'Stage.' + name + ' is back on the class');
  const attached = [],
    receiver = new facade.Stage({
      use(plugin) {
        attached.push(plugin);
      },
    });
  // The real constructor initializes cancellation state; setup is the GPU boundary.
  attached.length = 0;
  // These real imports and constructors need no GPU until setup. They catch a
  // feature entry accidentally returning a module, losing options or attachment.
  const particleOptions = { count: 16, size: 0.04 },
    postOptions = { grain: 0.2 },
    skyOptions = { moonPhase: 0.5 };
  const particle = await addParticles(receiver, particleOptions);
  const post = await addEffects(receiver, postOptions);
  const sky = await addSky(receiver, skyOptions);
  assert.ok(particle instanceof creative.GPUParticles);
  assert.ok(post instanceof creative.PostProcessing);
  assert.ok(sky instanceof scenery.SkyMoon);
  assert.deepEqual([particle.count, particle.options.size], [16, 0.08]);
  assert.equal(post.options, postOptions);
  assert.equal(sky.config, skyOptions);
  assert.deepEqual(attached, [particle, post, sky], 'Facade no longer attaches each optional feature');
});

test('stage shadows and environment load the real packs: shadows attaches, environment rejects on a disposed engine', async () => {
  const [facade, { Shadows }] = await Promise.all([import('margoengine'), import('@margoengine/shadows')]);
  const attached = [],
    engine = {
      disposed: false,
      scene: { meshes: new Map() },
      use(plugin) {
        attached.push(plugin);
      },
    };
  const receiver = new facade.Stage(engine);
  attached.length = 0;
  const shadows = await addShadows(receiver, { resolution: 512 });
  assert.ok(shadows instanceof Shadows);
  assert.equal(shadows.options.resolution, 512);
  assert.deepEqual(attached, [shadows]);
  // The real EnvironmentLighting.load sees the disposed stage engine and attaches nothing (no fetch, no GPU).
  engine.disposed = true;
  await assert.rejects(addEnvironment(receiver, { width: 4, height: 2, data: new Float32Array(32) }), {
    name: 'AbortError',
  });
  assert.deepEqual(attached, [shadows]);
});
