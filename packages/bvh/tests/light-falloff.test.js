// Point/spot distance falloff and spot cone of bakeVertexColors against the light-falloff vectors (binding cases within
// 1e-5 relative), plus first-principles checks: inverse power laws, the range window and the near-light floor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bakeVertexColors } from '../dist/bake.js';

const vectors = JSON.parse(readFileSync(new URL('./fixtures/light-falloff.json', import.meta.url), 'utf8'));
const bake = (light, vertex, normal) =>
  bakeVertexColors({ positions: vertex, normals: normal }, null, { shadows: false, lights: [light] });

test('binding light-falloff vectors match within 1e-5 relative', () => {
  let checked = 0;
  for (const c of vectors.cases) {
    if (!c.binding) continue;
    const out = bake(c.light, c.vertex, c.normal);
    for (let k = 0; k < 4; k++) {
      const want = c.rgba[k],
        error = Math.abs(out[k] - want);
      // Values far below float32's resolution of 1 (a spot cone at its very edge, ~1e-27) compare absolutely.
      assert.ok(
        error <= 1e-5 * Math.abs(want) || error < 1e-20,
        `${JSON.stringify(c.light)} at ${c.vertex}: ${out[k]} vs ${want}`,
      );
    }
    checked++;
  }
  assert.ok(checked > 170, `${checked} binding cases`);
});

test('non-binding (floor-decided) cases are finite and capped by the near-light floor 2^-12', () => {
  for (const c of vectors.cases.filter((c) => !c.binding)) {
    const out = bake(c.light, c.vertex, c.normal),
      peak = c.light.intensity * 4096;
    assert.ok(out.every(Number.isFinite));
    assert.ok(out[0] > 0 && out[0] <= peak * (1 + 1e-6), `${out[0]} <= ${peak}`);
  }
  // Inside the floor radius (d^2 < 2^-12, d < 1/64) the falloff is flat at the peak.
  const light = { type: 'point', position: [0, 0, 0] },
    a = bake(light, [0.005, 0, 0], [-1, 0, 0])[0],
    b = bake(light, [0.01, 0, 0], [-1, 0, 0])[0];
  assert.equal(a, 4096);
  assert.equal(b, 4096);
});

test('inverse power laws, the range window and the hard spot edge from first principles', () => {
  const point = (decay, distance, d) =>
    bake({ type: 'point', position: [0, 0, 0], decay, distance }, [d, 0, 0], [-1, 0, 0])[0];
  for (const decay of [0, 1, 2, 3.5])
    for (const d of [0.5, 1, 3, 9]) {
      const want = 1 / Math.max(d ** decay, 2 ** -12);
      assert.ok(Math.abs(point(decay, 0, d) / want - 1) < 1e-6, `decay ${decay} d ${d}`);
      const window = Math.max(1 - (d / 10) ** 4, 0) ** 2;
      assert.ok(Math.abs(point(decay, 10, d) - want * window) <= 1e-6 * want, `window decay ${decay} d ${d}`);
    }
  assert.equal(point(2, 4, 4), 0, 'nothing at the range');
  assert.equal(point(2, 4, 5), 0, 'nothing past it');
  // The squared window reaches 0 with zero slope: (1 - x^4)^2 ~ 16 (1 - x)^2 just inside the range.
  const near = point(0, 10, 9.999);
  assert.ok(near > 0 && Math.abs(near / (16 * 1e-4 ** 2) - 1) < 2e-3, `${near}`);
  const spot = (penumbra, degrees) =>
    bake(
      { type: 'spot', position: [0, 0, 0], direction: [1, 0, 0], angle: 0.5, penumbra, decay: 0 },
      [Math.cos((degrees * Math.PI) / 180), Math.sin((degrees * Math.PI) / 180), 0],
      [-Math.cos((degrees * Math.PI) / 180), -Math.sin((degrees * Math.PI) / 180), 0],
    )[0];
  const edge = (0.5 * 180) / Math.PI;
  assert.equal(spot(0, edge - 0.01), 1);
  assert.equal(spot(0, edge + 0.01), 0);
  const inner = edge * 0.6,
    ramp = [inner + 1, (inner + edge) / 2, edge - 1].map((a) => spot(0.4, a));
  assert.ok(ramp[0] < 1 && ramp[0] > ramp[1] && ramp[1] > ramp[2] && ramp[2] > 0, `${ramp}`);
  assert.equal(spot(0.4, inner - 0.5), 1);
});
