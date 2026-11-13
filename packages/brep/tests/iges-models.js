// The IGES test models, built entity by entity from the IGES 5.3 parameter tables, and written as fixed-format files
// by iges-writer.js. `node tests/iges-models.js` rewrites tests/fixtures/iges/*.igs from them.
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { writeIGES } from './iges-writer.js';

const DEP = '00010000',
  PARAM = '00010500';

/** A list that hands out entity indices: add(entity) returns { ref } to it. */
export function model() {
  const list = [];
  return {
    list,
    add(e) {
      list.push(e);
      return { ref: list.length - 1 };
    },
    /** Reserves a slot to fill later (for entities that point at each other's indices before they exist). */
    slot() {
      list.push(null);
      return { ref: list.length - 1 };
    },
    set(r, e) {
      list[r.ref] = e;
    },
  };
}
const point = (m, p) => m.add({ type: 116, params: [...p, 0], status: DEP });
const direction = (m, d) => m.add({ type: 123, params: d, status: DEP });
const line = (m, a, b, status = DEP) => m.add({ type: 110, params: [...a, ...b], status });
const arc = (m, zt, c, s, e, extra = {}) => m.add({ type: 100, params: [zt, ...c, ...s, ...e], status: DEP, ...extra });
/** A bilinear B-spline (type 128) plane patch through four corners: p00, p10, p01, p11. */
const patch = (m, corners, status = DEP) =>
  m.add({
    type: 128,
    params: [1, 1, 1, 1, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1, ...corners.flat(), 0, 1, 0, 1],
    status,
  });

/**
 * A 10 x 10 x 10 cube as a manifold solid B-rep object (186): 8 vertices, 12 line edges, 6 faces on plane surfaces
 * (190). The x = 10 face's plane points inwards and its shell use reverses it, as the specification allows.
 */
export function cube(options = {}) {
  const { transform } = options,
    m = model(),
    msbo = m.slot(),
    shell = m.slot(),
    vertices = m.slot(),
    edges = m.slot();
  const V = [
    [0, 0, 0],
    [10, 0, 0],
    [10, 10, 0],
    [0, 10, 0],
    [0, 0, 10],
    [10, 0, 10],
    [10, 10, 10],
    [0, 10, 10],
  ];
  const E = [
    [1, 2],
    [2, 3],
    [3, 4],
    [4, 1],
    [5, 6],
    [6, 7],
    [7, 8],
    [8, 5],
    [1, 5],
    [2, 6],
    [3, 7],
    [4, 8],
  ];
  m.set(vertices, { type: 502, form: 1, params: [8, ...V.flat()], status: DEP });
  const curves = E.map(([a, b]) => line(m, V[a - 1], V[b - 1]));
  m.set(edges, {
    type: 504,
    form: 1,
    params: [12, ...E.flatMap(([a, b], i) => [curves[i], vertices, a, vertices, b])],
    status: '00010001',
  });
  // Each face: plane point, normal, loop as [edge, agrees], and whether the shell uses it reversed.
  const faces = [
    {
      o: [0, 0, 0],
      n: [0, 0, -1],
      loop: [
        [4, 0],
        [3, 0],
        [2, 0],
        [1, 0],
      ],
    },
    {
      o: [0, 0, 10],
      n: [0, 0, 1],
      loop: [
        [5, 1],
        [6, 1],
        [7, 1],
        [8, 1],
      ],
    },
    {
      o: [0, 0, 0],
      n: [0, -1, 0],
      loop: [
        [1, 1],
        [10, 1],
        [5, 0],
        [9, 0],
      ],
    },
    {
      o: [0, 10, 0],
      n: [0, 1, 0],
      loop: [
        [3, 1],
        [12, 1],
        [7, 0],
        [11, 0],
      ],
    },
    {
      o: [0, 0, 0],
      n: [-1, 0, 0],
      loop: [
        [4, 1],
        [9, 1],
        [8, 0],
        [12, 0],
      ],
    },
    // x = 10 with an inward plane normal: the loop is reversed about it, and the shell uses the face reversed.
    {
      o: [10, 0, 0],
      n: [-1, 0, 0],
      loop: [
        [10, 1],
        [6, 1],
        [11, 0],
        [2, 0],
      ],
      reversed: true,
    },
  ];
  const faceRefs = faces.map((f) => {
    const plane = m.add({ type: 190, params: [point(m, f.o), direction(m, f.n)], status: DEP }),
      loop = m.add({
        type: 508,
        form: 1,
        params: [f.loop.length, ...f.loop.flatMap(([edge, agrees]) => [0, edges, edge, agrees, 0])],
        status: DEP,
      });
    return m.add({ type: 510, form: 1, params: [plane, 1, 1, loop], status: DEP });
  });
  m.set(shell, {
    type: 514,
    form: 1,
    params: [6, ...faceRefs.flatMap((f, i) => [f, faces[i].reversed ? 0 : 1])],
    status: DEP,
  });
  const xform = transform ? m.add({ type: 124, params: transform, status: DEP }) : undefined;
  m.set(msbo, { type: 186, params: [shell, 1, 0], ...(xform ? { transform: xform.ref } : {}) });
  return m.list;
}

