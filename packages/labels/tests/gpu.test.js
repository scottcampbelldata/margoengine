import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GPULabelLayer } from '@margoengine/labels/gpu';
import { Camera } from '@margoengine/core';

const bitmap = {
  cluster: 'A',
  width: 8,
  height: 12,
  left: 0,
  top: 10,
  color: false,
  data: new Uint8Array(96).fill(255),
};
const font = {
  size: 16,
  radius: 8,
  cutoff: 0.25,
  revision: 0,
  load: async () => {},
  advance: () => 0.5,
  kerning: () => 0,
  metrics: () => ({ ascent: 0.8, descent: 0.2 }),
  glyph: () => bitmap,
};
const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
test('100,000 independently located points batch into one packed glyph stream without DOM', async () => {
  const layer = await GPULabelLayer.create({ font, declutter: false });
  layer.setLabels(
    Array.from({ length: 100000 }, (_, i) => ({
      text: 'A',
      position: [(i % 400) / 200 - 1, Math.floor(i / 400) / 125 - 1, 0.5],
    })),
  );
  const data = layer.prepare(identity, 1600, 1000);
  assert.equal(layer.stats.labels, 100000);
  assert.equal(layer.stats.glyphs, 100000);
  assert.equal(data.length, 2000000);
  assert.deepEqual([...data.slice(0, 3)], [-1, -1, 0.5]);
  assert.deepEqual(
    [...data.slice(20, 23)].map((v) => Math.round(v * 1000) / 1000),
    [-0.995, -1, 0.5],
  );
});
test('grid collisions use full glyph bounds, priorities and padding; membership updates', async () => {
  const layer = await GPULabelLayer.create({ font, cell: 8, padding: 2 });
  const labels = [
    { text: 'A', position: [0, 0, 0.5], priority: 0, color: [1, 0, 0, 1] },
    { text: 'A', position: [0.02, 0, 0.5], priority: 1, color: [0, 1, 0, 1] },
    { text: 'A', position: [0.8, 0, 0.5] },
  ];
  layer.setLabels(labels);
  let data = layer.prepare(identity, 100, 100);
  assert.equal(layer.stats.labels, 2);
  assert.equal(layer.stats.hidden, 1);
  assert.ok(layer.stats.comparisons <= 3);
  assert.deepEqual([...data.slice(12, 16)], [0, 1, 0, 1]);
  labels[0].position = [-0.8, 0, 0.5];
  data = layer.prepare(identity, 100, 100);
  assert.equal(layer.stats.labels, 3);
  layer.setLabels([]);
  assert.equal(layer.prepare(identity, 100, 100).length, 0);
});
test('screen glyph extents stay constant with distance, perspective and orthographic matrices', async () => {
  const layer = await GPULabelLayer.create({ font, declutter: false });
  const camera = new Camera({ position: [0, 0, 5], target: [0, 0, 0] });
  camera.update(1, true);
  layer.setLabels([{ text: 'A', position: [0, 0, 0] }]);
  const near = layer.prepare(camera.matrix, 400, 400).slice(4, 8);
  camera.position = [0, 0, 50];
  camera.update(1, true);
  assert.deepEqual(layer.prepare(camera.matrix, 400, 400).slice(4, 8), near);
  assert.deepEqual(layer.prepare(identity, 400, 400).slice(4, 8), near);
});
test('depth conventions, invalid input, font changes, abort and atlas exhaustion are explicit', async () => {
  const layer = await GPULabelLayer.create({ font });
  layer.setLabels([{ text: 'A', position: [0, 0, -0.5] }]);
  assert.equal(layer.prepare(identity, 100, 100).length, 0);
  assert.equal(layer.prepare(identity, 100, 100, 'webgl2').length, 20);
  layer.setLabels([{ text: 'A', position: [0, 0, 0.5], fontSize: -1 }]);
  assert.throws(() => layer.prepare(identity, 100, 100), RangeError);
  layer.setLabels([{ text: 'A', position: [0, 0, 0.5] }]);
  layer.prepare(identity, 100, 100);
  font.revision++;
  assert.equal(layer.prepare(identity, 100, 100).length, 20);
  await assert.rejects(GPULabelLayer.create({ signal: AbortSignal.abort() }), { name: 'AbortError' });
  const tiny = await GPULabelLayer.create({ font, atlasSize: 8, maxPages: 1 });
  tiny.setLabels([{ text: 'A', position: [0, 0, 0.5] }]);
  assert.throws(
    () => tiny.prepare(identity, 100, 100),
    (e) => e.code === 'state',
  );
  layer.dispose();
  layer[Symbol.dispose]();
});

test('attach waits for fonts, registers once, detaches and leaves no registration on abort', async () => {
  const plugins = new Map(), engine = {
    use(layer) { if (!layer.name.startsWith('gpu-labels:attach:')) assert.equal(loaded, true); plugins.set(layer.name, layer); layer.setup(this); },
    sceneOf(layer) { return plugins.get(layer.name) === layer ? this : undefined; },
    removePlugin(name) { const layer = plugins.get(name); plugins.delete(name); layer?.dispose?.(); },
  };
  let loaded = false;
  const layer = await GPULabelLayer.attach(engine, { font: { ...font, async load() { loaded = true; } } });
  assert.equal(plugins.get(layer.name), layer);
  layer[Symbol.dispose]();
  layer.dispose();
  assert.equal(plugins.size, 0);
  const abort = new AbortController();
  await assert.rejects(GPULabelLayer.attach(engine, { font: { ...font, async load() { abort.abort(); } }, signal: abort.signal }), { name: 'AbortError' });
  assert.equal(plugins.size, 0);
});

test('attach joins the scene that was active when it was called, not the one active after the font loads', async () => {
  const scenes = [], make = (name) => {
    const scene = { name, plugins: new Map(), use(plugin) { this.plugins.set(plugin.name, plugin); plugin.setup?.(engine); },
      removePlugin(key) { this.plugins.delete(key); } };
    scenes.push(scene);
    return scene;
  };
  const first = make('first'), second = make('second');
  let active = first;
  const engine = {
    use(plugin) { active.use(plugin); },
    sceneOf(plugin) { return scenes.find((scene) => scene.plugins.get(plugin.name) === plugin); },
    removePlugin(name) { active.removePlugin(name); },
  };
  const pending = GPULabelLayer.attach(engine, { font: { ...font, async load() { active = second; } } });
  const layer = await pending;
  assert.equal(first.plugins.get(layer.name), layer);
  assert.equal(second.plugins.size, 0);
});
