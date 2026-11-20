import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore, box } from '../../core/dist/extension.js';
import { LODSystem, Imposter } from '../dist/index.js';
import { LODFade } from '../dist/fade.js';

test('preview keeps CPU geometry LOD and refuses imposters before changing levels or visibility', async () => {
  const engine = new Engine(
    { width: 64, height: 64 },
    await TransformStore.create(64),
    {
      backend: 'webgl2',
      add() {},
      remove() {},
      render() {},
      dispose() {},
    },
    { position: [0, 0, 4], target: [0, 0, 0] },
  );
  try {
    const system = LODSystem.attach(engine),
      anchor = engine.createMesh().setGeometry(box());
    const lod = system.add(anchor, [{ object: box() }]);
    system.update();
    assert.equal(lod.level, 0);
    const geometry = anchor.geometry,
      count = system.size;
    assert.throws(
      () => system.add(anchor, [{ object: box() }, { object: Object.create(Imposter.prototype), distance: 10 }]),
      (error) => error.code === 'unsupported' && error.message.includes('https://margoengine.com/errors#webgpu'),
    );
    assert.equal(system.size, count);
    assert.equal(anchor.geometry, geometry);
    assert.equal(anchor.visible, true);
    assert.throws(
      () => LODFade.attach(engine, system),
      (error) => error.code === 'unsupported',
    );
    assert.equal(engine.hasPlugin('lod-fade:' + system.name), false);
  } finally {
    engine.dispose();
  }
});

// KB-LOD-SCREENLAG1 rebuilt the camera's projection in the pick, with the backend's depth range: in the WebGL2 preview it
// is the -1..1 clip range core draws with, and a cut picks the level for the view it draws (scripts/check-preview-
// contract.mjs counts this second backend test against this route).
test('preview screen levels rebuild the WebGL2 projection and follow a cut on its frame', async () => {
  const engine = new Engine(
    { width: 400, height: 200, clientWidth: 400, clientHeight: 200 },
    await TransformStore.create(16),
    { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 200], target: [0, 0, 0], far: 5000 },
  );
  try {
    const system = LODSystem.attach(engine, { hysteresis: 0 }),
      lod = system.add(engine.createMesh(), [
        { object: box(2, 2, 2) },
        { object: null, screen: 0.5 },
        { object: null, screen: 0.05 },
      ]);
    system.update();
    assert.equal(lod.level, 2, 'far away: the coarsest level');
    engine.camera.position = [0, 0, 3];
    system.update();
    assert.equal(lod.level, 0, 'the pick right after the cut uses the new view');
    const picked = Array.from(engine.camera.matrix);
    engine.camera.update(2, false);
    assert.deepEqual(picked, Array.from(engine.camera.matrix), 'the WebGL2 clip range, as core draws the preview');
  } finally {
    engine.dispose();
  }
});
