import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../../dist/index.js';
import { CellMaterial, SoftBodies, SoftBodyDesc } from '../../dist/soft.js';
import { PhysicsWorld, RigidSolver, SoftSolver } from '../../dist/world.js';

await Physics.load();
const position = [
  [0, 0, 0],
  [2, 0, 0],
  [0, 2, 0],
  [0, 0, 2],
];
const unitVolume = 8 / 6;
const epsilon32 = 2 ** -23;
const wood = {
  youngsModuli: [12e3, 816, 600],
  shearModuli: [768, 936, 84],
  poissonRatios: [0.292, 0.449, 0.39],
};

async function specimen(desc) {
  const physics = new Physics(null, { fixedTimestep: 1 / 60, gravity: [0, 0, 0] });
  const soft = await SoftBodies.attach(physics, { substeps: 2, iterations: 6 });
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 } })
    .add(new RigidSolver(), { physics })
    .add(new SoftSolver(), { soft })
    .couple(['soft', 'rigid'], 'staggered');
  return { soft, body: soft.create(desc), world };
}

function tetrahedron() {
  return new SoftBodyDesc(position).setCells([0, 1, 2, 3]).setSurface().setParticleRadius(0);
}

const momentum = (body) => {
  const speeds = body.particleVelocities();
  return [0, 1, 2].map((axis) => body.masses.reduce((p, mass, i) => p + mass * speeds[3 * i + axis], 0));
};
const bound = (value, expected, scale, message) =>
  assert.ok(Math.abs(value - expected) <= 12 * epsilon32 * scale, message ?? `${value} versus ${expected}`);

function closed(fragment) {
  const triangles = fragment.triangles();
  const edges = new Map();
  for (let row = 0; row < triangles.length; row += 3) {
    for (let edge = 0; edge < 3; edge++) {
      const a = triangles[row + edge];
      const b = triangles[row + ((edge + 1) % 3)];
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const uses = edges.get(key) ?? [];
      uses.push(Math.sign(b - a));
      edges.set(key, uses);
    }
  }
  assert.ok(edges.size > 0);
  for (const uses of edges.values()) {
    assert.equal(uses.length, 2);
    assert.equal(uses[0], -uses[1]);
  }
}

test('a plane cuts through a tetrahedron and conserves its nonuniform mass and linear momentum', async () => {
  const { soft, body } = await specimen(tetrahedron().setMasses([1, 2, 4, 8]));
  for (let i = 0; i < position.length; i++) body.setParticleVelocity(i, [i, 2 - i, i / 3]);
  body.addParticleForce(1, [10, -5, 2]);
  body.addForce([1, 2, 3]);
  const before = momentum(body);
  const { pieces, destination } = soft.cutPlane(body, [0.5, 0, 0], [1, 0, 0]);
  assert.equal(pieces.length, 2);
  const [large, small] = pieces;
  const expected = (unitVolume * 27) / 64;
  assert.equal(large.numCells(), 3);
  assert.equal(small.numCells(), 1);
  bound(large.volume(), unitVolume - expected, unitVolume);
  bound(small.volume(), expected, unitVolume);
  bound(large.mass() + small.mass(), 15, 15);
  const left = momentum(large);
  const right = momentum(small);
  before.forEach((value, axis) => bound(left[axis] + right[axis], value, 45, `momentum axis ${axis}`));
  const component = (values, axis) => values.reduce((sum, vector) => sum + vector[axis], 0);
  const pointForces = pieces.flatMap((piece) => [...piece.pointForces.values()]);
  [10, -5, 2].forEach((value, axis) => bound(component(pointForces, axis), value, 10, `point force ${axis}`));
  [1, 2, 3].forEach((value, axis) =>
    bound(
      component(
        pieces.map((piece) => piece.force),
        axis,
      ),
      value,
      3,
      `force ${axis}`,
    ),
  );
  assert.equal(destination(1)[0].body, small);
  assert.equal(destination(0)[0].body, large);
  pieces.forEach(closed);
});

