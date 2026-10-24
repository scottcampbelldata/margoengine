import assert from 'node:assert/strict';
import test from 'node:test';

const K = await import('../dist/index.js');
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const object = (id = 'a', width = 1, height = 1) => ({
  id,
  worldMatrix: [...identity],
  canPaint: true,
  canProject: true,
  canMirror: true,
  vertices: [
    [0, 0, 0],
    [width, 0, 0],
    [width, height, 0],
    [0, height, 0],
  ],
  faces: [
    {
      id: 'face',
      vertices: [0, 1, 2, 3],
      uv: [
        [1 / 32, 1 / 16],
        [3 / 32, 1 / 16],
        [3 / 32, 3 / 16],
        [1 / 32, 3 / 16],
      ],
    },
  ],
});
const scene = (objects = [object()], width = 32, height = 16) => ({
  objects,
  texture: { width, height, pixels: Array.from({ length: width * height * 4 }, (_, i) => [23, 45, 67, 255][i % 4]) },
});
const rgba = (texture, x, y) =>
  Array.from(texture.pixels).slice((y * texture.width + x) * 4, (y * texture.width + x) * 4 + 4);
const close = (actual, expected) =>
  actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-12, `${value} != ${expected[i]}`));
const requireAPI = (name) => assert.equal(typeof K[name], 'function', `public ${name}`);

test('new-face allocation keeps fractional density while selected projection uses integer spans', () => {
  requireAPI('allocateMeshFaceUV');
  requireAPI('projectMeshUV');
  const mesh = object('a', 0.625, 0.375),
    before = structuredClone(mesh);
  const allocated = K.allocateMeshFaceUV(mesh, [], [], 4, [32, 16]);
  assert.deepEqual(allocated.faces[0].uv, [
    [1 / 32, 1 / 16],
    [3.5 / 32, 1 / 16],
    [3.5 / 32, 2.5 / 16],
    [1 / 32, 2.5 / 16],
  ]);
  const projected = K.projectMeshUV(scene([mesh]), 'a', 4);
  assert.deepEqual(projected.objects[0].faces[0].uv, [
    [1 / 32, 1 / 16],
    [4 / 32, 1 / 16],
    [4 / 32, 3 / 16],
    [1 / 32, 3 / 16],
  ]);
  assert.deepEqual(mesh, before);
  assert.deepEqual(Object.keys(projected.objects[0]).sort(), ['faces', 'id', 'vertices']);
  allocated.vertices[0][0] = 999;
  assert.equal(mesh.vertices[0][0], 0);
});

test('new-face density uses a compound rotated mirrored nonuniform world matrix', () => {
  requireAPI('allocateMeshFaceUV');
  const mesh = object();
  // Z90 * Y90 * X90 * scale(-2,3,4), then translation(7,-9,11).
  mesh.worldMatrix = [0, 0, 2, 0, 0, 3, 0, 0, 4, 0, 0, 0, 7, -9, 11, 1];
  const uv = K.allocateMeshFaceUV(mesh, [], [], 2, [32, 16]).faces[0].uv;
  assert.deepEqual(uv, [
    [1 / 32, 1 / 16],
    [5 / 32, 1 / 16],
    [5 / 32, 7 / 16],
    [1 / 32, 7 / 16],
  ]);
});

test('rotated fractional geometry retains world lengths through non-axis-aligned mirrored transforms', () => {
  requireAPI('allocateMeshFaceUV');
  const mesh = object();
  // Unit quaternion (1,2,3,4)/sqrt(30), scale(-2,3,4), translation(7,-9,11).
  mesh.worldMatrix = [-4 / 15, -28 / 15, 2 / 3, 0, -2, 1, 2, 0, 44 / 15, 8 / 15, 8 / 3, 0, 7, -9, 11, 1];
  const uv = K.allocateMeshFaceUV(mesh, [], [], 2, [32, 16]).faces[0].uv;
  close(uv.flat(), [1 / 32, 1 / 16, 5 / 32, 1 / 16, 5 / 32, 7 / 16, 1 / 32, 7 / 16]);
});

test('fractional ceil thresholds keep the separate allocation tolerances and deterministic first fit', () => {
  requireAPI('allocateMeshFaceUV');
  requireAPI('projectMeshUV');
  const mesh = object('a', (2 + 5e-7) / 4, 0.25);
  mesh.faces.push({ ...structuredClone(mesh.faces[0]), id: 'second' });
  const allocated = K.allocateMeshFaceUV(mesh, [], [], 4, [8, 8]);
  close(allocated.faces[1].uv[0], [5 / 8, 1 / 8]);
  const projected = K.projectMeshUV(scene([mesh], 8, 8), 'a', 4);
  close(projected.objects[0].faces[1].uv[0], [1 / 8, 4 / 8]);
  close(projected.objects[0].faces[0].uv[1], [4 / 8, 1 / 8]);
});

