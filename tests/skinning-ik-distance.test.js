import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

mkdirSync(resolve('test-results'), { recursive: true });
const temporary = mkdtempSync(resolve('test-results/ik-distance-')),
  path = join(temporary, 'distance.mjs');
const bundle = await build({
  configFile: false,
  publicDir: false,
  logLevel: 'silent',
  build: {
    write: false,
    minify: false,
    target: 'es2022',
    lib: { entry: resolve('examples/skinning-ik/body-distance.ts'), formats: ['es'] },
  },
});
writeFileSync(path, bundle[0].output[0].code);
const { BodyDistance, newDistance } = await import(pathToFileURL(path).href);
unlinkSync(path);
rmdirSync(temporary);

function hull(points) {
  return (direction) => {
    let best = points[0],
      value = best[0] * direction[0] + best[1] * direction[1] + best[2] * direction[2];
    for (const point of points) {
      const next = point[0] * direction[0] + point[1] * direction[1] + point[2] * direction[2];
      if (next > value) {
        value = next;
        best = point;
      }
    }
    return best;
  };
}
function sphere(center, radius) {
  const out = [0, 0, 0];
  return (direction) => {
    const inverse = 1 / Math.hypot(...direction);
    for (let i = 0; i < 3; i++) out[i] = center[i] + direction[i] * inverse * radius;
    return out;
  };
}
const box = hull(Array.from({ length: 8 }, (_, index) => [index & 1 ? 1 : -1, index & 2 ? 1 : -1, index & 4 ? 1 : -1]));

test('flat GJK agrees with analytic sphere-to-box distances away from the acceptance threshold', () => {
  const kernel = new BodyDistance(box),
    out = newDistance();
  for (let i = 0; i < 160; i++) {
    const center = [Math.sin(i * 1.7) * 2.4, Math.cos(i * 0.73) * 2.2, Math.sin(i * 0.37) * 2.5],
      radius = 0.2,
      outside = Math.hypot(...center.map((value) => Math.max(0, Math.abs(value) - 1))),
      expected = outside - radius;
    if (Math.abs(expected) < 0.03) continue;
    assert.equal(kernel.query(sphere(center, radius), out), undefined);
    assert.equal(out[1], expected < 0 ? 1 : 0);
    assert.ok(Math.abs(out[0] - Math.max(0, expected)) < 3e-5, `analytic gap ${expected}, measured ${out[0]}`);
  }
});

test('flat GJK preserves degenerate point, line, and coplanar hull clearance', () => {
  const out = newDistance(),
    origin = new BodyDistance(hull([[0, 0, 0]]));
  origin.query(hull([[1, 2, 3]]), out);
  assert.equal(out[0], Math.hypot(1, 2, 3));
  assert.equal(out[1], 0);
  origin.query(
    hull([
      [-1, 0, 0],
      [1, 0, 0],
    ]),
    out,
  );
  assert.equal(out[0], 0);
  assert.equal(out[1], 1);
  const plane = new BodyDistance(
    hull([
      [-1, -1, 0],
      [1, -1, 0],
      [0, 1, 0],
    ]),
  );
  plane.query(hull([[0.2, 0.3, 2]]), out);
  assert.ok(Math.abs(out[0] - 2) < 1e-12);
  assert.equal(out[1], 0);
  plane.query(hull([[0, 0, 0]]), out);
  assert.equal(out[0], 0);
  assert.equal(out[1], 1);
});

test('kernel scratch never escapes into retained caller outputs or another instance', () => {
  const first = new BodyDistance(box),
    second = new BodyDistance(hull([[0, 0, 0]])),
    retained = newDistance(),
    later = newDistance();
  first.query(sphere([3, 0, 0], 0.2), retained);
  const values = [...retained];
  for (let i = 0; i < 1000; i++) {
    second.query(sphere([2, 1, -1], 0.3), later);
    first.query(sphere([0.1, -0.2, 0.3], 0.2), later);
    assert.deepEqual([...retained], values);
  }
});
