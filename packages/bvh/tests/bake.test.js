import test from 'node:test';
import assert from 'node:assert/strict';
import { MeshBVH } from '../dist/index.js';
import { bakeVertexColors, limitPalette } from '../dist/bake.js';

// Quad a-b-c-d as two triangles, wound as given.
const quad = (a, b, c, d) => [...a, ...b, ...c, ...a, ...c, ...d];
// Horizontal square at height y facing +y (counter-clockwise seen from above).
const square = (x0, x1, z0, z1, y = 0) => quad([x0, y, z0], [x0, y, z1], [x1, y, z1], [x1, y, z0]);
const ground = square(-10, 10, -10, 10);
// The four walls and the lid of a unit box standing on the ground at the origin.
const box = [
  ...quad([-0.5, 0, -0.5], [-0.5, 1, -0.5], [-0.5, 1, 0.5], [-0.5, 0, 0.5]),
  ...quad([0.5, 0, -0.5], [0.5, 1, -0.5], [0.5, 1, 0.5], [0.5, 0, 0.5]),
  ...quad([-0.5, 0, -0.5], [-0.5, 1, -0.5], [0.5, 1, -0.5], [0.5, 0, -0.5]),
  ...quad([-0.5, 0, 0.5], [-0.5, 1, 0.5], [0.5, 1, 0.5], [0.5, 0, 0.5]),
  ...square(-0.5, 0.5, -0.5, 0.5, 1),
];
const bvh = (...parts) => MeshBVH.build({ positions: new Float32Array(parts.flat()) });
// Upward-facing sample points on the ground.
const floor = (...xs) => ({ positions: xs.flatMap((x) => [x, 0, 0]), normals: xs.flatMap(() => [0, 1, 0]) });
const red = (colors) => [...colors].filter((_, i) => i % 4 === 0);
const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));

test('AO is exactly 1 on an open plane and darkens toward a box standing on it', () => {
  const open = bakeVertexColors(floor(-3, 0, 2.5, 7), bvh(ground), { ao: { rays: 64 } });
  assert.deepEqual([...open], new Array(16).fill(1));
  const ao = red(bakeVertexColors(floor(0.6, 0.8, 1.2, 3), bvh(ground, box), { ao: { rays: 256, distance: 1 } }));
  assert.ok(ao[0] < ao[1] && ao[1] < ao[2] && ao[2] < 1, `${ao}`);
  assert.equal(ao[3], 1);
  assert.ok(ao[0] > 0.3 && ao[0] < 0.8, `next to the wall about half the hemisphere is blocked: ${ao[0]}`);
  // Strength scales the darkening linearly: 1 - strength * occluded / rays.
  const half = red(bakeVertexColors(floor(0.6), bvh(ground, box), { ao: { rays: 256, distance: 1, strength: 0.5 } }));
  assert.ok(close(half[0], 1 - (1 - ao[0]) / 2));
  // Ambient light is multiplied by the AO term too.
  const lit = red(
    bakeVertexColors(floor(0.6), bvh(ground, box), {
      lights: [{ type: 'ambient', intensity: 0.25 }],
      ao: { rays: 256, distance: 1 },
    }),
  );
  assert.ok(close(lit[0], 0.25 * ao[0]));
});

test('AO is deterministic for a seed and changes with it', () => {
  const run = (seed) => bakeVertexColors(floor(0.6, 0.9), bvh(ground, box), { ao: { rays: 64 }, seed });
  assert.deepEqual(run(7), run(7));
  assert.notDeepEqual(run(7), run(8));
});