test('two-by-two and shared-edge plane sections have the exact volume fractions', async () => {
  const a = await specimen(tetrahedron());
  const t = 0.375;
  const { pieces } = a.soft.cutPlane(a.body, [2 * t, 0, 0], [1, 1, 0]);
  assert.equal(pieces.length, 2);
  // The sum of two barycentric coordinates is Beta(2,2), whose cdf is 3t² - 2t³.
  bound(pieces[0].volume(), unitVolume * t * t * (3 - 2 * t), unitVolume);
  assert.deepEqual(
    pieces.map((body) => body.numCells()),
    [3, 3],
  );
  const b = await specimen(tetrahedron().setPinnedParticles([0, 3]));
  const throughEdge = b.soft.cutPlane(b.body, [0, 0, 0], [1, -1, 0]);
  assert.equal(throughEdge.pieces.length, 2);
  for (const piece of throughEdge.pieces) {
    bound(piece.volume(), unitVolume / 2, unitVolume);
    closed(piece);
  }
  for (const i of [0, 3]) {
    assert.equal(throughEdge.destination(i).length, 2);
    for (const { body, particle } of throughEdge.destination(i)) assert.ok(body.isParticlePinned(particle));
  }
});

test('an oblique cut through a shared tetrahedral mesh leaves only the expected boundary faces', async () => {
  const { body, soft } = await specimen(SoftBodyDesc.box([0, 0, 0], [1, 1, 1], [4, 4, 4]));
  const { pieces } = soft.cutPlane(body, [0.57, 0, 0], [1, 0.13, -0.21]);
  assert.equal(pieces.length, 2);
  bound(
    pieces.reduce((volume, fragment) => volume + fragment.volume(), 0),
    1,
    1,
  );
  const signed = ([x, y, z]) => x + 0.13 * y - 0.21 * z - 0.57;
  const planes = [signed, ...[0, 1, 2].flatMap((axis) => [0, 1].map((side) => (p) => p[axis] - side))];
  for (const piece of pieces) {
    closed(piece);
    const ids = piece.triangles();
    for (let row = 0; row < ids.length; row += 3) {
      const corners = Array.from(ids.subarray(row, row + 3), (id) => piece.particlePosition(id));
      assert.ok(planes.some((plane) => corners.every((point) => Math.abs(plane(point)) <= 4 * epsilon32)));
    }
  }
});

test('a plane along existing faces separates only those faces and duplicates their particles', async () => {
  const { soft, body } = await specimen(SoftBodyDesc.box([0, 0, 0], [1, 1, 1], [2, 2, 2]));
  const cells = body.numCells();
  const positions = body.particlePositions();
  const { pieces, destination } = soft.cutPlane(body, [0.5, 0, 0], [1, 0, 0]);
  assert.equal(pieces.length, 2);
  assert.equal(pieces[0].numCells() + pieces[1].numCells(), cells);
  pieces.forEach((piece) => bound(piece.volume(), 0.5, 0.5));
  for (let i = 0; i < positions.length; i += 3) assert.equal(destination(i / 3).length, positions[i] === 0.5 ? 2 : 1);
});

test('plane-cut pieces retain the strained material and continue with deterministic snapshots', async () => {
  const create = () => specimen(tetrahedron().setOrthotropicStiffness(wood).setSolver('vertex-block'));
  const a = await create();
  const b = await create();
  for (const item of [a, b]) item.body.setParticlePosition(1, [2.13, 0, 0]);
  const tensor = a.body.orthotropy;
  const cutA = a.soft.cutPlane(a.body, [0.75, 0, 0], [1, 0, 0]);
  const cutB = b.soft.cutPlane(b.body, [0.75, 0, 0], [1, 0, 0]);
  for (const piece of cutA.pieces) assert.deepEqual(piece.orthotropy, tensor);
  assert.equal(a.world.hash(), b.world.hash());
  const before = cutA.destination(1)[0];
  const x = before.body.particlePosition(before.particle)[0];
  a.world.advance(3);
  assert.ok(before.body.particlePosition(before.particle)[0] < x);
  b.world.advance(1);
  b.world.restoreSnapshot(a.world.takeSnapshot().bytes);
  a.world.advance(5);
  b.world.advance(5);
  assert.equal(a.world.hash(), b.world.hash());
  assert.deepEqual(
    cutA.pieces.map((piece) => piece.cells()),
    cutB.pieces.map((piece) => piece.cells()),
  );
});

