import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOUNCE_BINDING,
  OPEN,
  basis,
  bounceIrradiance,
  bounceViews,
  bounceWgsl,
  buildVisibility,
  crossesOpening,
  packBounce,
  rectIrradiance,
  reduceBounce,
  sampleSurfaces,
  texelRay,
  texelSolidAngle,
} from '../dist/bounce.js';
import { clusteredSampling } from '../dist/index.js';
import { blocked } from './ltc-reference.js';

// KB-CABIN-SNOWBOUNCE1: one bounce of light from point, spot and opening lights. The scenes here are rectangles,
// captured by casting each texel's ray in JS (the GPU draws the same capture in scripts/clustered-bounce-gpu-check.js),
// so every figure has an analytic or brute-force reference.

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** A two-sided rectangle: centre c, half-extent vectors u and v, albedo. */
const rect = (c, u, v, albedo) => ({ c, u, v, albedo, n: unit(cross(u, v)) }),
  cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  unit = (a) => {
    const l = Math.hypot(...a);
    return a.map((x) => x / l);
  };
/** Nearest hit along origin + t d (t > near, default 1e-6), or undefined. */
function cast(scene, origin, d, far = Infinity, near = 1e-6) {
  let best;
  for (const r of scene) {
    const denom = dot(d, r.n);
    if (Math.abs(denom) < 1e-12) continue;
    const t = dot(sub(r.c, origin), r.n) / denom;
    if (!(t > near) || t >= far || (best && t >= best.t)) continue;
    const p = sub(origin.map((o, k) => o + d[k] * t), r.c);
    if (Math.abs(dot(p, r.u)) > dot(r.u, r.u) + 1e-9 || Math.abs(dot(p, r.v)) > dot(r.v, r.v) + 1e-9) continue;
    best = { t, r };
  }
  return best;
}
/**
 * The capture of `source` over `scene`, as the GPU writes it: albedo and distance per texel. `clip` is the capture
 * camera's near plane, a depth along the view's forward (LightBounce's is near / 2, from 0.01 to 0.05 m); default none.
 */
function capture(scene, source, resolution, clip = 0) {
  const views = bounceViews(source),
    texels = new Float32Array(views.length * resolution * resolution * 4);
  views.forEach((view, f) => {
    for (let j = 0; j < resolution; j++)
      for (let i = 0; i < resolution; i++) {
        const ray = texelRay(view, resolution, i, j),
          hit = cast(scene, view.eye, ray, Infinity, Math.max(1e-6, clip / dot(ray, view.forward)));
        if (!hit) continue;
        texels.set([...hit.r.albedo, hit.t], ((f * resolution + j) * resolution + i) * 4);
      }
  });
  return { views, resolution, texels };
}
/** An axis-aligned box's six inner faces (a room), each two-sided. */
const box = (lo, hi, albedo) => {
  const c = lo.map((l, k) => (l + hi[k]) / 2),
    h = hi.map((x, k) => (x - lo[k]) / 2),
    out = [];
  for (let axis = 0; axis < 3; axis++)
    for (const s of [-1, 1]) {
      const a = (axis + 1) % 3,
        b = (axis + 2) % 3,
        centre = [...c],
        u = [0, 0, 0],
        v = [0, 0, 0];
      centre[axis] += s * h[axis];
      u[a] = h[a];
      v[b] = h[b];
      out.push(rect(centre, u, v, albedo));
    }
  return out;
};

// A wall point at height c over the middle of the edge of a 2 x 2 m patch on the floor (a = 2 out from the wall,
// b = 1 to each side), the wall facing the patch: integrating z c / (pi r^4) over the patch gives
// F = 2 [atan(b / c) - c / sqrt(a^2 + c^2) atan(b / sqrt(a^2 + c^2))] / (2 pi) (Howell's catalogue, a differential
// element to a perpendicular rectangle, by superposition of the two halves).
const formFactor = (c, a = 2, b = 1) => (2 * (Math.atan(b / c) - (c / Math.hypot(a, c)) * Math.atan(b / Math.hypot(a, c)))) / (2 * Math.PI);
test('the patch-to-wall form factor matches midpoint quadrature to 1e-5', () => {
  for (const [c, expected] of [[0.5, 0.31755], [1, 0.19014]]) {
    const steps = 1000;
    let sum = 0;
    for (let ix = 0; ix < steps; ix++)
      for (let iz = 0; iz < steps; iz++) {
        const x = -1 + ((ix + 0.5) / steps) * 2,
          z = ((iz + 0.5) / steps) * 2,
          r2 = x * x + c * c + z * z;
        sum += (z * c) / (Math.PI * r2 * r2);
      }
    sum *= (2 / steps) * (2 / steps);
    assert.ok(Math.abs(formFactor(c) - sum) < 1e-5, `c ${c}: ${formFactor(c)} vs quadrature ${sum}`);
    assert.ok(Math.abs(formFactor(c) - expected) < 1e-5);
  }
});

test('texel solid angles sum to 4 pi over a cube and to the cone view over a spot', () => {
  let sum = 0;
  for (let f = 0; f < 6; f++) for (let j = 0; j < 32; j++) for (let i = 0; i < 32; i++) sum += texelSolidAngle(1, 32, i, j);
  assert.ok(Math.abs(sum - 4 * Math.PI) < 1e-9, `cube ${sum}`);
  const t = Math.tan(0.3);
  let spot = 0;
  for (let j = 0; j < 16; j++) for (let i = 0; i < 16; i++) spot += texelSolidAngle(t, 16, i, j);
  assert.ok(Math.abs(spot - 4 * Math.asin(t * t / (1 + t * t))) < 1e-9, `spot view ${spot}`);
});