test('shadow rays block directional light, honoring backfaces and the shadows switch', () => {
  // A roof at y = 2 over [-1, 1]^2 whose front faces up: rays from below meet its back face.
  const scene = bvh(ground, square(-1, 1, -1, 1, 2)),
    up = [{ type: 'directional', direction: [0, 1, 0], intensity: 2 }];
  assert.deepEqual(red(bakeVertexColors(floor(0, 3), scene, { lights: up })), [0, 2]);
  assert.deepEqual(red(bakeVertexColors(floor(0, 3), scene, { lights: up, shadows: false })), [2, 2]);
  assert.deepEqual(red(bakeVertexColors(floor(0, 3), scene, { lights: up, backfaces: false })), [2, 2]);
  // A slanted light: from x = 0 the ray passes the roof edge at x = 2, from x = -2 it hits the roof at x = 0.
  const slant = red(bakeVertexColors(floor(0, -2), scene, { lights: [{ type: 'directional', direction: [1, 1, 0] }] }));
  assert.ok(close(slant[0], Math.SQRT1_2));
  assert.equal(slant[1], 0);
  // Light below the surface adds nothing.
  assert.deepEqual(
    red(bakeVertexColors(floor(3), scene, { lights: [{ type: 'directional', direction: [0, -1, 0] }] })),
    [0],
  );
});

test('point light falloff follows window / max(d^decay, 0.01)', () => {
  const at = (light) =>
    red(bakeVertexColors(floor(0), null, { lights: [{ type: 'point', position: [0, 2, 0], ...light }] }))[0];
  // d = 2, distance 4: window = (1 - (2/4)^4)^2 = 0.87890625, over d^2 = 4.
  assert.ok(close(at({ distance: 4 }), 0.87890625 / 4));
  assert.ok(close(at({ distance: 4, intensity: 3 }), (3 * 0.87890625) / 4));
  assert.equal(at({ distance: 1.5 }), 0);
  assert.ok(close(at({}), 0.25));
  assert.ok(close(at({ decay: 1 }), 0.5));
  assert.ok(close(at({ decay: 0, distance: 3 }), (1 - (2 / 3) ** 4) ** 2));
  // Very close lights are capped by the 0.01 floor.
  const near = red(bakeVertexColors(floor(0), null, { lights: [{ type: 'point', position: [0, 0.05, 0] }] }))[0];
  assert.ok(close(near, 100, 1e-5));
  // Lambert: a light off to the side at 45 degrees.
  const side = red(bakeVertexColors(floor(0), null, { lights: [{ type: 'point', position: [2, 2, 0] }] }))[0];
  assert.ok(close(side, Math.SQRT1_2 / 8));
});

test('spot cones fade by smoothstep between the outer and inner angles', () => {
  const deg = Math.PI / 180,
    smoothstep = (a, b, x) => {
      const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
      return t * t * (3 - 2 * t);
    };
  const sample = (theta, penumbra) => {
    const r = 2 * Math.tan(theta * deg);
    return red(
      bakeVertexColors(floor(r), null, {
        lights: [{ type: 'spot', position: [0, 2, 0], direction: [0, -1, 0], angle: 30 * deg, penumbra }],
      }),
    )[0];
  };
  // At angle theta from the axis: N.L = cos(theta), d = 2 / cos(theta).
  const unshaded = (theta) => Math.cos(theta * deg) ** 3 / 4;
  assert.ok(close(sample(10, 0.5), unshaded(10)));
  assert.ok(
    close(sample(20, 0.5), unshaded(20) * smoothstep(Math.cos(30 * deg), Math.cos(15 * deg), Math.cos(20 * deg))),
  );
  assert.ok(sample(20, 0.5) < unshaded(20) && sample(20, 0.5) > 0);
  assert.equal(sample(30.01, 0.5), 0);
  assert.equal(sample(35, 0.5), 0);
  // No penumbra: a hard edge.
  assert.ok(close(sample(29.9, 0), unshaded(29.9)));
  assert.equal(sample(30.1, 0), 0);
});

