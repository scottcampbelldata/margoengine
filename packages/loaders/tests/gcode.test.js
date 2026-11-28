// parseGCode: layers by Z, extrusion against travel, absolute and relative modes, units, comments, limits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGCode } from '../dist/gcode.js';
import { LoaderError } from '../dist/common.js';

const near = (actual, expected, label = 'value') => {
  assert.equal(actual.length, expected.length, label);
  [...actual].forEach((v, i) =>
    assert.ok(Math.abs(v - expected[i]) < 1e-4, `${label}: ${[...actual]} against ${expected}`),
  );
};

test('extruding moves form layers by rising Z; travel leads into the next layer', () => {
  const { layers, filament, min, max } = parseGCode(`
G21 ; millimetres
G90
M82
G92 E0
G0 Z0.2 F3000
G1 X10 Y0 E1 F1200 ; first line
G1 X10 Y10 E2
G0 X0 Y0
G0 Z0.4
G1 X5 E3
`);
  assert.deepEqual(
    layers.map((l) => Math.round(l.z * 10) / 10),
    [0.2, 0.4],
  );
  near(layers[0].extrusion, [0, 0, 0.2, 10, 0, 0.2, 10, 0, 0.2, 10, 10, 0.2], 'layer 0 extrusion');
  near(layers[0].travel, [0, 0, 0, 0, 0, 0.2], 'the Z move leads in');
  near(layers[1].extrusion, [0, 0, 0.4, 5, 0, 0.4], 'layer 1 extrusion');
  near(layers[1].travel, [10, 10, 0.2, 0, 0, 0.2, 0, 0, 0.2, 0, 0, 0.4], 'layer 1 travel');
  assert.equal(filament, 3);
  near(min, [0, 0, 0]);
  near(max, [10, 10, 0.4]);
});

test('layers come back sorted though the file printed them out of order', () => {
  const { layers } = parseGCode('G1 Z2\nG1 X1 E1\nG1 Z1\nG1 X2 E2\nG1 Z2\nG1 X3 E3\n');
  assert.deepEqual(
    layers.map((l) => l.z),
    [1, 2],
  );
  assert.equal(layers[1].extrusion.length, 12, 'a return to a Z joins its layer');
});

test('regression: retraction and pure E moves draw nothing, and filament is the net length pushed', () => {
  const { layers, filament } = parseGCode('G1 Z1\nG1 X5 E5\nG1 E3\nG1 E5\nG1 X9 E4\nG1 X12 E6\n');
  // A slicer's "filament used" is net: counting each recovery again read 1,941 mm for a print of 317 mm.
  assert.equal(filament, 6);
  assert.equal(layers.length, 1);
  near(layers[0].extrusion, [0, 0, 1, 5, 0, 1, 9, 0, 1, 12, 0, 1]);
  near(layers[0].travel.subarray(6), [5, 0, 1, 9, 0, 1], 'an E that falls is travel');
});

test('relative modes: G91 moves all axes, M83 only E, G90 and M82 restore them', () => {
  const all = parseGCode('G1 Z1\nG91\nG1 X1 E1\nG1 X1 E1\nG90\nG1 X5 E3\n');
  near(all.layers[0].extrusion, [0, 0, 1, 1, 0, 1, 1, 0, 1, 2, 0, 1, 2, 0, 1, 5, 0, 1]);
  assert.equal(all.filament, 3);
  const onlyE = parseGCode('M83\nG1 Z1\nG1 X1 E1\nG1 X2 E1\nM82\nG92 E0\nG1 X3 E5\n');
  near(onlyE.layers[0].extrusion, [0, 0, 1, 1, 0, 1, 1, 0, 1, 2, 0, 1, 2, 0, 1, 3, 0, 1]);
  assert.equal(onlyE.filament, 7);
});

