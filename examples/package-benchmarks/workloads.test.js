import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkload as ecs } from './ecs.js';
import { createWorkload as fsm } from './fsm.js';
import { createWorkload as tween } from './tween.js';
import { createWorkload as net } from './net.js';

test('workloads use their advertised bounded defaults and reject invalid sizes', () => {
  for (const [create, count] of [
    [ecs, 10000],
    [fsm, 1000],
    [tween, 1000],
    [net, 256],
  ]) {
    const workload = create();
    assert.equal(workload.points.length, count * 4);
    workload.dispose?.();
    for (const invalid of [0, -1, 1.5, 20001, NaN]) assert.throws(() => create(invalid), /Workload count/);
  }
});

test('ECS visual positions come from queried, integrated component rows', () => {
  const work = ecs(64),
    before = work.points[0],
    entity = work.position.entities[0];
  work.step(0.1);
  assert.equal(work.details().queriedPerFrame, 64);
  assert.equal(work.details().queries, 1);
  const row = work.position.index(entity);
  assert.equal(work.points[0], work.position.fields.x[row]);
  assert.ok(Math.abs(work.points[0] - before + 0.012) < 1e-6);
  assert.ok(work.points.every(Number.isFinite));
});

test('FSM agents execute hierarchy updates, transitions, blends and parent event routing', () => {
  const work = fsm(64);
  for (let i = 0; i < 100; i++) work.step(0.05);
  assert.equal(work.details().hierarchyUpdatesPerFrame, 128);
  assert.ok(work.details().transitions >= 256);
  assert.ok(work.machines.every((machine) => machine.context.phase > 0 && machine.blend >= 0 && machine.blend <= 1));
  assert.ok(work.points.some((value, i) => i % 4 === 1 && value > 0.15));
  work.reset();
  assert.ok(work.machines.every((machine) => machine.state === 'idle'));
  assert.ok(work.points.every(Number.isFinite));
});

test('tweens remain active through completion callbacks and drive visible eased heights', () => {
  const work = tween(64);
  work.step(0.5);
  assert.ok(work.targets[0].height > work.targets.at(-1).height);
  for (let i = 0; i < 100; i++) work.step(0.05);
  assert.ok(work.details().completions > 64);
  for (let i = 0; i < 64; i++) {
    assert.equal(work.points[i * 4 + 1], Math.fround(work.targets[i].height));
    assert.ok(work.targets[i].height >= 0.15 && work.targets[i].height <= 1.1);
  }
  work.dispose();
  const height = work.targets[0].height;
  work.step(0.1);
  assert.equal(work.targets[0].height, height);
});

test('network actors reuse snapshot rings/outputs and show interpolated positions and rotations across packet loss', () => {
  const work = net(64),
    storage = work.buffers.map((buffer) => buffer.samples),
    outputs = work.outputs.slice();
  for (let i = 0; i < 200; i++) work.step(0.02);
  assert.ok(work.details().dropped > 0);
  assert.ok(work.details().packets > 64 * 60);
  for (let i = 0; i < 64; i++) {
    assert.equal(work.buffers[i].samples, storage[i]);
    assert.equal(work.outputs[i], outputs[i]);
    assert.equal(work.points[i * 4], Math.fround(outputs[i].position[0]));
    assert.ok(Math.abs(Math.hypot(...outputs[i].rotation) - 1) < 1e-12);
    assert.ok(Number.isFinite(work.yaw[i]));
  }
  assert.ok(work.points.every(Number.isFinite));
  work.dispose();
  assert.ok(work.buffers.every((buffer) => buffer.sample(5) === null));
});
