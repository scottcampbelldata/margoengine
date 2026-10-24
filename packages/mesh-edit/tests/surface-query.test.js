import assert from 'node:assert/strict';
import test from 'node:test';
import { Matrix4, Quaternion, Ray, Vector3 } from '@margoengine/math';
import { MeshSurfaceQuery, compilePolygonMesh, createPrimitiveMesh } from '../dist/index.js';

const triangle = () => ({
  vertices: [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
  ],
  faces: [
    {
      id: 'face',
      vertices: [0, 1, 2],
      uv: [
        [0, 0],
        [1, 0],
        [0, 1],
      ],
    },
  ],
});
const ray = (x = 0.25, y = 0.25, z = 2) => ({ origin: [x, y, z], direction: [0, 0, -1] });
const query = (mesh = triangle(), extras = {}) => new MeshSurfaceQuery([{ objectId: 'art', mesh, ...extras }]);
const texture = () => ({ width: 128, height: 128, pixels: new Uint8Array(128 * 128 * 4).fill(255) });

test('exact source hit supplies independently owned barycentrics, UV, local/world/ray positions and a nearest texel', () => {
  const q = query(),
    image = texture(),
    hits = q.intersect(ray(), { texture: image });
  assert.deepEqual(hits, [
    {
      objectId: 'art',
      faceId: 'face',
      triangleIndex: 0,
      distance: 2,
      barycoord: [0.5, 0.25, 0.25],
      uv: [0.25, 0.25],
      localPoint: [0.25, 0.25, 0],
      worldPoint: [0.25, 0.25, 0],
      rayPoint: [0.25, 0.25, 0],
      texel: [32, 32],
    },
  ]);
  hits[0].uv.fill(99);
  hits[0].worldPoint.fill(99);
  hits[0].barycoord.fill(99);
  assert.deepEqual(q.intersect(ray(), { texture: image })[0].texel, [32, 32]);
  assert.deepEqual(q.intersect(ray())[0].uv, [0.25, 0.25]);
});

test('both windings, behind rays, misses and narrow source triangles retain Margo Ray precision', () => {
  for (const reverse of [false, true]) {
    const mesh = triangle();
    if (reverse) {
      mesh.faces[0].vertices.reverse();
      mesh.faces[0].uv.reverse();
    }
    const q = query(mesh);
    assert.equal(q.intersect(ray())[0].distance, 2);
    assert.deepEqual(q.intersect(ray(2, 2)), []);
    assert.deepEqual(q.intersect({ origin: [0.25, 0.25, -1], direction: [0, 0, -1] }), []);
    assert.deepEqual(q.intersect({ origin: [0.25, 0.25, -1], direction: [0, 0, 1] })[0].uv, [0.25, 0.25]);
  }
  const mesh = triangle();
  mesh.vertices = [
    [1 + 1e-8, 0, 0],
    [1 + 3e-8, 0, 0],
    [1 + 1e-8, 1, 0],
  ];
  const input = ray(1 + 1.5e-8, 0.25, 1),
    q = query(mesh),
    hit = q.intersect(input)[0];
  const exact = new Ray(new Vector3(...input.origin), new Vector3(...input.direction)).intersectTriangle(
    ...mesh.vertices.map((p) => new Vector3(...p)),
    false,
    new Vector3(),
  );
  assert(exact);
  assert(hit);
  assert.equal(hit.distance, exact.distanceTo(new Vector3(...input.origin)));
  assert(hit.barycoord.every(Number.isFinite));
  const thin = triangle();
  thin.vertices = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1e-8, 0],
  ];
  query(thin)
    .intersect(ray(0.75, 2.5e-9, 3))[0]
    .barycoord.forEach((value, axis) => assert(Math.abs(value - [0.25, 0.5, 0.25][axis]) < 1e-14));
});