test('G92 sets positions without moving, G28 homes, G20 reads inches', () => {
  const set = parseGCode('G1 Z1\nG1 X10 E1\nG92 X0\nG1 X5 E2\n');
  near(set.layers[0].extrusion.subarray(6), [0, 0, 1, 5, 0, 1]);
  const home = parseGCode('G1 X5 Y5 Z5\nG28 X\nG1 Y6 E1\nG28\nG1 X1 E2\n');
  near(home.layers[1].extrusion, [0, 5, 5, 0, 6, 5]);
  near(home.layers[0].extrusion, [0, 0, 0, 1, 0, 0]);
  const inches = parseGCode('G20\nG1 Z1\nG1 X1 E1\nG21\nG1 X100 E100\n');
  near(inches.layers[0].extrusion, [0, 0, 25.4, 25.4, 0, 25.4, 25.4, 0, 25.4, 100, 0, 25.4]);
});

test('spelling: no spaces, lower case, line numbers, checksums, comments of both kinds, CRLF', () => {
  const { layers } = parseGCode(
    'N1 g1z1*12\r\ng1x1e1 (a comment G1 X99)\r\nN3 G1 X2 ; G1 X99\r\n;G1 X99\r\n(G1 X99)\r\nM104 S200\r\nG1 X-1.5 Y+.5 E2\r\n',
  );
  near(layers[0].extrusion, [0, 0, 1, 1, 0, 1, 2, 0, 1, -1.5, 0.5, 1]);
});

test('an empty file is empty', () => {
  const empty = parseGCode('; nothing\nM84\n');
  assert.deepEqual(empty.layers, []);
  assert.deepEqual(empty.min, [0, 0, 0]);
  assert.deepEqual(empty.max, [0, 0, 0]);
});

test('a file that only travels still shows its moves', () => {
  const { layers } = parseGCode('G0 X1\nG0 X2\n');
  assert.equal(layers.length, 1);
  near(layers[0].travel, [0, 0, 0, 1, 0, 0, 1, 0, 0, 2, 0, 0]);
});

test('bad input and limits throw coded errors', () => {
  const coded = (fn, code, pattern) =>
    assert.throws(
      fn,
      (e) => e instanceof LoaderError && e.code === code && e.format === 'G-code' && pattern.test(e.message),
    );
  coded(() => parseGCode('G1 X'), 'syntax', /X has no number on line 1/);
  coded(() => parseGCode('G1 X1\nG\n'), 'syntax', /without a number on line 2/);
  coded(() => parseGCode('G1 X1\nG1 X2\n', { maxVertices: 3 }), 'limit', /vertex count/);
  coded(() => parseGCode('G1 X1', { maxVertices: -1 }), 'range', /maxVertices/);
  assert.equal(parseGCode(new TextEncoder().encode('G1 X1 E1')).layers.length, 1);
});

// Points of a layer's segments (end of each), and checks that each is on a circle.
const ends = (list) => {
  const out = [];
  for (let i = 3; i < list.length; i += 6) out.push([list[i], list[i + 1], list[i + 2]]);
  return out;
};
const onCircle = (points, centre, radius, u = 0, v = 1) =>
  points.forEach((p) =>
    assert.ok(Math.abs(Math.hypot(p[u] - centre[0], p[v] - centre[1]) - radius) < 1e-4, `${p} is off the circle`),
  );
const bounds = (points, axis) => [Math.min(...points.map((p) => p[axis])), Math.max(...points.map((p) => p[axis]))];
// Chord ends fall within the 0.002 mm tolerance of a circle's extremes, not on them.
const about = (actual, expected, label) =>
  actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 0.01, `${label}: ${actual} against ${expected}`));

test('regression: G3 and G2 by centre offsets draw arcs as chords within 0.002 mm, E spread along them', () => {
  const ccw = parseGCode('G1 Z1\nG1 X10 E1\nG3 X0 Y10 I-10 J0 E3\n');
  const quarter = ends(ccw.layers[0].extrusion).slice(1);
  onCircle(quarter, [0, 0], 10);
  assert.ok(
    quarter.every((p) => p[0] >= -1e-9 && p[1] >= -1e-9),
    'G3 turns counter-clockwise: the short way here',
  );
  near(quarter.at(-1), [0, 10, 1], 'it ends on the given point');
  const chords = quarter.length,
    half = Math.PI / 4 / chords;
  assert.ok(10 * (1 - Math.cos(half)) <= 0.002 + 1e-12, 'the chords stay within the tolerance');
  assert.equal(
    chords,
    Math.ceil(Math.PI / 2 / (2 * Math.acos(1 - 0.002 / 10))),
    'and use no more chords than it needs',
  );
  assert.equal(ccw.filament, 3);
  near(ccw.max, [10, 10, 1]);
  const cw = ends(parseGCode('G1 Z1\nG1 X10 E1\nG2 X0 Y10 I-10 E3\n').layers[0].extrusion).slice(1);
  onCircle(cw, [0, 0], 10);
  about(bounds(cw, 1), [-10, 10], 'G2 turns clockwise: three quarters, through y = -10');
});