test('apply modes, multiplier and hidden lights', () => {
  const target = { ...floor(0, 1), colors: [0.5, 0.25, 1, 0.7, 1, 0.5, 0.2, 0.3] };
  assert.deepEqual(
    [...bakeVertexColors(target, null, { multiplier: 2 })],
    [2, 2, 2, 0.7, 2, 2, 2, 0.3].map(Math.fround),
  );
  assert.deepEqual(
    [...bakeVertexColors(target, null, { multiplier: 2, apply: 'standard' })],
    [1, 0.5, 2, 0.7, 2, 1, 0.4, 0.3].map(Math.fround),
  );
  // RGB colours have no alpha, so it is 1.
  assert.deepEqual(
    [...bakeVertexColors({ ...floor(0), colors: [0.5, 0.5, 0.5] }, null, { apply: 'standard' })],
    [0.5, 0.5, 0.5, 1],
  );
  const hidden = [{ type: 'ambient', visible: false }];
  assert.deepEqual(red(bakeVertexColors(floor(0), null, { lights: hidden })), [0]);
  assert.deepEqual(red(bakeVertexColors(floor(0), null, { lights: hidden, includeHidden: true })), [1]);
  assert.deepEqual(red(bakeVertexColors(floor(0), null, { lights: [] })), [0]);
  assert.throws(() => bakeVertexColors(floor(0), null, { apply: 'add' }), TypeError);
  assert.throws(() => bakeVertexColors(floor(0), null, { lights: [{ type: 'area' }] }), TypeError);
  assert.throws(
    () => bakeVertexColors(floor(0), null, { lights: [{ type: 'spot', position: [0, 1, 0], direction: [0, -1, 0] }] }),
    RangeError,
  );
  assert.throws(() => bakeVertexColors(floor(0), null, { ao: { rays: 0 } }), RangeError);
  assert.throws(() => bakeVertexColors({ positions: [0, 0, 0], normals: [0, 1] }, null), RangeError);
  assert.throws(() => bakeVertexColors({ ...floor(0), colors: [1, 1] }, null), RangeError);
});

test('limitPalette picks entries by RGB, a stretched RGB range or luminance and keeps alpha', () => {
  const linear = (hex) => ((parseInt(hex, 16) / 255 + 0.055) / 1.055) ** 2.4;
  const grey = Math.fround(linear('80')),
    dim = Math.fround(linear('40'));
  // Dark green: closest sRGB value is black, closest luminance is red (hue ignored).
  const four = ['#000000', '#ffffff', '#ff0000', '#0000ff'],
    green = [0, 0.3, 0, 0.5];
  assert.deepEqual([...limitPalette(green, four)], [0, 0, 0, 0.5]);
  assert.deepEqual([...limitPalette(green, four, 'luminance')], [1, 0, 0, 0.5]);
  // One colour has no range to stretch: balanced matches as nearest.
  assert.deepEqual([...limitPalette(green, four, 'balanced')], [0, 0, 0, 0.5]);
  // Dark blue: sRGB distance prefers mid grey, luminance prefers blue.
  const three = ['#000000', '#808080', '#0000ff'],
    navy = [0.05, 0.05, 0.3, 1];
  assert.deepEqual([...limitPalette(navy, three)], [grey, grey, grey, 1]);
  assert.deepEqual([...limitPalette(navy, three, 'luminance')], [0, 0, 1, 1]);
  // A black-to-white bake on a dark palette: nearest crowds mid and white onto the top entry, balanced maps the
  // brightest value to the palette's highest and spreads the middle over the rest.
  const dark = ['#000000', '#404040', '#808080'],
    bake = [0, 0, 0, 1, linear('80'), linear('80'), linear('80'), 1, 1, 1, 1, 1];
  assert.deepEqual([...limitPalette(bake, dark)], [0, 0, 0, 1, grey, grey, grey, 1, grey, grey, grey, 1]);
  assert.deepEqual([...limitPalette(bake, dark, 'balanced')], [0, 0, 0, 1, dim, dim, dim, 1, grey, grey, grey, 1]);
  // Several colours at once; ties go to the earlier entry; out-of-range bakes still map.
  assert.deepEqual(
    [...limitPalette([2, 2, 2, 1, 0.01, 0, 0, 1], ['#fff', '#ffffff', '#000'])],
    [1, 1, 1, 1, 0, 0, 0, 1],
  );
  assert.throws(() => limitPalette([0, 0, 0, 1], []), RangeError);
  assert.throws(() => limitPalette([0, 0, 0, 1], ['#fff'], 'closest'), TypeError);
  assert.throws(() => limitPalette([0, 0, 0], ['#fff']), RangeError);
});