test("Lambert's polygon irradiance of a rectangle matches quadrature, clipped at the receiver's horizon", () => {
  const source = { kind: 'rect', position: [0, 1, 0], normal: [0, 0, 1], u: [0.5, 0, 0], v: [0, 0.5, 0] };
  for (const [x, n] of [
    [[0.2, 0.3, 1.5], [0, 0, -1]],
    [[0.3, 1, 0.8], [0, 1, 0]],
    [[0.1, 0, 2], [0, 0.6, -0.8]],
  ]) {
    const steps = 600;
    let sum = 0;
    for (let a = 0; a < steps; a++)
      for (let b = 0; b < steps; b++) {
        const p = [-0.5 + (a + 0.5) / steps, 0.5 + (b + 0.5) / steps, 0],
          w = sub(p, x),
          r = Math.hypot(...w),
          ci = dot(n, w) / r,
          cs = -w[2] / r;
        if (ci > 0 && cs > 0) sum += (ci * cs) / (Math.PI * r * r);
      }
    sum /= steps * steps;
    assert.ok(Math.abs(rectIrradiance(source, x, n) / Math.PI - sum) < 2e-4 * Math.max(sum, 0.01), `${x}: ${rectIrradiance(source, x, n) / Math.PI} vs ${sum}`);
  }
  assert.equal(rectIrradiance(source, [0, 1, -1], [0, 0, 1]), 0, 'one-sided: nothing behind it');
});

// KB-BOUNCE-CAPEYE1: an opening's capture looked out from the rectangle's centre, which in a window of four lites lies
// inside the crossing of its bars; the capture draws back faces, so it saw the bars' inner faces and lit them. It now
// looks out from in front of the bars (`front`), or from the mouth of its reveal (`recess`) when that is further out.
test("an opening's capture looks out from in front of its glazing bars, and sees none of their inside", () => {
  const glass = 0.004,
    depth = 0.05,
    bar = 0.045,
    // Cabin Hearth's window: 1.2 x 1.1 m, its light on the glass's outdoor face at z 0, four lites.
    // `front`: half the bar depth and the capture camera's near distance (0.05 m at `near` 0.15), as LightBounce sets it.
    source = { kind: 'rect', position: [0, 1.5, 0], normal: [0, 0, 1], u: [0.6, 0, 0], v: [0, 0.55, 0], front: 0.075 },
    mid = -glass / 2,
    bars = [
      box([-bar / 2, 0.95, mid - depth / 2], [bar / 2, 2.05, mid + depth / 2], [0.3, 0.2, 0.1]),
      box([-0.6, 1.5 - bar / 2, mid - depth / 2], [0.6, 1.5 + bar / 2, mid + depth / 2], [0.3, 0.2, 0.1]),
    ].flat(),
    snow = rect([0, 0, 2], [3, 0, 0], [0, 0, 2], [0.9, 0.92, 0.95]),
    // On a bar's surface (closed boxes, 0.1 mm slack for the distance's rounding).
    onBars = (p) =>
      Math.abs(p[2] - mid) <= depth / 2 + 1e-4 &&
      ((Math.abs(p[0]) <= bar / 2 + 1e-4 && p[1] > 0.95 - 1e-4 && p[1] < 2.05 + 1e-4) ||
        (Math.abs(p[1] - 1.5) <= bar / 2 + 1e-4 && Math.abs(p[0]) <= 0.6 + 1e-4));
  assert.deepEqual(bounceViews(source)[0].eye, [0, 1.5, 0.075]);
  assert.deepEqual(bounceViews({ ...source, recess: 0.216 })[0].eye, [0, 1.5, 0.216], 'the mouth of a deeper reveal');
  assert.deepEqual(bounceViews({ ...source, front: 0 })[0].eye, [0, 1.5, 0], 'no bars, no reveal: the centre');
  // Texels on a bar that the opening's light lights: from inside the crossing, its inner faces. The capture camera's
  // near plane (0.05 m) clips the faces round the eye, so it sees along the bars to their far inner faces.
  const seen = (s) => {
    const out = reduceBounce(capture([...bars, snow], s, 32, 0.05), s, { vpls: 32, near: 0.15 });
    return { lit: out.points.filter((p) => onBars(p.position) && rectIrradiance(s, p.position, p.normal) > 0).length, out };
  };
  const before = seen({ ...source, front: 0 }),
    after = seen(source);
  assert.ok(before.lit > 0, `from the centre the capture lights the bars' inner faces (${before.lit} texels)`);
  assert.equal(after.lit, 0, 'from in front of the bars it sees only their unlit outer faces');
  assert.ok(after.out.flux[1] > 0, 'it still sees the lit snow');
});

// KB-BOUNCE-REVEAL1: an opening's light set back in its wall lights only what its reveal and sill let it reach, so
// the snow it bounces off is lit as the opening light lights it (`AreaLights` clips the same rectangle).
test("a recessed opening's irradiance is the rectangle its reveal and sill let through, as a traced wall", () => {
  const source = { kind: 'rect', position: [0, 1.5, 0], normal: [0, 0, 1], u: [0.6, 0, 0], v: [0, 0.55, 0], recess: 0.22, sill: 0.09 },
    bare = { ...source, recess: 0, sill: 0 },
    wall = { center: source.position, right: source.u, up: source.v, recess: source.recess, sill: source.sill };
  let shaded = 0;
  for (const [x, n] of [
    [[0.3, 0.1, 0.6], [0, 1, 0]],
    [[0, 0.1, 1.2], [0, 1, 0]],
    [[1.4, 0.1, 1.5], [0, 1, 0]],
    [[0.2, 1.6, 2], [0, 0, -1]],
    [[0.1, 0.951, 0.28], [0, 1, 0]],
  ]) {
    const steps = 400;
    let sum = 0;
    for (let a = 0; a < steps; a++)
      for (let b = 0; b < steps; b++) {
        const p = [-0.6 + (1.2 * (a + 0.5)) / steps, 0.95 + (1.1 * (b + 0.5)) / steps, 0],
          w = sub(p, x),
          r = Math.hypot(...w),
          ci = dot(n, w) / r,
          cs = -w[2] / r;
        if (ci > 0 && cs > 0 && !blocked(p, x, wall)) sum += (ci * cs * 1.2 * 1.1) / (Math.PI * r * r);
      }
    sum /= steps * steps;
    const got = rectIrradiance(source, x, n) / Math.PI;
    // Midpoint quadrature errs to first order where the reveal cuts the rectangle: 1% at 400 x 400.
    assert.ok(Math.abs(got / sum - 1) < 0.01, `${x}: ${got} vs traced ${sum}`);
    if (rectIrradiance(bare, x, n) / Math.PI > 1.1 * sum) shaded++;
  }
  assert.equal(shaded, 3, 'the reveal and sill shade the near, middle and side snow');
  assert.equal(rectIrradiance(source, [-1, 1.5, 0.221], [0, 0, 1]), 0, 'beside the opening on the wall face');
  assert.equal(rectIrradiance(source, [0, 0.8, 0.25], [0, 0, 1]), 0, 'under the sill');
});

