import assert from 'node:assert/strict';
import test from 'node:test';
import { PointCloud } from '@margoengine/points';
import { Figure } from '../dist/index.js';
import { SelectionStore, bindSelection } from '../dist/link.js';

globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2, STORAGE: 4, COPY_SRC: 8 };
globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 };

// KB5588c: a bound scatter keeps drawing its own cloud (no replacement draw), so picking and box selection keep
// working, and the binding's visibility is the cloud's.
test('a bound scatter keeps its native cloud with a mask; picking and box selection follow its visibility', () => {
  const device = {
    createBuffer: ({ size }) => ({ size, destroy() {} }),
    createBindGroupLayout: () => ({}),
    createBindGroup: () => ({}),
    queue: { writeBuffer() {} },
  };
  const canvas = Object.assign(new EventTarget(), { width: 100, height: 100, clientWidth: 100, clientHeight: 100 });
  const engine = { canvas, use() {}, camera: { matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) } };
  const renderer = { device, add() {}, remove() {}, dispose() {}, ready: async () => {} };
  using figure = new Figure(engine, { axes: false, legend: false, limits: [-1, 1, -1, 1, -1, 1] }, renderer);
  const positions = new Float32Array([0, 0, 0, 0.5, 0, 0]);
  const cloud = new PointCloud({ positions, material: { size: 2 } });
  const layer = figure.addLayer({ kind: 'scatter', positions, cloud, count: 2, bounds: [-1, 1, -1, 1, -1, 1] });
  using store = new SelectionStore([0, 1]);
  const binding = bindSelection(figure, layer, store, { rowIds: [0, 1] });
  assert.equal(cloud.visible, true, 'the cloud itself draws the bound marks');
  assert.ok(cloud.mask, 'the selection is the cloud mask');
  assert.equal(figure.pick(50, 50).index, 0, 'picking reads the original data');
  figure.select({ rect: [49, 49, 51, 51] });
  assert.deepEqual(store.rowIds, [0], 'the figure box selection reaches the shared store');
  assert.deepEqual([cloud.isSelected(0), cloud.isSelected(1)], [true, false], 'and comes back as the mask');
  binding.visible = false;
  assert.equal(cloud.visible, false);
  assert.equal(figure.pick(50, 50), null);
  assert.deepEqual(figure.select({ rect: [0, 0, 100, 100] }).points, []);
  binding.visible = true;
  binding.dispose();
  assert.equal(cloud.mask, null, 'dispose removes the mask');
  assert.equal(cloud.visible, true);
  assert.equal(figure.pick(50, 50).index, 0);
});
