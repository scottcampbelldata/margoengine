import assert from 'node:assert/strict';
import test from 'node:test';
import { projectMeshUV, packMeshUV, paintMeshSurface } from '../dist/index.js';
const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  background = [219, 33, 201, 255],
  blue = [31, 79, 191, 255];
function scene() {
  const width = 128,
    height = 128,
    pixels = Array.from({ length: width * height * 4 }, (_, i) => background[i % 4]);
  for (let y = 64; y <= 80; y++) for (let x = 64; x <= 80; x++) pixels.splice((y * width + x) * 4, 4, ...blue);
  return {
    objects: [
      {
        id: 'taper',
        worldMatrix: [...matrix],
        canPaint: true,
        canProject: true,
        canMirror: true,
        vertices: [
          [0, 0, 0],
          [1, 0, 0],
          [0, 0.125, 0],
        ],
        faces: [
          {
            id: 'face',
            vertices: [0, 1, 2],
            uv: [
              [0.5, 0.5],
              [0.625, 0.5],
              [0.5, 0.625],
            ],
          },
        ],
      },
    ],
    texture: { width, height, pixels },
  };
}
const rgba = (texture, x, y) => texture.pixels.slice((y * texture.width + x) * 4, (y * texture.width + x) * 4 + 4);
// Independent convex separating-axis oracle; the implementation uses clipping, not this predicate.
function intersects(polygon, x, y) {
  const box = [
      [x, y],
      [x + 1, y],
      [x + 1, y + 1],
      [x, y + 1],
    ],
    axes = [
      [1, 0],
      [0, 1],
      ...polygon.map((p, i) => {
        const q = polygon[(i + 1) % polygon.length];
        return [p[1] - q[1], q[0] - p[0]];
      }),
    ];
  return axes.every((axis) => {
    const a = polygon.map((p) => p[0] * axis[0] + p[1] * axis[1]),
      b = box.map((p) => p[0] * axis[0] + p[1] * axis[1]);
    return Math.max(...a) >= Math.min(...b) && Math.max(...b) >= Math.min(...a);
  });
}
function covered(output) {
  const f = output.objects[0].faces[0],
    w = output.texture.width,
    h = output.texture.height,
    p = f.uv.map((uv) => [uv[0] * w, uv[1] * h]),
    left = Math.floor(Math.min(...p.map((p) => p[0]))),
    right = Math.ceil(Math.max(...p.map((p) => p[0]))) - 1,
    top = Math.floor(Math.min(...p.map((p) => p[1]))),
    bottom = Math.ceil(Math.max(...p.map((p) => p[1]))) - 1,
    cells = [];
  for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) if (intersects(p, x, y)) cells.push([x, y]);
  return cells;
}

