// generateLogWall (KB-CABIN-SEAM1): the sky showed through the seams between a log wall's courses as one-pixel lines
// (cabin-window-snow, inside the window and at the right-hand corner). A faceted log's flat sits r (1 - cos(pi / n))
// inside its circle, so logs stacked at a pitch of one diameter leave a straight slit through the wall at every
// course line. These tests cast lines through the wall at every course line, straight and oblique, and require each
// to hit the wall; without the chinking every line through the slit passes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateLogWall } from '../dist/index.js';

/** Möller-Trumbore: does the line o + t d (any t) cross a triangle of the geometry? `tris` are prefiltered indices. */
function hits(g, tris, o, d) {
  const p = g.positions;
  for (const t of tris) {
    const a = g.indices[t] * 3,
      b = g.indices[t + 1] * 3,
      c = g.indices[t + 2] * 3;
    const e1 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]],
      e2 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
    const h = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]],
      det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
    if (Math.abs(det) < 1e-12) continue;
    const s = [o[0] - p[a], o[1] - p[a + 1], o[2] - p[a + 2]],
      u = (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]) / det;
    if (u < 0 || u > 1) continue;
    const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]],
      v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) / det;
    if (v >= 0 && u + v <= 1) return true;
  }
  return false;
}

/** Triangle offsets whose Y range meets [lo, hi]. */
function band(g, lo, hi) {
  const out = [];
  for (let t = 0; t < g.indices.length; t += 3) {
    const ys = [0, 1, 2].map((k) => g.positions[g.indices[t + k] * 3 + 1]);
    if (Math.max(...ys) >= lo && Math.min(...ys) <= hi) out.push(t);
  }
  return out;
}

// Through the wall: straight, along the wall, up and down, and both at once.
const directions = [
  [0, 0, 1],
  [0.6, 0, 1],
  [-0.6, 0, 1],
  [0, 0.04, 1],
  [0, -0.04, 1],
  [0.5, 0.03, 1],
];

/** Count the lines through the wall at each course line `i` (between courses i - 1 and i), within `solid(x, i)`,
 * that miss it. */
function leaks(wall, { diameter, bottom = diameter / 2, lines, xs, solid }) {
  let missed = 0,
    cast = 0;
  for (let i = 1; i < lines; i++) {
    const y = bottom + (i - 0.5) * diameter,
      tris = band(wall, y - diameter, y + diameter);
    for (const x of xs)
      for (let k = -20; k <= 20; k++) {
        const at = y + (k / 20) * 0.02 * diameter;
        if (!solid(x, i)) continue;
        for (const d of directions) {
          cast++;
          if (!hits(wall, tris, [x, at, 0], d)) missed++;
        }
      }
  }
  return { missed, cast };
}

test('a log wall has no line of sight through it between its courses, straight or oblique', () => {
  // The Cabin Hearth front wall: 9 courses of 0.3 m logs, 14 segments, a window and a door.
  const window = [0.6, 1.8, 0.95, 2.05],
    door = [-2.1, -1.1, -Infinity, 2.15],
    wall = generateLogWall({
      courses: Array.from({ length: 9 }, () => [-3.25, 3.25]),
      diameter: 0.3,
      openings: [window, door],
    });
  const xs = Array.from({ length: 61 }, (_, i) => -3.2 + (i * 6.4) / 60),
    // A course is cut where its log overlaps an opening; keep 2 cm clear of the cut ends.
    cut = (o, course) => 0.15 + course * 0.3 + 0.15 > o[2] && 0.15 + course * 0.3 - 0.15 < o[3],
    clear = (o, x, i) => x < o[0] - 0.02 || x > o[1] + 0.02 || (!cut(o, i - 1) && !cut(o, i)),
    { missed, cast } = leaks(wall, {
      diameter: 0.3,
      lines: 9,
      xs,
      solid: (x, i) => clear(window, x, i) && clear(door, x, i),
    });
  assert.ok(cast > 15000, `cast ${cast}`);
  assert.equal(missed, 0, `${missed} of ${cast} lines through the course lines pass the wall`);
  // Not vacuous: lines through the window and the door pass.
  const all = band(wall, -1, 4);
  assert.equal(hits(wall, all, [1.2, 1.5, 0], [0, 0, 1]), false, 'the window is open');
  assert.equal(hits(wall, all, [-1.6, 1, 0], [0, 0, 1]), false, 'the door is open');
  assert.equal(hits(wall, all, [-2.6, 1.05, 0], [0, 0, 1]), true, 'the log beside the door is solid');
});

