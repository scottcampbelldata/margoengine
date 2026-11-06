import test from 'node:test';
import assert from 'node:assert/strict';
import { Line, LineMaterial } from '../dist/index.js';
import { rig } from './gpu-rig.js';

const positions = [0, 0, 0, 1, 0, 0];
const pipelines = (log) => log.filter((e) => e[0] === 'renderPipeline').map((e) => e[2]);
const modules = (log) => log.filter((e) => e[0] === 'module').map((e) => e[2].code);
const draws = (log) => log.filter((e) => e[0] === 'pass.draw').length;
const opened = (log) => log.find((e) => e[0] === 'beginRenderPass')[1];

test('depthWrite is off by default and keeps the read-only overlay pass', () => {
  const { lines, frame } = rig();
  lines.add(new Line({ positions }));
  const log = frame();
  assert.equal(new LineMaterial().depthWrite, false);
  assert.equal(opened(log).depthStencilAttachment.depthReadOnly, true);
  assert.deepEqual(
    pipelines(log).map((p) => p.depthStencil.depthWriteEnabled),
    [false],
  );
  assert.equal(draws(log), 1);
});

test('depthWrite draws the solid part with writes, then the edge ramp without, before lines that do not write', () => {
  const { lines, frame } = rig();
  lines.add(new Line({ positions }));
  lines.add(new Line({ positions, depthWrite: true }));
  const log = frame(),
    made = pipelines(log),
    code = modules(log),
    pass = opened(log);
  assert.equal(pass.depthStencilAttachment.depthLoadOp, 'load');
  assert.equal(pass.depthStencilAttachment.depthStoreOp, 'store');
  assert.deepEqual(
    made.map((p) => p.depthStencil.depthWriteEnabled),
    [true, false, false],
  );
  assert.equal(code.length, 2, 'one new shader per step; the plain shader was made at setup');
  assert.match(code[0], /if\(cover<0\.5\)\{discard;\}/);
  assert.match(code[1], /if\(cover>=0\.5\)\{discard;\}/);
  assert.equal(draws(log), 3);
  assert.equal(lines.stats.drawCalls, 3);
  assert.equal(lines.stats.lines, 2);
});

test('a depth-writing line without antialiasing is one draw; onTop keeps its always compare', () => {
  const { lines, frame } = rig();
  lines.add(new Line({ positions, depthWrite: true, antialias: false, onTop: true }));
  const log = frame();
  assert.equal(draws(log), 1);
  const [pipeline] = pipelines(log);
  assert.equal(pipeline.depthStencil.depthWriteEnabled, true);
  assert.equal(pipeline.depthStencil.depthCompare, 'always');
});

test('fogged depth-writing lines get the fog shader in both steps', () => {
  const { lines, frame } = rig();
  lines.setFog({ color: '#808080', near: 1, far: 2 });
  lines.add(new Line({ positions, depthWrite: true }));
  const code = modules(frame());
  assert.ok(code.some((c) => c.includes('if(cover<0.5)') && c.includes('fogAmount(i.world)')));
  assert.ok(code.some((c) => c.includes('if(cover>=0.5)') && c.includes('fogAmount(i.world)')));
});

test('depthWrite must be boolean', () => {
  assert.throws(() => new LineMaterial({ depthWrite: 1 }), TypeError);
});
