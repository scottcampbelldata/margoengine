import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { Stats } from '../dist/index.js';
import { FrameBeacon } from '../dist/beacon.js';
import { PipelineCompiles } from '../dist/compile.js';
import { FramePhases } from '../dist/phases.js';
import { GeometryStats } from '../dist/geometry.js';
import { GLStats } from '../dist/gl.js';
import { StatsPanels } from '../dist/panels.js';

const cases = [
  ['Stats', (parent) => new Stats({ parent })],
  ['FrameBeacon', () => new FrameBeacon({ endpoint: 'https://example.test/frames', intervalMilliseconds: 0 })],
  ['PipelineCompiles', () => new PipelineCompiles()],
  ['FramePhases', () => new FramePhases()],
  ['GeometryStats', () => new GeometryStats()],
  ['GLStats', () => new GLStats()],
  ['StatsPanels', (parent) => new StatsPanels({ parent })],
];

for (const [name, make] of cases)
  for (const remove of [false, true])
    test(`${name} ${remove ? 'owner removal' : 'direct disposal'} releases only its registered scene`, async (t) => {
      const dom = new JSDOM('<body></body>');
      dom.window.HTMLCanvasElement.prototype.getContext = () => null;
      t.after(() => dom.window.close());
      const store = await TransformStore.create(16),
        renderer = { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} },
        engine = new Engine({ width: 8, height: 8, clientWidth: 8, clientHeight: 8 }, store, renderer, undefined, null);
      t.after(() => engine.dispose());
      const scene = engine.createScene('stats-owner'),
        tick = store.tick,
        plugin = make(dom.window.document.body);
      scene.use(plugin);
      let defaultDisposals = 0;
      const primary = {
        name: plugin.name,
        setup() {},
        dispose() {
          defaultDisposals++;
        },
      };
      engine.use(primary);
      plugin.onDeviceRestored?.(engine);
      assert.equal(engine.sceneOf(plugin), scene);
      if (remove) scene.removePlugin(plugin.name);
      else plugin.dispose();
      plugin.dispose();
      assert.equal(engine.sceneOf(plugin) === undefined, true, 'disposed plugin remains registered');
      assert.equal(scene.plugins.size, 0);
      assert.equal(engine.scene.plugins.get(primary.name), primary);
      assert.equal(defaultDisposals, 0);
      assert.equal(store.tick, tick, 'phase wrapper is released');
      assert.equal(dom.window.document.body.children.length, 0, 'overlay is released');
      const replacement = { name: plugin.name, setup() {}, dispose() {} };
      scene.use(replacement);
      plugin.dispose();
      assert.equal(scene.plugins.get(replacement.name), replacement);
      scene.removePlugin(replacement.name);
    });
