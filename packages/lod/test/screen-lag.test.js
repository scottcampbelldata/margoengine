import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore, box } from '../../core/dist/extension.js';
import { LODSystem } from '../dist/index.js';

// KB-LOD-SCREENLAG1: plugins pick levels in onPreUpdate, before core updates the camera, so `screen` levels read the
// clip matrix of the frame before. A cut from far to near drew one frame with the far level.

async function engine() {
  const store = await TransformStore.create(16),
    renderer = { backend: 'webgpu', gpu: null, add() {}, remove() {}, render() {}, dispose() {} };
  return new Engine(
    { width: 400, height: 200, clientWidth: 400, clientHeight: 200 },
    store,
    renderer,
    { position: [0, 0, 200], target: [0, 0, 0], far: 5000 },
    null,
  );
}

test('screen levels follow a camera cut on the frame of the cut', async () => {
  const e = await engine(),
    lods = new LODSystem({ hysteresis: 0 });
  e.use(lods);
  const anchor = e.createMesh(),
    lod = lods.add(anchor, [{ object: box(2, 2, 2) }, { object: null, screen: 0.5 }, { object: null, screen: 0.05 }]);
  e.render({ culling: false });
  e.render({ culling: false });
  assert.equal(lod.level, 2, 'far away: the coarsest level');
  // Cut: near the anchor, then one frame.
  e.camera.position = [0, 0, 3];
  e.render({ culling: false });
  assert.equal(lod.level, 0, 'the first frame after the cut shows the level for the new view');
  // And back out.
  e.camera.position = [0, 0, 200];
  e.render({ culling: false });
  assert.equal(lod.level, 2, 'the first frame after the cut back shows the coarse level');
  // A field of view change alone (a zoom cut) also counts on its frame.
  e.camera.position = [0, 0, 20];
  e.render({ culling: false });
  const wide = lod.level;
  e.camera.fov = 5;
  e.render({ culling: false });
  assert.ok(lod.level < wide, `a narrow lens shows a finer level on its own frame (${wide} to ${lod.level})`);
  e.dispose();
});
