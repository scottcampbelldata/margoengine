import assert from 'node:assert/strict';
import {test} from 'node:test';
import {AvoidanceSolver, CapsuleVolume, SphereVolume, SolveStatus} from '../dist/index.js';

const root = [0, 0, 0], target = [1, 0, 0];
function elbow(_root, _target, angle, out) {
  out[0] = 0.5; out[1] = Math.sqrt(0.75) * Math.cos(angle); out[2] = Math.sqrt(0.75) * Math.sin(angle);
}
function solve(solver) {return solver.solve(root, target, target, 1, 1, 0.03, 0.05, 1 / 60, elbow);}
function farVolume(Base) {
  return Base === SphereVolume ? new Base({center: [0, 4, 0], radius: 0.2})
    : new Base({start: [0, 4, 0], end: [0, 5, 0], radius: 0.2});
}

test('subclass segment overrides determine the checked geometry', () => {
  for (const Base of [SphereVolume, CapsuleVolume]) {
    let calls = 0;
    class Custom extends Base {segmentClearance() {calls++; return -0.1;}}
    const solver = new AvoidanceSolver([farVolume(Base)]);
    assert.ok(solve(solver).resolved);
    const custom = Base === SphereVolume ? new Custom({center: [0, 4, 0], radius: 0.2})
      : new Custom({start: [0, 4, 0], end: [0, 5, 0], radius: 0.2});
    const result = solve(new AvoidanceSolver([custom]));
    assert.ok(calls > 0);
    assert.equal(result.resolved, false);
    assert.equal(result.status, SolveStatus.ObstacleOccluded);
  }
});

test('instance segment overrides installed after solver construction remain active', () => {
  for (const Base of [SphereVolume, CapsuleVolume]) {
    const volume = farVolume(Base), solver = new AvoidanceSolver([volume]);
    assert.ok(solve(solver).resolved);
    let calls = 0;
    volume.segmentClearance = () => {calls++; return -0.1;};
    const result = solve(solver);
    assert.ok(calls > 0);
    assert.equal(result.status, SolveStatus.ObstacleOccluded);
    assert.equal(result.resolved, false);
  }
});

test('prototype segment overrides are honored and restore without cached dispatch', () => {
  for (const Base of [SphereVolume, CapsuleVolume]) {
    const original = Base.prototype.segmentClearance;
    const volume = farVolume(Base), solver = new AvoidanceSolver([volume]);
    assert.ok(solve(solver).resolved);
    let calls = 0;
    try {
      Base.prototype.segmentClearance = function (start, end, radius) {calls++; original.call(this, start, end, radius); return -0.1;};
      assert.equal(solve(solver).status, SolveStatus.ObstacleOccluded);
      assert.ok(calls > 0);
    } finally {Base.prototype.segmentClearance = original;}
    assert.ok(solve(solver).resolved);
  }
});

test('mixed-volume segment callbacks preserve per-volume lower-then-upper ordering', () => {
  for (const omitUpper of [false, true]) {
    const events = [];
    const volumes = ['A', 'B'].map(name => ({
      evaluate(point, surface, normal) {surface.set(point); normal.set([1, 0, 0]); return 1;},
      segmentClearance(start, end, radius) {events.push({name, start: [...start], end: [...end], radius}); return 1;},
    }));
    const solver = new AvoidanceSolver([farVolume(SphereVolume), ...volumes, farVolume(CapsuleVolume)],
      {upperArmRadius: omitUpper ? null : 0.07, rootExclusion: 0.2});
    const result = solve(solver);
    assert.ok(result.resolved);
    const sequence = omitUpper ? ['A:0.05', 'B:0.05'] : ['A:0.05', 'A:0.07', 'B:0.05', 'B:0.07'];
    assert.deepEqual(events.map(event => `${event.name}:${event.radius}`), [...sequence, ...sequence]);
    for (const event of events) {
      if (event.radius === 0.05) {
        assert.deepEqual(event.start, [...result.elbow]); assert.deepEqual(event.end, [...result.target]);
      } else {
        assert.deepEqual(event.start, [...result.elbow].map(value => value * 0.2));
        assert.deepEqual(event.end, [...result.elbow]);
      }
    }
  }
});

test('nonfinite custom lower clearance preserves the upper callback before rejection', () => {
  for (const invalid of [NaN, Infinity, -Infinity, undefined, '1', null, true, new Number(1), 1n, Symbol('distance')]) {
    const calls = [], far = farVolume(SphereVolume);
    const custom = {
      evaluate(point, surface, normal) {return far.evaluate(point, surface, normal);},
      segmentClearance(_start, _end, radius) {calls.push(radius); return radius === 0.05 ? invalid : 1;},
    };
    const solver = new AvoidanceSolver([farVolume(CapsuleVolume), custom, farVolume(SphereVolume)], {upperArmRadius: 0.07});
    assert.throws(() => solve(solver), {name: 'RangeError', message: 'Non-finite segment clearance'});
    assert.deepEqual(calls, [0.05, 0.07]);
  }
});

test('custom upper clearance is checked independently of the finite lower value', () => {
  for (const invalid of [NaN, Infinity, -Infinity, undefined, '1', null]) {
    const far = farVolume(SphereVolume);
    const custom = {evaluate(point, surface, normal) {return far.evaluate(point, surface, normal);},
      segmentClearance(_a, _b, radius) {return radius === 0.07 ? invalid : 1;}};
    assert.throws(() => solve(new AvoidanceSolver([custom], {upperArmRadius: 0.07})), /Non-finite segment clearance/);
  }
});

test('custom scalar validation rejects coercible values without invoking valueOf', () => {
  let coercions = 0;
  const invalid = {valueOf() {coercions++; return 1;}};
  const far = farVolume(SphereVolume);
  const segment = {evaluate(point, surface, normal) {return far.evaluate(point, surface, normal);}, segmentClearance() {return invalid;}};
  assert.throws(() => solve(new AvoidanceSolver([segment])), /Non-finite segment clearance/);
  const point = {evaluate(query, surface, normal) {far.evaluate(query, surface, normal); return invalid;}, segmentClearance() {return 1;}};
  assert.throws(() => new AvoidanceSolver([point]).resolveTarget(target, 1 / 60), /Non-finite volume distance/);
  assert.equal(coercions, 0);
});

test('public segment methods preserve numeric and mutable geometry guards', () => {
  for (const Base of [SphereVolume, CapsuleVolume]) {
    const volume = farVolume(Base);
    for (const radius of [-1, NaN, Infinity]) assert.throws(() => volume.segmentClearance(root, target, radius));
    for (const start of [[NaN, 0, 0], [Infinity, 0, 0], [0, 0]]) assert.throws(() => volume.segmentClearance(start, target, 0.05));
    const old = volume.radius; volume.radius = -1;
    assert.throws(() => volume.segmentClearance(root, target, 0.05)); volume.radius = old;
    const coordinate = Base === SphereVolume ? volume.center : volume.end;
    const previous = coordinate[0]; coordinate[0] = Infinity;
    assert.throws(() => volume.segmentClearance(root, target, 0.05)); coordinate[0] = previous;
    assert.ok(Number.isFinite(volume.segmentClearance(root, target, 0.05)));
  }
});