test('compiled alternative diagonal and corner order are queried without refanning polygons', () => {
  const mesh = createPrimitiveMesh('cube', 'cube'),
    face = mesh.faces[0];
  mesh.faces = [
    {
      ...face,
      uv: [
        [0.1, 0.1],
        [0.9, 0.1],
        [0.9, 0.9],
        [0.1, 0.9],
      ],
    },
  ];
  const compiled = compilePolygonMesh(mesh);
  compiled.indices = [0, 1, 3, 1, 2, 3];
  const q = query(mesh, { compiled }),
    triangles = q.triangles();
  assert.deepEqual(
    triangles.map((t) => t.local),
    [
      [face.vertices[0], face.vertices[1], face.vertices[3]],
      [face.vertices[1], face.vertices[2], face.vertices[3]],
    ].map((ids) => ids.map((v) => mesh.vertices[v])),
  );
  assert.deepEqual(triangles[0].uv, [
    [0.1, 0.1],
    [0.9, 0.1],
    [0.1, 0.9],
  ]);
  assert.deepEqual(
    triangles.map((t) => t.triangleIndex),
    [0, 1],
  );
  const permutation = [2, 0, 3, 1],
    inverse = permutation.map((_, i) => permutation.indexOf(i));
  const reordered = {
    ...compiled,
    positions: permutation.flatMap((i) => compiled.positions.slice(i * 3, i * 3 + 3)),
    uvs: permutation.flatMap((i) => compiled.uvs.slice(i * 2, i * 2 + 2)),
    cornerVertices: permutation.map((i) => compiled.cornerVertices[i]),
    indices: compiled.indices.map((i) => inverse[i]),
  };
  assert.deepEqual(query(mesh, { compiled: reordered }).triangles(), triangles);
  const reversed = { ...compiled, positions: [...compiled.positions].reverse() };
  assert.throws(() => query(mesh, { compiled: reversed }), /corners/);
  for (const bad of [
    { ...compiled, indices: [0, 1, 999] },
    { ...compiled, triangleFaces: ['other', face.id] },
    { ...compiled, uvs: [] },
  ])
    assert.throws(() => query(mesh, { compiled: bad }), TypeError);
});

test('captured sources, compiled provenance, matrices and returned triangles/vertices cannot mutate the query', () => {
  const mesh = triangle(),
    compiled = compilePolygonMesh(mesh),
    matrix = new Matrix4().makeTranslation(3, -2, 5).elements;
  const q = query(mesh, { compiled, worldMatrix: matrix }),
    original = q.intersect(ray(3.25, -1.75, 7));
  mesh.vertices[0].fill(99);
  mesh.faces[0].uv[0].fill(99);
  compiled.indices.fill(2);
  compiled.uvs.fill(99);
  matrix.fill(0);
  const triangles = q.triangles();
  triangles[0].a.fill(99);
  triangles[0].local[0].fill(99);
  triangles[0].uv[0].fill(99);
  triangles[0].bounds.fill(99);
  q.worldVertices('art')[0].fill(99);
  assert.deepEqual(q.intersect(ray(3.25, -1.75, 7)), original);
  assert.deepEqual(original[0].localPoint, [0.25, 0.25, 0]);
  assert.deepEqual(original[0].worldPoint, [3.25, -1.75, 5]);
});

test('mirrored, sheared, singular and loose-vertex source transforms have explicit source-frame semantics', () => {
  const m = [-2, 0.2, 0, 0, 0.3, 3, 0, 0, 0, 0, 1, 0, 4, -3, 2, 1],
    q = query(triangle(), { worldMatrix: m });
  const target = new Vector3(0.25, 0.25, 0).applyMatrix4({ elements: m }).toArray();
  const hit = q.intersect(ray(target[0], target[1], 5))[0];
  assert(hit);
  assert(Math.abs(hit.localPoint[0] - 0.25) < 1e-14);
  assert(Math.abs(hit.localPoint[1] - 0.25) < 1e-14);
  const singular = new Matrix4().compose(new Vector3(), new Quaternion(), new Vector3(0, 1, 1)).elements;
  assert.deepEqual(query(triangle(), { worldMatrix: singular }).intersect(ray(0, 0.25)), []);
  const loose = query({ vertices: [[1, 2, 3]], faces: [] });
  assert.deepEqual(loose.worldVertices('art'), [[1, 2, 3]]);
  assert.deepEqual(loose.intersect(ray()), []);
});

test('maximum polygon UV edges belong to content texels; constant normalized UVs clamp to image', () => {
  const mesh = triangle();
  mesh.faces[0].uv = [
    [0.25, 0.25],
    [0.5, 0.25],
    [0.25, 0.5],
  ];
  const q = query(mesh),
    image = texture();
  assert.deepEqual(q.intersect(ray(1, 0), { texture: image })[0].texel, [63, 32]);
  assert.deepEqual(q.intersect(ray(0, 1), { texture: image })[0].texel, [32, 63]);
  mesh.faces[0].uv = [
    [2, -1],
    [2, -1],
    [2, -1],
  ];
  assert.throws(() => query(mesh), /normalized/);
  mesh.faces[0].uv = [
    [1, 0],
    [1, 0],
    [1, 0],
  ];
  assert.deepEqual(query(mesh).intersect(ray(), { texture: image })[0].texel, [127, 0]);
});

