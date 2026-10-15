import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'vite';

const normalize = path => path.replaceAll('\\', '/');
const featureMarkers = {
  particles: 'gpu-particles', targets: 'HDR target size exceeds limits', toon: 'toon-shading',
  post: 'post-processing', grass: 'grass:instances', planet: 'planet:surface',
  sky: 'sky-moon',
  cad: 'part-instancer', cadAsync: 'Invalid CAD input',
  kinematics: 'Invalid solver limits', surface: 'surface-physics',
  telemetry: 'telemetry-channel', section: 'section-planes', assembly: 'Invalid assembly tag',
  metrology: 'Invalid metrology vertex', spatial: 'BVH requires 1..1000000 triangles',
  clearance: 'Clearance requires geometry', materials: 'Unknown industrial material',
  overlays: 'engineering-annotations', exploded: 'exploded-view',
  // worldAnchor is a shared helper; retaining it must not pull in SVG annotations.
  worldAnchor: 'Invalid annotation anchor',
};
const cases = [
  // Wrappers load the one implementation they wrap: creative particles over vfx, scenery's SkyMoon over sky.
  {key: 'particles', pack: 'creative', entry: 'particles', exports: ['GPUParticles'], allowed: ['particles'], packs: ['vfx']},
  {key: 'targets', pack: 'creative', entry: 'targets', exports: ['HDRRenderTarget'], allowed: ['targets']},
  {key: 'toon', pack: 'creative', entry: 'toon', exports: ['ToonShading'], allowed: ['toon']},
  {key: 'post', pack: 'creative', entry: 'post', exports: ['PostProcessing'], allowed: ['post', 'targets']},
  {key: 'grass', pack: 'creative', entry: 'grass', exports: ['GrassField'], allowed: ['grass']},
  {key: 'planet', pack: 'creative', entry: 'planet', exports: ['Planet'], allowed: ['planet']},
  {key: 'sky', pack: 'scenery', entry: 'sky', exports: ['SkyMoon'], allowed: ['sky'], packs: ['sky']},
  {key: 'cad', pack: 'machinery', entry: 'cad', exports: ['parseCAD', 'loadCAD', 'deduplicateParts', 'PartInstancer'], allowed: ['cad', 'cadAsync']},
  {key: 'cadAsync', pack: 'machinery', entry: 'cad-async', exports: ['parseCADAsync'], allowed: ['cadAsync']},
  {key: 'kinematics', pack: 'machinery', entry: 'kinematics', exports: ['Kinematics'], allowed: ['kinematics']},
  {key: 'surface', pack: 'machinery', entry: 'surface', exports: ['SurfacePhysics'], allowed: ['surface']},
  {key: 'telemetry', pack: 'machinery', entry: 'telemetry', exports: ['TelemetryChannel'], allowed: ['telemetry', 'kinematics']},
  {key: 'section', pack: 'machinery', entry: 'section', exports: ['SectionPlanes', 'boxSection'], allowed: ['section']},
  {key: 'assembly', pack: 'machinery', entry: 'assembly', exports: ['AssemblyIndex'], allowed: ['assembly']},
  {key: 'metrology', pack: 'machinery', entry: 'metrology', exports: ['vertexAnchor', 'edgeAnchor', 'faceAnchor', 'holeAnchor', 'snapAnchor', 'snapFeature', 'measureDistance'], allowed: ['metrology', 'worldAnchor']},
  {key: 'spatial', pack: 'machinery', entry: 'spatial', exports: ['AssemblyBVH'], allowed: ['spatial', 'metrology', 'worldAnchor']},
  {key: 'clearance', pack: 'machinery', entry: 'clearance', exports: ['measureClearance'], allowed: ['clearance']},
  {key: 'materials', pack: 'machinery', entry: 'materials', exports: ['industrialMaterials', 'industrialMaterial'], exportTypes: {industrialMaterials: 'object'}, allowed: ['materials']},
  {key: 'overlays', pack: 'machinery', entry: 'overlays', exports: ['EngineeringAnnotations', 'worldAnchor', 'projectAnnotation'], allowed: ['overlays', 'worldAnchor']},
  {key: 'exploded', pack: 'machinery', entry: 'exploded', exports: ['ExplodedView'], allowed: ['exploded']},
];
const optionalPacks = [
  'creative', 'scenery', 'sky', 'machinery', 'gltf', 'gltf-pro', 'blender', 'animation',
  'post', 'shadows', 'clustered', 'vfx', 'animator', 'taa', 'splats', 'terrain', 'loaders', 'exporters',
  'react', 'controls', 'input', 'audio', 'net', 'ecs', 'fsm', 'cinematic', 'stats', 'inspector',
  'gizmo', 'tween', 'splines', 'points', 'lines', 'text', 'labels', 'physics',
];
let graphPromise;