// The patch under a spot 100 m up (intensity 1e4, half angle atan 0.02, 1.15 degrees): direct irradiance 1 on the
// patch, which fills the middle 16 x 16 texels of the 32 x 32 capture.
const patchScene = [rect([0, 0, 1], [1, 0, 0], [0, 0, 1], [0.8, 0.8, 0.8])],
  spot = { kind: 'point', position: [0, 100, 1], range: 0, direction: [0, -1, 0], cosOuter: 1 / Math.hypot(1, 0.02), cosInner: 1 / Math.hypot(1, 0.02) },
  patch = () => reduceBounce(capture(patchScene, spot, 32), spot, { vpls: 32, near: 0.15 });
test('the patch bounces onto the wall as the form factor gives, within 5%', () => {
  const { vpls, points } = patch(),
    maps = buildVisibility(vpls, points, { resolution: 32 }),
    data = packBounce([[1e4, 1e4, 1e4]], vpls, maps, 32);
  for (const [c, expected] of [[0.5, 0.254], [1, 0.1521]]) {
    const e = bounceIrradiance(data, [0, c, 0], [0, 0, 1]);
    assert.ok(Math.abs(expected - 0.8 * formFactor(c)) < 2e-4);
    assert.ok(Math.abs(e[0] / expected - 1) < 0.05, `c ${c}: ${e[0]} vs ${expected} (${((e[0] / expected - 1) * 100).toFixed(2)}%)`);
  }
});
test('the VPLs carry the reflected flux exactly, and the same capture gives the same VPLs', () => {
  const a = patch(),
    b = patch(),
    sum = [0, 1, 2].map((k) => a.vpls.reduce((s, v) => s + v.flux[k], 0));
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(sum[k] / a.flux[k] - 1) < 1e-6);
  // 0.8 albedo x 1e-4 irradiance per unit intensity x the 4 m^2 patch.
  assert.ok(Math.abs(a.flux[0] / (0.8e-4 * 4) - 1) < 1e-3, `flux ${a.flux[0]}`);
  assert.ok(a.vpls.length <= 32 && a.vpls.length >= 30);
  assert.deepEqual(a, b);
});

// Two rooms side by side, a 0.3 m wall between them; the light near the ceiling of room A.
const roomA = box([0, 0, 0], [4, 2.5, 4], [0.6, 0.6, 0.6]),
  roomB = box([4.3, 0, 0], [8.3, 2.5, 4], [0.6, 0.6, 0.6]),
  lamp = { kind: 'point', position: [2, 2.2, 2], range: 0 };
const gather = (scene, sources, receivers, { visible = true, openings = [] } = {}) => {
  const vpls = [],
    points = [];
  sources.forEach((s, i) => {
    const out = reduceBounce(capture(scene, s, 32), s, { vpls: 32, near: 0.15, openings, source: i });
    vpls.push(...out.vpls);
    points.push(...out.points);
  });
  const maps = visible ? buildVisibility(vpls, points, { resolution: 32, openings }) : new Float32Array(vpls.length * 1024).fill(OPEN);
  const data = packBounce(sources.map(() => [1, 1, 1]), vpls, maps, 32);
  return { vpls, points, data, at: receivers.map(([x, n]) => bounceIrradiance(data, x, n)[0]) };
};
test('the wall between two rooms keeps the bounce out of the dark one (under 2% of unblocked)', () => {
  const x = [[6.3, 0, 2], [0, 1, 0]],
    blocked = gather([...roomA, ...roomB], [lamp], [x]).at[0],
    open = gather([...roomA, ...roomB], [lamp], [x], { visible: false }).at[0];
  assert.ok(open > 1e-3, `unblocked ${open}`);
  assert.ok(blocked < 0.02 * open, `dark room ${blocked} of unblocked ${open}`);
});

/** The same VPLs with exact ray-cast visibility: what the maps approximate. */
function traced(scene, vpls, x, n) {
  let e = 0;
  for (const v of vpls) {
    const w = sub(x, v.position),
      r = Math.hypot(...w),
      d = w.map((c) => c / r),
      cj = dot(v.normal, d),
      ci = -dot(n, d);
    if (cj <= 0 || ci <= 0) continue;
    // From just off the VPL to just off the receiver, so neither surface hides the other.
    const a = v.position.map((p, k) => p + v.normal[k] * 1e-3),
      b = x.map((p, k) => p + n[k] * 1e-3),
      ab = sub(b, a),
      l = Math.hypot(...ab);
    if (cast(scene, a, ab.map((c) => c / l), l - 1e-3)) continue;
    e += (v.flux[0] * cj * ci) / (Math.PI * r * r + v.area);
  }
  return e;
}
// Brute-force reference: every texel of a fine capture lights x with its own flux and an exact ray-cast visibility.
function reference(scene, source, x, n, resolution = 96) {
  const cap = capture(scene, source, resolution),
    { vpls } = reduceBounce(cap, source, { vpls: resolution * resolution * 6, near: 0.15 });
  let e = 0;
  for (const v of vpls) {
    const w = sub(x, v.position),
      r = Math.hypot(...w),
      d = w.map((c) => c / r),
      cj = dot(v.normal, d),
      ci = -dot(n, d);
    if (cj <= 0 || ci <= 0) continue;
    const start = v.position.map((p, k) => p + v.normal[k] * 1e-4);
    if (cast(scene, start, d, r - 1e-3)) continue;
    e += (v.flux[0] * cj * ci) / (Math.PI * r * r + v.area);
  }
  return e;
}
test('a receiver under a table keeps the bounce from the lit walls', () => {
  const table = [rect([2, 0.8, 2], [0.6, 0, 0], [0, 0, 0.35], [0.5, 0.4, 0.3])],
    scene = [...roomA, ...table],
    under = [[2, 0, 2], [0, 1, 0]],
    open = [[0.6, 0, 0.6], [0, 1, 0]],
    run = gather(scene, [lamp], [under, open]),
    got = run.at,
    exact = reference(scene, lamp, ...under),
    unblocked = gather(scene, [lamp], [under], { visible: false }).at[0];
  // The table hides the ceiling and the floor's lit middle from the point under it, not the walls.
  assert.ok(exact < 0.8 * unblocked, `the table must shade the point: ${exact} of ${unblocked}`);
  assert.ok(Math.abs(got[0] / exact - 1) < 0.2, `under the table ${got[0]} vs exact ${exact}`);
  // The maps against exact visibility of the same VPLs, under the table and in the open.
  for (const [i, x] of [under, open].entries()) {
    const ray = traced(scene, run.vpls, ...x);
    assert.ok(Math.abs(got[i] / ray - 1) < 0.1, `${i ? 'in the open' : 'under the table'} ${got[i]} vs traced ${ray}`);
  }
});

