import test from 'node:test';
import assert from 'node:assert/strict';
import { Lines, Line } from '../dist/index.js';
import { LineBatches, LineBatch } from '../dist/batch.js';
import { DebugLines } from '../dist/debug.js';
import { nodeLifetimeAdapter } from '../../../tests/support/owner-lifetime-node.js';

// Found by the owner/lifetime fixture: dispose() freed the buffers but left the plugin registered, with its draw pass
// still in the frame graph, so a second attach under the same name threw and the stale pass ran every frame.
for (const [name, make, fill] of [
  ['Lines', () => new Lines(), (p) => p.add(new Line({ positions: [0, 0, 0, 1, 0, 0] }))],
  ['LineBatches', () => new LineBatches(), (p) => p.add(new LineBatch({ positions: [0, 0, 0, 1, 0, 0] }))],
  ['DebugLines', () => new DebugLines(), (p) => p.drawLine([0, 0, 0], [1, 0, 0])],
]) {
  test(`${name}.dispose leaves its scene and frame graph, and can be attached again`, async () => {
    const adapter = await nodeLifetimeAdapter();
    try {
      const host = await adapter.create(), { engine } = host;
      // Counts the runs of every pass registered from here on: the plugin's draw pass among them.
      const graph = engine.scene.frameGraph, add = graph.add.bind(graph);
      let runs = 0;
      graph.add = (pass) => add({ ...pass, execute(context) { runs++; return pass.execute(context); } });
      const frame = () => host.render([{ camera: engine.camera, viewport: [0, 0, 64, 32], pixels: true }]);
      const plugin = make();
      fill(plugin);
      engine.use(plugin);
      assert.equal(engine.sceneOf(plugin), engine.scene);
      await frame();
      const ran = runs;
      assert.ok(ran > 0, 'the plugin registered its draw pass');
      plugin.dispose();
      await frame();
      assert.equal(engine.sceneOf(plugin), undefined, 'disposal removes the registration');
      assert.equal(engine.plugins.has(plugin.name), false);
      assert.equal(runs, ran, 'no draw pass outlives the plugin');
      plugin.dispose();
      engine.use(plugin);
      assert.equal(engine.sceneOf(plugin), engine.scene, 'the same plugin attaches again');
      engine.dispose();
    } finally {
      adapter.close();
    }
  });
}
