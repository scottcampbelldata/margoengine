import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { TransmissionLayers } from '../dist/transmission-layers.js';
import { acquireNativeGlass } from '../src/native-glass.js';

// Both owners read a captured WebGPU scene texture; the small preview has no device. They must refuse at setup with a
// coded error (so autoEngine can escalate) instead of registering passes that skip every frame.
test('transmission layers and the native glass capture refuse the small WebGL2 preview during setup', async () => {
  const engine = new Engine({ width: 8, height: 8 }, await TransformStore.create(8), {
    backend: 'webgl2',
    add() {},
    remove() {},
    render() {},
    dispose() {},
  });
  const refused = (name) => (error) =>
    error.code === 'unsupported' &&
    error.message.startsWith(`${name} needs WebGPU`) &&
    error.message.includes('https://margoengine.com/errors#webgpu');
  try {
    assert.throws(() => engine.use(new TransmissionLayers()), refused('TransmissionLayers'));
    assert.equal(engine.plugins.size, 0);
    assert.throws(() => acquireNativeGlass(engine, () => true), refused('Native glass capture'));
    assert.equal(engine.plugins.size, 0);
    // Nothing was cached for the graph: a second request refuses the same way instead of reusing a dead capture.
    assert.throws(() => acquireNativeGlass(engine, () => true), refused('Native glass capture'));
  } finally {
    engine.dispose();
  }
});
