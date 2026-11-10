import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { Spline } from '../dist/index.js';
import { intersectSplines } from '../dist/query.js';

const wave = (n, phase, z = 0) =>
  Array.from({ length: n }, (_, i) => [i / (n - 1), 0.3 * Math.sin(i * 1.7 + phase), z]);
const curves = [
  () => [new Spline(wave(9, 0)), new Spline(wave(9, 1.3))],
  () => [new Spline(wave(7, 0.4), { kind: 'bspline' }), new Spline(wave(11, 2), { kind: 'kochanek-bartels', tension: 0.3, bias: -0.2 })],
  () => [new Spline(wave(6, 0), { closed: true }), new Spline(wave(5, 0.9), { kind: 'bspline', closed: true })],
  () => [new Spline(wave(10, 0), { kind: 'bezier' }), new Spline(wave(9, 0.2))],
  () => {
    const a = new Spline(wave(8, 0.5));
    return [a, new Spline(wave(8, 0.5))];
  },
  () => [
    new Spline(wave(5, 0), { kind: 'hermite', tangents: wave(5, 2).map(([x, y, z]) => [1, y, z]) }),
    new Spline(wave(6, 1)),
  ],
];

const bytes = (r) =>
  Buffer.concat([
    Buffer.from(new Float64Array(r.points.flatMap((p) => [p.t, p.otherT ?? -1, ...p.point])).buffer),
    Buffer.from(new Float64Array(r.overlaps.flatMap((o) => [o.t0, o.t1, o.otherT0 ?? -1, o.otherT1 ?? -1])).buffer),
  ]);

test('curve-curve intersection reconstructs each segment once', () => {
  const at = Spline.prototype.at;
  let calls = 0;
  const [a, b] = curves[0]();
  Spline.prototype.at = function (...args) {
    calls++;
    return at.apply(this, args);
  };
  try {
    intersectSplines(a, b);
  } finally {
    Spline.prototype.at = at;
  }
  // Parent: 512, four point evaluations per segment for every one of the 8 x 8 segment pairs, both sides.
  assert.equal(calls, 64);
});

test('six curve pairs retain every intersection byte from the parent', () => {
  const hash = createHash('sha256');
  let size = 0, hits = 0, spans = 0;
  for (const make of curves) {
    const [a, b] = make(),
      r = intersectSplines(a, b),
      out = bytes(r);
    hits += r.points.length;
    spans += r.overlaps.length;
    size += out.length;
    hash.update(out);
  }
  assert.deepEqual([size, hits, spans], [1264, 26, 7]);
  assert.equal(hash.digest('hex'), '769dc0b4158961ab3161e435586b94d1f5dee85cb8aa33fae79536390a6bff0b');
});