/**
 * A cylinder of radius 5 and height 8 as a manifold solid (186): a cylindrical surface (192) side bounded by two full
 * circles and a seam line, two plane (190) ends. `transforms` places the solid through a chain of 124 entities (the
 * first applied first), and `color` gives the solid a colour definition (314).
 */
export function cylinder(options = {}) {
  const { transforms = [], color } = options,
    m = model(),
    msbo = m.slot(),
    shell = m.slot(),
    vertices = m.add({ type: 502, form: 1, params: [2, 5, 0, 0, 5, 0, 8], status: DEP }),
    bottom = arc(m, 0, [0, 0], [5, 0], [5, 0]),
    top = arc(m, 8, [0, 0], [5, 0], [5, 0]),
    seam = line(m, [5, 0, 0], [5, 0, 8]),
    edges = m.add({
      type: 504,
      form: 1,
      params: [3, bottom, vertices, 1, vertices, 1, top, vertices, 2, vertices, 2, seam, vertices, 1, vertices, 2],
      status: DEP,
    });
  const loop = (uses) =>
    m.add({
      type: 508,
      form: 1,
      params: [uses.length, ...uses.flatMap(([edge, agrees]) => [0, edges, edge, agrees, 0])],
      status: DEP,
    });
  const side = m.add({
      type: 192,
      form: 1,
      params: [point(m, [0, 0, 0]), direction(m, [0, 0, 1]), 5, direction(m, [1, 0, 0])],
      status: DEP,
    }),
    low = m.add({ type: 190, params: [point(m, [0, 0, 0]), direction(m, [0, 0, -1])], status: DEP }),
    high = m.add({ type: 190, params: [point(m, [0, 0, 8]), direction(m, [0, 0, 1])], status: DEP });
  const faces = [
    m.add({
      type: 510,
      form: 1,
      params: [
        side,
        1,
        1,
        loop([
          [1, 1],
          [3, 1],
          [2, 0],
          [3, 0],
        ]),
      ],
      status: DEP,
    }),
    m.add({ type: 510, form: 1, params: [low, 1, 1, loop([[1, 0]])], status: DEP }),
    m.add({ type: 510, form: 1, params: [high, 1, 1, loop([[2, 1]])], status: DEP }),
  ];
  m.set(shell, { type: 514, form: 1, params: [3, ...faces.flatMap((f) => [f, 1])], status: DEP });
  // Each matrix points at the one applied after it.
  let next;
  for (let i = transforms.length - 1; i >= 0; i--)
    next = m.add({ type: 124, params: transforms[i], status: DEP, ...(next ? { transform: next.ref } : {}) });
  const colour = color ? m.add({ type: 314, params: [...color, { h: 'TEST' }], status: '00000200' }) : undefined;
  m.set(msbo, {
    type: 186,
    params: [shell, 1, 0],
    ...(next ? { transform: next.ref } : {}),
    ...(colour ? { color: colour } : {}),
  });
  return m.list;
}

/**
 * A 10 x 10 trimmed surface (144) on a bilinear B-spline plane: the outer boundary only in parameter space (a 2D linear
 * path, 106 form 11), a hole of radius 2 only in model space (a circle, written counterclockwise like the outer one).
 */
export function plate() {
  const m = model(),
    surface = patch(m, [
      [0, 0, 0],
      [10, 0, 0],
      [0, 10, 0],
      [10, 10, 0],
    ]),
    path = m.add({ type: 106, form: 11, params: [1, 5, 0, 0, 0, 1, 0, 1, 1, 0, 1, 0, 0], status: PARAM }),
    outer = m.add({ type: 142, params: [0, surface, path, 0, 1], status: DEP }),
    circle = arc(m, 0, [5, 5], [7, 5], [7, 5]),
    hole = m.add({ type: 142, params: [0, surface, 0, circle, 2], status: DEP });
  m.add({ type: 144, params: [surface, 1, 1, outer, hole], color: 2 });
  return m.list;
}

