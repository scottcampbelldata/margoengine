import assert from 'node:assert/strict';
import test from 'node:test';
import { compilePolygonMesh, createPrimitiveMesh, polygonMeshEdges } from '@margoengine/mesh-edit';
import { applyMeshModifiers, latticePoints, MeshModifierStack } from '@margoengine/mesh-edit/modifiers';

const volume = (mesh) => {
  let sum = 0;
  for (const face of mesh.faces) {
    const a = mesh.vertices[face.vertices[0]];
    for (let i = 1; i < face.vertices.length - 1; i++) {
      const b = mesh.vertices[face.vertices[i]],
        c = mesh.vertices[face.vertices[i + 1]];
      sum +=
        a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
    }
  }
  return sum / 6;
};

function assertClosed(mesh) {
  compilePolygonMesh(mesh);
  for (const edge of polygonMeshEdges(mesh)) {
    assert.equal(edge.incidences.length, 2, `edge ${edge.id} has ${edge.incidences.length} faces`);
    assert.notEqual(edge.incidences[0].from, edge.incidences[1].from);
  }
}

const near = (actual, expected, epsilon = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} vs ${expected}`);

/** A half box: the +x side of a unit cube cut at x = 0 and left open there. */
function openHalfBox() {
  const cube = createPrimitiveMesh('cube', 'box'),
    vertices = cube.vertices.map(([x, y, z]) => [x + 0.5, y, z]);
  return { vertices, faces: cube.faces.filter((face) => !face.vertices.every((v) => vertices[v][0] === 0)) };
}

test('mirror closes an open half across its plane, and flips the copy outward', () => {
  const half = openHalfBox(),
    result = applyMeshModifiers(half, [{ type: 'mirror' }]);
  assertClosed(result.mesh);
  near(volume(result.mesh), 2);
  assert.equal(result.mesh.vertices.length, 12);
  assert.equal(result.faceMap[half.faces[0].id].length, 2);
});

test('mirror keeps a closed solid separate with merge 0 and drops plane faces when merging', () => {
  const cube = createPrimitiveMesh('cube', 'box'),
    moved = { ...cube, vertices: cube.vertices.map(([x, y, z]) => [x + 0.5, y, z]) },
    apart = applyMeshModifiers(moved, [{ type: 'mirror', axis: 'x', merge: 0 }]),
    joined = applyMeshModifiers(moved, [{ type: 'mirror', axis: 'x' }]);
  assert.equal(apart.mesh.faces.length, 12);
  near(volume(apart.mesh), 2);
  assert.equal(joined.mesh.faces.length, 10);
  assertClosed(joined.mesh);
  near(volume(joined.mesh), 2);
  const other = applyMeshModifiers(cube, [{ type: 'mirror', axis: 'z', origin: 2, merge: 0 }]);
  near(Math.max(...other.mesh.vertices.map((p) => p[2])), 4.5);
});

test('array repeats by offset and bounding box, and welds touching copies', () => {
  const cube = createPrimitiveMesh('cube', 'box'),
    fixed = applyMeshModifiers(cube, [{ type: 'array', count: 3, offset: [2, 0, 0] }]);
  assert.equal(fixed.mesh.faces.length, 18);
  near(volume(fixed.mesh), 3);
  near(Math.max(...fixed.mesh.vertices.map((p) => p[0])), 4.5);
  const relative = applyMeshModifiers(cube, [{ type: 'array', count: 2 }]);
  near(Math.max(...relative.mesh.vertices.map((p) => p[0])), 1.5);
  const plane = createPrimitiveMesh('plane', 'tile'),
    welded = applyMeshModifiers(plane, [{ type: 'array', count: 4, merge: 1e-6 }]);
  assert.equal(welded.mesh.vertices.length, 10);
  assert.equal(welded.mesh.faces.length, 4);
  assert.equal(welded.vertexMap.length, plane.vertices.length);
});

test('solidify shells a closed solid and walls an open surface', () => {
  const cube = createPrimitiveMesh('cube', 'box'),
    shell = applyMeshModifiers(cube, [{ type: 'solidify', thickness: 0.1 }]);
  assertClosed(shell.mesh);
  near(volume(shell.mesh), 1 - 0.8 ** 3);
  const plane = createPrimitiveMesh('plane', 'tile'),
    wall = applyMeshModifiers(plane, [{ type: 'solidify', thickness: 0.25, offset: 0 }]);
  assertClosed(wall.mesh);
  assert.equal(wall.mesh.faces.length, 6);
  near(Math.abs(volume(wall.mesh)), 0.25);
  // Corners of an even wall keep the wall thickness, plain normals thin it.
  const thin = applyMeshModifiers(cube, [{ type: 'solidify', thickness: 0.1, even: false }]);
  assert.ok(volume(thin.mesh) < volume(shell.mesh));
});

test('screw makes a closed ring, a partial sweep with caps, and a climbing helix', () => {
  // A unit square in the XY plane, centered at x = 2: its sweep about Y is a square-section ring.
  const square = createPrimitiveMesh('plane', 'tile'),
    flat = square.vertices.every((p) => p[1] === square.vertices[0][1]),
    profile = {
      ...square,
      vertices: square.vertices.map((p) => (flat ? [p[0] + 2, p[2], 0] : [p[0] + 2, p[1], 0])),
    },
    steps = 64,
    ring = applyMeshModifiers(profile, [{ type: 'screw', steps }]);
  assertClosed(ring.mesh);
  // Ring of polygon section: Pappus with the inscribed polygon's area factor.
  const factor = (steps / (2 * Math.PI)) * Math.sin((2 * Math.PI) / steps);
  near(Math.abs(volume(ring.mesh)), 2 * Math.PI * 2 * factor, 1e-9);
  assert.ok(volume(ring.mesh) > 0, 'sweep faces outward');
  const part = applyMeshModifiers(profile, [{ type: 'screw', angle: Math.PI, steps: 8 }]);
  assertClosed(part.mesh);
  assert.ok(volume(part.mesh) > 0);
  const other = applyMeshModifiers(profile, [{ type: 'screw', angle: -Math.PI, steps: 8 }]);
  assertClosed(other.mesh);
  near(volume(other.mesh), volume(part.mesh));
  const helix = applyMeshModifiers(profile, [{ type: 'screw', angle: Math.PI * 4, height: 3, steps: 40 }]);
  assertClosed(helix.mesh);
  near(Math.max(...helix.mesh.vertices.map((p) => p[1])) - Math.min(...helix.mesh.vertices.map((p) => p[1])), 4);
});

test('screw shares vertices on the axis and refuses a sweep along the surface', () => {
  const plane = createPrimitiveMesh('plane', 'tile'),
    onAxis = {
      ...plane,
      vertices: plane.vertices.map((p) => {
        const flatY = plane.vertices.every((q) => q[1] === plane.vertices[0][1]);
        return flatY ? [p[0] + 0.5, p[2], 0] : [p[0] + 0.5, p[1], 0];
      }),
    },
    solid = applyMeshModifiers(onAxis, [{ type: 'screw', steps: 12 }]);
  // The profile's axis edge sweeps to nothing, so the result closes as a prism of 12 sides.
  assertClosed(solid.mesh);
  assert.equal(solid.mesh.vertices.length, 2 + 2 * 12);
  const sideways = { ...plane, vertices: plane.vertices.map((p) => [p[0], 0, p[2] + p[1]]) };
  assert.throws(() => applyMeshModifiers(sideways, [{ type: 'screw', height: 0 }]), RangeError);
});

test('lattice: rest points change nothing, moved points bend, outside stays', () => {
  const cube = createPrimitiveMesh('cube', 'box'),
    min = [-0.5, -0.5, -0.5],
    max = [0.5, 0.5, 0.5],
    resolution = [3, 3, 3],
    points = latticePoints(min, max, resolution),
    same = applyMeshModifiers(cube, [{ type: 'lattice', min, max, resolution, points }]);
  same.mesh.vertices.forEach((p, v) => {
    for (let k = 0; k < 3; k++) near(p[k], cube.vertices[v][k], 1e-12);
  });
  const bent = points.map((p) => (p[1] === 0.5 ? [p[0] * 2, p[1], p[2] * 2] : p)),
    wide = applyMeshModifiers(cube, [{ type: 'lattice', min, max, resolution, points: bent }]);
  assertClosed(wide.mesh);
  near(Math.max(...wide.mesh.vertices.map((p) => p[0])), 1);
  const outside = { ...cube, vertices: cube.vertices.map(([x, y, z]) => [x + 3, y, z]) },
    kept = applyMeshModifiers(outside, [{ type: 'lattice', min, max, resolution, points: bent }]);
  assert.deepEqual(kept.mesh.vertices, outside.vertices);
});

test('a warped result stays valid: a twist splits faces and keeps provenance', () => {
  const cube = createPrimitiveMesh('cube', 'box'),
    min = [-0.5, -0.5, -0.5],
    max = [0.5, 0.5, 0.5],
    resolution = [2, 2, 2],
    points = latticePoints(min, max, resolution).map(([x, y, z]) => (y > 0 ? [z, y, -x] : [x, y, z]).map((v) => v)),
    { mesh, faceMap } = applyMeshModifiers(cube, [{ type: 'lattice', min, max, resolution, points }]);
  assertClosed(mesh);
  assert.equal(Object.values(faceMap).flat().length, mesh.faces.length);
});

test('modifiers chain and IDs repeat run to run', () => {
  const half = openHalfBox(),
    list = [
      { type: 'mirror' },
      { type: 'array', count: 2, offset: [3, 0, 0] },
      { type: 'solidify', thickness: 0.05, enabled: false },
    ],
    first = applyMeshModifiers(half, list),
    again = applyMeshModifiers(half, list);
  assert.deepEqual(first.mesh, again.mesh);
  assert.equal(first.mesh.faces.length, half.faces.length * 4);
  assert.equal(first.vertexMap[half.vertices.findIndex((p) => p[0] === 1)].length, 4);
  assert.equal(first.faceMap[half.faces[0].id].length, 4);
});

test('stack re-runs when the base changes, and only from the changed stage', () => {
  const cube = createPrimitiveMesh('cube', 'box'),
    stack = new MeshModifierStack(cube, [{ type: 'array', count: 2, offset: [2, 0, 0] }]);
  stack.add({ type: 'mirror', axis: 'y', origin: 5, merge: 0 });
  const first = stack.evaluate();
  near(volume(first.mesh), 4);
  assert.deepEqual(stack.evaluate().mesh, first.mesh);
  // A new base: the same stack, on bigger input.
  stack.base = { ...cube, vertices: cube.vertices.map((p) => p.map((x) => x * 2)) };
  near(volume(stack.evaluate().mesh), 32);
  stack.update(0, { count: 3 });
  near(volume(stack.evaluate().mesh), 48);
  stack.update(1, { enabled: false });
  near(volume(stack.evaluate().mesh), 24);
  stack.update(1, { enabled: true });
  stack.move(1, 0);
  assert.equal(stack.modifiers[0].type, 'mirror');
  near(volume(stack.evaluate().mesh), 48);
  stack.remove(0);
  near(volume(stack.evaluate().mesh), 24);
  const baked = stack.apply();
  assert.equal(stack.modifiers.length, 0);
  assert.deepEqual(stack.evaluate().mesh, baked);
  assert.deepEqual(stack.base, baked);
});

test('the stack owns its base; results cannot reach it', () => {
  const cube = createPrimitiveMesh('cube', 'box'),
    stack = new MeshModifierStack(cube, [{ type: 'array', count: 2 }]),
    before = JSON.stringify(stack.evaluate().mesh);
  cube.vertices[0][0] = 99;
  stack.evaluate().mesh.vertices[0][0] = 99;
  stack.base.vertices[0][0] = 99;
  assert.equal(JSON.stringify(stack.evaluate().mesh), before);
});

test('bad modifiers reject with the fix in the message', () => {
  const cube = createPrimitiveMesh('cube', 'box');
  assert.throws(() => applyMeshModifiers(cube, 'mirror'), TypeError);
  assert.throws(() => applyMeshModifiers(cube, [{ type: 'bend' }]), TypeError);
  assert.throws(() => applyMeshModifiers(cube, [{ type: 'mirror', axis: 'w' }]), TypeError);
  assert.throws(() => applyMeshModifiers(cube, [{ type: 'array', count: 0 }]), RangeError);
  assert.throws(() => applyMeshModifiers(cube, [{ type: 'array', offset: [1, 2] }]), TypeError);
  assert.throws(() => applyMeshModifiers(cube, [{ type: 'solidify', thickness: 0 }]), RangeError);
  assert.throws(() => applyMeshModifiers(cube, [{ type: 'solidify', offset: 2 }]), RangeError);
  assert.throws(() => applyMeshModifiers(cube, [{ type: 'screw', angle: 0 }]), RangeError);
  assert.throws(() => applyMeshModifiers(cube, [{ type: 'screw', steps: 2 }]), RangeError);
  assert.throws(() => latticePoints([0, 0, 0], [1, 1, 1], [1, 2, 2]), RangeError);
  const lattice = { type: 'lattice', min: [0, 0, 0], max: [1, 1, 1], resolution: [2, 2, 2] };
  assert.throws(() => applyMeshModifiers(cube, [{ ...lattice, points: [] }]), TypeError);
  assert.throws(() => applyMeshModifiers(cube, [{ ...lattice, max: [0, 1, 1], points: [] }]), RangeError);
  assert.throws(() => new MeshModifierStack(cube).update(0, {}), RangeError);
  assert.throws(() => new MeshModifierStack(cube).remove(0), RangeError);
});
