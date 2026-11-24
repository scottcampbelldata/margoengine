import test from 'node:test';
import assert from 'node:assert/strict';
import { ArrowHelper, PlaneHelper } from '../dist/index.js';
import { rig } from './gpu-rig.js';

const named = (log, name) => log.filter((e) => e[0] === name);
const pipelines = (log) => named(log, 'renderPipeline').map((e) => e[2]);
const entry = (p) => p.vertex.entryPoint;

test('a solid head draws before the arrow, writes depth and costs a helper without one nothing', () => {
  const { lines, frame } = rig(),
    solid = lines.add(new ArrowHelper({ solidHead: true })),
    log = frame(),
    made = pipelines(log);
  assert.deepEqual(made.map(entry), ['fillVertex', 'vertex']);
  assert.equal(made[0].depthStencil.depthWriteEnabled, true);
  assert.equal(made[1].depthStencil.depthWriteEnabled, false);
  assert.equal(log.find((e) => e[0] === 'beginRenderPass')[1].depthStencilAttachment.depthReadOnly, undefined);
  assert.equal(lines.stats.drawCalls, 2);
  assert.equal(lines.stats.segments, solid.segmentCount);
  const wire = rig();
  wire.lines.add(new ArrowHelper());
  const plain = wire.frame();
  assert.deepEqual(pipelines(plain).map(entry), ['vertex']);
  assert.equal(named(plain, 'buffer').length, 3, 'style, points and colours');
  assert.equal(wire.lines.stats.drawCalls, 1);
});

test('the cone closes on the tip and base, follows the arrow and uploads only when it moves', () => {
  const { lines, frame } = rig(),
    arrow = lines.add(new ArrowHelper({ direction: [0, 1, 0], length: 2, headLength: 0.5, headWidth: 0.5, solidHead: true }));
  frame();
  const cone = arrow.fill;
  assert.equal(cone.length, 12 * 24);
  assert.deepEqual(Array.from(cone.subarray(0, 4)), [0, 2, 0, 1]);
  assert.deepEqual(Array.from(cone.subarray(12, 16)), [0, 1.5, 0, 1]);
  for (let i = 0; i < cone.length; i += 4) {
    const radius = Math.hypot(cone[i], cone[i + 2]);
    assert.ok(radius < 0.2501 && (radius < 1e-6 || Math.abs(cone[i + 1] - 1.5) < 1e-6));
  }
  const fillWrites = (log) => named(log, 'writeBuffer').filter((e) => e[3].length === cone.byteLength * 2);
  assert.equal(fillWrites(frame()).length, 0);
  arrow.setOrigin([1, 0, 0]);
  assert.equal(cone[0], 1);
  assert.equal(fillWrites(frame()).length, 1);
});

test('a translucent fill writes no depth, and an opaque one stops writing when its material turns translucent', () => {
  const { lines, frame } = rig();
  lines.add(new PlaneHelper({ size: 2, fillOpacity: 0.25 }));
  const [fill] = pipelines(frame());
  assert.equal(entry(fill), 'fillVertex');
  assert.equal(fill.depthStencil.depthWriteEnabled, false);
  const opaque = rig(),
    plane = opaque.lines.add(new PlaneHelper({ fillOpacity: 1 }));
  assert.equal(pipelines(opaque.frame())[0].depthStencil.depthWriteEnabled, true);
  plane.material.opacity = 0.5;
  assert.equal(pipelines(opaque.frame())[0].depthStencil.depthWriteEnabled, false);
});

test('the plane fill is its square with the opacity on every corner, and follows setPlane', () => {
  const plane = new PlaneHelper({ size: 2, fillOpacity: 0.25 }),
    square = plane.fill;
  assert.equal(square.length, 24);
  for (let i = 0; i < 24; i += 4) {
    assert.equal(square[i + 3], 0.25);
    assert.equal(Math.abs(square[i + 1]), 0);
    assert.equal(Math.max(Math.abs(square[i]), Math.abs(square[i + 2])), 1);
  }
  plane.setPlane([0, 1, 0], -3, 2);
  assert.equal(square[1], 3);
  assert.equal(new PlaneHelper().fill, null);
  assert.throws(() => new PlaneHelper({ fillOpacity: 2 }), RangeError);
});

test('a fill shader keeps the plain fragment apart from dashes, and its buffer goes with the line', () => {
  const { gpu, lines, frame } = rig(),
    arrow = lines.add(new ArrowHelper({ solidHead: true, dashed: true }));
  const log = frame(),
    code = named(log, 'module').map((e) => e[2].code).find((text) => text.includes('fillVertex'));
  assert.match(code, /if\(false\)\{\s+let dash=/);
  const before = gpu.record(() => lines.remove(arrow));
  assert.equal(named(before, 'destroy').length, 4, 'style, points, colours and fill');
});