test('projection initializes tapered edge-only cells before generating their one-pixel halo', () => {
  const input = scene(),
    before = structuredClone(input),
    out = projectMeshUV(input, 'taper', 16);
  assert.deepEqual(out.objects[0].faces[0].uv, [
    [1 / 128, 1 / 128],
    [17 / 128, 1 / 128],
    [1 / 128, 3 / 128],
  ]);
  assert.deepEqual(rgba(out.texture, 16, 1), blue);
  assert.deepEqual(rgba(out.texture, 17, 1), blue);
  assert.deepEqual(rgba(out.texture, 9, 2), blue);
  for (const [x, y] of covered(out))
    assert.deepEqual(rgba(out.texture, x, y), blue, `uninitialized covered texel ${x},${y}`);
  assert.deepEqual(input, before);
});
test('edge centroid copies the exact original RGBA texel, including transparent RGB, while center samples stay exact', () => {
  const input = scene();
  for (let y = 64; y <= 80; y++)
    for (let x = 64; x <= 80; x++)
      input.texture.pixels.splice((y * 128 + x) * 4, 4, x, y, (x + y) % 256, (x * 17 + y * 3) % 256);
  input.texture.pixels.splice((64 * 128 + 79) * 4, 4, 7, 13, 29, 0);
  const out = projectMeshUV(input, 'taper', 16);
  assert.deepEqual(rgba(out.texture, 16, 1), [7, 13, 29, 0]);
  assert.deepEqual(rgba(out.texture, 17, 1), [7, 13, 29, 0]);
  assert.deepEqual(rgba(out.texture, 9, 2), rgba(input.texture, 72, 72));
  for (let y = 1; y <= 2; y++)
    for (let x = 1; x <= 16; x++) {
      const a = (x + 0.5 - 1) / 16,
        b = (y + 0.5 - 1) / 2;
      if (a + b <= 1)
        assert.deepEqual(
          rgba(out.texture, x, y),
          rgba(input.texture, Math.floor(64 + 16 * a), Math.floor(64 + 16 * b)),
        );
    }
});
test('nearest edge samples follow reversed/mirrored source UV direction without altering destination coverage', () => {
  for (const uv of [
    [
      [0.5, 0.625],
      [0.625, 0.5],
      [0.5, 0.5],
    ],
    [
      [0.625, 0.5],
      [0.5, 0.5],
      [0.625, 0.625],
    ],
  ]) {
    const input = scene();
    input.objects[0].faces[0].uv = uv;
    for (let y = 64; y <= 80; y++)
      for (let x = 64; x <= 80; x++) input.texture.pixels.splice((y * 128 + x) * 4, 4, x, y, 17, 255);
    const out = projectMeshUV(input, 'taper', 16),
      weights = [1 / 48, 23 / 24, 1 / 48],
      source = [0, 1].map((axis) => Math.floor(uv.reduce((s, p, i) => s + p[axis] * weights[i], 0) * 128));
    assert.deepEqual(rgba(out.texture, 16, 1), rgba(input.texture, ...source));
  }
});
test('all independently covered cells initialize across triangles, collinear-corner and multi-fan convex tapers', () => {
  const polygons = [
    [
      [0, 0],
      [1, 0],
      [0, 0.125],
    ],
    [
      [0, 0],
      [1, 0],
      [1, 0.05],
      [0.4, 0.12],
      [0, 0.125],
    ],
    [
      [0, 0],
      [0.5, 0],
      [1, 0],
      [0, 0.125],
    ],
    [
      [0, 0],
      [1, 0],
      [0.01, 0.125],
    ],
  ];
  for (const points of polygons) {
    const input = scene(),
      object = input.objects[0];
    object.vertices = points.map((p) => [...p, 0]);
    object.faces[0].vertices = points.map((_, i) => i);
    object.faces[0].uv = points.map(() => [0.5, 0.5]);
    const out = projectMeshUV(input, 'taper', 16);
    for (const [x, y] of covered(out))
      assert.deepEqual(rgba(out.texture, x, y), blue, `${JSON.stringify(points)} at ${x},${y}`);
  }
});
test('selected packing uses the same complete transfer and retains protected peer content and halos', () => {
  const input = scene(),
    peer = structuredClone(input.objects[0]);
  peer.id = 'locked';
  peer.canPaint = false;
  peer.canProject = false;
  peer.faces[0].uv = [
    [22 / 128, 1 / 128],
    [26 / 128, 1 / 128],
    [22 / 128, 5 / 128],
  ];
  input.objects.push(peer);
  const before = structuredClone(input),
    out = packMeshUV(input, 'taper', 16, 'selected');
  for (const [x, y] of covered(out)) assert.deepEqual(rgba(out.texture, x, y), blue);
  for (let y = 0; y <= 6; y++)
    for (let x = 21; x <= 27; x++) assert.deepEqual(rgba(out.texture, x, y), rgba(input.texture, x, y));
  assert.deepEqual(input, before);
  assert.deepEqual(
    out.objects.map((o) => o.id),
    ['taper'],
  );
});
test('invalid source UV fallback initializes every conservative cell; finite collapsed UVs sample the original texel', () => {
  for (const uv of [
    [],
    [
      [0.5, 0.5],
      [0.5, 0.5],
      [0.5, 0.5],
    ],
  ]) {
    const input = scene();
    input.objects[0].faces[0].uv = uv;
    const out = projectMeshUV(input, 'taper', 16),
      expected = uv.length ? blue : [180, 185, 180, 255];
    for (const [x, y] of covered(out)) assert.deepEqual(rgba(out.texture, x, y), expected);
  }
});
test('subtexel surface brush coverage already works and exhaustion remains atomic', () => {
  const input = scene();
  input.objects[0].faces[0].uv = [
    [1.1 / 128, 1.1 / 128],
    [1.4 / 128, 1.1 / 128],
    [1.1 / 128, 1.4 / 128],
  ];
  const before = structuredClone(input),
    paint = paintMeshSurface(
      input,
      { objectId: 'taper', faceId: 'face', uv: [1.2 / 128, 1.2 / 128], distance: 0 },
      '#123456',
      1,
    );
  assert(paint);
  assert.deepEqual(rgba(paint, 1, 1), [18, 52, 86, 255]);
  assert.deepEqual(input, before);
  input.texture = { width: 8, height: 8, pixels: Array.from({ length: 256 }, (_, i) => background[i % 4]) };
  const small = structuredClone(input);
  assert.throws(() => projectMeshUV(input, 'taper', 16), /free space/);
  assert.deepEqual(input, small);
});

test('independent coverage stays complete for many acute tapers under mirrored nonuniform transforms', () => {
  for (let seed = 0; seed < 36; seed++) {
    const input = scene(),
      object = input.objects[0],
      a = (((seed * 17) % 37) + 1) / 23,
      b = (((seed * 11) % 29) + 1) / 31;
    object.vertices = [
      [0, 0, 0],
      [1, 0, 0],
      [a, b, 0],
    ];
    object.faces[0].uv = [
      [0.5, 0.5],
      [0.5, 0.5],
      [0.5, 0.5],
    ];
    if (seed % 2) object.worldMatrix = [0, -2, 0, 0, -3, 0, 0, 0, 0, 0, 0.5, 0, 7, -9, 11, 1];
    const before = structuredClone(input),
      out = projectMeshUV(input, 'taper', 4 + (seed % 13));
    for (const [x, y] of covered(out)) assert.deepEqual(rgba(out.texture, x, y), blue, `seed${seed} cell${x},${y}`);
    assert.deepEqual(input, before);
  }
});

test('identical UV layouts preserve every owned texel and repeated projection is idempotent including contact cells', () => {
  const input = scene();
  input.objects[0].vertices = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 0.125, 0],
  ];
  for (let y = 0; y < 128; y++)
    for (let x = 0; x < 128; x++)
      input.texture.pixels.splice((y * 128 + x) * 4, 4, x, y, (x + y) % 256, (x * 17 + y * 3) % 256);
  const first = projectMeshUV(input, 'taper', 16),
    current = { texture: input.texture, objects: [{ ...input.objects[0], ...first.objects[0] }] },
    repeated = projectMeshUV(current, 'taper', 16);
  for (const [x, y] of covered(repeated))
    assert.deepEqual(rgba(repeated.texture, x, y), rgba(current.texture, x, y), `identity cell ${x},${y}`);
  const second = projectMeshUV(
    { texture: first.texture, objects: [{ ...input.objects[0], ...first.objects[0] }] },
    'taper',
    16,
  );
  assert.deepEqual(second, first);
});
