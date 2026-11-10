import test from 'node:test';
import assert from 'node:assert/strict';
import { sceneGraph, staticFiles } from '../scripts/support/basic-scene-graph.mjs';

test('the selected PBR graph pins required requests and leaves codec assets deferred', () => {
  const key = '../../../packages/gltf-pro/dist/index.js';
  const manifest = {
    'index.html': { file: 'app.js', imports: ['shared'], dynamicImports: [key] },
    shared: { file: 'shared.js', imports: ['cycle'] },
    cycle: { file: 'cycle.js', imports: ['shared'] },
    [key]: { file: 'pbr.js', imports: ['shared'], dynamicImports: ['codec'] },
    codec: { file: 'codec.js', assets: ['codec.wasm', 'codec.worker.js'] },
    unrelated: { file: 'other.js', assets: ['unrelated.worker.js'] },
  };
  const graph = sceneGraph(manifest);
  assert.deepEqual(graph.entry, ['app.js', 'shared.js', 'cycle.js']);
  assert.deepEqual(graph.gltf, ['pbr.js', 'shared.js', 'cycle.js']);
  assert.deepEqual([...graph.deferredAssets], ['codec.wasm', 'codec.worker.js']);
  assert.ok(!graph.entry.includes('codec.js') && !graph.gltf.includes('codec.js'));
  assert.ok(!graph.deferredAssets.has('unrelated.worker.js'));
  assert.ok(graph.emittedFiles.has('codec.js'));
  assert.ok(!graph.emittedFiles.has('other.js') && !graph.emittedFiles.has('unrelated.worker.js'));
});

test('missing loader or static/dynamic dependency is a visible record failure', () => {
  assert.throws(() => sceneGraph({ 'index.html': { file: 'app.js' } }), /selected.*gltf-pro/);
  assert.throws(() => staticFiles({ app: { file: 'app.js', imports: ['missing'] } }, 'app'), /dependency missing/);
  assert.throws(
    () =>
      sceneGraph({
        'index.html': { file: 'app.js' },
        'packages/gltf-pro/dist/index.js': { file: 'pbr.js', dynamicImports: ['missing'] },
      }),
    /dependency missing/,
  );
});