// KB-BOUNCE-VPL-BURIED1: a VPL stands for a cluster of lit texels; on a convex surface (a snow drift, a log) their
// centroid lies below the surface, inside the surfels its own texels draw in the visibility maps, so before the fix
// every such VPL was hidden from everything (the cabin's lantern-lit snow lit the logs round the window 64 times too
// little). A mound of 12 strips, 0.3 m high over 3 m, lit from above, lights a point of a wall beside it facing it:
// the maps give the brute-force reference within 20% (the table's bound), as they do in the open.
test('VPLs on a convex mound are not hidden by their own surface', () => {
  const strips = 12,
    span = 3,
    height = (z) => 0.3 * Math.cos((Math.PI * z) / span),
    mound = [];
  for (let s = 0; s < strips; s++) {
    const z0 = -span / 2 + (s * span) / strips,
      z1 = z0 + span / strips,
      y0 = height(z0),
      y1 = height(z1);
    mound.push(rect([0, (y0 + y1) / 2, (z0 + z1) / 2], [2, 0, 0], [0, (y1 - y0) / 2, (z1 - z0) / 2], [0.9, 0.9, 0.9]));
  }
  const light = { kind: 'point', position: [0, 3, 0.5], range: 0 },
    beside = [[0, 1.2, 3.2], [0, 0, -1]],
    run = gather(mound, [light], [beside]),
    open = gather(mound, [light], [beside], { visible: false }).at[0],
    exact = reference(mound, light, ...beside);
  assert.ok(exact > 1e-3, `the mound lights the wall: ${exact}`);
  assert.ok(Math.abs(run.at[0] / exact - 1) < 0.2, `beside the mound ${run.at[0]} vs exact ${exact} (unblocked ${open})`);
});

// A room with a 1.2 x 1.1 m window in its +z wall (0.3 m of logs), snow outside; the lamp inside.
const windowAt = [2, 1.5, 4.3],
  opening = (frosted) => ({ position: windowAt, normal: [0, 0, 1], u: [0.6, 0, 0], v: [0, 0.55, 0], frosted }),
  wall = (z) => [
    rect([0.7, 1.25, z], [0.7, 0, 0], [0, 1.25, 0], [0.5, 0.4, 0.3]),
    rect([3.3, 1.25, z], [0.7, 0, 0], [0, 1.25, 0], [0.5, 0.4, 0.3]),
    rect([2, 0.475, z], [0.6, 0, 0], [0, 0.475, 0], [0.5, 0.4, 0.3]),
    rect([2, 2.275, z], [0.6, 0, 0], [0, 0.225, 0], [0.5, 0.4, 0.3]),
  ],
  // The window's reveal: the cut ends of the logs round it.
  reveal = [
    rect([1.4, 1.5, 4.15], [0, 0.55, 0], [0, 0, 0.15], [0.5, 0.4, 0.3]),
    rect([2.6, 1.5, 4.15], [0, 0.55, 0], [0, 0, 0.15], [0.5, 0.4, 0.3]),
    rect([2, 0.95, 4.15], [0.6, 0, 0], [0, 0, 0.15], [0.5, 0.4, 0.3]),
    rect([2, 2.05, 4.15], [0.6, 0, 0], [0, 0, 0.15], [0.5, 0.4, 0.3]),
  ],
  cabin = [...box([0, 0, 0], [4, 2.5, 4], [0.5, 0.4, 0.3]).filter((r) => !(r.c[2] === 4)), ...wall(4), ...wall(4.3), ...reveal],
  snowy = [...cabin, rect([2, -0.001, 10], [10, 0, 0], [0, 0, 5.7], [0.9, 0.92, 0.95])],
  outsideWall = [[2, 0.6, 4.31], [0, 0, 1]],
  onSnow = [[2, 0, 9], [0, 1, 0]];
test('count once: a room-side VPL lights nothing through the opening; the opening light does', () => {
  for (const frosted of [false, true]) {
    const openings = [opening(frosted)],
      room = gather(snowy, [lamp], [outsideWall, onSnow], { openings }),
      inside = room.vpls.filter((v) => v.position[2] < 4.3);
    // With the rule the room's VPLs light the snow only through the logs' imperfect maps; without it, through the window.
    const lit = (list) => packBounce([[1, 1, 1]], inside, buildVisibility(inside, room.points, { resolution: 32, openings: list }), 32),
      kept = bounceIrradiance(lit(openings), ...onSnow)[0],
      through = bounceIrradiance(lit([]), ...onSnow)[0];
    assert.ok(through > 1e-4, `${frosted ? 'frosted' : 'clear'}: the room's light reaches the snow through the window, ${through}`);
    assert.ok(kept < 0.02 * through, `${frosted ? 'frosted' : 'clear'}: room light through the opening ${kept} of ${through}`);
    // Frosted: the lamp's capture stops at the pane, so no VPL lies outside; clear: its beam lights the snow.
    const outside = room.vpls.filter((v) => v.position[2] > 4.3);
    if (frosted) assert.equal(outside.length, 0);
    else assert.ok(outside.length > 0 && outside.every((v) => v.position[1] < 0.01));
    assert.ok(crossesOpening(openings[0], lamp.position, [2, 0, 8]) === true);
  }
});
test("the opening's light on the snow bounces with the flux Lambert's formula gives it", () => {
  const o = opening(true),
    source = { kind: 'rect', position: o.position, normal: o.normal, u: o.u, v: o.v },
    { flux, vpls } = reduceBounce(capture(snowy, source, 64), source, { vpls: 32, near: 0.15, openings: [o] });
  // The snow's reflected flux per unit radiance: albedo x the integral of the rectangle's irradiance over the ground.
  let expected = 0;
  const step = 0.05;
  for (let x = -8; x < 12; x += step)
    for (let z = 4.3; z < 15.7; z += step) expected += rectIrradiance(source, [x + step / 2, 0, z + step / 2], [0, 1, 0]) * step * step;
  expected *= 0.9;
  const snow = vpls.filter((v) => v.position[1] < 0.01).reduce((s, v) => s + v.flux[0], 0);
  assert.ok(Math.abs(snow / expected - 1) < 0.03, `snow flux ${snow} vs ${expected}`);
  assert.ok(Math.abs(flux[0] / snow - 1) < 0.05, 'nearly all of it lands on the snow');
});