test('regression: R arcs take the short way when R > 0 and the long way when R < 0', () => {
  const points = (code) => ends(parseGCode(`G1 Z1\n${code}\n`).layers[0].travel).slice(1);
  const semicircle = points('G2 X10 Y0 R5');
  onCircle(semicircle, [5, 0], 5);
  about(bounds(semicircle, 1), [0, 5], 'G2 over the top');
  const short = points('G3 X10 R10'),
    long = points('G3 X10 R-10'),
    rise = Math.sqrt(75);
  onCircle(short, [5, rise], 10);
  onCircle(long, [5, -rise], 10);
  about(bounds(short, 1), [rise - 10, 0], 'short arc below the chord');
  about(bounds(long, 1), [-rise - 10, 0], 'long arc around the bottom');
  about([Math.max(...points('G2 X10 R-10').map((p) => p[1]))], [rise + 10], 'G2 R-10 mirrors it');
});

test('regression: a full circle, P turns and a helix', () => {
  const circle = ends(parseGCode('G1 Z1\nG2 I5 E2\n').layers[0].extrusion);
  onCircle(circle, [5, 0], 5);
  about(bounds(circle, 0), [0, 10], 'an arc that ends where it starts is a whole turn');
  about(bounds(circle, 1), [-5, 5], 'y');
  const twice = ends(parseGCode('G1 Z1\nG2 I5 P2 E2\n').layers[0].extrusion);
  onCircle(twice, [5, 0], 5);
  assert.ok(Math.abs(twice.length - circle.length * 2) <= 1, 'P2 turns twice');
  const helix = ends(parseGCode('G3 I5 Z2\n').layers[0].travel);
  onCircle(helix, [5, 0], 5);
  near([helix.at(-1)[2]], [2], 'the normal axis ends at Z');
  near([helix[(helix.length >> 1) - 1][2]], [(2 * (helix.length >> 1)) / helix.length], 'and moves evenly');
});

test('regression: G18 and G19 select the ZX and YZ planes, turning about the positive Y and X axes', () => {
  const path = (code) => ends(parseGCode(code).layers[0].travel).slice(1);
  const zx = path('G0 X10\nG18\nG2 X0 Z10 I-10 K0\n');
  onCircle(zx, [0, 0], 10, 0, 2);
  assert.ok(
    zx.every((p) => p[0] >= -1e-9 && p[2] >= -1e-9 && p[1] === 0),
    'G18 G2 from X to Z is a quarter',
  );
  about(bounds(path('G0 X10\nG18\nG3 X0 Z10 I-10\n'), 0), [-10, 10], 'G3 the other way round');
  const yz = path('G0 Y10\nG19\nG3 Y0 Z10 J-10\n');
  onCircle(yz, [0, 0], 10, 1, 2);
  assert.ok(
    yz.every((p) => p[1] >= -1e-9 && p[2] >= -1e-9 && p[0] === 0),
    'G19 G3 from Y to Z is a quarter',
  );
  about(bounds(path('G0 Y10\nG19\nG2 Y0 Z10 J-10\n'), 1), [-10, 10], 'G19 G2');
  const back = path('G0 X10\nG19\nG17\nG3 X0 Y10 I-10\n');
  onCircle(back, [0, 0], 10);
});

