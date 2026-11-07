// @margoengine/physics2d/outline: alpha to outlines to colliders. Drawn images are stand-ins with exact answers; the real
// file is a Noto Emoji doughnut (fixtures/outline/NOTICE.md), read through the engine's own PNG decoder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Physics2D } from '../dist/index.js';
import { outlineColliders, traceOutlines } from '../dist/outline.js';
import { decodePNG } from '../../decoders/dist/png.js';

const warn = console.warn;
console.warn = () => {};
await Physics2D.load();
console.warn = warn;

/** An RGBA image whose alpha is `alpha(x, y)` at each pixel centre. */
function image(width, height, alpha) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) data[(y * width + x) * 4 + 3] = alpha(x + 0.5, y + 0.5);
  return { width, height, data };
}
const solid = (test) => (x, y) => (test(x, y) ? 255 : 0);
const area = (loop) =>
  Math.abs(loop.reduce((sum, [x, y], i) => {
    const [nx, ny] = loop[(i + 1) % loop.length];
    return sum + x * ny - nx * y;
  }, 0)) / 2;
const pieceArea = (colliders) => colliders.reduce((sum, { points }) => sum + area(points), 0);
const isConvex = (points) => {
  let sign = 0;
  for (let i = 0; i < points.length; i++) {
    const [a, b, c] = [points[i], points[(i + 1) % points.length], points[(i + 2) % points.length]],
      turn = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(turn) < 1e-9) continue;
    if (sign && Math.sign(turn) !== sign) return false;
    sign = Math.sign(turn);
  }
  return true;
};

test('a hard square lands half a pixel in from its pixel edges, cut only at its corners', () => {
  // The field is sampled at pixel centres, and threshold 128 of 255 sits just past the middle of a 0 to 255 step: the
  // edge lies at the pixel boundary, moved inward by 1/255 of a pixel at most.
  const [island, ...rest] = traceOutlines(image(16, 16, solid((x, y) => x > 4 && x < 12 && y > 4 && y < 12)), { tolerance: 0.1 });
  assert.equal(rest.length, 0);
  assert.equal(island.holes.length, 0);
  const xs = island.outer.map((p) => p[0]),
    ys = island.outer.map((p) => p[1]);
  assert.ok(Math.abs(Math.min(...xs) - 4) < 0.51 && Math.abs(Math.max(...xs) - 12) < 0.51, xs.join());
  assert.ok(Math.abs(Math.min(...ys) - 4) < 0.51 && Math.abs(Math.max(...ys) - 12) < 0.51, ys.join());
  // Each of the four corners is cut by a triangle of half a pixel by half a pixel: 8 by 8 less 4 x 1/8.
  assert.ok(Math.abs(area(island.outer) - 63.5) < 0.1, `area ${area(island.outer)}`);
});

test('a disc traces to the area of a circle, and a soft edge lands where the alpha crosses', () => {
  const r = 40,
    disc = image(100, 100, solid((x, y) => Math.hypot(x - 50, y - 50) < r)),
    [hard] = traceOutlines(disc, { tolerance: 0.25 });
  // Pixel stairs fall on both sides of the circle, and a tolerance of d changes the area by at most d times the perimeter.
  const limit = 0.25 * 2 * Math.PI * r + 2 * Math.PI * r * 0.1;
  assert.ok(Math.abs(area(hard.outer) - Math.PI * r * r) < limit, `area ${area(hard.outer)} against ${Math.PI * r * r}`);
  // Pixel stairs stand about half a pixel high, so a tolerance of 1 smooths them and 0.25 keeps most.
  const [every] = traceOutlines(disc, { tolerance: 0 }),
    [coarse] = traceOutlines(disc, { tolerance: 1 });
  assert.ok(coarse.outer.length < every.outer.length / 2, `thinned to ${coarse.outer.length} of ${every.outer.length} points`);
  // A ramp 4 pixels wide, so no cell the edge crosses is clipped at 0 or 255.
  const soft = image(100, 100, (x, y) => Math.max(0, Math.min(255, 255 * (0.5 + (r - Math.hypot(x - 50, y - 50)) / 4)))),
    [smooth] = traceOutlines(soft, { threshold: 128, tolerance: 0 });
  // Alpha 128 of 255 sits at radius r less 0.01, and linear interpolation along a cell follows the ramp to about
  // 1 / (8 r) of a pixel, the sag of the circle across one cell.
  for (const [x, y] of smooth.outer) assert.ok(Math.abs(Math.hypot(x - 50, y - 50) - r) < 0.05, `${x}, ${y}`);
});