test('the lit shader adds clusterBounceLighting only while a bounce hook is set', () => {
  const plain = clusteredSampling(0),
    hooked = clusteredSampling(0, undefined, undefined, false, false, false, { bounce: { declarations: (g) => bounceWgsl(g) } });
  assert.ok(!plain.includes('clusterBounce'));
  assert.ok(hooked.includes(`@binding(${BOUNCE_BINDING}) var<storage,read> clusterBounce:array<vec4f>`));
  assert.ok(hooked.includes('+clusterBounceLighting(position,n,base,metal))*clusterFrame.intensity.x'));
});

test('LightBounce checks its options before it touches a GPU', async () => {
  const { LightBounce } = await import('../dist/bounce.js'),
    { Clustered } = await import('../dist/index.js'),
    lights = new Clustered();
  assert.throws(() => new LightBounce({}), TypeError);
  assert.throws(() => new LightBounce(), TypeError);
  for (const [name, bad] of [
    ['maxLights', [0, 5, 1.5]],
    ['vpls', [7, 129]],
    ['resolution', [7, 129]],
    ['visibility', [7, 65]],
    ['near', [-0.1, 11, NaN]],
    ['intensity', [-1, 17, Infinity]],
    ['refresh', [-1, 7]],
  ])
    for (const value of bad) assert.throws(() => new LightBounce({ lights, [name]: value }), RangeError, `${name} ${value}`);
  assert.throws(() => new LightBounce({ lights, occlusion: 1 }), TypeError);
  const light = { position: [0, 1, 0], direction: [0, 0, 1], width: 1, height: 1, color: [1, 1, 1], intensity: 1 };
  assert.throws(() => new LightBounce({ lights, openings: Array(5).fill({ light }) }), RangeError);
  assert.throws(() => new LightBounce({ lights, openings: [{ light: { ...light, width: 0 } }] }), RangeError);
  assert.throws(() => new LightBounce({ lights, openings: [{ light, glazing: 'tinted' }] }), RangeError);
  for (const bad of [{ recess: -0.1 }, { sill: Number.NaN }])
    assert.throws(() => new LightBounce({ lights, openings: [{ light: { ...light, ...bad } }] }), RangeError);
  // The opening's capture source carries the light's recess and sill (KB-BOUNCE-REVEAL1).
  const recessed = new LightBounce({ lights, openings: [{ light: { ...light, recess: 0.2, sill: 0.05 } }] });
  recessed['select']();
  assert.deepEqual([recessed['states'][0].source.recess, recessed['states'][0].source.sill], [0.2, 0.05]);
  // Its glazing bars move the capture's eye out in front of them (KB-BOUNCE-CAPEYE1); one lite has no bars.
  for (const bad of [{ lites: [2] }, { lites: [0, 2] }, { lites: [2, 1.5] }, { lites: [17, 1] }, { barDepth: 0 }, { barDepth: 0.31 }])
    assert.throws(() => new LightBounce({ lights, openings: [{ light, ...bad }] }), RangeError, JSON.stringify(bad));
  const barred = new LightBounce({ lights, openings: [{ light, lites: [2, 2], barDepth: 0.05 }, { light, lites: [1, 1], barDepth: 0.05 }] });
  barred['select']();
  assert.deepEqual(barred['states'].map((s) => s.source.front && Math.round(s.source.front * 1e9) / 1e9), [0.075, undefined]);
  const n = barred['states'][0].source.normal,
    p = barred['states'][0].source.position;
  assert.deepEqual(
    barred['states'][0].views[0].eye.map((v) => Math.round(v * 1e9) / 1e9),
    p.map((v, k) => Math.round((v + n[k] * 0.075) * 1e9) / 1e9),
  );
  const bounce = new LightBounce({ lights, openings: [{ light, glazing: 'frosted' }] });
  assert.deepEqual(
    [bounce.maxLights, bounce.vpls, bounce.resolution, bounce.visibility, bounce.near, bounce.intensity, bounce.occlusion, bounce.refresh],
    [4, 32, 32, 32, 0.15, 1, true, 1],
  );
  assert.equal(bounce.openings.length, 1);
  assert.deepEqual(bounce.stats, { captures: 0, vpls: 0, sources: 0, occluders: 0 });
});

