import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { FrontToBack } from '../dist/sort.js';
import { WebGL2Culling } from '../dist/webgl2.js';

// Both owners draw nothing themselves and are useful only with a WebGPU-shaped device: the small preview must get a
// coded refusal at setup (so autoEngine can escalate) instead of a pass that silently skips every frame.
test('front-to-back sorting and software culling refuse the small WebGL2 preview during setup', async () => {
  const engine = new Engine({ width: 8, height: 8 }, await TransformStore.create(8), {
    backend: 'webgl2',
    add() {},
    remove() {},
    render() {},
    dispose() {},
  });
  try {
    for (const [plugin, name] of [
      [new FrontToBack(), 'FrontToBack'],
      [new WebGL2Culling(), 'WebGL2Culling'],
    ]) {
      assert.throws(
        () => engine.use(plugin),
        (error) =>
          error.code === 'unsupported' &&
          error.message.startsWith(`${name} needs WebGPU`) &&
          error.message.includes('https://margoengine.com/errors#webgpu'),
        name,
      );
      assert.equal(engine.plugins.size, 0, name);
    }
  } finally {
    engine.dispose();
  }
});
