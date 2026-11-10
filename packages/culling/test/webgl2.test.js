import assert from 'node:assert/strict';
import test from 'node:test';
import { box } from '@margoengine/core';
import { SoftwareDepthBuffer, WebGL2Culling } from '../dist/webgl2.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { wgsl } from '../../core/src/shaders.ts';
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const at = (x = 0, y = 0, z = 0) => [...identity.slice(0, 12), x, y, z, 1];
const bounds = [-0.025, -0.025, -0.01, 0.025, 0.025, 0.01];
test('inner coverage keeps holes, edges, near crossings and coplanar surfaces', () => {
  const depth = new SoftwareDepthBuffer(64, 64);
  depth.clear(identity);
  depth.rasterize(box(1.8, 1.8, 0.1), at(0, 0, 0.8), true);
  assert.equal(depth.visible(bounds, at(0.4, 0, 0.3)), false);
  assert.equal(depth.visible(bounds, at(0.4, 0, 0.95)), true);
  assert.equal(depth.visible(bounds, at(0.89, 0, 0.3)), true);
  assert.equal(depth.visible(bounds, at(0, 0, 0.3)), false, 'coplanar shared diagonals have complete coverage');
  assert.equal(depth.visible(bounds, at(0.4, 0, 0.85)), true, 'coplanar target kept');
  depth.clear(identity);
  depth.rasterize(box(1.8, 1.8, 0.1), at(0, 0, 1.1), true);
  assert.equal(depth.visible(bounds, at(0.4, 0, 0.3)), true, 'clipped occluder cannot hide anything');
});
test('single-sided and mirrored surfaces occlude only their rendered faces', () => {
  const geometry = {
    vertices: new Float32Array([-1, -1, 0, 0, 0, 1, 1, -1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
  };
  const depth = new SoftwareDepthBuffer(64, 64);
  depth.clear(identity);
  depth.rasterize(geometry, at(0, 0, 0.8));
  assert.equal(depth.visible(bounds, at(0, -0.5, 0.3)), false);
  geometry.indices.reverse();
  depth.clear(identity);
  depth.rasterize(geometry, at(0, 0, 0.8));
  assert.equal(depth.visible(bounds, at(0, -0.5, 0.3)), true);
  depth.rasterize(geometry, at(0, 0, 0.8), true);
  assert.equal(depth.visible(bounds, at(0, -0.5, 0.3)), false);
});
test('software plugin compacts complete records, updates moving occluders, releases redirects and buffers', () => {
  const h = optionalGPU();
  h.context.shader = wgsl;
  h.context.camera.matrix = new Float32Array(identity);
  const wall = box(1.8, 1.8, 0.1),
    target = box(0.05, 0.05, 0.02),
    row = (m, id) => new Float32Array([...m, 1, 0, 0, 1, 0.5, 0, 1, id]),
    batches = [
      { geometry: wall, instances: row(at(0, 0, 0.8), 1), count: 1 },
      {
        geometry: target,
        instances: new Float32Array([...row(at(0.4, 0, 0.3), 2), ...row(at(0.4, 0, 0.95), 3)]),
        count: 2,
      },
    ];
  h.context.batches = batches;
  const culler = WebGL2Culling.attach(h.engine);
  h.engine.frameGraph.execute(h.context);
  assert.equal(culler.readCounts().get(target), 1);
  batches[0].instances[12] = 4;
  h.engine.frameGraph.execute(h.context);
  assert.equal(culler.readCounts().get(target), 2, 'new geometry position is used immediately');
  batches[0].instances[12] = 0;
  h.context.shader = wgsl + ' discard;';
  h.engine.frameGraph.execute(h.context);
  assert.equal(culler.readCounts().get(target), 2, 'surface-changing shaders disable occlusion');
  culler.dispose();
  culler.dispose();
  assert.ok(batches.every((b) => b.redirect === undefined));
  assert.equal(culler.readCounts().size, 0);
});
test('depth resolution and camera validation are bounded', () => {
  for (const n of [0, 2.5, 2049, NaN]) assert.throws(() => new WebGL2Culling({ resolution: n }), RangeError);
  assert.throws(() => new SoftwareDepthBuffer().clear([NaN]), TypeError);
});

test('each view has independent uploads until the frame command buffer is submitted', () => {
  const h = optionalGPU();
  h.context.shader = wgsl;
  h.context.camera.matrix = new Float32Array(identity);
  const batch = { geometry: box(), instances: new Float32Array([...identity, 1, 1, 1, 1, 0.5, 0, 1, 0]), count: 1 };
  h.context.batches = [batch];
  const c = WebGL2Culling.attach(h.engine);
  h.context.view = { id: 'left' };
  h.engine.frameGraph.execute(h.context);
  const left = batch.redirect;
  h.context.view = { id: 'right' };
  h.engine.frameGraph.execute(h.context);
  const right = batch.redirect;
  assert.notEqual(left.instances, right.instances);
  assert.notEqual(left.args, right.args);
  c.dispose();
  assert.equal(batch.redirect, undefined);
});