test("the capture draws core's shader from the capture's camera, tone-mapped or linear, with or without TAA", async () => {
  const { frameCapture } = await import('../../shared/frame-capture.js'),
    tail = 'return vec4f(i.color,length(i.position-frame.eye.xyz));',
    head = '@group(0) @binding(0) var<uniform> frame:Frame;\n',
    vertex = (clip) => `@vertex fn vertex(i:Input)->Output {var o:Output;o.clip=${clip}*p;return o;}\n`,
    toneMapped = `${head}${vertex('frame.camera')}@fragment fn fragment(i:Output)->@location(0) vec4f {let linear=i.color;let mapped=linear/(1.0+linear);\nreturn vec4f(mapped,1);\n}`,
    // A post stack takes the linear radiance; TAA jitters the clip transform (packages/taa: o.clip=taaCamera*p).
    linearTaa = `${head}@group(0) @binding(18) var<uniform> taaCamera:mat4x4f;\n${vertex('taaCamera')}@fragment fn fragment(i:Output)->@location(0) vec4f {let linear=i.color;\nreturn vec4f(linear,1);\n}`;
  for (const shader of [toneMapped, linearTaa]) {
    const code = frameCapture(shader, 165, tail, 'LightBounce');
    assert.ok(code.includes('@group(0) @binding(165) var<uniform> frame:Frame;') && code.includes('_=margoMainFrame.eye;'));
    assert.ok(code.includes(`if(false){_=linear;}${tail}`) && !code.includes('return vec4f(mapped,1);') && !code.includes('return vec4f(linear,1);'));
    assert.ok(code.includes('o.clip=frame.camera*p;'), 'the capture camera places the vertices');
  }
  assert.ok(frameCapture(linearTaa, 165, tail, 'LightBounce').includes('o.clip=frame.camera*p;_=taaCamera;'));
  assert.throws(() => frameCapture('@fragment fn fragment()->@location(0) vec4f {return vec4f(1);}', 165, tail, 'LightBounce'), /standard core lighting shader/);
});

// KB-BOUNCE-CLUSTER1: a cluster spanned the snow, the window's sill top and a glazing bar's face (all facing up, at
// 0.1, 0.97 and 1.48 m) and its VPL was lifted to the bar, above the log crest's horizon, so the crest lost the
// snow's light: with the reveal clip 32 VPLs read 0.55 of the same capture's texel-by-texel sum. The fixture is
// Cabin Hearth's two captures as an RTX A6000 read them back (the lantern's and the frosted window's, its recess and
// sill set). 32 VPLs light the crest within 15% of one VPL per texel, both unshadowed (the clustering alone).
test('32 VPLs light the cabin log crest as the capture texels do: no cluster spans parallel surfaces', async () => {
  const { readFileSync } = await import('node:fs'),
    fixture = JSON.parse(readFileSync(new URL('./fixtures/cabin-bounce-captures.json', import.meta.url), 'utf8')),
    bytes = (b64) => {
      const b = Buffer.from(b64, 'base64');
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
    },
    res = fixture.resolution,
    crest = [0.3, 1.35, 2.65],
    n = [0, 0, 1];
  for (const c of fixture.captures) {
    const texels = new Float32Array(c.views.length * res * res * 4),
      index = new Uint16Array(bytes(c.index)),
      distance = new Float32Array(bytes(c.distance)),
      albedo = new Uint8Array(bytes(c.albedo));
    index.forEach((t, i) => texels.set([...c.albedos[albedo[i]], distance[i]], t * 4));
    const capture = { views: c.views, resolution: res, texels },
      at = (count) => {
        const { vpls } = reduceBounce(capture, c.source, { vpls: count, near: 0.15 });
        return bounceIrradiance(packBounce([[1, 1, 1]], vpls, new Float32Array(vpls.length * 1024).fill(OPEN), 32), crest, n)[0];
      },
      got = at(32),
      exact = at(1e6);
    assert.ok(exact > 0, `${c.source.kind}: the texels light the crest`);
    assert.ok(Math.abs(got / exact - 1) < 0.15, `${c.source.kind}: 32 VPLs ${got} vs the texels' ${exact}`);
  }
});

// KB-BOUNCE-SHADOWSNOW1: a lantern 0.4 m from a long wall sees most of it at grazing angles.
const nearWall = { kind: 'point', position: [3, 2.0, 3.6], range: 0 };
test('a wall texel takes its normal from its own wall, not the floor or ceiling beside it', () => {
  // The smaller distance jump took the floor's neighbour at the wall's foot: 108 of 2270 wall texels tilted, by up to
  // 38.7 degrees, so their surfels stood out of the wall and VPL rays slipped past them.
  const room = box([0, 0, 0], [6, 2.5, 4], [0.6, 0.6, 0.6]),
    { points } = reduceBounce(capture(room, nearWall, 32), nearWall, { vpls: 32, near: 0.15 }),
    wall = points.filter((p) => p.position[2] > 3.999 && p.position[1] > 0.02 && p.position[1] < 2.48 && p.position[0] > 0.02 && p.position[0] < 5.98);
  assert.ok(wall.length > 2000, `${wall.length} wall texels`);
  for (const p of wall) assert.ok(-p.normal[2] > Math.cos((2 * Math.PI) / 180), `normal ${p.normal} at ${p.position}`);
});
test('surfels seen at grazing angles cover their wall in every VPL map (elliptical splats)', () => {
  // Round surfels of the texel's area missed a grazing texel's long axis: 4, 15 and 3 holes in these three maps.
  const wall = [rect([3, 1.25, 4], [3, 0, 0], [0, 1.25, 0], [0.6, 0.6, 0.6])],
    { points } = reduceBounce(capture(wall, nearWall, 32), nearWall, { vpls: 32, near: 0.15 }),
    res = 32;
  assert.ok(points.every((p) => p.ray && Math.abs(Math.hypot(...p.ray) - 1) < 1e-9));
  for (const position of [[2, 1.3, 0], [5.5, 0.8, 2.8], [0.5, 2, 1]]) {
    const vpl = { position, normal: [0, 0, 1], flux: [1, 1, 1], area: 0.01, source: 0 },
      map = buildVisibility([vpl], points, { resolution: res, budget: points.length }),
      [t, b] = basis(vpl.normal);
    let inside = 0;
    for (let y = 0; y < res; y++)
      for (let x = 0; x < res; x++) {
        const u = ((x + 0.5) / res) * 2 - 1,
          v = ((y + 0.5) / res) * 2 - 1,
          q = u * u + v * v,
          c = [0, 1, 2].map((k) => (2 * u * t[k] + 2 * v * b[k] + (1 - q) * vpl.normal[k]) / (1 + q));
        if (!(c[2] > 0)) continue;
        const s = (4 - position[2]) / c[2],
          hx = position[0] + c[0] * s,
          hy = position[1] + c[1] * s;
        if (hx < 0.3 || hx > 5.7 || hy < 0.1 || hy > 2.4) continue;
        inside++;
        assert.ok(Math.abs(map[y * res + x] - s) < 0.05 * s, `VPL at ${position}: texel ${x},${y} holds ${map[y * res + x]}, the wall is at ${s}`);
      }
    assert.ok(inside > 30, `${inside} texels on the wall`);
  }
});

