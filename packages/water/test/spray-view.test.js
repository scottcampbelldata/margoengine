import test from 'node:test';
import assert from 'node:assert/strict';
import { Water } from '../dist/index.js';
import { exerciseLifetime } from '../../../tests/support/owner-lifetime.js';
import { nodeLifetimeAdapter } from '../../../tests/support/owner-lifetime-node.js';

// Found by the owner/lifetime fixture: the spray drops began their own render pass and drew without the view's
// viewport and scissor, so with two views side by side each view's drops covered the whole canvas.
test('spray draws inside the drawn view rectangle and scissor', async () => {
  const adapter = await nodeLifetimeAdapter();
  try {
    const result = await exerciseLifetime({ name: 'spray', create({ engine, dependency }) {
      const terrain = dependency(() => engine.gpu.createTexture({ size: [16, 16], format: 'r32float', usage: 4 | 2 }));
      const plugin = new Water({ size: [16, 16], segments: 4, spray: true,
        terrain: { heightmap: () => terrain, origin: [-8, -8], size: [16, 16] } });
      return { plugin, dispose: () => plugin.dispose(), cleanup: () => terrain.destroy() };
    } }, adapter, { mode: 'direct' });
    // Each draw in an owner view checks the viewport and scissor the view set (tests/support/owner-lifetime.js).
    assert.ok(result.draws > 0, 'the spray and surface drew in the owner views');
  } finally {
    adapter.close();
  }
});
