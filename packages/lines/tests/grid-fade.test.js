import test from 'node:test';
import assert from 'node:assert/strict';
import { GridHelper, PolarGridHelper } from '../dist/index.js';

// GAP-FILM-GRIDFADE: a grid with `fade` falls to alpha 0 by `far` from its centre, smoothly, so it melts into the
// horizon; without `fade` it draws as before (helpers.test.js pins those vectors).

/** Every point of a line as [x, z, alpha]. */
const points = (line) => {
  const out = [];
  for (let i = 0; i < line.count; i++) out.push([line.points[i * 4], line.points[i * 4 + 2], line.colors[i * 4 + 3]]);
  return out;
};
const smooth = (r, near, far) => {
  const t = Math.min(1, Math.max(0, (r - near) / (far - near)));
  return 1 - t * t * (3 - 2 * t);
};

test('GridHelper fade: full alpha within near, 0 by far, nothing drawn past far', () => {
  const grid = new GridHelper({ size: 100, divisions: 100, fade: { near: 20, far: 45 } }),
    all = points(grid);
  assert.ok(all.length > 0 && all.length % 2 === 0);
  for (const [x, z, a] of all) {
    const r = Math.hypot(x, z);
    assert.ok(r <= 45 + 1e-4, `no point past far (${r})`);
    assert.ok(Math.abs(a - smooth(r, 20, 45)) < 1e-5, `alpha at ${r} follows smoothstep`);
  }
  assert.ok(
    all.some(([x, z, a]) => Math.hypot(x, z) < 20 && a === 1),
    'full alpha near the centre',
  );
  assert.ok(
    all.some(([x, z, a]) => Math.abs(Math.hypot(x, z) - 45) < 1e-4 && a < 1e-6),
    'alpha 0 at far',
  );
  // Inside the band no piece is longer than a sixteenth of it, so the linear blend follows the curve.
  for (let i = 0; i < all.length; i += 2) {
    const [ax, az, aa] = all[i],
      [bx, bz, ba] = all[i + 1];
    if (aa < 1 - 1e-6 || ba < 1 - 1e-6) assert.ok(Math.hypot(bx - ax, bz - az) <= 25 / 16 + 1e-6);
  }
});

test('GridHelper without fade keeps its points at full alpha', () => {
  const plain = new GridHelper({ size: 10, divisions: 4 });
  assert.equal(plain.count, 5 * 4);
  assert.ok(points(plain).every(([, , a]) => a === 1));
});

test('PolarGridHelper fade dims the outer rings and cuts the sectors at far', () => {
  const polar = new PolarGridHelper({ radius: 50, sectors: 8, rings: 5, fade: { near: 10, far: 30 } }),
    all = points(polar);
  for (const [x, z, a] of all) {
    const r = Math.hypot(x, z);
    assert.ok(r <= 30 + 1e-4);
    assert.ok(Math.abs(a - smooth(r, 10, 30)) < 1e-5);
  }
  assert.ok(
    all.some(([x, z]) => Math.abs(Math.hypot(x, z) - 20) < 1e-3),
    'the 20 m ring is kept',
  );
  assert.ok(!all.some(([x, z]) => Math.abs(Math.hypot(x, z) - 40) < 1e-3), 'the 40 m ring is gone');
});

test('fade refuses bad ranges with a fix', () => {
  for (const fade of [{ near: 5, far: 5 }, { near: -1, far: 5 }, { near: 0, far: Infinity }, null, { near: 1 }])
    assert.throws(() => new GridHelper({ fade }), /Invalid grid fade; pass \{ near, far \}/);
  assert.throws(() => new PolarGridHelper({ fade: { near: 3, far: 2 } }), /Invalid grid fade/);
});