// KB-BOUNCE-SHADOWSNOW1 cause 3: the captures hold only what a source sees, so the wall a table hides from the lantern
// was in no map and the room's VPLs lit the ground outside through it (5.9% to 8.2% of the unblocked bounce here).
// The scene's own triangles (sampleSurfaces) close it; the maps of the triangles are exact along every centre ray.
const asMesh = (r) => {
  const vertices = new Float32Array(24);
  [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([a, b], i) => vertices.set([...[0, 1, 2].map((k) => r.c[k] + a * r.u[k] + b * r.v[k]), ...r.n], i * 6));
  return { vertices, indices: new Uint32Array([0, 1, 2, 0, 2, 3]), matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] };
};
test('a wall no source sees still hides the room: the scene triangles are occluders (under 2% of unblocked)', () => {
  const scene = [...box([0, 0, 0], [6, 2.5, 4], [0.6, 0.6, 0.6]), rect([1.5, 0.97, 3.6], [1, 0, 0], [0, 0, 0.4], [0.5, 0.4, 0.3])],
    { vpls, points } = reduceBounce(capture(scene, nearWall, 32), nearWall, { vpls: 32, near: 0.15 }),
    occluders = sampleSurfaces(scene.map(asMesh), vpls, { resolution: 32 }),
    lit = (o) => packBounce([[1, 1, 1]], vpls, buildVisibility(vpls, points, { resolution: 32, occluders: o }), 32),
    open = packBounce([[1, 1, 1]], vpls, new Float32Array(vpls.length * 1024).fill(OPEN), 32),
    [captured, meshes] = [lit([]), lit(occluders)];
  assert.ok(occluders.every((p) => p.corners?.length === 9), 'big triangles stay whole and exact');
  // Behind the table, on the ground outside the wall the lantern stands 0.4 m from (exact visibility: 0).
  for (const x of [[1, 0.05, 5], [1.5, 0.05, 4.5], [1.5, 0.05, 4.3], [1, 0.3, 4.5], [2, 0.05, 4.2]]) {
    const unblocked = bounceIrradiance(open, x, [0, 1, 0])[0],
      before = bounceIrradiance(captured, x, [0, 1, 0])[0],
      after = bounceIrradiance(meshes, x, [0, 1, 0])[0];
    assert.ok(traced(scene, vpls, x, [0, 1, 0]) === 0 && unblocked > 0.02, `${x}: traced 0, unblocked ${unblocked}`);
    assert.ok(before > 0.05 * unblocked, `${x}: the captures alone leak (${before} of ${unblocked}), as before the fix`);
    assert.ok(after < 0.02 * unblocked, `${x}: ${after} of unblocked ${unblocked}`);
  }
  // Each map holds the true first hit of every centre ray in front of its VPL.
  const res = 32,
    maps = buildVisibility(vpls, [], { resolution: res, occluders });
  vpls.forEach((vpl, j) => {
    const [t, b] = basis(vpl.normal);
    for (let y = 0; y < res; y += 3)
      for (let x = 0; x < res; x += 3) {
        const u = ((x + 0.5) / res) * 2 - 1,
          v = ((y + 0.5) / res) * 2 - 1,
          q = u * u + v * v,
          c = [0, 1, 2].map((k) => (2 * u * t[k] + 2 * v * b[k] + (1 - q) * vpl.normal[k]) / (1 + q));
        if (q > 0.98) continue;
        const hit = cast(scene, vpl.position, c, Infinity, 1e-4),
          got = maps[j * res * res + y * res + x];
        if (hit && dot(c, vpl.normal) > 0.05) assert.ok(Math.abs(got - hit.t) < 1e-4 * hit.t + 1e-5, `VPL ${j} texel ${x},${y}: ${got} vs ${hit.t}`);
      }
  });
});
test('sampleSurfaces merges small far triangles into covering surfels and leaves out what no VPL faces', () => {
  // A 1 m sheet of 2 x 20 x 20 triangles 20 m from a VPL facing it, and one behind the VPL.
  const sheet = (z) => {
      const n = 21,
        vertices = new Float32Array(n * n * 6),
        indices = [];
      for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) vertices.set([i / 20 - 0.5, k / 20 - 0.5, z, 0, 0, -1], (i * n + k) * 6);
      for (let i = 0; i < 20; i++) for (let k = 0; k < 20; k++) indices.push(i * n + k, (i + 1) * n + k, i * n + k + 1, (i + 1) * n + k, (i + 1) * n + k + 1, i * n + k + 1);
      return { vertices, indices: new Uint32Array(indices), matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] };
    },
    vpl = { position: [0, 0, 0], normal: [0, 0, 1], flux: [1, 1, 1], area: 0.01, source: 0 },
    points = sampleSurfaces([sheet(20), sheet(-5)], [vpl], { resolution: 32 });
  // Cells of 2^floor(log2(20 / 16)) = 1 m: the 800 triangles are a few surfels, none behind the VPL.
  assert.ok(points.length > 0 && points.length <= 8, `${points.length} surfels`);
  assert.ok(points.every((p) => p.position[2] > 19 && !p.corners && Math.abs(Math.abs(p.normal[2]) - 1) < 1e-9));
  assert.ok(Math.abs(points.reduce((s, p) => s + p.area, 0) - 1) < 1e-9, 'the area is kept');
  // Every triangle corner lies inside some surfel's disc.
  for (let i = 0; i <= 20; i++)
    for (let k = 0; k <= 20; k++) {
      const c = [i / 20 - 0.5, k / 20 - 0.5, 20];
      assert.ok(points.some((p) => Math.hypot(...sub(c, p.position)) <= p.reach + 1e-9), `corner ${c} is covered`);
    }
});
test('buildVisibility skips the map tiles a triangle cannot cover, with the same maps (KB-SHOT-COMPAT-SKYCOV1)', () => {
  // The maps as the brute force draws them: every texel a triangle's circumscribed disc can reach (the whole map when
  // the disc reaches the VPL's plane), each centre ray against the triangle, as buildVisibility did before the tiles.
  const brute = (vpls, occluders, res) => {
    const maps = new Float32Array(vpls.length * res * res).fill(OPEN);
    let rays = 0;
    vpls.forEach((vpl, j) => {
      const n = vpl.normal,
        [t, b] = basis(n),
        origin = vpl.position;
      for (const point of occluders) {
        const w = sub(point.position, origin),
          r = Math.hypot(...w);
        if (r < 1e-4) continue;
        const z = dot(w, n) / r,
          c3 = point.corners;
        if (z * r + point.reach <= 0) continue;
        const e1 = [c3[3] - c3[0], c3[4] - c3[1], c3[5] - c3[2]],
          e2 = [c3[6] - c3[0], c3[7] - c3[1], c3[8] - c3[2]],
          o = [origin[0] - c3[0], origin[1] - c3[1], origin[2] - c3[2]],
          q = cross(o, e1),
          whole = z * r <= point.reach || r <= 2 * point.reach,
          u = whole ? 0 : dot(w, t) / r / (1 + z),
          v = whole ? 0 : dot(w, b) / r / (1 + z),
          radius = whole ? 2 : point.reach / Math.sqrt(r * r - point.reach * point.reach) + 1 / res,
          x0 = Math.max(0, Math.floor(((u - radius) * 0.5 + 0.5) * res)),
          x1 = Math.min(res - 1, Math.floor(((u + radius) * 0.5 + 0.5) * res)),
          y0 = Math.max(0, Math.floor(((v - radius) * 0.5 + 0.5) * res)),
          y1 = Math.min(res - 1, Math.floor(((v + radius) * 0.5 + 0.5) * res));
        for (let y = y0; y <= y1; y++)
          for (let x = x0; x <= x1; x++) {
            rays++;
            const uu = ((x + 0.5) / res) * 2 - 1,
              vv = ((y + 0.5) / res) * 2 - 1,
              qq = uu * uu + vv * vv,
              c = [0, 1, 2].map((k) => (2 * uu * t[k] + 2 * vv * b[k] + (1 - qq) * n[k]) / (1 + qq)),
              p = cross(c, e2),
              det = dot(e1, p);
            if (Math.abs(det) < 1e-12) continue;
            const a = dot(o, p) / det,
              bb = dot(c, q) / det;
            if (a < -1e-6 || bb < -1e-6 || a + bb > 1 + 1e-6) continue;
            const depth = dot(e2, q) / det,
              k = j * res * res + y * res + x;
            if (depth > 0.02 && depth < maps[k]) maps[k] = depth;
          }
      }
    });
    return { maps, rays };
  };
  const triangle = (corners) => {
    const [a, b, c] = [corners.slice(0, 3), corners.slice(3, 6), corners.slice(6, 9)],
      g = [0, 1, 2].map((k) => (a[k] + b[k] + c[k]) / 3),
      x = cross(sub(b, a), sub(c, a));
    return { position: g, normal: unit(x), area: Math.hypot(...x) / 2, reach: Math.max(...[a, b, c].map((p) => Math.hypot(...sub(p, g)))), corners };
  };
  // A cabin: a 6 x 4 m floor and four 2.5 m walls of 0.5 m quads, a table, and VPLs on the floor (1 mm up, the
  // near-coplanar case), on the walls and on the table, as the cabin's bounce places them.
  const occluders = [],
    quad = (o, u, v, nu, nv) => {
      for (let i = 0; i < nu; i++)
        for (let k = 0; k < nv; k++) {
          const p = (s, r) => [0, 1, 2].map((d) => o[d] + u[d] * ((i + s) / nu) + v[d] * ((k + r) / nv));
          occluders.push(triangle([...p(0, 0), ...p(1, 0), ...p(0, 1)]), triangle([...p(1, 0), ...p(1, 1), ...p(0, 1)]));
        }
    };
  quad([-3, 0, -2], [6, 0, 0], [0, 0, 4], 12, 8);
  quad([-3, 0, -2], [6, 0, 0], [0, 2.5, 0], 12, 5);
  quad([-3, 0, 2], [6, 0, 0], [0, 2.5, 0], 12, 5);
  quad([-3, 0, -2], [0, 0, 4], [0, 2.5, 0], 8, 5);
  quad([3, 0, -2], [0, 0, 4], [0, 2.5, 0], 8, 5);
  quad([-0.6, 0.75, -0.4], [1.2, 0, 0], [0, 0, 0.8], 1, 1);
  // One far, large ground triangle beyond the walls, and one standing on its edge through a VPL's plane.
  occluders.push(triangle([-90, -0.01, -90, 90, -0.01, -90, 0, -0.01, 90]), triangle([1, -0.5, 0.5, 1.5, 1, 0.5, 2, -0.5, 0.5]));
  const vpls = [];
  for (const [x, z] of [[-2, -1], [0, 0], [1.3, 1.1], [2.9, -1.9], [0.5, 0.5]]) vpls.push({ position: [x, 0.001, z], normal: [0, 1, 0] });
  vpls.push({ position: [0.1, 0.751, 0.1], normal: [0, 1, 0] });
  vpls.push({ position: [-2.999, 1.2, 0.3], normal: [1, 0, 0] });
  vpls.push({ position: [0.4, 1.7, 1.999], normal: [0, 0, -1] });
  vpls.push({ position: [0, 1, 0], normal: unit([0.3, 0.8, -0.2]) });
  for (const [res, share] of [[32, 0.35], [13, 0.75]]) {
    const stats = { rays: 0 },
      maps = buildVisibility(vpls, [], { resolution: res, occluders, stats }),
      want = brute(vpls, occluders, res);
    assert.deepEqual(maps, want.maps, `resolution ${res}: the tiles change no texel`);
    assert.ok(maps.some((d) => d < OPEN), 'the walls are in the maps');
    // The brute force tests 1,024 rays at 32 for each triangle beside a VPL; the tiles about a quarter of its 2 million
    // rays (0.66 of them at 13, where a tile is a third of the map's width).
    console.log(`resolution ${res}: ${stats.rays} rays of the brute force's ${want.rays}`);
    assert.ok(stats.rays > 0 && stats.rays < share * want.rays, `resolution ${res}: ${stats.rays} rays of the brute force's ${want.rays}`);
  }
});