test('an outer or tangent plane leaves the body, and an uncuttable input reports how to change it', async () => {
  const { soft, body, world } = await specimen(tetrahedron());
  const before = world.hash();
  assert.deepEqual(soft.cutPlane(body, [2, 0, 0], [1, 0, 0]).pieces, []);
  assert.equal(before, world.hash());
  assert.throws(() => soft.cutPlane(body, [0, 0, 0], [0, 0, 0]), /nonzero/);
  const volume = new CellMaterial();
  volume.model = 'volume';
  const springBody = soft.create(tetrahedron().setCellMaterial(volume).addCellEdges());
  assert.throws(() => soft.cutPlane(springBody, [0, 0, 0], [1, 0, 0]), /without springs/);
});

test('plane cuts and snapshot restore retain the smoothed strain that governs later tearing', async () => {
  const material = new CellMaterial();
  material.tearStrain = 1;
  material.tearSmoothing = 0.125;
  const make = async () => {
    const item = await specimen(tetrahedron().setCellMaterial(material).setPinnedParticles([0, 1, 2, 3]));
    item.body.setParticlePosition(1, [2.5, 0, 0]);
    item.world.advance(2);
    const load = item.soft.cellColumns().load[item.body.cellRange.first];
    const residual = 1 - 1 / 120 / material.tearSmoothing;
    bound(load, 0.25 * (1 - residual * residual * residual * residual), 0.25);
    const { pieces } = item.soft.cutPlane(item.body, [0.8, 0, 0], [1, 0, 0]);
    for (const piece of pieces) {
      const { first, count } = piece.cellRange;
      assert.deepEqual(
        Array.from(item.soft.cellColumns().load.subarray(first, first + count)),
        Array(count).fill(load),
      );
    }
    return item;
  };
  const a = await make();
  const b = await make();
  const snapshot = a.world.takeSnapshot();
  b.world.advance(11);
  b.world.restoreSnapshot(snapshot.bytes);
  a.world.advance(4);
  b.world.advance(4);
  assert.equal(a.world.hash(), b.world.hash());
});

test('a finite interior incision creates two movable faces and keeps the rest of a tetrahedron connected', async () => {
  const { soft, body, world } = await specimen(tetrahedron().setPinnedParticles([0, 1, 2]));
  const originalMass = body.mass();
  const blade = [
    [0.5, 0.2, 0.2],
    [0.5, 0.65, 0.2],
    [0.5, 0.2, 0.65],
  ];
  const { pieces } = soft.cutTriangle(body, blade);
  assert.equal(pieces.length, 1);
  const [cut] = pieces;
  bound(cut.mass(), originalMass, originalMass);
  bound(cut.volume(), unitVolume, unitVolume);
  closed(cut);
  const points = cut.particlePositions();
  const ids = cut.triangles();
  const centre = [];
  for (let i = 0; i < points.length; i += 3)
    if (
      Math.abs(points[i] - 0.5) <= epsilon32 &&
      Math.abs(points[i + 1] - 0.35) <= epsilon32 &&
      Math.abs(points[i + 2] - 0.35) <= epsilon32
    )
      centre.push(i / 3);
  assert.equal(centre.length, 2);
  let area = 0;
  let net = 0;
  for (let i = 0; i < ids.length; i += 3) {
    const p = Array.from(ids.subarray(i, i + 3), (id) => cut.particlePosition(id));
    if (p.some(([x]) => Math.abs(x - 0.5) > epsilon32)) continue;
    for (const [_, y, z] of p) assert.ok(y >= 0.2 - epsilon32 && z >= 0.2 - epsilon32 && y + z <= 0.85 + 2 * epsilon32);
    const [a, b, c] = p;
    const oriented = ((b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1])) / 2;
    area += Math.abs(oriented);
    net += oriented;
  }
  const bladeAreaTwice = 0.45 * 0.45;
  bound(area, bladeAreaTwice, bladeAreaTwice);
  bound(net, 0, area);
  cut.addParticleForce(centre[0], [-100, 0, 0]);
  world.advance(1);
  assert.notEqual(cut.particlePosition(centre[0])[0], cut.particlePosition(centre[1])[0]);
});