test('borrowed live alpha rejects transparent foreground and accepts exactly the threshold, without scanning RGB', () => {
  const mesh = triangle(),
    back = triangle();
  back.vertices.forEach((p) => (p[2] = -1));
  const q = new MeshSurfaceQuery([
      { objectId: 'front', mesh },
      { objectId: 'back', mesh: back },
    ]),
    image = texture(),
    index = (32 * 128 + 32) * 4 + 3;
  image.pixels[index] = 5;
  assert.deepEqual(q.intersect(ray(), { texture: image }), []);
  assert.equal(
    q.intersect(ray(), { texture: image, includeTransparent: true, firstHitOnly: true })[0].objectId,
    'front',
  );
  image.pixels[index] = 6;
  assert.deepEqual(
    q.intersect(ray(), { texture: image }).map((h) => h.objectId),
    ['front', 'back'],
  );
  const bytes = Array.from(image.pixels);
  bytes[0] = NaN;
  assert.equal(q.intersect(ray(), { texture: { ...image, pixels: bytes } }).length, 2);
  bytes[index] = NaN;
  assert.throws(() => q.intersect(ray(), { texture: { ...image, pixels: bytes } }), /sampled alpha/);
});

test('distance sorting and equal-distance ties are stable across sources and exact near/far boundaries', () => {
  const mesh = triangle(),
    q = new MeshSurfaceQuery([
      { objectId: 'b', mesh },
      { objectId: 'a', mesh },
    ]);
  assert.deepEqual(
    q.intersect(ray()).map((h) => h.objectId),
    ['b', 'a'],
  );
  assert.equal(q.intersect(ray(), { firstHitOnly: true })[0].objectId, 'b');
  assert.equal(q.intersect(ray(), { near: 0, far: 2 }).length, 2);
  assert.deepEqual(q.intersect(ray(), { near: 2, far: 2 }), []);
  assert.deepEqual(q.intersect(ray(), { far: 1.999999 }), []);
  assert.equal(q.intersect(ray(), { objectIds: ['a'] })[0].objectId, 'a');
  assert.deepEqual(q.intersect(ray(), { objectIds: [] }), []);
});

test('query-only helpers use explicit IDs without any render visibility mutation', () => {
  const mesh = triangle(),
    hidden = { objectId: 'helper', mesh },
    q = new MeshSurfaceQuery([{ objectId: 'art', mesh }, hidden]);
  assert.equal(q.intersect(ray(), { objectIds: ['helper'] })[0].objectId, 'helper');
  assert.deepEqual(Object.keys(hidden), ['objectId', 'mesh']);
  assert.throws(() => q.intersect(ray(), { objectIds: ['missing'] }), /uncaptured/);
  assert.throws(() => q.worldVertices('missing'), /not captured/);
});

test('owned frame shares world corner references for projection reuse and never aliases captured geometry', () => {
  const q = query(createPrimitiveMesh('cube', 'cube')),
    frame = q.frame(),
    first = frame.triangles[0];
  assert(frame.objects[0].vertices.includes(first.a));
  assert(frame.objects[0].vertices.includes(first.b));
  assert(frame.objects[0].vertices.includes(first.c));
  const old = q.frame();
  first.a.fill(99);
  first.local[0].fill(99);
  frame.objects[0].vertices[1].fill(99);
  assert.deepEqual(q.frame(), old);
  const disposed = query();
  disposed.dispose();
  assert.throws(() => disposed.frame(), { code: 'disposed' });
});

test('world presentation frame matches every rich-frame world vertex and triangle without copying unused attributes', () => {
  const q = query(createPrimitiveMesh('cube', 'cube'));
  const rich = q.frame(),
    world = q.worldFrame();
  const strip = ({ objectId, faceId, triangleIndex, a, b, c }) => ({ objectId, faceId, triangleIndex, a, b, c });
  assert.deepEqual(world, { objects: rich.objects, triangles: rich.triangles.map(strip) });
  for (const t of world.triangles) {
    assert(world.objects[0].vertices.includes(t.a));
    assert(world.objects[0].vertices.includes(t.b));
    assert(world.objects[0].vertices.includes(t.c));
    assert.deepEqual(Object.keys(t).sort(), ['a', 'b', 'c', 'faceId', 'objectId', 'triangleIndex']);
  }
  assert(q.triangles().every((t) => t.local.length === 3 && t.uv.length === 3 && t.bounds.length === 4));
});

