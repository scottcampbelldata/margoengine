// @margoengine/water/foam-surface without a GPU: the options SeaFoamSurface refuses and the order of its setup checks.
// The pictures are checked by sea-foam-surface.browser.mjs on WebGPU and the WebGL2 compatibility layer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SeaFoamSurface } from '@margoengine/water/foam-surface';

const surface = { name: 'sea', onDispose: () => () => {} };
const source = { cells: [4, 4], origin: [0, 0], spacing: 1, copyCoverage: (out) => out.fill(0) };

test('SeaFoamSurface refuses a missing Water surface or grid with a coded error', () => {
  for (const options of [undefined, {}, { surface }, { source }, { surface: { name: 'sea' }, source }])
    assert.throws(
      () => new SeaFoamSurface(options),
      (error) => error.code === 'state' && /Pass both/.test(error.message),
    );
});

test('SeaFoamSurface takes its name from the Water surface it lights', () => {
  assert.equal(new SeaFoamSurface({ surface, source }).name, 'sea:sea-foam-surface');
});

test('setup on an engine without that Water throws and leaves the surface free for a later foam surface', () => {
  const engine = { gpu: {}, hasPlugin: () => false };
  const first = new SeaFoamSurface({ surface, source });
  assert.throws(
    () => first.setup(engine),
    (error) => error.code === 'state' && /Attach Water before/.test(error.message),
  );
  // The refused setup did not mark the Water as taken: a second foam surface reaches the same check, not 'attached'.
  assert.throws(
    () => new SeaFoamSurface({ surface, source }).setup(engine),
    (error) => error.code === 'state',
  );
});

test('a disposed SeaFoamSurface refuses setup', () => {
  const foam = new SeaFoamSurface({ surface, source });
  foam.dispose();
  assert.throws(
    () => foam.setup({ gpu: {}, hasPlugin: () => true }),
    (error) => error.code === 'disposed',
  );
});
