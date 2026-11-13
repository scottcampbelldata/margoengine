// Face offset, shell and draft on bodies of planar faces, against closed forms (boxes and prisms composed of boxes: volume,
// area, centroid and the inertia tensor), and the offsets that must be refused: a face moved past a neighbour (the
// topology would change), walls too thick, faces not on planes, names the body does not have.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { model } from '../dist/index.js';

const { box, boolean, checkBody, cylinder, draft, extrude, frameOf, massProperties, offsetFaces, shell, validateBody } = model;
const mm = 0.001;

/** Volume, first and second moments (about the origin, mm) of boxes, each [x0, y0, z0, x1, y1, z1] with a sign. */
function boxes(list) {
  const S = { V: 0, m: [0, 0, 0], xx: 0, yy: 0, zz: 0, xy: 0, yz: 0, zx: 0 };
  for (const [sign, [x0, y0, z0, x1, y1, z1]] of list) {
    const lx = x1 - x0,
      ly = y1 - y0,
      lz = z1 - z0,
      i1 = (a, b) => (b * b - a * a) / 2,
      i2 = (a, b) => (b ** 3 - a ** 3) / 3;
    S.V += sign * lx * ly * lz;
    S.m[0] += sign * i1(x0, x1) * ly * lz;
    S.m[1] += sign * i1(y0, y1) * lx * lz;
    S.m[2] += sign * i1(z0, z1) * lx * ly;
    S.xx += sign * i2(x0, x1) * ly * lz;
    S.yy += sign * i2(y0, y1) * lx * lz;
    S.zz += sign * i2(z0, z1) * lx * ly;
    S.xy += sign * i1(x0, x1) * i1(y0, y1) * lz;
    S.yz += sign * i1(y0, y1) * i1(z0, z1) * lx;
    S.zx += sign * i1(z0, z1) * i1(x0, x1) * ly;
  }
  const c = S.m.map((x) => x / S.V),
    xx = S.xx - S.V * c[0] * c[0],
    yy = S.yy - S.V * c[1] * c[1],
    zz = S.zz - S.V * c[2] * c[2];
  return {
    volume: S.V,
    centroid: c,
    inertia: [
      yy + zz,
      xx + zz,
      xx + yy,
      -(S.xy - S.V * c[0] * c[1]),
      -(S.yz - S.V * c[1] * c[2]),
      -(S.zx - S.V * c[2] * c[0]),
    ],
  };
}

function expectMass(body, { volume, area, centroid, inertia }, tolerance = 1e-12) {
  const m = massProperties(body),
    rel = (a, b) => Math.abs(a - b) / Math.abs(b);
  assert.ok(rel(m.volume, volume * mm ** 3) <= tolerance, `volume ${m.volume / mm ** 3} vs ${volume}`);
  if (area !== undefined) assert.ok(rel(m.area, area * mm ** 2) <= tolerance, `area ${m.area / mm ** 2} vs ${area}`);
  const size = Math.cbrt(volume);
  centroid.forEach((x, k) =>
    assert.ok(Math.abs(m.centroid[k] / mm - x) <= tolerance * size, `centroid ${k}: ${m.centroid[k] / mm} vs ${x}`),
  );
  const trace = inertia[0] + inertia[1] + inertia[2];
  inertia.forEach((x, k) =>
    assert.ok(Math.abs(m.inertia[k] / mm ** 5 - x) <= tolerance * trace, `inertia ${k}: ${m.inertia[k] / mm ** 5} vs ${x}`),
  );
}

const cube = (a = 10) => box('a', [a * mm, a * mm, a * mm]),
  top = 'a/face:+z';

test('offset: a face moved out and in, its neighbours re-solved; the faces keep their names', () => {
  // brep-compare O_offset_face: the top of a 10 mm cube 2 mm out, 10 x 10 x 12.
  const up = offsetFaces('o', cube(), [top], 2 * mm);
  assert.deepEqual(checkBody(up), []);
  assert.deepEqual(
    up.faces.map((f) => f.name).sort(),
    cube().faces.map((f) => f.name).sort(),
  );
  expectMass(up, { ...boxes([[1, [0, 0, 0, 10, 10, 12]]]), area: 2 * 100 + 4 * 120 });
  // Two faces in: -x by 3 and +y by 1.5.
  const two = offsetFaces('o', offsetFaces('p', cube(), ['a/face:-x'], -3 * mm), ['a/face:+y'], -1.5 * mm);
  expectMass(two, { ...boxes([[1, [3, 0, 0, 10, 8.5, 10]]]), area: 2 * (7 * 8.5 + 8.5 * 10 + 10 * 7) });
  // Moved 1 km from the origin: the same body to 1e-9 in volume (stage 0a's bar).
  const far = box('a', [10 * mm, 10 * mm, 10 * mm], frameOf([1000, 1000, 1000], [0, 0, 1], [1, 0, 0])),
    moved = offsetFaces('o', far, [top], 2 * mm);
  assert.deepEqual(validateBody(moved), []);
  assert.ok(Math.abs(massProperties(moved).volume / (1200 * mm ** 3) - 1) <= 1e-9);
});