/**
 * One trimmed face whose boundary is a composite curve (102) of every curve entity: a line (110), a 3D linear path
 * (106 form 12), a circular arc (100), a degree-1 rational B-spline (126), a cubic parametric spline (112) and an
 * elliptical conic arc (104) moved into place by a transformation matrix (124). Area 100 + 9.5 pi + 20 / 3.
 */
export function curves() {
  const m = model(),
    surface = patch(m, [
      [-5, -5, 0],
      [15, -5, 0],
      [-5, 15, 0],
      [15, 15, 0],
    ]),
    a = line(m, [0, 0, 0], [10, 0, 0]),
    b = m.add({ type: 106, form: 12, params: [2, 3, 10, 0, 0, 10, 2, 0, 10, 4, 0], status: DEP }),
    c = arc(m, 0, [10, 6], [10, 4], [10, 8]),
    d = m.add({
      type: 126,
      params: [1, 1, 1, 0, 1, 0, 0, 0, 1, 1, 1, 1, 10, 8, 0, 10, 10, 0, 0, 1, 0, 0, 1],
      status: DEP,
    }),
    // x = 10 - 10 s, y = 10 + 4 s - 4 s^2: a bump of height 1 over the top edge, area 20 / 3.
    e = m.add({
      type: 112,
      params: [3, 0, 3, 1, 0, 1, 10, -10, 0, 0, 10, 4, -4, 0, 0, 0, 0, 0, 0, -10, 0, 0, 10, -4, -4, 0, 0, 0, 0, 0],
      status: DEP,
    }),
    shift = m.add({ type: 124, params: [1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1, 0], status: DEP }),
    // 25 x^2 + 9 y^2 - 225 = 0: semi-axes 3 and 5, from (0, 5) counterclockwise to (0, -5), then up by 5.
    f = m.add({
      type: 104,
      form: 1,
      params: [25, 0, 9, 0, 0, -225, 0, 0, 5, 0, -5],
      status: DEP,
      transform: shift.ref,
    }),
    loop = m.add({ type: 102, params: [6, a, b, c, d, e, f], status: DEP }),
    boundary = m.add({ type: 142, params: [0, surface, 0, loop, 2], status: DEP });
  m.add({ type: 144, params: [surface, 1, 0, boundary] });
  return m.list;
}

/**
 * A trimmed face whose top side is a parabolic arc (104 form 3, bulging out by 2.5) and whose left side is a hyperbolic
 * arc (104 form 2, bulging in), each in standard position and moved into place by a 124. Area
 * 100 + 50 / 3 - (10 sqrt 2 - 5 (sqrt 2 + asinh 1)).
 */
export function conics() {
  const m = model(),
    surface = patch(m, [
      [-5, -5, 0],
      [15, -5, 0],
      [-5, 15, 0],
      [15, 15, 0],
    ]),
    move = (x, y) => m.add({ type: 124, params: [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, 0], status: DEP }),
    // 0.1 x^2 + y = 0, vertex at the origin, from (5, -2.5) to (-5, -2.5); moved so the vertex is at (5, 12.5).
    parabola = m.add({
      type: 104,
      form: 3,
      params: [0.1, 0, 0, 0, 1, 0, 0, 5, -2.5, -5, -2.5],
      status: DEP,
      transform: move(5, 12.5).ref,
    }),
    // 25 x^2 - y^2 - 25 = 0 (left branch through (-sqrt 2, +-5)), moved right by sqrt 2 and up by 5.
    hyperbola = m.add({
      type: 104,
      form: 2,
      params: [25, 0, -1, 0, 0, -25, 0, -Math.SQRT2, 5, -Math.SQRT2, -5],
      status: DEP,
      transform: move(Math.SQRT2, 5).ref,
    }),
    loop = m.add({
      type: 102,
      params: [4, line(m, [0, 0, 0], [10, 0, 0]), line(m, [10, 0, 0], [10, 10, 0]), parabola, hyperbola],
      status: DEP,
    }),
    boundary = m.add({ type: 142, params: [0, surface, 0, loop, 2], status: DEP });
  m.add({ type: 144, params: [surface, 1, 0, boundary] });
  return m.list;
}