test('new-face allocation preserves old corners and reserves hidden locked occupancy and halos', () => {
  requireAPI('allocateMeshFaceUV');
  const mesh = object(),
    original = structuredClone(mesh.faces[0]);
  mesh.faces.push({ ...structuredClone(original), id: 'new' });
  const peer = object('peer');
  peer.canPaint = false;
  peer.canProject = false;
  peer.faces[0].uv = [
    [6 / 32, 1 / 16],
    [8 / 32, 1 / 16],
    [8 / 32, 3 / 16],
    [6 / 32, 3 / 16],
  ];
  const before = structuredClone({ mesh, peer });
  const pre = K.allocateMeshFaceUV(mesh, ['face'], [object(), peer], 2, [32, 16]);
  const post = K.allocateMeshFaceUV(mesh, ['face'], [mesh, peer], 2, [32, 16]);
  assert.deepEqual(pre, post);
  assert.deepEqual(pre.faces[0], original);
  assert.deepEqual(pre.faces[1].uv, [
    [10 / 32, 1 / 16],
    [12 / 32, 1 / 16],
    [12 / 32, 3 / 16],
    [10 / 32, 3 / 16],
  ]);
  assert.deepEqual({ mesh, peer }, before);
});

test('whole-polygon normals tolerate collinear boundary corners', () => {
  requireAPI('projectMeshUV');
  const mesh = object();
  mesh.vertices.push([0.5, 0, 0]);
  mesh.faces[0].vertices = [0, 4, 1, 2, 3];
  mesh.faces[0].uv.splice(1, 0, [2 / 32, 1 / 16]);
  const projected = K.projectMeshUV(scene([mesh]), 'a', 2);
  assert.deepEqual(projected.objects[0].faces[0].uv, [
    [1 / 32, 1 / 16],
    [2 / 32, 1 / 16],
    [3 / 32, 1 / 16],
    [3 / 32, 3 / 16],
    [1 / 32, 3 / 16],
  ]);
});

test('selected projection copies patterned original RGBA nearest with reversed UV winding and overlapping destinations', () => {
  requireAPI('projectMeshUV');
  const mesh = object();
  mesh.faces[0].uv = [
    [3 / 32, 1 / 16],
    [1 / 32, 1 / 16],
    [1 / 32, 3 / 16],
    [3 / 32, 3 / 16],
  ];
  const input = scene([mesh]);
  const set = (x, y, color) =>
    color.forEach((value, channel) => {
      input.texture.pixels[(y * 32 + x) * 4 + channel] = value;
    });
  set(1, 1, [11, 12, 13, 0]);
  set(2, 1, [21, 22, 23, 64]);
  set(1, 2, [31, 32, 33, 128]);
  set(2, 2, [41, 42, 43, 255]);
  const before = structuredClone(input),
    output = K.projectMeshUV(input, 'a', 2);
  assert.deepEqual(rgba(output.texture, 1, 1), [21, 22, 23, 64]);
  assert.deepEqual(rgba(output.texture, 2, 1), [11, 12, 13, 0]);
  assert.deepEqual(rgba(output.texture, 1, 2), [41, 42, 43, 255]);
  assert.deepEqual(rgba(output.texture, 2, 2), [31, 32, 33, 128]);
  assert.deepEqual(rgba(output.texture, 0, 0), [21, 22, 23, 64]);
  assert.deepEqual(input, before);
  assert.deepEqual(rgba(output.texture, 20, 10), [23, 45, 67, 255]);
});

test('selected projection preserves protected peer pixels and permits a hidden projectable target', () => {
  requireAPI('projectMeshUV');
  const target = object(),
    peer = object('peer');
  target.canPaint = false;
  peer.canProject = false;
  peer.canPaint = false;
  peer.faces[0].uv = [
    [7 / 32, 1 / 16],
    [9 / 32, 1 / 16],
    [9 / 32, 3 / 16],
    [7 / 32, 3 / 16],
  ];
  const input = scene([target, peer]),
    output = K.projectMeshUV(input, 'a', 2);
  assert.deepEqual(
    output.objects.map((mesh) => mesh.id),
    ['a'],
  );
  for (let y = 0; y <= 3; y++)
    for (let x = 6; x <= 9; x++) assert.deepEqual(rgba(output.texture, x, y), rgba(input.texture, x, y));
  assert.deepEqual(rgba(output.texture, 0, 0), [23, 45, 67, 255]);
  assert.throws(() => K.projectMeshUV(input, 'peer', 2), /project|unlock|eligible/i);
});