// KB-CABIN-DOORLEAK1: Cabin Hearth's door opening ends at 2.15 m, inside the 2.1 to 2.4 m course, and that whole log
// was cut away, so a 25 cm strip above the door's planks looked into the lit room from outside. An opening is now cut
// exactly: a log its edge crosses keeps the part outside it.
test('an opening is cut to its own edges: a log its top or bottom crosses keeps the rest, notched flat', () => {
  const window = [0.6, 1.8, 0.95, 2.05],
    door = [-2.1, -1.1, -Infinity, 2.15],
    wall = generateLogWall({
      courses: Array.from({ length: 9 }, () => [-3.25, 3.25]),
      diameter: 0.3,
      openings: [window, door],
    }),
    all = band(wall, -1, 4),
    through = (x, y, d = [0, 0, 1]) => hits(wall, all, [x, y, 0], d);
  let open = 0,
    shut = 0;
  for (let k = 0; k <= 20; k++) {
    const x = -2.08 + (k / 20) * 0.96,
      u = 0.62 + (k / 20) * 1.16;
    // Above the door, up to the next course: solid wood, straight and oblique.
    for (const y of [2.152, 2.2, 2.3, 2.39])
      for (const d of [
        [0, 0, 1],
        [0, 0.04, 1],
        [0, -0.04, 1],
      ])
        shut += through(x, y, d) ? 0 : 1;
    // Under and over the window, outside its edges: solid.
    for (const y of [0.91, 0.94, 2.06, 2.09]) shut += through(u, y) ? 0 : 1;
    // Inside the openings: open.
    for (const y of [1, 2.14]) open += through(x, y) ? 0 : 1;
    for (const y of [0.96, 1.5, 2.04]) open += through(u, y) ? 0 : 1;
  }
  assert.equal(shut, 0, `${shut} lines outside the openings pass the wall`);
  assert.equal(open, 21 * 5, 'every line inside the openings passes');
  // The notched logs keep the wall closed between their courses too (chinking at the kept faces).
  const { missed } = leaks(wall, {
    diameter: 0.3,
    lines: 9,
    xs: Array.from({ length: 41 }, (_, i) => -3.2 + (i * 6.4) / 40),
    solid: (x, i) => {
      const line = 0.15 + (i - 0.5) * 0.3;
      return !(x > -2.12 && x < -1.08 && line < 2.15) && !(x > 0.58 && x < 1.82 && line > 0.95 && line < 2.05);
    },
  });
  assert.equal(missed, 0, `${missed} lines through the course lines pass the wall`);
  // Every face is wound to face out: a normal agrees with its triangle's winding.
  const p = wall.positions,
    n = wall.normals;
  let inward = 0;
  for (let t = 0; t < wall.indices.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => wall.indices[t + k] * 3),
      e1 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]],
      e2 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]],
      f = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (Math.hypot(...f) < 1e-9) continue;
    const m = [n[a] + n[b] + n[c], n[a + 1] + n[b + 1] + n[c + 1], n[a + 2] + n[b + 2] + n[c + 2]];
    if (f[0] * m[0] + f[1] * m[1] + f[2] * m[2] < 0) inward++;
  }
  assert.equal(inward, 0, `${inward} triangles face against their normals`);
});

test('every segment count and a gable of shortening courses are closed too', () => {
  for (const segments of [6, 8, 12, 14, 16, 24]) {
    // Whiteout Pass's side wall: 0.26 m logs, a gable of shortening courses and an empty course at the top.
    const courses = [
        ...Array.from({ length: 8 }, () => [-1.92, 1.92]),
        [-1.4, 1.4],
        [-1.03, 1.03],
        [-0.66, 0.66],
        [0, 0],
      ],
      wall = generateLogWall({ courses, diameter: 0.26, bottom: 0.26, segments }),
      { missed, cast } = leaks(wall, {
        diameter: 0.26,
        bottom: 0.26,
        lines: 11,
        xs: Array.from({ length: 21 }, (_, i) => -1.9 + (i * 3.8) / 20),
        solid: (x, i) => {
          const reach = Math.min(Math.abs(courses[i - 1]?.[1] ?? 0), Math.abs(courses[i]?.[1] ?? 0));
          return Math.abs(x) < reach - 0.02;
        },
      });
    assert.ok(cast > 3000, `${segments} segments: cast ${cast}`);
    assert.equal(missed, 0, `${segments} segments: ${missed} of ${cast} lines pass the wall`);
  }
});

test('the chinking stays inside the logs: the wall is no deeper and no taller than its logs', () => {
  const wall = generateLogWall({
      courses: [
        [-1, 1],
        [-1, 1],
        [-1, 1],
      ],
      diameter: 0.3,
      segments: 14,
    }),
    p = wall.positions;
  let zMax = 0,
    yMin = Infinity,
    yMax = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    zMax = Math.max(zMax, Math.abs(p[i + 2]));
    yMin = Math.min(yMin, p[i + 1]);
    yMax = Math.max(yMax, p[i + 1]);
  }
  assert.ok(zMax <= 0.15 + 1e-6 && yMin >= -1e-6 && yMax <= 0.9 + 1e-6, `${zMax} ${yMin} ${yMax}`);
  // Each chink vertex lies inside the inscribed circle of the logs above and below it, so it never shows.
  const c = Math.cos(Math.PI / 14) * 0.15;
  let chinks = 0;
  for (let i = 0; i < p.length; i += 3) {
    const y = p[i + 1],
      z = p[i + 2],
      line = Math.round(y / 0.3) * 0.3;
    if (Math.abs(y - line) > 0.02 || line === 0 || Math.abs(line - 0.9) < 1e-9) continue;
    if (Math.abs(z) > 0.1) continue;
    const inside = Math.min(Math.hypot(z, y - (line - 0.15)), Math.hypot(z, y - (line + 0.15)));
    if (Math.abs(inside - 0.15) < 1e-4) continue; // a log's own vertex, on its circle
    chinks++;
    assert.ok(inside <= c + 1e-6, `chink vertex (${y}, ${z}) is ${inside} from a log axis; inscribed ${c}`);
  }
  assert.equal(chinks, 48, 'two chinks of 24 vertices');
});

test('generateLogWall validates its options', () => {
  assert.throws(() => generateLogWall({ courses: [] }), /log wall/);
  assert.throws(() => generateLogWall({ courses: [[0, Number.NaN]] }), /log wall/);
  assert.throws(() => generateLogWall({ courses: [[0, 1]], segments: 2 }), /log wall/);
  assert.throws(() => generateLogWall({ courses: [[0, 1]], diameter: 0 }), /log wall/);
  assert.throws(() => generateLogWall({ courses: [[0, 1]], openings: [[0, 1, Number.NaN, 1]] }), /log wall/);
  assert.throws(() => generateLogWall({ courses: [[0, 1]], openings: [[-1, 2, -Infinity, Infinity]] }), /cut away/);
});
