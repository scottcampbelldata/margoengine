import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkBuilt,
  checkFetched,
  sceneGraph,
  staticFiles,
  unrelatedFiles,
} from '../scripts/support/basic-scene-graph.mjs';

// The basic scene's build as margoengine/stage/gltf routes it (8f4f4db72): the entry imports the basic loader, gltf/pbr
// and animation dynamically; gltf/pbr's codecs are dynamic imports of their own with Wasm and worker assets.
const basic = '../../../packages/gltf/dist/index.js',
  pro = '../../../packages/gltf/dist/pbr.js',
  animation = '../../../packages/animation/dist/index.js';
const routed = () => ({
  'index.html': { file: 'app.js', imports: ['shared'], dynamicImports: [basic, pro, animation] },
  shared: { file: 'shared.js', imports: ['cycle'] },
  cycle: { file: 'cycle.js', imports: ['shared'] },
  [basic]: { file: 'gltf.js', imports: ['shared', 'parse'] },
  parse: { file: 'parse.js' },
  [pro]: { file: 'pbr.js', imports: ['shared'], dynamicImports: ['codec'] },
  codec: { file: 'codec.js', assets: ['codec.wasm', 'codec.worker.js'] },
  [animation]: { file: 'anim.js', imports: ['shared'] },
  unrelated: { file: 'other.js', assets: ['unrelated.worker.js'] },
});
const requests = ['index.html', 'app.js', 'shared.js', 'cycle.js', 'gltf.js', 'parse.js', 'model.glb'];

test('a basic scene fetches the routed @margoengine/gltf graph; gltf/pbr, animation and codecs stay deferred', () => {
  const graph = sceneGraph(routed());
  assert.equal(graph.loader, basic);
  assert.deepEqual(graph.entry, ['app.js', 'shared.js', 'cycle.js']);
  assert.deepEqual(graph.gltf, ['gltf.js', 'shared.js', 'cycle.js', 'parse.js']);
  assert.deepEqual([...graph.deferredChunks].sort(), ['anim.js', 'pbr.js']);
  assert.deepEqual([...graph.deferredAssets].sort(), ['codec.wasm', 'codec.worker.js']);
  assert.deepEqual([...graph.emittedFiles].sort(), [
    'anim.js',
    'app.js',
    'codec.js',
    'codec.wasm',
    'codec.worker.js',
    'cycle.js',
    'gltf.js',
    'parse.js',
    'pbr.js',
    'shared.js',
  ]);
});

test('the network check passes only the exact basic requests and names a fetched gltf/pbr or animation loader', () => {
  const graph = sceneGraph(routed()),
    expected = new Set(requests);
  checkFetched(requests, expected, graph);
  assert.throws(() => checkFetched([...requests, 'pbr.js'], expected, graph), /fetched a deferred glTF feature loader/);
  assert.throws(
    () => checkFetched([...requests, 'anim.js'], expected, graph),
    /fetched a deferred glTF feature loader/,
  );
  assert.throws(() => checkFetched([...requests, 'codec.js'], expected, graph), /exactly the HTML/);
  assert.throws(
    () =>
      checkFetched(
        requests.filter((p) => p !== 'gltf.js'),
        expected,
        graph,
      ),
    /exactly the HTML/,
  );
  assert.throws(() => checkFetched([...requests, 'model.glb'], expected, graph), /each file once/);
});

test('the build check passes the named loader graphs and fails on any other emitted file', () => {
  const graph = sceneGraph(routed()),
    expected = new Set(requests),
    built = [...new Set([...requests, ...graph.emittedFiles])];
  checkBuilt(built, expected, graph);
  assert.throws(() => checkBuilt([...built, 'other.js'], expected, graph), /selected glTF feature graph/);
  assert.throws(() => checkBuilt([...built, 'unrelated.worker.js'], expected, graph), /selected glTF feature graph/);
  assert.throws(() => checkBuilt([...built, 'assets/dist-stray.js'], expected, graph), /selected glTF feature graph/);
});

test('a missing basic loader, a missing dependency or a statically imported feature loader is a record failure', () => {
  assert.throws(
    () => sceneGraph({ 'index.html': { file: 'app.js', dynamicImports: [pro] }, [pro]: { file: 'pbr.js' } }),
    /routed basic/,
  );
  assert.throws(() => staticFiles({ app: { file: 'app.js', imports: ['missing'] } }, 'app'), /dependency missing/);
  assert.throws(
    () => sceneGraph({ 'index.html': { file: 'app.js' }, [basic]: { file: 'gltf.js', dynamicImports: ['missing'] } }),
    /dependency missing/,
  );
  const eager = routed();
  eager['index.html'].imports.push(pro);
  assert.throws(() => sceneGraph(eager), /pbr\.js, a deferred glTF feature loader, is a static import/);
});

test('an optional pack or a stray worker is read from the manifest source, never from a hashed emitted name', () => {
  // Regression (2026-11-27): Vite's hash of gltf's model chunk was CN0rSkyN, and the emitted-name test read it as sky.
  const model = '../../../packages/gltf/dist/model-B16_Idts.js',
    manifest = {
      ...routed(),
      [model]: { file: 'assets/model-B16_Idts-CN0rSkyN.js', src: model },
      '_accessor-Skyy1234-Post5678.js': { file: 'assets/accessor-Skyy1234-Post5678.js', name: 'accessor-Skyy1234' },
    },
    graph = sceneGraph(manifest),
    built = [
      'index.html',
      'model.glb',
      'app.js',
      'codec.wasm',
      'codec.worker.js',
      'assets/model-B16_Idts-CN0rSkyN.js',
      'assets/accessor-Skyy1234-Post5678.js',
    ];
  assert.deepEqual(unrelatedFiles(manifest, built, graph), []);
  const sky = '../../../packages/sky/dist/index.js',
    stage = '../../../packages/stage/dist/shadows.js',
    packs = {
      ...manifest,
      [sky]: { file: 'assets/dist-AbCdEfGh.js', src: sky },
      [stage]: { file: 'assets/shadows-AbCdEfGh.js', src: stage },
    };
  assert.deepEqual(
    unrelatedFiles(
      packs,
      [
        ...built,
        'assets/dist-AbCdEfGh.js',
        'assets/shadows-AbCdEfGh.js',
        'unrelated.worker.js',
        'assets/stray-AbCdEfGh.wasm',
      ],
      sceneGraph(packs),
    ),
    ['assets/dist-AbCdEfGh.js', 'assets/shadows-AbCdEfGh.js', 'unrelated.worker.js', 'assets/stray-AbCdEfGh.wasm'],
  );
});
