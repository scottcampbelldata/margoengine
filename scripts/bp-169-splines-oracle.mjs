// Black-box value comparison only: Margo Catmull-Rom points against three.js CatmullRomCurve3 run from an external
// install. No timings and no rival source inspection.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Spline } from '../packages/splines/dist/index.js';
import { intersectSplines } from '../packages/splines/dist/query.js';

const root = resolve(import.meta.dirname, '..');
const external = process.argv.find((a) => a.startsWith('--three='))?.slice(8);
assert.ok(external && isAbsolute(external), 'Supply --three=<absolute external three package directory>');
const rel = relative(root, external);
assert.ok(rel.startsWith('..') || isAbsolute(rel), 'Install the rival outside this repository');
const manifest = JSON.parse(readFileSync(resolve(external, 'package.json'), 'utf8'));
assert.equal(manifest.name, 'three');
const THREE = await import(pathToFileURL(resolve(external, 'build/three.module.js')).href);
const wave = (n, phase) => Array.from({ length: n }, (_, i) => [i / (n - 1), 0.3 * Math.sin(i * 1.7 + phase), 0]);
const cases = [
  ['open-9', wave(9, 0), false],
  ['open-9-shifted', wave(9, 1.3), false],
  ['closed-6', wave(6, 0), true],
];
for (const [name, points, closed] of cases) {
  const margo = new Spline(points, { closed }),
    rival = new THREE.CatmullRomCurve3(
      points.map((p) => new THREE.Vector3(...p)),
      closed,
      'catmullrom',
      0.5,
    );
  let interior = 0,
    ends = 0;
  const segments = closed ? points.length : points.length - 1;
  for (let k = 0; k <= 400; k++) {
    const t = k / 400,
      a = margo.at(t, new Float64Array(3)),
      b = rival.getPoint(t),
      d = Math.max(Math.abs(a[0] - b.x), Math.abs(a[1] - b.y), Math.abs(a[2] - b.z));
    // Open curves pick their end neighbours differently; report the first and last segments separately.
    const segment = Math.min(segments - 1, Math.floor(t * segments));
    if (!closed && (segment === 0 || segment === segments - 1)) ends = Math.max(ends, d);
    else interior = Math.max(interior, d);
  }
  console.log(JSON.stringify({ case: name, three: manifest.version, samples: 401, interiorMaxError: interior, endSegmentMaxError: ends }));
}
const [a, b] = [new Spline(wave(9, 0)), new Spline(wave(9, 1.3))],
  hits = intersectSplines(a, b);
console.log(JSON.stringify({ case: 'intersections', points: hits.points.length, rival: 'none (three.js has no curve-curve intersection)' }));