test('tolerance bounds how far the thinned outline strays, and 0 only drops points on a line', () => {
  const blob = image(64, 64, solid((x, y) => Math.hypot(x - 32, y - 32) < 20 + 6 * Math.sin(Math.atan2(y - 32, x - 32) * 5))),
    [exact] = traceOutlines(blob, { tolerance: 0 }),
    [thin] = traceOutlines(blob, { tolerance: 2 });
  assert.ok(thin.outer.length < exact.outer.length / 2, `${thin.outer.length} of ${exact.outer.length}`);
  const toSegment = ([px, py], [ax, ay], [bx, by]) => {
    const dx = bx - ax,
      dy = by - ay,
      t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(px - ax - t * dx, py - ay - t * dy);
  };
  for (const point of exact.outer) {
    const nearest = Math.min(...thin.outer.map((a, i) => toSegment(point, a, thin.outer[(i + 1) % thin.outer.length])));
    assert.ok(nearest <= 2 + 1e-9, `${point} strays ${nearest}`);
  }
});

test('a ring keeps its hole, two islands stay two, and a speck under minArea goes', () => {
  const ring = image(64, 64, solid((x, y) => {
      const d = Math.hypot(x - 32, y - 32);
      return d > 12 && d < 24;
    })),
    [band, ...none] = traceOutlines(ring);
  assert.equal(none.length, 0);
  assert.equal(band.holes.length, 1);
  assert.ok(area(band.holes[0]) < area(band.outer));
  const pieces = outlineColliders(ring);
  const holeless = Math.PI * (24 * 24 - 12 * 12);
  assert.ok(Math.abs(pieceArea(pieces) - holeless) / holeless < 0.08, `pieces cover ${pieceArea(pieces)} of ${holeless}`);
  const two = image(40, 20, solid((x, y) => (x > 2 && x < 12 && y > 2 && y < 12) || (x > 24 && x < 36 && y > 4 && y < 16)));
  assert.equal(traceOutlines(two).length, 2);
  const speck = image(40, 20, solid((x, y) => (x > 2 && x < 12 && y > 2 && y < 12) || (x > 30 && x < 32 && y > 10 && y < 12)));
  assert.equal(traceOutlines(speck).length, 1);
  assert.equal(traceOutlines(speck, { minArea: 0 }).length, 2);
  assert.deepEqual(traceOutlines(image(4, 4, () => 0)), []);
  assert.deepEqual(outlineColliders(image(4, 4, () => 0)), []);
});

test('a hole inside an island inside a hole goes to the smallest island around it', () => {
  const nest = image(80, 80, solid((x, y) => {
      const d = Math.max(Math.abs(x - 40), Math.abs(y - 40));
      return (d > 28 && d < 38) || (d > 8 && d < 18);
    })),
    islands = traceOutlines(nest);
  assert.equal(islands.length, 2);
  for (const island of islands) assert.equal(island.holes.length, 1);
});

test('an L is cut into few convex pieces that add up to it', () => {
  const ell = image(32, 32, solid((x, y) => x > 4 && x < 28 && y > 4 && y < 28 && (x < 12 || y > 20))),
    pieces = outlineColliders(ell, { tolerance: 0.1 });
  assert.ok(pieces.length >= 2 && pieces.length <= 4, `${pieces.length} pieces`);
  for (const piece of pieces) {
    assert.equal(piece.shape, 'polygon');
    assert.ok(isConvex(piece.points), `${piece.points}`);
  }
  // 24 by 24 less the 16 by 16 notch; every corner cuts up to 1/8 of a pixel.
  assert.ok(Math.abs(pieceArea(pieces) - (24 * 24 - 16 * 16)) < 1, `${pieceArea(pieces)}`);
});

test('a filled U holds a ball in its hollow in a real world, and so do its edges', () => {
  const cup = image(64, 64, solid((x, y) => x > 8 && x < 56 && y > 8 && y < 56 && !(x > 16 && x < 48 && y < 48)));
  for (const edges of [false, true]) {
    const physics = new Physics2D(null, { gravity: [0, 9.81], pixelsPerMeter: 1 }),
      colliders = outlineColliders(cup, { edges, friction: 0.5 });
    if (edges) for (const collider of colliders) assert.equal(collider.shape, 'polyline');
    physics.addBody(null, { type: 'fixed', colliders });
    const ball = physics.addBody(null, { position: [32, 30], colliders: { shape: 'circle', radius: 6 } });
    for (let i = 0; i < 400; i++) physics.step();
    // The floor is at 48 and the ball's radius 6; a thinned edge may stray by the default tolerance of 1.
    assert.ok(Math.abs(ball.position[1] - 42) <= 1.02, `edges ${edges}: rests at y ${ball.position[1]}`);
    assert.ok(ball.position[0] > 16 && ball.position[0] < 48, `edges ${edges}: x ${ball.position[0]}`);
    physics.dispose();
  }
});

