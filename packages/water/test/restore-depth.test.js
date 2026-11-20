import test from 'node:test';
import assert from 'node:assert/strict';
import { Water } from '../dist/index.js';
import { nodeLifetimeAdapter } from '../../../tests/support/owner-lifetime-node.js';

// Found by the owner/lifetime fixture: on a device restore Water let go of the shared scene-depth capture and took a
// new one, so the scene's capture plugin was removed and replaced by another object in the middle of the restore.
test('a device restore keeps the shared scene-depth capture registered as it was', async () => {
  const adapter = await nodeLifetimeAdapter();
  try {
    const host = await adapter.create(), { engine } = host;
    const water = new Water({ size: [16, 16], segments: 4 });
    engine.use(water);
    const views = [{ camera: engine.camera, viewport: [0, 0, 64, 32], pixels: true }];
    await host.render(views);
    const capture = engine.plugins.get('optional:scene-depth');
    assert.ok(capture, 'Water uses the shared scene-depth capture');
    const removed = [], remove = engine.removePlugin.bind(engine);
    engine.removePlugin = (name, ...rest) => { removed.push(name); return remove(name, ...rest); };
    await host.lose({ lost() {}, watchDevice() {} });
    await host.render(views);
    assert.deepEqual(removed.filter((name) => name !== 'owner-lifetime:restore'), [], 'no plugin leaves on restore');
    assert.equal(engine.plugins.get('optional:scene-depth'), capture, 'the same capture stays registered');
    assert.equal(engine.sceneOf(water), engine.scene);
    water.dispose();
    assert.equal(engine.plugins.get('optional:scene-depth'), undefined, 'the last user releases the capture');
    engine.dispose();
  } finally {
    adapter.close();
  }
});