test('unmapped packing repairs drafts with first finite sample or fallback and leaves mapped corners exact', () => {
  requireAPI('packMeshUV');
  const drafts = [
    [],
    [
      [NaN, 0],
      [2 / 32, 2 / 16],
    ],
    [
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    ],
    [
      [2, -1],
      [2, -1],
      [2, -1],
      [2, -1],
    ],
  ];
  const expected = [
    [180, 185, 180, 255],
    [91, 92, 93, 0],
    [23, 45, 67, 255],
    [23, 45, 67, 255],
  ];
  for (let i = 0; i < drafts.length; i++) {
    const mesh = object();
    mesh.faces.push({ id: 'repair', vertices: [0, 1, 2, 3], uv: drafts[i] });
    const input = scene([mesh]);
    [91, 92, 93, 0].forEach((value, c) => {
      input.texture.pixels[(2 * 32 + 2) * 4 + c] = value;
    });
    const before = structuredClone(input),
      output = K.packMeshUV(input, undefined, 2);
    assert.equal(output.packed, 1);
    assert.deepEqual(output.objects[0].faces[0].uv, mesh.faces[0].uv);
    assert.deepEqual(output.objects[0].faces[1].uv, [
      [5 / 32, 1 / 16],
      [7 / 32, 1 / 16],
      [7 / 32, 3 / 16],
      [5 / 32, 3 / 16],
    ]);
    for (let y = 0; y <= 3; y++) for (let x = 4; x <= 7; x++) assert.deepEqual(rgba(output.texture, x, y), expected[i]);
    assert.deepEqual(input, before);
    const remapped = scene(output.objects.map((geometry) => ({ ...object(geometry.id), ...geometry })));
    assert.equal(K.packMeshUV(remapped), null);
  }
});

test('selected projection repairs missing drafts but samples finite zero-area source UVs', () => {
  requireAPI('projectMeshUV');
  for (const uv of [
    [],
    [[NaN, 0]],
    [
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    ],
  ]) {
    const mesh = object();
    mesh.faces[0].uv = uv;
    const input = scene([mesh]),
      output = K.projectMeshUV(input, 'a', 2);
    assert.deepEqual(rgba(output.texture, 1, 1), uv.length === 4 ? [23, 45, 67, 255] : [180, 185, 180, 255]);
  }
});

test('sparse malformed UV pairs are repaired rather than interpreted as finite source coordinates', () => {
  requireAPI('projectMeshUV');
  requireAPI('packMeshUV');
  const mesh = object();
  mesh.faces[0].uv = [new Array(2), new Array(2), new Array(2), new Array(2)];
  const input = scene([mesh]),
    before = structuredClone(input);
  assert.deepEqual(rgba(K.projectMeshUV(input, 'a', 2).texture, 1, 1), [180, 185, 180, 255]);
  assert.deepEqual(rgba(K.packMeshUV(input, 'a', 2).texture, 1, 1), [180, 185, 180, 255]);
  assert.deepEqual(input, before);
});

test('unmapped packing stages multiple objects and exhaustion never mutates any original', () => {
  requireAPI('packMeshUV');
  const first = object('first'),
    second = object('second');
  first.faces[0].uv = [];
  second.faces[0].uv = [];
  const input = scene([first, second], 4, 4),
    before = structuredClone(input);
  assert.throws(() => K.packMeshUV(input, undefined, 2), /atlas|space|fit/i);
  assert.deepEqual(input, before);
  second.canProject = false;
  const one = K.packMeshUV(input, undefined, 2);
  assert.equal(one.packed, 1);
  assert.deepEqual(
    one.objects.map((mesh) => mesh.id),
    ['first'],
  );
  assert.throws(() => K.packMeshUV(input, 'second', 2), /project|unlock|eligible/i);
});

