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