test('world presentation mutations/disposal cannot change retained exact query/UV results or other returned frames', () => {
  const q = query(),
    image = texture(),
    expected = q.intersect(ray(), { texture: image }),
    before = q.worldFrame(),
    changed = q.worldFrame();
  changed.objects[0].vertices[0].fill(99);
  changed.triangles[0].a.fill(99);
  changed.triangles[0].objectId = 'changed';
  assert.deepEqual(q.worldFrame(), before);
  assert.deepEqual(q.intersect(ray(), { texture: image }), expected);
  q.dispose();
  assert.throws(() => q.worldFrame(), { code: 'disposed' });
  assert.deepEqual(before.triangles[0].a, [0, 0, 0]);
});

test('source ordering retains original triangle traversal for component policy while nearest mode still resolves closest', () => {
  const mesh = triangle(),
    back = triangle();
  back.vertices.forEach((p) => (p[2] = -1));
  const q = new MeshSurfaceQuery([
    { objectId: 'back', mesh: back },
    { objectId: 'front', mesh },
  ]);
  assert.deepEqual(
    q.intersect(ray(), { order: 'source' }).map((h) => h.objectId),
    ['back', 'front'],
  );
  assert.deepEqual(
    q.intersect(ray()).map((h) => h.objectId),
    ['front', 'back'],
  );
  assert.equal(q.intersect(ray(), { order: 'source', firstHitOnly: true })[0].objectId, 'front');
  assert.throws(() => q.intersect(ray(), { order: 'invalid' }), /order/);
});

test('parallel/grazing and extreme finite slabs do not reject checked source hits', () => {
  const q = query();
  for (const input of [
    ray(0, 0),
    ray(1, 0),
    ray(0, 1),
    { origin: [0.25, 0.25, 2], direction: [Number.MIN_VALUE, 0, -1] },
  ])
    assert(q.intersect(input).length);
});

test('invalid source/transform/ray/policy/storage are actionable; failed calls do not poison later queries', () => {
  assert.throws(() => new MeshSurfaceQuery(null), /source array/);
  assert.throws(
    () =>
      new MeshSurfaceQuery([
        { objectId: 'x', mesh: triangle() },
        { objectId: 'x', mesh: triangle() },
      ]),
    /unique/,
  );
  const m = new Matrix4().elements;
  m[3] = 1;
  assert.throws(() => query(triangle(), { worldMatrix: m }), /affine/);
  const q = query();
  for (const input of [
    null,
    { origin: [0, 0, NaN], direction: [0, 0, -1] },
    { origin: [0, 0, 1], direction: [0, 0, -2] },
  ])
    assert.throws(() => q.intersect(input), TypeError);
  for (const options of [{ near: -1 }, { far: NaN }, { near: 3, far: 2 }, { alphaThreshold: 256 }])
    assert.throws(() => q.intersect(ray(), options), RangeError);
  for (const options of [
    { firstHitOnly: 1 },
    { includeTransparent: null },
    { objectIds: 'x' },
    { texture: { width: 1, height: 1, pixels: [] } },
  ])
    assert.throws(() => q.intersect(ray(), options), TypeError);
  assert.equal(q.intersect(ray()).length, 1);
});

test('getter-driven reentry is rejected; disposal during a texture read publishes no hit', () => {
  const q = query(),
    image = texture();
  const reentrant = {
    get width() {
      q.intersect(ray());
      return 128;
    },
    height: 128,
    pixels: image.pixels,
  };
  assert.throws(() => q.intersect(ray(), { texture: reentrant }), { code: 'state' });
  assert.equal(q.intersect(ray()).length, 1);
  const disposing = {
    get width() {
      q.dispose();
      return 128;
    },
    height: 128,
    pixels: image.pixels,
  };
  assert.throws(() => q.intersect(ray(), { texture: disposing }), { code: 'disposed' });
  assert.equal(q.disposed, true);
  q.dispose();
  q[Symbol.dispose]();
  assert.throws(() => q.intersect(ray()), { code: 'disposed' });
  assert.throws(() => q.triangles(), { code: 'disposed' });
  assert.throws(() => q.worldVertices('art'), { code: 'disposed' });
  const q2 = query(),
    pixels = new Proxy(Array.from(image.pixels), {
      get(target, key) {
        if (key === String((32 * 128 + 32) * 4 + 3)) q2.dispose();
        return Reflect.get(target, key);
      },
    });
  assert.throws(() => q2.intersect(ray(), { texture: { ...image, pixels } }), { code: 'disposed' });
});