test('offset: a slanted face of a prism, and a step of an L-shaped block', () => {
  // A prism on the trapezoid (0,0) (10,0) (6,8) (0,8), 5 deep: the slanted face moved out by 1 keeps its slope.
  // The trapezoid's slanted side has unit outward normal (8, 4)/sqrt(80); moved by 1, the side meets y = 0 at
  // x = 10 + sqrt(80)/8 and y = 8 at x = 6 + sqrt(80)/8: area (bottom + top) / 2 * 8.
  const prism = extrude(
      'w',
      {
        name: 'p',
        start: [0, 0, 0],
        normal: [0, 0, 1],
        segments: [
          { kind: 'line', to: [10 * mm, 0, 0], name: 'low' },
          { kind: 'line', to: [6 * mm, 8 * mm, 0], name: 'slant' },
          { kind: 'line', to: [0, 8 * mm, 0], name: 'high' },
          { kind: 'line', to: [0, 0, 0], name: 'back' },
        ],
      },
      [0, 0, 5 * mm],
    ),
    s = Math.sqrt(80) / 8,
    out = offsetFaces('o', prism, ['w/face:slant'], 1 * mm);
  assert.deepEqual(checkBody(out), []);
  const m = massProperties(out);
  assert.ok(Math.abs(m.volume / mm ** 3 - ((10 + s + 6 + s) / 2) * 8 * 5) <= 1e-12 * 500);
  // An L: a 20 x 10 x 5 slab and a 10 x 10 x 15 tower; the slab's top raised from 5 to 8.
  const L = boolean('L', 'union', box('low', [20 * mm, 10 * mm, 5 * mm]), box('high', [10 * mm, 10 * mm, 15 * mm])),
    step = L.faces.find((f) => f.surface.kind === 'plane' && Math.abs(f.surface.frame.origin[2] - 5 * mm) < 1e-12 && f.surface.frame.z[2] !== 0),
    raised = offsetFaces('r', L, [step.name], 3 * mm);
  assert.deepEqual(checkBody(raised), []);
  expectMass(raised, boxes([[1, [0, 0, 0, 20, 10, 8]], [1, [0, 0, 8, 10, 10, 15]]]));
  // Raised past the tower's top the step's edges would turn round: refused, naming the change.
  assert.throws(() => offsetFaces('r', L, [step.name], 11 * mm), { name: 'RangeError', message: /topology/ });
});

test('shell: a cube opened at its top, walls inside and outside, and a closed cavity', () => {
  // brep-compare O_shell_in and O_shell_out: 1 mm walls, open at +z.
  const inside = shell('s', cube(), [top], -1 * mm);
  assert.deepEqual(checkBody(inside), []);
  expectMass(inside, {
    ...boxes([
      [1, [0, 0, 0, 10, 10, 10]],
      [-1, [1, 1, 1, 9, 9, 10]],
    ]),
    area: 500 + 64 + 4 * 8 * 9 + (100 - 64),
  });
  const outside = shell('s', cube(), [top], 1 * mm);
  assert.deepEqual(checkBody(outside), []);
  expectMass(outside, {
    ...boxes([
      [1, [-1, -1, -1, 11, 11, 10]],
      [-1, [0, 0, 0, 10, 10, 10]],
    ]),
    area: 144 + 4 * 12 * 11 + 500 + (144 - 100),
  });
  // Open at two faces (+z and -x): a channel.
  const channel = shell('s', cube(), [top, 'a/face:-x'], -2 * mm);
  assert.deepEqual(checkBody(channel), []);
  expectMass(
    channel,
    boxes([
      [1, [0, 0, 0, 10, 10, 10]],
      [-1, [0, 2, 2, 8, 8, 10]],
    ]),
  );
  // No open face: a hollow cube, its cavity a second shell facing in.
  const hollow = shell('s', cube(), [], -1 * mm);
  assert.deepEqual(checkBody(hollow), []);
  assert.equal(hollow.shells.length, 2);
  expectMass(
    hollow,
    boxes([
      [1, [0, 0, 0, 10, 10, 10]],
      [-1, [1, 1, 1, 9, 9, 9]],
    ]),
  );
});

