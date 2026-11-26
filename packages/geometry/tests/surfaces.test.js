// Named surfaces against their defining identities: where the Klein bottle and the Möbius strip glue to themselves, the
// Möbius band's area, and the knot tubes' volume against pi r^2 times the centre line's length.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  kleinBottleGeometry,
  kleinBottleSurface,
  kleinFigure8Surface,
  mobiusStripGeometry,
  mobiusSurface,
  knotGeometry,
} from '../dist/extras.js';
import { assertValid, close, signedVolume, surfaceArea, vertexCount } from './support/mesh-checks.js';

const at = (fn, u, v) => {
  const target = [0, 0, 0];
  fn(u, v, target);
  return target;
};
const near = (a, b, tolerance, label) => a.forEach((x, i) => close(x, b[i], tolerance, `${label}[${i}]`));

test('classic Klein bottle glues P(0, v) to P(1, 1/2 - v), and is about 8 units across', () => {
  const f = kleinBottleSurface();
  for (const v of [0, 0.1, 0.23, 0.5, 0.77, 0.9]) near(at(f, 0, v), at(f, 1, (0.5 - v + 1) % 1), 1e-12, `v=${v}`);
  // the v seam: P(u, 0) = P(u, 1)
  for (const u of [0, 0.3, 0.8]) near(at(f, u, 0), at(f, u, 1), 1e-12, `u=${u}`);
  let reach = 0;
  for (let i = 0; i <= 20; i++) for (let j = 0; j <= 20; j++) reach = Math.max(reach, Math.hypot(...at(f, i / 20, j / 20)));
  assert.ok(reach > 3.5 && reach < 5, `reach ${reach}`);
  assertValid(kleinBottleGeometry(), 'bottle');
});

test('figure-8 Klein bottle glues P(1, v) to P(0, 1 - v) and scales', () => {
  const f = kleinFigure8Surface(2);
  for (const v of [0, 0.15, 0.4, 0.75]) near(at(f, 1, v), at(f, 0, (1 - v) % 1), 1e-12, `v=${v}`);
  const g = kleinBottleGeometry({ kind: 'figure8', radius: 2, scale: 3 });
  const base = kleinBottleGeometry({ kind: 'figure8', radius: 2 });
  assertValid(g, 'figure8');
  close(g.positions[10], base.positions[10] * 3, 1e-5, 'scaled coordinate');
  assert.equal(vertexCount(g), 65 * 33);
});

test('Möbius strip: one half twist has one edge, its area is 2 pi R w, two half twists have two edges', () => {
  const f = mobiusSurface(1, 0.5, 1);
  for (const v of [0, 0.3, 1]) near(at(f, 0, v), at(f, 1, 1 - v), 1e-12, `v=${v}`);
  const strip = mobiusStripGeometry({ radius: 1, width: 0.5, slices: 256, stacks: 8 });
  close(surfaceArea(strip), 2 * Math.PI * 1 * 0.5, 0.02, 'area');
  assertValid(strip, 'mobius');
  const two = mobiusSurface(1, 0.5, 2);
  for (const v of [0, 0.3, 1]) near(at(two, 0, v), at(two, 1, v), 1e-12, `two v=${v}`); // an annulus: the ends meet without a flip
  assert.throws(() => mobiusStripGeometry({ halfTwists: 0 }), /halfTwists/);
  assert.throws(() => mobiusStripGeometry({ width: -1 }), /positive/);
});

const lengths = {
  'trefoil': [(t) => [Math.sin(t) + 2 * Math.sin(2 * t), Math.cos(t) - 2 * Math.cos(2 * t), -Math.sin(3 * t)], 1],
  'figure-eight': [(t) => [(2 + Math.cos(2 * t)) * Math.cos(3 * t), (2 + Math.cos(2 * t)) * Math.sin(3 * t), Math.sin(4 * t)], 1],
  'cinquefoil': [(t) => [(2 + Math.cos((5 * t) / 2)) * Math.cos(t), (2 + Math.cos((5 * t) / 2)) * Math.sin(t), Math.sin((5 * t) / 2)], 2],
  'three-twist': [(t) => [(2 + Math.cos((7 * t) / 2)) * Math.cos(t), (2 + Math.cos((7 * t) / 2)) * Math.sin(t), Math.sin((7 * t) / 2)], 2],
};
for (const [name, [curve, turns]] of Object.entries(lengths))
  test(`${name} tube has volume pi r^2 L of its centre line and outward winding`, () => {
    const r = 0.05;
    let L = 0,
      prev = curve(0);
    const n = 20000;
    for (let i = 1; i <= n; i++) {
      const p = curve((i / n) * 2 * Math.PI * turns);
      L += Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]);
      prev = p;
    }
    const g = knotGeometry(name, { tube: r, tubularSegments: 400, radialSegments: 16 });
    assertValid(g, name);
    const volume = signedVolume(g);
    assert.ok(volume > 0, 'normals outward');
    close(volume / (Math.PI * r * r * L), 1, 0.03, `${name} volume ratio`);
  });

test('knot and surface options are validated', () => {
  assert.throws(() => knotGeometry('granny'), /unknown/);
  assert.throws(() => knotGeometry('trefoil', { tube: 0 }), /tube/);
  assert.throws(() => knotGeometry('trefoil', { radialSegments: 2 }), /radialSegments/);
  assert.throws(() => kleinBottleGeometry({ kind: 'plane' }), /kind/);
  assert.throws(() => kleinBottleGeometry({ scale: 0 }), /scale/);
});
