import test from 'node:test';
import assert from 'node:assert/strict';
import { nodeLifetimeAdapter } from '../../../tests/support/owner-lifetime-node.js';
import { fillGaps } from './fake-gpu-gaps.js';
import { Ui, UiRenderer } from '../dist/index.js';
import { WorldPanel, WorldPanels } from '../dist/world.js';
import { GlWorldPanels } from '../dist/world-gl.js';

for (const Plugin of [UiRenderer, WorldPanels, GlWorldPanels]) fillGaps(Plugin); // the node adapter's fake GPU gaps

for (const [name, make] of Object.entries({
  UiRenderer: (engine) => UiRenderer.attach(engine, new Ui({ width: 64, height: 32 }), { mirror: false }),
  WorldPanels: (engine) => WorldPanels.attach(engine),
  GlWorldPanels: (engine) => GlWorldPanels.attach(engine),
})) {
  test(`${name}.dispose() also removes the plugin from its engine, so the next frame does not run it`, async () => {
    const adapter = await nodeLifetimeAdapter(), host = await adapter.create(), { engine } = host;
    try {
      const plugin = make(engine), view = [{ id: 'a', scene: engine.scene, camera: engine.camera, pixels: true,
        viewport: [0, 0, 32, 32], scissor: [0, 0, 16, 32] }];
      await host.render(view);
      plugin.dispose();
      assert.equal(engine.sceneOf(plugin), undefined);
      assert.equal(engine.plugins.has(plugin.name), false);
      await host.render(view);
      plugin.dispose();
    } finally {
      engine.dispose();
      adapter.close();
    }
  });
}

for (const [name, make] of Object.entries({
  WorldPanels: (engine) => WorldPanels.attach(engine),
  GlWorldPanels: (engine) => GlWorldPanels.attach(engine),
}))
  test(`${name} drawn only in a later view is disposed and restored without a camera slot for the earlier view`, async () => {
    const adapter = await nodeLifetimeAdapter(), host = await adapter.create(), { engine } = host;
    try {
      const plugin = make(engine), other = engine.createScene('other');
      plugin.add(new WorldPanel(new Ui({ width: 64, height: 32 }), { width: 1, height: 0.5, position: [0, 0, -2] }));
      // View 0 shows another scene, so the panels draw only in view 1.
      const views = [
        { id: 'a', scene: other, camera: engine.camera, viewport: [0, 0, 32, 32], pixels: true },
        { id: 'b', scene: engine.scene, camera: engine.camera, viewport: [32, 0, 32, 32], pixels: true },
      ];
      await host.render(views);
      plugin.onDeviceRestored(engine);
      await host.render(views);
      plugin.dispose();
      assert.equal(engine.sceneOf(plugin), undefined);
    } finally {
      engine.dispose();
      adapter.close();
    }
  });