test('shell and offset refuse what they cannot make', () => {
  // Walls 5 mm thick inside a 10 mm cube meet in the middle: refused.
  assert.throws(() => shell('s', cube(), [top], -5 * mm), { name: 'RangeError', message: /topology/ });
  assert.throws(() => shell('s', cube(), [top], -6 * mm), { name: 'RangeError', message: /topology/ });
  for (const t of [0, NaN, Infinity]) assert.throws(() => shell('s', cube(), [top], t), { name: 'RangeError' });
  assert.throws(() => shell('s', cube(), ['a/face:nope'], -1 * mm), { name: 'RangeError', message: /no face/ });
  assert.throws(() => offsetFaces('o', cube(), ['a/face:nope'], 1 * mm), { name: 'RangeError', message: /no face/ });
  assert.throws(() => offsetFaces('o', cube(), [], 1 * mm), { name: 'RangeError' });
  assert.throws(() => offsetFaces('o', cube(), [top], NaN), { name: 'RangeError', message: /finite/ });
  // A cylinder's side is not on a plane: refused by name, not a wrong body.
  assert.throws(() => offsetFaces('o', cylinder('c', 3 * mm, 5 * mm), ['c/face:+z'], 1 * mm), {
    name: 'RangeError',
    message: /c\/face:side is on a cylinder/,
  });
});

test('draft: the sides of a cube against the frustum of a square pyramid; zero is the identity', () => {
  const sides = ['a/face:-x', 'a/face:+x', 'a/face:-y', 'a/face:+y'],
    base = { origin: [0, 0, 0], normal: [0, 0, 1] },
    /** A frustum of a square pyramid, h = 10 between sides b (at z = 0) and t (at z = 10), its sides at angle a. */
    frustum = (b, t, a) => {
      const A1 = b * b,
        A2 = t * t,
        r = Math.sqrt(A1 * A2);
      return {
        volume: (10 / 3) * (A1 + A2 + r),
        area: A1 + A2 + 4 * ((b + t) / 2) * (10 / Math.cos(a)),
        z: (10 * (A1 + 2 * r + 3 * A2)) / (4 * (A1 + r + A2)),
      };
    },
    check = (body, { volume, area, z }) => {
      assert.deepEqual(checkBody(body), []);
      const m = massProperties(body);
      assert.ok(Math.abs(m.volume / mm ** 3 - volume) <= 1e-12 * volume, `volume ${m.volume / mm ** 3} vs ${volume}`);
      assert.ok(Math.abs(m.area / mm ** 2 - area) <= 1e-12 * area, `area ${m.area / mm ** 2} vs ${area}`);
      assert.ok(Math.abs(m.centroid[2] / mm - z) <= 1e-12 * 10, `centroid ${m.centroid[2] / mm} vs ${z}`);
      assert.ok(Math.abs(m.centroid[0] / mm - 5) <= 1e-12 * 10 && Math.abs(m.centroid[1] / mm - 5) <= 1e-12 * 10);
    };
  // brep-compare O_draft: 5 degrees about the base, pulled up: the top closes in to 10 - 20 tan 5.
  const a = (5 * Math.PI) / 180,
    t = Math.tan(a);
  check(draft('d', cube(), sides, base, [0, 0, 1], a), frustum(10, 10 - 20 * t, a));
  // Hinged at the top instead: the base opens out to 10 + 20 tan 5.
  check(draft('d', cube(), sides, { origin: [0, 0, 10 * mm], normal: [0, 0, 1] }, [0, 0, 1], a), frustum(10 + 20 * t, 10, a));
  // A negative angle flares the sides out along the pull.
  check(draft('d', cube(), sides, base, [0, 0, 1], -a), frustum(10, 10 + 20 * t, a));
  // Zero: the cube.
  check(draft('d', cube(), sides, base, [0, 0, 1], 0), frustum(10, 10, 0));
  // Refused: a right angle, the top face (parallel to the neutral plane), unknown names, and so steep the top would
  // turn inside out (the topology would change).
  assert.throws(() => draft('d', cube(), sides, base, [0, 0, 1], Math.PI / 2), { name: 'RangeError', message: /angle/ });
  assert.throws(() => draft('d', cube(), [top], base, [0, 0, 1], a), { name: 'RangeError', message: /parallel/ });
  assert.throws(() => draft('d', cube(), ['a/face:nope'], base, [0, 0, 1], a), { name: 'RangeError', message: /no face/ });
  assert.throws(() => draft('d', cube(), sides, base, [0, 0, 1], (50 * Math.PI) / 180), {
    name: 'RangeError',
    message: /topology/,
  });
});