test('regression: arcs in inches and in relative mode; arc errors are coded', () => {
  const inches = ends(parseGCode('G20\nG0 X1\nG3 X0 Y1 I-1\n').layers[0].travel).slice(1);
  onCircle(inches, [0, 0], 25.4);
  const relative = ends(parseGCode('G0 X10\nG91\nG3 X-10 Y10 I-10\n').layers[0].travel).slice(1);
  onCircle(relative, [0, 0], 10);
  near(relative.at(-1), [0, 10, 0]);
  const coded = (text, code, pattern) =>
    assert.throws(
      () => parseGCode(text),
      (e) => e instanceof LoaderError && e.code === code && e.format === 'G-code' && pattern.test(e.message),
    );
  coded('G2 X5 Y5 I1 J1', 'range', /off its circle on line 1/);
  coded('G2 X5 Y5', 'syntax', /centre offsets in its plane or R/);
  coded('G18\nG2 X5 J1', 'syntax', /centre offsets in its plane/);
  coded('G2 X10 R4', 'range', /shorter than half its chord/);
  coded('G2 R4', 'syntax', /end away from its start/);
  coded('G2 I5 P1.5', 'syntax', /whole number of turns/);
  coded('G2 X10 I', 'syntax', /I has no number/);
  assert.throws(
    () => parseGCode('G2 I5', { maxVertices: 20 }),
    (e) => e.code === 'limit',
  );
  assert.deepEqual(parseGCode('G2 I5').warnings, []);
});

// LinuxCNC G-code reference, G90.1 and G91.1 (arc distance mode) and G2/G3 P; Marlin G2-G3 page, P "complete circles".
test('regression: G90.1 reads I, J and K as the centre itself, G91.1 as an offset again', () => {
  const path = (code) => ends(parseGCode(code).layers[0].travel).slice(1);
  // Start (10, 0), centre (0, 0): absolute I0 J0 and incremental I-10 draw the same quarter.
  const absolute = path('G0 X10\nG90.1\nG3 X0 Y10 I0 J0\n');
  onCircle(absolute, [0, 0], 10);
  near(absolute.at(-1), [0, 10, 0]);
  const incremental = path('G0 X10\nG3 X0 Y10 I-10 J0\n');
  assert.equal(absolute.length, incremental.length);
  absolute.forEach((p, i) => near(p, incremental[i], `chord ${i}`));
  // G91.1 switches back; G91 relative axes leave the absolute centre absolute.
  onCircle(path('G0 X10\nG90.1\nG91.1\nG3 X0 Y10 I-10\n'), [0, 0], 10);
  const relativeAxes = path('G0 X10\nG90.1\nG91\nG3 X-10 Y10 I0 J0\n');
  onCircle(relativeAxes, [0, 0], 10);
  near(relativeAxes.at(-1), [0, 10, 0]);
  // The plane picks the words: G18 takes K (u) and I (v), G19 J and K.
  onCircle(path('G0 X10\nG18\nG90.1\nG2 X0 Z10 I0 K0\n'), [0, 0], 10, 0, 2);
  onCircle(path('G0 Y10\nG19\nG90.1\nG3 Y0 Z10 J0 K0\n'), [0, 0], 10, 1, 2);
  // Inches scale the centre too; a full circle about an absolute centre.
  onCircle(path('G20\nG0 X1\nG90.1\nG3 X0 Y1 I0 J0\n'), [0, 0], 25.4);
  const circle = ends(parseGCode('G0 X10 Y5\nG90.1\nG2 I5 J5\n').layers[0].travel);
  onCircle(circle, [5, 5], 5);
  about(bounds(circle, 0), [0, 10], 'whole turn about (5, 5)');
  // LinuxCNC: both centre words of the plane are required in G90.1; R still works.
  assert.throws(
    () => parseGCode('G0 X10\nG90.1\nG3 X0 Y10 I0\n'),
    (e) =>
      e instanceof LoaderError &&
      e.code === 'syntax' &&
      /G90.1 arc needs both centre words of its plane or R on line 3/.test(e.message),
  );
  onCircle(path('G0 X10\nG90.1\nG3 X0 Y10 R10\n'), [0, 0], 10);
});