/** A bicubic parametric spline surface (114) patch: x = x0 + 2 s, y = 3 t, z = 1 (one patch, 2 x 3). */
export const square114 = (m, x0, status = '00000000') =>
  m.add({
    type: 114,
    params: [
      3,
      1,
      1,
      1,
      0,
      1,
      0,
      1,
      // Patch (1, 1): x, y, z coefficients in the order 1, s, s^2, s^3, t, s t, ...
      ...[x0, 2, ...Array(14).fill(0)],
      ...[0, 0, 0, 0, 3, ...Array(11).fill(0)],
      ...[1, ...Array(15).fill(0)],
      // Placeholders for the (N + 1)-th column and (M + 1)-th row of patches.
      ...Array(48 * 3).fill(0),
    ],
    status,
  });

/**
 * Untrimmed surfaces, each meshed over its whole parameter rectangle: a surface of revolution (120, a cylinder side of
 * radius 5 and height 8), a tabulated cylinder (122, radius 3, height 4), a ruled surface (118) between circles of
 * radius 2 and 4 three apart, an offset surface (140) by 0.5 of a 2 x 3 bilinear B-spline square at z = 1, and a
 * bilinear rational B-spline surface (128, 2 x 2).
 */
export function surfaces() {
  const m = model(),
    axis = line(m, [0, 0, 0], [0, 0, 1]),
    generatrix = line(m, [5, 0, 0], [5, 0, 8]);
  m.add({ type: 120, params: [axis, generatrix, 0, 2 * Math.PI] });
  const directrix = arc(m, 0, [20, 0], [23, 0], [23, 0]);
  m.add({ type: 122, params: [directrix, 23, 0, 4] });
  const r1 = arc(m, 0, [40, 0], [42, 0], [42, 0]),
    r2 = arc(m, 3, [40, 0], [44, 0], [44, 0]);
  m.add({ type: 118, form: 1, params: [r1, r2, 0, 1] });
  const base = patch(m, [
    [70, 0, 1],
    [72, 0, 1],
    [70, 3, 1],
    [72, 3, 1],
  ]);
  m.add({ type: 140, params: [0, 0, 1, 0.5, base] });
  patch(
    m,
    [
      [80, 0, 0],
      [82, 0, 0],
      [80, 2, 0],
      [82, 2, 0],
    ],
    '00000000',
  );
  return m.list;
}

/**
 * Bounded surfaces (143) with boundary entities (141): a 4 x 4 square with a 1 x 1 hole (the hole listed first, one of
 * its lines used reversed), a 4 x 2 rectangle whose top side is an offset curve (130) of its bottom side used reversed,
 * and a bounded plane (108 form 1) inside a circle of radius 1.
 */
export function bounded() {
  const m = model(),
    surface = patch(m, [
      [-5, -5, 0],
      [45, -5, 0],
      [-5, 10, 0],
      [45, 10, 0],
    ]);
  const boundary = (curves) =>
    m.add({
      type: 141,
      params: [0, 1, surface, curves.length, ...curves.flatMap(([c, sense]) => [c, sense, 0])],
      status: DEP,
    });
  const outer = boundary([
      [line(m, [0, 0, 0], [4, 0, 0]), 1],
      [line(m, [4, 0, 0], [4, 4, 0]), 1],
      [line(m, [4, 4, 0], [0, 4, 0]), 1],
      [line(m, [0, 4, 0], [0, 0, 0]), 1],
    ]),
    hole = boundary([
      [line(m, [1, 1, 0], [2, 1, 0]), 1],
      [line(m, [2, 2, 0], [2, 1, 0]), 2],
      [line(m, [2, 2, 0], [1, 2, 0]), 1],
      [line(m, [1, 2, 0], [1, 1, 0]), 1],
    ]);
  m.add({ type: 143, params: [0, surface, 2, hole, outer] });
  const base = line(m, [10, 0, 0], [14, 0, 0]),
    offset = m.add({ type: 130, params: [base, 1, 0, 0, 0, 2, 0, 0, 0, 0, 0, 1, 0, 1], status: DEP }),
    rectangle = boundary([
      [line(m, [10, 0, 0], [14, 0, 0]), 1],
      [line(m, [14, 0, 0], [14, 2, 0]), 1],
      [offset, 2],
      [line(m, [10, 2, 0], [10, 0, 0]), 1],
    ]);
  m.add({ type: 143, params: [0, surface, 1, rectangle] });
  const circle = arc(m, 0, [30, 0], [31, 0], [31, 0]);
  m.add({ type: 108, form: 1, params: [0, 0, 1, 0, circle, 30, 0, 0, 0] });
  return m.list;
}

export const fixtures = { cube, cylinder, plate, curves, conics, surfaces, bounded };

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  for (const [name, build] of Object.entries(fixtures))
    await writeFile(new URL(`./fixtures/iges/${name}.igs`, import.meta.url), writeIGES(build()));