test('a finite triangle across a shared tetrahedral plane separates complete pieces', async () => {
  const build = () => specimen(SoftBodyDesc.box([0, 0, 0], [1, 1, 1], [2, 2, 2]));
  const a = await build();
  const b = await build();
  const blade = [
    [0.5, -1, -1],
    [0.5, 3, -1],
    [0.5, -1, 3],
  ];
  const cutA = a.soft.cutTriangle(a.body, blade);
  const cutB = b.soft.cutTriangle(b.body, blade);
  assert.equal(cutA.pieces.length, 2);
  for (const piece of cutA.pieces) {
    bound(piece.volume(), 0.5, 1);
    closed(piece);
  }
  assert.deepEqual(
    cutB.pieces.map((piece) => piece.cells()),
    cutA.pieces.map((piece) => piece.cells()),
  );
  a.world.advance(3);
  b.world.advance(1);
  b.world.restoreSnapshot(a.world.takeSnapshot().bytes);
  a.world.advance(6);
  b.world.advance(6);
  assert.equal(a.world.hash(), b.world.hash());
});

test('an oblique interior incision has conforming shared facets across a volume mesh', async () => {
  const { soft, body } = await specimen(SoftBodyDesc.box([0, 0, 0], [1, 1, 1], [3, 3, 3]));
  const surface = (y, z) => 0.47 - 0.13 * y + 0.21 * z;
  const blade = [
    [0.15, 0.2],
    [0.8, 0.25],
    [0.25, 0.78],
  ].map(([y, z]) => [surface(y, z), y, z]);
  const { pieces } = soft.cutTriangle(body, blade);
  assert.equal(pieces.length, 1);
  const [cut] = pieces;
  bound(cut.volume(), 1, 1);
  closed(cut);
  const triangles = cut.triangles();
  const twiceArea = ([a, b, c]) => {
    const u = b.map((x, i) => x - a[i]);
    const v = c.map((x, i) => x - a[i]);
    return Math.sqrt(
      (u[1] * v[2] - u[2] * v[1]) ** 2 + (u[2] * v[0] - u[0] * v[2]) ** 2 + (u[0] * v[1] - u[1] * v[0]) ** 2,
    );
  };
  let stitchedAreaTwice = 0;
  for (let i = 0; i < triangles.length; i += 3) {
    const face = Array.from(triangles.subarray(i, i + 3), (id) => cut.particlePosition(id));
    if (face.every(([x, y, z]) => Math.abs(x - surface(y, z)) < 4 * epsilon32)) stitchedAreaTwice += twiceArea(face);
  }
  bound(stitchedAreaTwice, 2 * twiceArea(blade), 1);
});

test('a finite blade that misses the solid leaves all state alone', async () => {
  const { world, soft, body } = await specimen(tetrahedron());
  const before = world.hash();
  const blade = [
    [0.5, 2, 2],
    [0.5, 3, 2],
    [0.5, 2, 3],
  ];
  assert.deepEqual(soft.cutTriangle(body, blade).pieces, []);
  assert.throws(() => soft.cutTriangle(body, [blade[0], blade[0], blade[1]]), /noncollinear/);
  assert.equal(world.hash(), before);
});

test('a second finite blade can cross an existing incision without losing volume or closing either lip', async () => {
  const { soft, body } = await specimen(tetrahedron());
  const first = [
    [0.5, 0.2, 0.2],
    [0.5, 0.65, 0.2],
    [0.5, 0.2, 0.65],
  ];
  const second = [
    [0.35, 0.23, 0.42],
    [0.72, 0.22, 0.42],
    [0.37, 0.55, 0.42],
  ];
  const initialMass = body.mass();
  const [once] = soft.cutTriangle(body, first).pieces;
  const { pieces } = soft.cutTriangle(once, second);
  assert.equal(pieces.length, 1);
  const [twice] = pieces;
  bound(twice.volume(), unitVolume, unitVolume);
  bound(twice.mass(), initialMass, initialMass);
  closed(twice);
  const ids = twice.triangles();
  for (const [axis, plane] of [
    [0, 0.5],
    [2, 0.42],
  ]) {
    assert.ok(
      Array.from({ length: ids.length / 3 }, (_, i) => ids.subarray(3 * i, 3 * i + 3)).some((face) =>
        face.every((id) => Math.abs(twice.particlePosition(id)[axis] - plane) <= 2 * epsilon32),
      ),
    );
  }
});