test('regression: arcP chooses LinuxCNC turns (default) or Marlin complete circles for P', () => {
  // Chords drawn, without the G0 that leads in.
  const count = (code, options) => ends(parseGCode(code, options).layers[0].travel).length - 1;
  const quarter = count('G0 X10\nG3 X0 Y10 I-10\n'),
    turn = count('G0 X10\nG3 I-10\n');
  assert.equal(count('G0 X10\nG3 X0 Y10 I-10 P1\n'), quarter, 'LinuxCNC P1 is the arc alone');
  assert.ok(Math.abs(count('G0 X10\nG3 X0 Y10 I-10 P2\n') - (quarter + turn)) <= 1, 'LinuxCNC P2 adds one turn');
  const marlin = { arcP: 'circles' };
  assert.equal(count('G0 X10\nG3 X0 Y10 I-10\n', marlin), quarter, 'no P: the arc alone');
  assert.equal(count('G0 X10\nG3 X0 Y10 I-10 P0\n', marlin), quarter, 'Marlin P0 is the arc alone');
  // Marlin's Pn draws what LinuxCNC's P(n + 1) does, chord for chord.
  assert.equal(
    count('G0 X10\nG3 X0 Y10 I-10 P1\n', marlin),
    count('G0 X10\nG3 X0 Y10 I-10 P2\n'),
    'Marlin P1 adds a circle',
  );
  const three = count('G0 X10\nG3 I-10 P2\n', marlin);
  assert.equal(three, count('G0 X10\nG3 I-10 P3\n'), 'a full circle with P2: three turns');
  assert.ok(Math.abs(three - 3 * turn) <= 3, 'about three times one turn');
  assert.equal(count('G0 X10\nG3 X0 Y10 I-10\n', { arcP: 'turns' }), quarter);
  const coded = (fn, code, pattern) =>
    assert.throws(fn, (e) => e instanceof LoaderError && e.code === code && pattern.test(e.message));
  coded(() => parseGCode('G2 I5 P0'), 'syntax', /whole number of turns/);
  coded(() => parseGCode('G2 I5 P-1', marlin), 'syntax', /whole number of circles, 0 or more/);
  coded(() => parseGCode('G2 I5', { arcP: 'loops' }), 'range', /arcP must be 'turns' or 'circles'/);
});

test('toolpathBeads: a closed stadium bead under the path, wound outward, with the slicer section area', async () => {
  const { toolpathBeads } = await import('../dist/gcode.js');
  const width = 0.45,
    height = 0.2,
    z = 1.4;
  const bead = toolpathBeads([0, 0, z, 10, 0, z, 10, 0, z, 10, 0, z + 1, 5, 5, z, 5, 5, z], {
    width,
    height,
    round: 16,
  });
  // Only the first segment draws: the vertical and zero-length ones are skipped.
  const p = bead.positions,
    nrm = bead.normals,
    idx = bead.indices;
  let volume = 0,
    zMin = Infinity,
    zMax = -Infinity;
  for (let i = 2; i < p.length; i += 3) (zMin = Math.min(zMin, p[i])), (zMax = Math.max(zMax, p[i]));
  assert.ok(Math.abs(zMax - z) < 1e-6 && Math.abs(zMin - (z - height)) < 1e-6, `${zMin} ${zMax}`);
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]].map((k) => [p[k * 3], p[k * 3 + 1], p[k * 3 + 2]]);
    const e1 = b.map((v, k) => v - a[k]),
      e2 = c.map((v, k) => v - a[k]);
    const face = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const k = idx[t];
    // Every triangle faces the way its vertex normals point (outward), so back-face culling keeps the outside.
    assert.ok(face[0] * nrm[k * 3] + face[1] * nrm[k * 3 + 1] + face[2] * nrm[k * 3 + 2] > -1e-12, `triangle ${t / 3}`);
    volume +=
      (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) /
      6;
  }
  // Closed and outward: the divergence-theorem volume is the length times (w - h) h + PI (h / 2)^2.
  const section = (width - height) * height + Math.PI * (height / 2) ** 2;
  assert.ok(Math.abs(volume - 10 * section) < 10 * section * 0.01, `${volume} against ${10 * section}`);
  assert.equal(toolpathBeads(new Float32Array(0)).indices.length, 0);
  assert.throws(() => toolpathBeads([0, 0, 0, 1, 0]), RangeError);
  assert.throws(() => toolpathBeads([0, 0, 0, 1, 0, 0], { width: 0 }), RangeError);
  assert.throws(() => toolpathBeads([0, 0, 0, 1, 0, 0], { round: 0 }), RangeError);
});
