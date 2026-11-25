// One scene/container saved alone and restored. Here, not in scene's tests: save already builds after scene.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Engine, TransformStore, box } from '@margoengine/core/extension';
import { children, parent } from '../../scene/dist/index.js';
import { AssetContainer } from '../../scene/dist/container.js';
import { captureScene, restoreScene } from '../dist/engine.js';

const make = async () =>
  new Engine({ width: 16, height: 16, clientWidth: 16, clientHeight: 16 }, await TransformStore.create(16), {
    backend: 'webgl2',
    add() {},
    remove() {},
    render() {},
    dispose() {},
  });

test('a container saves alone with captureScene and comes back with restoreScene', async () => {
  using engine = await make();
  const geometry = box(),
    tent = engine.createMesh().setGeometry(geometry).setPosition([2, 0, 0]),
    flap = engine.createMesh(tent).setGeometry(geometry),
    ground = engine.createMesh().setGeometry(geometry),
    camp = new AssetContainer(engine).add(tent);
  tent.name = 'tent';
  flap.name = 'flap';
  const save = captureScene(engine, { filter: (mesh) => camp.contains(mesh) });
  assert.deepEqual(save.entities.map((entity) => entity.id), ['tent', 'flap']);
  camp.dispose();
  const { meshes } = await restoreScene(engine, JSON.parse(JSON.stringify(save)), { clear: false, camera: false });
  const again = new AssetContainer(engine).add(...[...meshes.values()].filter((mesh) => !parent(mesh)));
  assert.deepEqual(again.meshes.map((mesh) => mesh.name), ['tent']);
  assert.deepEqual([again.meshes[0].position.x, children(again.meshes[0])[0].name], [2, 'flap']);
  ground.check();
  again.removeAllFromScene();
  engine.render({ delta: 0 });
  assert.equal(engine.stats.visible, 1);
});
