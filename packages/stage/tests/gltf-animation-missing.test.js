import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleHooks } from '../../../scripts/support/node-compat.mjs';
import { readFile } from 'node:fs/promises';
import { Stage } from '@margoengine/stage';
import { loadedPBREngine } from '../../../tests/support/loaded-pbr-fixtures.js';

await moduleHooks([
  {
    specifier: '@margoengine/animation',
    error: "Cannot find package '@margoengine/animation'",
    code: 'ERR_MODULE_NOT_FOUND',
  },
]);
const { addGLTF } = await import('@margoengine/stage/gltf');
test('a skinned file requires animation with a feature-specific coded error and leaves no nodes', async () => {
  const bytes = await readFile(
    new URL('../../../examples/assets/khronos/RiggedFigure/RiggedFigure.glb', import.meta.url),
  );
  const previous = globalThis.fetch,
    stage = new Stage(await loadedPBREngine());
  globalThis.fetch = async () => new Response(bytes);
  try {
    await assert.rejects(addGLTF(stage, 'https://test.invalid/rig.glb'), {
      name: 'MargoError',
      code: 'state',
      message: /(?:skins|animation clips).*@margoengine\/animation/,
    });
    assert.equal(stage.engine.scene.meshes.size, 0);
  } finally {
    globalThis.fetch = previous;
    stage.dispose();
  }
});