function productionGraph() {
  // One real multi-entry consumer build also exposes accidental duplication between
  // the eager facade, whole-pack helpers and narrow lazy entry points.
  graphPromise ??= build({
    configFile: false, publicDir: false, logLevel: 'silent',
    build: {
      write: false, target: 'es2022', minify: true, modulePreload: false,
      rollupOptions: {input: {
        stage: resolve('tests/fixtures/modular-stage.js'),
        features: resolve('tests/fixtures/modular-features.js'),
      }},
    },
  }).then(result => {
    const outputs = Array.isArray(result) ? result : [result];
    const chunks = outputs.flatMap(output => output.output).filter(item => item.type === 'chunk');
    assert.ok(chunks.length > 1, 'Consumer was flattened; lazy chunk isolation was not exercised');
    const byFile = new Map(chunks.map(chunk => [chunk.fileName, chunk]));
    const closure = start => {
      const visited = new Map();
      const visit = chunk => {
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
    const entry = path => {
      const found = chunks.filter(chunk => chunk.facadeModuleId && normalize(chunk.facadeModuleId) === normalize(path));
      assert.equal(found.length, 1, 'Missing/duplicated consumer entry for ' + path);
      return found[0];
    };
    return {chunks, closure, entry};
  });
  return graphPromise;
}

const moduleIds = chunks => chunks.flatMap(chunk => Object.keys(chunk.modules).map(normalize));
const payload = chunks => chunks.map(chunk => chunk.code).join('\n');
const packageName = id => /\/packages\/([^/]+)\//.exec(id)?.[1];
const featurePath = feature => fileURLToPath(import.meta.resolve('@margoengine/' + feature.pack + '/' + feature.entry));

test('initial core + stage consumer keeps every optional pack behind a lazy boundary', async () => {
  const graph = await productionGraph();
  const stage = graph.entry(resolve('tests/fixtures/modular-stage.js'));
  const initial = graph.closure(stage), modules = moduleIds(initial);
  assert.ok(modules.some(id => packageName(id) === 'core'), 'Real core code was not retained');
  assert.ok(modules.some(id => packageName(id) === 'margoengine'), 'Real stage facade was not retained');
  for (const pack of optionalPacks) assert.ok(modules.every(id => packageName(id) !== pack), pack + ' entered the initial stage payload');
  const code = payload(initial);
  for (const marker of Object.values(featureMarkers)) assert.ok(!code.includes(marker), 'Optional feature code entered the initial stage payload: ' + marker);
  // The facade's existing whole-pack escape hatches must still coexist with its
  // newly narrow helpers; checking only the fixture's imports would miss this.
  const dynamic = new Set(initial.flatMap(chunk => chunk.dynamicImports));
  for (const specifier of [
    '@margoengine/creative', '@margoengine/scenery', '@margoengine/machinery', '@margoengine/gltf',
    '@margoengine/creative/particles', '@margoengine/creative/post',
    '@margoengine/scenery/sky', '@margoengine/machinery/cad',
  ]) {
    const entry = graph.entry(fileURLToPath(import.meta.resolve(specifier)));
    assert.ok(dynamic.has(entry.fileName), 'Facade lost its actual lazy import for ' + specifier);
  }
});

test('each granular feature consumer excludes unrelated shaders and domain features', async t => {
  const graph = await productionGraph();
  for (const feature of cases) await t.test(feature.pack + '/' + feature.entry, () => {
    const entry = graph.entry(featurePath(feature)), closure = graph.closure(entry);
    const modules = moduleIds(closure), code = payload(closure);
    assert.ok(entry.isDynamicEntry, feature.key + ' is no longer lazy');
    assert.ok(code.includes(featureMarkers[feature.key]), 'Feature implementation was omitted: ' + feature.key);
    for (const [key, marker] of Object.entries(featureMarkers)) {
      if (!feature.allowed.includes(key)) assert.ok(!code.includes(marker), key + ' leaked into ' + feature.key + ' through shared/static chunks');
    }
    for (const pack of optionalPacks.filter(pack => pack !== feature.pack && !feature.packs?.includes(pack))) {
      assert.ok(modules.every(id => packageName(id) !== pack), pack + ' leaked into ' + feature.key);
    }
    assert.ok(modules.every(id => !id.endsWith('/packages/' + feature.pack + '/dist/index.js')), 'Whole-pack root retained by narrow ' + feature.key + ' import');
  });
});

test('eager facade and lazy features retain one canonical core module graph', async () => {
  const {chunks} = await productionGraph();
  const geometry = normalize(resolve('packages/core/dist/geometry.js'));
  assert.equal(chunks.filter(chunk => Object.keys(chunk.modules).some(id => normalize(id) === geometry)).length, 1, 'Geometry was duplicated across consumer chunks');
  const coreModules = moduleIds(chunks).filter(id => packageName(id) === 'core');
  assert.equal(new Set(coreModules).size, coreModules.length, 'Core module identity was split between initial and optional chunks');
  for (const feature of cases) {
    const path = normalize(featurePath(feature));
    assert.equal(chunks.filter(chunk => Object.keys(chunk.modules).some(id => normalize(id) === path)).length, 1, 'Feature module was duplicated: ' + feature.key);
  }
});

test('actual root/subpath imports share identities and facade helpers preserve returned features', async () => {
  const [facade, core, creative, scenery, machinery, gltf] = await Promise.all([
    import('margoengine'), import('@margoengine/core'), import('@margoengine/creative'),
    import('@margoengine/scenery'), import('@margoengine/machinery'), import('@margoengine/gltf'),
  ]);
  assert.equal(facade.Geometry, core.Geometry, 'Facade has a different Geometry constructor');
  assert.equal(facade.Engine, core.Engine, 'Facade has a different Engine factory');
  const roots = {creative, scenery, machinery};
  for (const feature of cases) {
    const narrow = await import('@margoengine/' + feature.pack + '/' + feature.entry);
    assert.deepEqual(Object.keys(narrow).sort(), [...feature.exports].sort(), 'Unexpected narrow runtime exports: ' + feature.key);
    for (const name of feature.exports) {
      assert.equal(typeof narrow[name], feature.exportTypes?.[name] ?? 'function', 'Missing narrow export: ' + feature.key + '.' + name);
      assert.notEqual(narrow[name], null, 'Null narrow export: ' + feature.key + '.' + name);
      assert.equal(narrow[name], roots[feature.pack][name], 'Root/subpath identity changed: ' + feature.key + '.' + name);
    }
  }
  const prototype = facade.Stage.prototype;
  const attached = [], receiver = new facade.Stage({use(plugin) {attached.push(plugin);}});
  // The real constructor initializes cancellation state; setup is the GPU boundary.
  attached.length = 0;
  for (const [helper, namespace] of Object.entries({creative, scenery, machinery, gltf})) {
    assert.equal(await prototype[helper].call(receiver), namespace, 'Whole-pack helper changed: ' + helper);
  }
  // These real imports and constructors need no GPU until setup. They catch a
  // facade helper accidentally returning a module, losing options or attachment.
  const particleOptions = {count: 16, size: 0.04}, postOptions = {grain: 0.2}, skyOptions = {moonPhase: 0.5};
  const particle = await prototype.particles.call(receiver, particleOptions);
  const post = await prototype.effects.call(receiver, postOptions);
  const sky = await prototype.sky.call(receiver, skyOptions);
  assert.ok(particle instanceof creative.GPUParticles);
  assert.ok(post instanceof creative.PostProcessing);
  assert.ok(sky instanceof scenery.SkyMoon);
  assert.deepEqual([particle.count, particle.options.size], [16, 0.08]);
  assert.equal(post.options, postOptions);
  assert.equal(sky.config, skyOptions);
  assert.deepEqual(attached, [particle, post, sky], 'Facade no longer attaches each optional feature');
});
