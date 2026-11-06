import test from 'node:test';
import assert from 'node:assert/strict';
import { Line, LineMaterial } from '../dist/index.js';
import { HiddenLine } from '../dist/hidden.js';
import { LinePicking } from '../dist/pick.js';
import { rig } from './gpu-rig.js';

const positions = [0, 0, 0, 1, 0, 0, 1, 1, 0];
const pipelines = (log) => log.filter((e) => e[0] === 'renderPipeline').map((e) => e[2]);
const modules = (log) => log.filter((e) => e[0] === 'module').map((e) => e[2].code);

test('a hidden line turns the depth test around and biases both lines, leaving a plain line alone', () => {
  const { lines, frame } = rig(),
    source = lines.add(new Line({ positions, color: [1, 0, 0], width: 3 })),
    hidden = lines.add(new HiddenLine(source));
  assert.equal(hidden.material.behind, true);
  assert.equal(hidden.material.dashed, true);
  assert.equal(hidden.material.opacity, 0.5);
  assert.equal(hidden.material.width, 3);
  assert.deepEqual(Array.from(hidden.material.color), [1, 0, 0]);
  assert.equal(source.material.depthBias, 0.001);
  const log = frame(),
    made = pipelines(log);
  assert.deepEqual(made.map((p) => p.depthStencil.depthCompare), ['greater-equal', 'less']);
  assert.deepEqual(made.map((p) => p.depthStencil.depthWriteEnabled), [false, false]);
  assert.equal(modules(log).length, 1, 'both share the biased shader');
  assert.match(modules(log)[0], /min\(base\.z\*\(1\.0\+style\.b\.w\),base\.w\)/);
});

test('a source with its own bias keeps it, and a faded hidden line draws no dashes', () => {
  const source = new Line({ positions, depthBias: 0.01 }),
    hidden = new HiddenLine(source, { dashed: false, opacity: 0.2 });
  assert.equal(source.material.depthBias, 0.01);
  assert.equal(hidden.material.dashed, false);
  assert.equal(hidden.material.opacity, 0.2);
});

test('a hidden line follows its source and draws only while the source does', () => {
  const { lines, frame } = rig(),
    source = lines.add(new Line({ positions, colors: [1, 0, 0, 0, 1, 0, 0, 0, 1] })),
    hidden = lines.add(new HiddenLine(source));
  frame();
  assert.equal(hidden.count, 3);
  assert.equal(hidden.colors[5], 1);
  source.setPositions([0, 0, 0, 2, 0, 0]);
  source.mode = 'segments';
  source.setMatrix([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 1, 2, 3, 1]);
  frame();
  assert.equal(hidden.count, 2);
  assert.equal(hidden.mode, 'segments');
  assert.equal(hidden.matrix[12], 1);
  assert.equal(hidden.totalDistance, 4, 'dashes measure in world space');
  source.visible = false;
  frame();
  assert.equal(lines.stats.lines, 0);
  source.visible = true;
  lines.remove(source);
  frame();
  assert.equal(lines.stats.lines, 0, 'a source out of its plugin stops its hidden line');
});

test('behind takes no depth writes, and depthBias is checked', () => {
  const { lines, frame } = rig();
  lines.add(new Line({ positions, behind: true, depthWrite: true }));
  assert.deepEqual(pipelines(frame()).map((p) => [p.depthStencil.depthCompare, p.depthStencil.depthWriteEnabled]), [
    ['less', false],
  ]);
  assert.throws(() => new LineMaterial({ depthBias: -1 }), RangeError);
  assert.throws(() => new LineMaterial({ depthBias: 1 }), RangeError);
  assert.throws(() => new LineMaterial({ behind: 1 }), TypeError);
  assert.throws(() => new HiddenLine({}), TypeError);
});

test('a pick skips hidden lines and tests depth with the bias drawn', () => {
  const { gpu, lines } = rig();
  lines['engine'] = { canvas: { clientWidth: 64, width: 64 }, createMesh: () => ({ dispose() {} }) };
  const source = lines.add(new Line({ positions }));
  lines.add(new HiddenLine(source));
  const picking = LinePicking.attach({ addOverlay: () => () => {} }, lines),
    view = gpu.device.createTexture({ size: [3, 3], format: 'r32uint' }).createView(),
    log = gpu.record(() =>
      picking.drawPick({
        encoder: gpu.encoder,
        color: view,
        depth: view,
        matrix: new Float32Array(16),
        camera: { matrix: new Float32Array(16).fill(1), fov: 60 },
        rect: [0, 0, 64, 64],
        firstId: 1000,
      }),
    );
  assert.equal(log.filter((e) => e[0] === 'pass.draw').length, 1);
  assert.ok(modules(log).every((code) => code.includes('min(base.z*(1.0+style.b.w),base.w)')));
});