test('a sprite places the colliders on its pivot and scale, and its rect picks the frame of an atlas', () => {
  const atlas = image(32, 16, solid((x, y) => x > 20 && x < 28 && y > 4 && y < 12)),
    sprite = { x: 0, y: 0, rotation: 0, rect: [16, 0, 16, 16], pivotX: 0.5, pivotY: 0.5, scaleX: 2, scaleY: 3 },
    [piece] = outlineColliders(atlas, { sprite, tolerance: 0.1 });
  const xs = piece.points.map((p) => p[0]),
    ys = piece.points.map((p) => p[1]);
  // The square is pixels 4 to 12 of the 16 frame: 8 either side of the pivot, by 2 and by 3.
  assert.ok(Math.abs(Math.min(...xs) + 8) < 1.1 && Math.abs(Math.max(...xs) - 8) < 1.1, xs.join());
  assert.ok(Math.abs(Math.min(...ys) + 12) < 1.6 && Math.abs(Math.max(...ys) - 12) < 1.6, ys.join());
  assert.deepEqual(traceOutlines(atlas, { rect: [0, 0, 16, 16] }), []);
});

test('collider settings reach every collider', () => {
  const pieces = outlineColliders(image(16, 16, solid((x, y) => x > 4 && x < 12 && y > 4 && y < 12)), {
    friction: 0.3,
    restitution: 0.2,
    sensor: true,
  });
  for (const piece of pieces) assert.deepEqual([piece.friction, piece.restitution, piece.sensor], [0.3, 0.2, true]);
});

test('bad images and options are refused with what to pass', () => {
  const good = image(4, 4, () => 255);
  assert.throws(() => traceOutlines(null), TypeError);
  assert.throws(() => traceOutlines({ width: 1.5, height: 1, data: [] }), TypeError);
  assert.throws(() => traceOutlines({ width: 2, height: 2, data: new Uint8Array(4) }), RangeError);
  assert.throws(() => traceOutlines(good, { threshold: 0 }), RangeError);
  assert.throws(() => traceOutlines(good, { threshold: 256 }), RangeError);
  assert.throws(() => traceOutlines(good, { tolerance: -1 }), RangeError);
  assert.throws(() => traceOutlines(good, { minArea: NaN }), RangeError);
  assert.throws(() => traceOutlines(good, { rect: [0, 0, 5, 1] }), RangeError);
  assert.throws(() => traceOutlines(good, { rect: [0.5, 0, 1, 1] }), RangeError);
});

test('a real PNG: the doughnut traces to its filled pixels, keeps its hole, and the hole holds a ball', () => {
  const file = fileURLToPath(new URL('./fixtures/outline/donut.png', import.meta.url)),
    decoded = decodePNG(new Uint8Array(readFileSync(file))),
    { width, height, data } = decoded;
  let filled = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] >= 128) filled++;
  const tolerance = 0.5,
    islands = traceOutlines(decoded, { tolerance }),
    [every] = traceOutlines(decoded, { tolerance: 0 }),
    length = (loop) => loop.reduce((sum, [x, y], i) => sum + Math.hypot(loop[(i + 1) % loop.length][0] - x, loop[(i + 1) % loop.length][1] - y), 0);
  assert.equal(islands.length, 1);
  const [{ outer, holes }] = islands;
  assert.equal(holes.length, 1);
  const traced = area(outer) - area(holes[0]),
    edge = length(every.outer) + length(every.holes[0]);
  // Thinning moves the area by at most the tolerance along the edge, and the edge passes within a pixel of its stairs.
  assert.ok(Math.abs(traced - filled) < edge * (tolerance + 0.5), `traced ${traced} of ${filled}, edge ${edge}`);
  const pieces = outlineColliders(decoded, { tolerance });
  for (const piece of pieces) assert.ok(isConvex(piece.points), `${piece.points}`);
  assert.ok(Math.abs(pieceArea(pieces) - traced) < 1, `pieces ${pieceArea(pieces)} of ${traced}`);

  const physics = new Physics2D(null, { gravity: [0, 9.81], pixelsPerMeter: 1 });
  physics.addBody(null, { type: 'fixed', colliders: pieces });
  const xs = holes[0].map((p) => p[0]),
    ys = holes[0].map((p) => p[1]),
    middle = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2],
    ball = physics.addBody(null, { position: middle, colliders: { shape: 'circle', radius: 2 } });
  for (let i = 0; i < 600; i++) physics.step();
  const [x, y] = ball.position;
  physics.dispose();
  assert.equal(width, 128);
  assert.equal(height, 128);
  // It fell to the bottom of the hole and stayed in it.
  assert.ok(y > middle[1] && y < Math.max(...ys) && x > Math.min(...xs) && x < Math.max(...xs), `at ${x}, ${y} in ${xs.length} points`);
});
