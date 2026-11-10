import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Stage } from '@margoengine/stage';
import { addGLTF } from '@margoengine/stage/gltf';
import { loadedPBREngine } from '../../../tests/support/loaded-pbr-fixtures.js';

// Image uploads use a CPU device stand-in here; real image decoding and pixels run in test/gpu/gltf-check.mjs.
globalThis.createImageBitmap = async () => ({ width: 16, height: 16, close() {} });
for (const name of ['RiggedFigure', 'MorphStressTest']) {
  test(`the one-call path preserves ${name} deformation and clips`, async () => {
    const bytes = await readFile(new URL(`../../../examples/assets/khronos/${name}/${name}.glb`, import.meta.url)),
      previous = globalThis.fetch,
      stage = new Stage(await loadedPBREngine());
    stage.engine.gpu.queue.copyExternalImageToTexture = () => {};
    globalThis.fetch = async () => new Response(bytes);
    try {
      const model = await addGLTF(stage, `https://test.invalid/${name}.glb`);
      assert.ok(model.pbr);
      assert.ok(model.animation.clips.length > 0);
      assert.equal(model.animation.playing, false);
      model.animation.play(0);
      assert.equal(model.animation.playing, true);
      assert.ok(model.meshes.length > 0);
      if (name === 'RiggedFigure') assert.ok(model.pbr.asset.doc.skins.length > 0);
      else {
        const primitive = model.pbr.primitives.find((p) => p.weights.length);
        assert.ok(primitive);
        model.animation.setMorph(primitive.nodeIndex, 0, 0.75);
        assert.equal(primitive.weights[0], 0.75);
      }
      model.animation.seek(0.1);
      const player = model.animation;
      model.destroy();
      assert.equal(player.disposed, true);
      assert.equal(stage.engine.scene.meshes.size, 0);
    } finally {
      globalThis.fetch = previous;
      stage.dispose();
    }
  });
}

test('a failed fit rolls back the skinned model, deformation and all nodes', async () => {
  const bytes = await readFile(
      new URL('../../../examples/assets/khronos/RiggedFigure/RiggedFigure.glb', import.meta.url),
    ),
    previous = globalThis.fetch,
    stage = new Stage(await loadedPBREngine());
  globalThis.fetch = async () => new Response(bytes);
  stage.fit = () => {
    throw new Error('fit failed');
  };
  try {
    await assert.rejects(addGLTF(stage, 'https://test.invalid/rig.glb'), /fit failed/);
    assert.equal(stage.engine.scene.meshes.size, 0);
    assert.deepEqual([...stage.engine.plugins.keys()], ['margoengine-imports']);
  } finally {
    globalThis.fetch = previous;
    stage.dispose();
  }
});
