import test from 'node:test';
import assert from 'node:assert/strict';
import { Line, LineMaterial } from '../dist/index.js';
import { rig } from './gpu-rig.js';

const positions = [0, 0, 0, 1, 0, 0];
const pipelines = (log) => log.filter((e) => e[0] === 'renderPipeline').map((e) => e[2]);
const draws = (log) => log.filter((e) => e[0] === 'pass.draw').length;

test('with MSAA a line takes coverage in place of blending and keeps the scene alpha', () => {
  const { lines, frame } = rig({ samples: 4 });
  lines.add(new Line({ positions, alphaToCoverage: true }));
  const [pipeline] = pipelines(frame());
  assert.deepEqual(pipeline.multisample, { count: 4, alphaToCoverageEnabled: true });
  assert.equal(pipeline.fragment.targets[0].blend, undefined);
  assert.equal(pipeline.fragment.targets[0].writeMask, 7);
});

test('without MSAA the line blends as usual', () => {
  const { lines, frame } = rig();
  lines.add(new Line({ positions, alphaToCoverage: true }));
  const [pipeline] = pipelines(frame());
  assert.deepEqual(pipeline.multisample, { count: 1 });
  assert.ok(pipeline.fragment.targets[0].blend);
});

test('a depth-writing line is one draw with coverage, two steps without', () => {
  const covered = rig({ samples: 4 }),
    stepped = rig();
  covered.lines.add(new Line({ positions, depthWrite: true, alphaToCoverage: true }));
  stepped.lines.add(new Line({ positions, depthWrite: true, alphaToCoverage: true }));
  const log = covered.frame();
  assert.equal(draws(log), 1);
  assert.equal(pipelines(log)[0].depthStencil.depthWriteEnabled, true);
  assert.equal(pipelines(log)[0].multisample.alphaToCoverageEnabled, true);
  assert.equal(log.filter((e) => e[0] === 'module' && e[2].code.includes('discard;}let alpha')).length, 0);
  assert.equal(draws(stepped.frame()), 2);
});

test('a plain line beside a covered one keeps its blending, and the flag is checked', () => {
  const { lines, frame } = rig({ samples: 4 });
  lines.add(new Line({ positions }));
  lines.add(new Line({ positions, alphaToCoverage: true }));
  const made = pipelines(frame());
  assert.equal(made.length, 2);
  assert.ok(made[0].fragment.targets[0].blend);
  assert.deepEqual(made[0].multisample, { count: 4 });
  assert.throws(() => new LineMaterial({ alphaToCoverage: 1 }), TypeError);
});
