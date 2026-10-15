import test from 'node:test';
import assert from 'node:assert/strict';
import {parseModules, expand, interpret, tubes} from '../dist/lsystem.js';

const text = modules => modules.map(m => m.symbol + (m.params.length ? `(${m.params.join(',')})` : '')).join('');

test('deterministic grammars rewrite in parallel and parse parameters', () => {
  assert.equal(text(expand('A', {A: 'AB', B: 'A'}, 5)), 'ABAABABAABAAB'); // Lindenmayer's algae, generation 5
  assert.deepEqual(parseModules(' F(1.5, -2)[+ X] '), [{symbol: 'F', params: [1.5, -2]}, {symbol: '[', params: []}, {symbol: '+', params: []}, {symbol: 'X', params: []}, {symbol: ']', params: []}]);
  assert.throws(() => parseModules('F(1,x)'), /parameter/); assert.throws(() => parseModules('F(1'), /Invalid L-system text/);
  assert.throws(() => expand('F', {FF: 'F'}, 1), /single symbols/); assert.throws(() => expand('F', {F: 'FF'}, 30, {maxModules: 1000}), /budget/);
});

test('stochastic rules are seeded and follow their weights', () => {
  const rules = {F: [{successor: 'a', weight: 3}, {successor: 'b', weight: 1}]}, axiom = 'F'.repeat(4000);
  const a = text(expand(axiom, rules, 1, {seed: 9})), b = text(expand(axiom, rules, 1, {seed: 9}));
  assert.equal(a, b); assert.notEqual(text(expand(axiom, rules, 1, {seed: 10})), a);
  const share = [...a].filter(c => c === 'a').length / a.length; assert.ok(Math.abs(share - 0.75) < 0.03, `share ${share}`);
});

test('parametric rules use conditions and functions of the parameters', () => {
  // A(l): grow while l > 1, shrinking by half each step, and stop as a leaf L.
  const rules = {A: [{condition: l => l > 1, successor: l => `F(${l})[+A(${l / 2})]A(${l / 2})`}, {condition: l => l <= 1, successor: 'L'}]};
  const out = expand('A(4)', rules, 4);
  assert.equal(text(out), 'F(4)[+F(2)[+L]L]F(2)[+L]L');
  assert.deepEqual(expand('B(1)', {B: {successor: x => [{symbol: 'C', params: [x + 1]}]}}, 3), [{symbol: 'C', params: [2]}]);
});

test('turtle draws, turns and branches; tubes connect continuing segments', () => {
  const b = interpret(parseModules('F[+F]F'), {angle: 90, step: 2, radius: 0.2});
  assert.deepEqual([...b.positions], [0, 0, 0, 0, 2, 0, 0, 2, 0, -2, 2, 0, 0, 2, 0, 0, 4, 0].map(v => Math.fround(v)));
  assert.deepEqual([...b.parents], [-1, 0, 0]); assert.deepEqual([...b.depths], [0, 1, 0]);
  const moved = interpret(parseModules('FfF!F(3)'));
  assert.deepEqual([...moved.parents], [-1, -1, 1]); assert.equal(moved.positions[16], 6); assert.ok(Math.abs(moved.radii[2] - 0.07) < 1e-7);
  const pitch = interpret(parseModules('&(90)F'));
  assert.ok(Math.abs(pitch.positions[5] + 1) < 1e-6, 'pitching down turns the heading toward -up');
  assert.throws(() => interpret(parseModules('F]')), /Unbalanced/);

  const mesh = tubes(b, {radialSegments: 6}), ring = 6;
  // Trunk start, shared trunk joint, side branch start and two tips: five rings; three segments of 2 * 6 triangles.
  assert.equal(mesh.vertices.length / 6, 5 * ring); assert.equal(mesh.indices.length, 3 * ring * 6);
  for (let v = 0; v < mesh.vertices.length; v += 6) {
    const n = mesh.vertices.subarray(v + 3, v + 6); assert.ok(Math.abs(Math.hypot(...n) - 1) < 1e-5);
  }
  // Outward winding: each face normal points away from its segment's axis.
  const V = mesh.vertices, I = mesh.indices, at = i => [V[i * 6], V[i * 6 + 1], V[i * 6 + 2]];
  for (let t = 0; t < 12; t += 3) {
    const [a, c, d] = [at(I[t]), at(I[t + 1]), at(I[t + 2])], u = [0, 1, 2].map(k => c[k] - a[k]), w = [0, 1, 2].map(k => d[k] - a[k]);
    const normal = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]], center = [0, 1, 2].map(k => (a[k] + c[k] + d[k]) / 3);
    assert.ok(normal[0] * center[0] + normal[2] * center[2] > 0, 'trunk faces point outward');
  }
  assert.throws(() => tubes(b, {radialSegments: 2}), /tube/);
});

test('a stochastic plant is reproducible end to end', () => {
  const plant = seed => tubes(interpret(expand('X', {X: [{successor: 'F[+X][-X]FX', weight: 2}, {successor: 'F[&X]F[^X]X'}], F: 'FF'}, 4, {seed}), {angle: 22.5, step: 0.1, radius: 0.02}));
  const a = plant(5), b = plant(5);
  assert.deepEqual(a.vertices, b.vertices); assert.deepEqual(a.indices, b.indices); assert.notDeepEqual(plant(6).vertices, a.vertices);
});
