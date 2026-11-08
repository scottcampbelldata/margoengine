import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '@margoengine/core/extension';
import { PlanetTerrain, cubeSphere, planetNoise } from '../dist/planet.js';

const R = 6371000;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
};
// The inverse of cubeSphere: the face and (s, t) of a unit direction (face axes as in src/planet.ts).
const FACES = [
  [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
  [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
  [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
  [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
  [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
  [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
];
function faceOf(d) {
  let face = 0;
  for (let f = 1; f < 6; f++) if (dot(FACES[f][0], d) > dot(FACES[face][0], d)) face = f;
  const [n, u, v] = FACES[face],
    w = dot(n, d);
  return { face, s: (Math.atan(dot(u, d) / w) * 4) / Math.PI, t: (Math.atan(dot(v, d) / w) * 4) / Math.PI };
}
const inside = (patch, d) => {
  const { face, s, t } = faceOf(d),
    size = 2 / 2 ** patch.level,
    e = 1e-9;
  return (
    face === patch.face &&
    s >= -1 + patch.x * size - e &&
    s <= -1 + (patch.x + 1) * size + e &&
    t >= -1 + patch.y * size - e &&
    t <= -1 + (patch.y + 1) * size + e
  );
};
const look = (position, target, fov = 60) => new Camera({ position, target, fov, near: 0.5, far: 1e9 });

test('cubeSphere: unit directions, faces meet edge to edge, and cells within a factor 1.5 of each other in area', () => {
  const edges = [];
  for (let face = 0; face < 6; face++)
    for (let k = 0; k <= 16; k++) {
      const q = -1 + k / 8;
      for (const [s, t] of [[q, -1], [q, 1], [-1, q], [1, q]]) edges.push({ face, p: cubeSphere(face, s, t) });
    }
  for (const { face, p } of edges) {
    assert.ok(Math.abs(Math.hypot(...p) - 1) < 1e-15);
    // Every point on a face's edge is a point on another face's edge: no gap or overlap between faces.
    assert.ok(edges.some((o) => o.face !== face && Math.hypot(o.p[0] - p[0], o.p[1] - p[1], o.p[2] - p[2]) < 1e-12));
  }
  // The equal-angle warp keeps cell areas close (the plain gnomonic projection's ratio is about 5.2 on this grid).
  const n = 32,
    areas = [];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const a = cubeSphere(0, -1 + (2 * i) / n, -1 + (2 * j) / n),
        b = cubeSphere(0, -1 + (2 * (i + 1)) / n, -1 + (2 * j) / n),
        c = cubeSphere(0, -1 + (2 * i) / n, -1 + (2 * (j + 1)) / n),
        ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
        ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      areas.push(Math.hypot(ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]));
    }
  assert.ok(Math.max(...areas) / Math.min(...areas) < 1.5, `area ratio ${Math.max(...areas) / Math.min(...areas)}`);
  assert.throws(() => cubeSphere(6, 0, 0), RangeError);
});

test('planetNoise: deterministic, within its relief, and coarser detail leaves out the fine octaves', () => {
  const h = planetNoise({ radius: R, relief: 8000, seed: 3 }),
    other = planetNoise({ radius: R, relief: 8000, seed: 4 });
  let differs = 0;
  for (let i = 0; i < 200; i++) {
    const d = norm([Math.sin(i * 1.7), Math.cos(i * 0.9), Math.sin(i * 0.37 + 1)]),
      full = h(...d, 0);
    assert.equal(full, h(...d, 0));
    assert.ok(Math.abs(full) <= 8000);
    if (full !== other(...d, 0)) differs++;
    // With a detail of 100 km only octaves of 200 km and longer remain: what is left out is at most their amplitude.
    assert.ok(Math.abs(full - h(...d, 100000)) <= (8000 / 2) * (200000 / (R / 2)) * 2 + 1e-9);
  }
  assert.ok(differs > 190);
  assert.throws(() => planetNoise({ radius: 0 }), RangeError);
});

test('options: invalid values throw, every default holds', () => {
  const p = new PlanetTerrain();
  assert.deepEqual(
    [p.radius, p.resolution, p.maxLevel, p.maxPatches, p.screenError, p.budget, p.seaLevel, p.relief, p.center],
    [R, 32, 20, 2048, 4, 4, 0, 8000, [0, 0, 0]],
  );
  for (const bad of [
    { radius: 0 },
    { radius: Infinity },
    { center: [0, 0] },
    { center: [0, NaN, 0] },
    { relief: -1 },
    { seaLevel: NaN },
    { resolution: 5 },
    { resolution: 66 },
    { maxLevel: 25 },
    { maxLevel: 1.5 },
    { screenError: 0 },
    { budget: -1 },
    { maxPatches: 5 },
  ])
    assert.throws(() => new PlanetTerrain(bad), RangeError, JSON.stringify(bad));
  assert.throws(() => new PlanetTerrain({ height: 3 }), TypeError);
  assert.throws(() => new PlanetTerrain({ origin: {} }), TypeError);
  assert.throws(() => p.update(look([0, 0, 3 * R], [0, 0, 0]), [0, 10]), RangeError);
});

test('from orbit: a few coarse patches, none on the far side (horizon culling)', () => {
  const p = new PlanetTerrain({ budget: Infinity }),
    camera = look([0, 0, 3 * R], [0, 0, 0]);
  let stats;
  for (let i = 0; i < 4; i++) stats = p.update(camera, [1280, 720]);
  assert.ok(stats.drawn >= 6 && stats.drawn < 200, JSON.stringify(stats));
  assert.ok(stats.level <= 5, JSON.stringify(stats));
  for (const patch of p.patches) {
    const size = 2 / 2 ** patch.level,
      c = cubeSphere(patch.face, -1 + (patch.x + 0.5) * size, -1 + (patch.y + 0.5) * size);
    // The visible cap reaches acos(1/3) = 70.5 degrees from the point under the camera; nothing drawn lies far past it.
    assert.ok(c[2] > -0.2, `a patch on the far side: ${JSON.stringify(patch)}`);
  }
});

test('near the ground: the ground in the middle of the view is fine enough for the screen error', () => {
  const p = new PlanetTerrain({ budget: Infinity }),
    up = norm([0.3, 0.8, 0.52]),
    ahead = norm([up[1], -up[0], 0]),
    ground = R + p.heightAt(up),
    eye = up.map((v) => v * (ground + 100)),
    target = eye.map((v, i) => v + ahead[i] * 100 - up[i] * 100),
    camera = look(eye, target),
    stats = p.update(camera, [1280, 720]);
  assert.ok(Math.abs(p.altitude(eye) - 100) < 1e-6);
  // One update with no budget plans and builds until nothing more is wanted.
  assert.equal(p.update(camera, [1280, 720]).built, 0);
  // The view's centre meets the ground about 140 m away: vertices at most 4 px apart there are 4 * 140 / 623 = 0.9 m
  // apart, level 19 at the Earth's size (0.6 m), or 18 where the ground rises toward the camera.
  const middle = norm(target),
    patch = p.patches.find((q) => inside(q, middle));
  assert.ok(patch && patch.level >= 18, JSON.stringify({ patch, stats }));
  assert.ok(stats.drawn <= p.maxPatches);
});

test('progressive refinement with no budget never leaves a hole in the visible cap', () => {
  const p = new PlanetTerrain({ budget: 0 }),
    d = 1.5 * R,
    camera = look([0, 0, d], [0, 0, 0], 100),
    cap = Math.acos(R / d) - 0.05;
  let previous = -1;
  for (let frame = 0; frame < 40; frame++) {
    const stats = p.update(camera, [800, 800]);
    assert.ok(stats.built <= (frame ? 1 : 7), JSON.stringify(stats));
    for (let k = 0; k < 400; k++) {
      // A spiral of directions over the cap facing the camera.
      const a = (cap * Math.sqrt((k + 0.5) / 400)),
        b = k * 2.39996,
        dir = [Math.sin(a) * Math.cos(b), Math.sin(a) * Math.sin(b), Math.cos(a)];
      assert.ok(p.patches.some((patch) => inside(patch, dir)), `frame ${frame}: hole at ${dir}`);
    }
    previous = Math.max(previous, stats.level);
  }
  assert.ok(previous >= 2, `refined to level ${previous}`);
});

test('a flight from orbit to the ground keeps within maxPatches, evicting the patches used longest ago', () => {
  const p = new PlanetTerrain({ budget: Infinity, maxPatches: 256 }),
    up = norm([0.1, 0.2, 1]);
  let deepest = 0;
  for (let i = 0; i <= 30; i++) {
    const ground = R + p.heightAt(up),
      altitude = 2 * R * 0.6 ** i + 2,
      eye = up.map((v) => v * (ground + altitude)),
      camera = look(eye, [0, 0, 0].map((_, k) => eye[k] + [0, 1, 0][k] * 1000 - up[k] * Math.max(altitude, 10)));
    const stats = p.update(camera, [640, 360]);
    assert.ok(stats.resident <= 256 && stats.drawn <= 256 && stats.drawn > 0, JSON.stringify(stats));
    deepest = Math.max(deepest, stats.level);
  }
  // 256 patches are too few for full detail 2 m above the ground; the ground nearest the camera is still refined first.
  assert.ok(deepest >= 14, `deepest level ${deepest}`);
});

test('a smaller screenError draws more and finer patches', () => {
  const camera = look([0, 0, 1.2 * R], [0, 0, 0]),
    run = (screenError) => {
      const p = new PlanetTerrain({ budget: Infinity, screenError });
      for (let i = 0; i < 6; i++) p.update(camera, [1280, 720]);
      return p.stats;
    },
    fine = run(2),
    coarse = run(16);
  assert.ok(fine.drawn > coarse.drawn && fine.level > coarse.level, JSON.stringify({ fine, coarse }));
});

test('sea level: ground under the sea reads as the sea surface; seaLevel false keeps the floor', () => {
  const height = () => -500,
    sea = new PlanetTerrain({ height }),
    floor = new PlanetTerrain({ height, seaLevel: false });
  assert.equal(sea.altitude([0, R + 100, 0]), 100);
  assert.equal(floor.altitude([0, R + 100, 0]), 600);
  assert.throws(() => new PlanetTerrain({ height: () => NaN }).heightAt([0, 1, 0]), RangeError);
});

test('a floating origin moves the planet with each rebase', () => {
  let listener, unsubscribed = 0;
  const origin = {
      origin: [0, 0, 0],
      onRebase(l) {
        listener = l;
        return () => unsubscribed++;
      },
    },
    p = new PlanetTerrain({ origin, height: () => 0 });
  assert.equal(p.altitude([0, R + 100, 0]), 100);
  listener([0, R, 0], [0, R, 0]);
  // The engine's coordinates are now relative to the new origin: the same world point is 100 m up.
  assert.equal(p.altitude([0, 100, 0]), 100);
  assert.deepEqual(p.center, [0, 0, 0]);
  p.dispose();
  assert.equal(unsubscribed, 1);
  assert.throws(() => p.update(look([0, 0, 3 * R], [0, 0, 0]), [10, 10]), { name: 'MargoError', code: 'disposed' });
});