test('rectangular canvas resize copies top-left RGBA and adjusts UV texel coordinates without resampling', () => {
  requireAPI('resizeMeshPaintAtlas');
  const input = scene(),
    before = structuredClone(input);
  input.texture.pixels[0] = 119;
  input.texture.pixels[3] = 0;
  const output = K.resizeMeshPaintAtlas(input, 64, 32);
  assert.equal(output.texture.width, 64);
  assert.equal(output.texture.height, 32);
  assert.deepEqual(output.objects[0].faces[0].uv, [
    [1 / 64, 1 / 32],
    [3 / 64, 1 / 32],
    [3 / 64, 3 / 32],
    [1 / 64, 3 / 32],
  ]);
  assert.deepEqual(rgba(output.texture, 0, 0), [119, 45, 67, 0]);
  assert.deepEqual(rgba(output.texture, 40, 20), [38, 43, 48, 255]);
  assert.deepEqual(K.resizeMeshPaintAtlas(input, 40, 20, [4, 3, 2, 0]).texture.pixels.slice(-4), [4, 3, 2, 0]);
  const restored = K.resizeMeshPaintAtlas(
    { objects: output.objects.map((geometry) => ({ ...object(geometry.id), ...geometry })), texture: output.texture },
    32,
    16,
  );
  assert.deepEqual(restored.texture, input.texture);
  assert.deepEqual(input.objects, before.objects);
  output.objects[0].vertices[0][0] = 500;
  output.texture.pixels[0] = 255;
  assert.equal(input.objects[0].vertices[0][0], 0);
  assert.equal(input.texture.pixels[0], 119);
});

test('canvas shrink protects the right and bottom halo and rejects invalid dimensions atomically', () => {
  requireAPI('resizeMeshPaintAtlas');
  const input = scene();
  input.objects[0].faces[0].uv[1][0] = 8 / 32;
  const before = structuredClone(input);
  assert.throws(() => K.resizeMeshPaintAtlas(input, 8, 16), /fit|occupied|halo|padding/i);
  assert.deepEqual(input, before);
  assert.equal(K.resizeMeshPaintAtlas(input, 9, 16).texture.width, 9);
  for (const size of [0, 1.5, NaN, Infinity, 1025])
    assert.throws(() => K.resizeMeshPaintAtlas(input, size, 16), /dimension|size|integer|1024/i);
});

test('canvas resize rejects sparse and undefined fill channels before modifying input', () => {
  requireAPI('resizeMeshPaintAtlas');
  const input = { objects: [], texture: { width: 1, height: 1, pixels: [1, 2, 3, 4] } },
    before = structuredClone(input);
  for (const fill of [new Array(4), [1, 2, undefined, 4], null, {}, new Uint8Array([1, 2, 3, 4])]) {
    assert.throws(() => K.resizeMeshPaintAtlas(input, 2, 2, fill), { name: 'TypeError' });
    assert.deepEqual(input, before);
  }
  assert.deepEqual(K.resizeMeshPaintAtlas(input, 2, 2, undefined).texture.pixels.slice(-4), [38, 43, 48, 255]);
});

test('UV operations validate geometry separately from repairable UV drafts and reject invalid density', () => {
  requireAPI('allocateMeshFaceUV');
  requireAPI('packMeshUV');
  const bad = object();
  bad.faces[0].vertices[2] = 99;
  assert.throws(() => K.allocateMeshFaceUV(bad, [], []), /vert|indices|geometry|corner/i);
  for (const density of [0, NaN, Infinity, 129])
    assert.throws(() => K.packMeshUV(scene(), undefined, density), /density|128|finite/i);
  assert.throws(() => K.packMeshUV(scene(), 'missing'), /mesh|object|select/i);
});

for (const { name, run, message } of [
  {
    name: 'selected projection',
    run: (input) => K.projectMeshUV(input, 'a', 3),
    message:
      'Texture atlas has no free space for these UVs and their padding. Reduce texels per unit or enlarge the atlas.',
  },
  {
    name: 'selected packing',
    run: (input) => K.packMeshUV(input, 'a', 3, 'selected'),
    message:
      'Texture atlas has no free space for these UVs and their padding. Reduce texels per unit or enlarge the atlas.',
  },
  {
    name: 'new-face allocation',
    run: (input) => K.allocateMeshFaceUV(input.objects[0], [], [], 3, [4, 4]),
    message: 'The 4×4 atlas has no free space for Auto UV at this density. Reduce density or free an island.',
  },
])
  test(`${name} exhaustion retains its legacy error message and immutable input`, () => {
    const input = scene([object()], 4, 4),
      before = structuredClone(input);
    assert.throws(() => run(input), { name: 'RangeError', message });
    assert.deepEqual(input, before);
  });
