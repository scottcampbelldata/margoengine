import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import RAPIER from '@dimforge/rapier3d-compat';
import {loadGLTF, parseGLTF, PBRModel} from '@margoengine/gltf-pro';
import {parseGLTF as parseBasicGLTF} from '@margoengine/gltf';
import {Physics} from '@margoengine/physics';
import {exportGLB} from '@margoengine/exporters';
import {deduplicateParts} from '@margoengine/machinery/cad';
import {AssemblyBVH} from '@margoengine/machinery/spatial';
import {BoxHelper} from '@margoengine/lines';
import {Stage} from 'margoengine';
import {worldBounds} from '../packages/margoengine/dist/model.js';
import {meshTriangles} from '../packages/shared/mesh-source.js';
import {accessor, readGLB} from '../packages/exporters/tests/helpers.js';
import {loadedPBREngine, primitivePositions, positionBounds} from './support/loaded-pbr-fixtures.js';

// This gate loads Box by itself through the published build entry. The separate
// FBX fixture is deliberately not read or preflighted before these assertions.
assert.match(import.meta.resolve('@margoengine/gltf-pro'), /\/dist\/index\.js$/);
const box = await readFile(new URL('../packages/exporters/tests/fixtures/Box.glb', import.meta.url));
await RAPIER.init();
const server = createServer((_request, response) => {
  response.writeHead(200, {'content-type': 'model/gltf-binary'});
  response.end(box);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
after(() => {server.closeAllConnections(); return new Promise(resolve => server.close(resolve));});
const url = `http://127.0.0.1:${server.address().port}/Box.glb`;

async function withBox(action, document) {
  const engine = await loadedPBREngine();
  try {
    assert.equal(engine.backend, 'webgpu');
    const model = document ? parseGLTF(engine, document) : await loadGLTF(engine, url);
    assert.ok(model instanceof PBRModel);
    assert.equal(model.primitives.length, 1);
    engine.store.tick(false);
    await action({engine, model, primitive: model.primitives[0], mesh: model.nodes[1]});
  } finally {engine.dispose();}
}

const xyz = vector => [vector.x, vector.y, vector.z];
function close(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label} length`);
  for (let axis = 0; axis < actual.length; axis++) assert.ok(Math.abs(actual[axis] - expected[axis]) < 2e-5,
    `${label}[${axis}]: ${actual[axis]} vs ${expected[axis]}`);
}
function transformed(positions, matrix) {
  const result = new Float32Array(positions.length);
  for (let at = 0; at < positions.length; at += 3) {
    const x = positions[at], y = positions[at + 1], z = positions[at + 2];
    for (let axis = 0; axis < 3; axis++) result[at + axis] = matrix[axis] * x + matrix[axis + 4] * y + matrix[axis + 8] * z + matrix[axis + 12];
  }
  return result;
}
function bodyFramePositions(world, body) {
  // Rapier poses contain translation and unit rotation, never mesh scale.
  // Rotate each actual world vertex by the inverse rigid quaternion rather than
  // reusing the physics package's fitting code or its hierarchy traversal.
  const position = body.raw.translation(), rotation = body.raw.rotation();
  const q = [-rotation.x, -rotation.y, -rotation.z], w = rotation.w;
  const out = new Float32Array(world.length);
  for (let at = 0; at < world.length; at += 3) {
    const x = world[at] - position.x, y = world[at + 1] - position.y, z = world[at + 2] - position.z;
    const tx = 2 * (q[1] * z - q[2] * y), ty = 2 * (q[2] * x - q[0] * z), tz = 2 * (q[0] * y - q[1] * x);
    out[at] = x + w * tx + q[1] * tz - q[2] * ty;
    out[at + 1] = y + w * ty + q[2] * tx - q[0] * tz;
    out[at + 2] = z + w * tz + q[0] * ty - q[1] * tx;
  }
  return out;
}
function assertColliderBounds(collider, positions, label) {
  const {min, max} = positionBounds(positions);
  close(xyz(collider.halfExtents()), max.map((value, axis) => (value - min[axis]) / 2), `${label} half extents`);
  close(xyz(collider.translationWrtParent()), max.map((value, axis) => (value + min[axis]) / 2), `${label} center`);
}
function gltfNodeMatrix(node) {
  if (node.matrix) return node.matrix;
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1], [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + w * z) * sx, 2 * (x * z - w * y) * sx, 0,
    2 * (x * y - w * z) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + w * x) * sy, 0,
    2 * (x * z + w * y) * sz, 2 * (y * z - w * x) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}
function embeddedBoxDocument() {
  const {json, bin} = readGLB(box);
  json.buffers[0].uri = 'data:application/octet-stream;base64,' + Buffer.from(bin).toString('base64');
  return json;
}

test('built gltf-pro Box preserves all three null-Geometry nodes and registers only its genuine primitive', async () => {
  await withBox(({engine, model, primitive, mesh}) => {
    assert.equal(engine.meshes.size, 3);
    assert.equal(model.nodes.length, 2);
    for (const node of [model.root, ...model.nodes]) assert.equal(node.geometry, null);
    assert.equal(meshTriangles(model.root), null);
    assert.equal(meshTriangles(model.nodes[0]), null);
    const triangles = meshTriangles(mesh);
    assert.equal(triangles.kind, 'pbr');
    assert.equal(triangles.source.model, model);
    assert.equal(triangles.source.node, mesh);
    assert.equal(triangles.source.stride, 80);
    assert.deepEqual(triangles.source.primitives, [primitive]);
    assert.equal(primitive.node, mesh);
    assert.equal(primitive.vertices.length / 20, 24);
    assert.equal(primitive.indices.length, 36);
    assert.equal(triangles.source.skinned, false);
    assert.equal(triangles.source.morphed, false);
  });
});

test('Box addBody(model.root) fits the attached grandchild through the authored (x,z,-y) parent matrix', async () => {
  await withBox(({engine, model, primitive, mesh}) => {
    const physics = new Physics(engine, {rapier: RAPIER});
    try {
      const parents = [model.root, ...model.nodes].map(node => engine.store.parents[node.id]);
      const matrices = [model.root, ...model.nodes].map(node => [...node.matrix]);
      const local = primitivePositions(primitive), authored = local.slice();
      for (let at = 0; at < authored.length; at += 3) {
        authored[at + 1] = local[at + 2]; authored[at + 2] = -local[at + 1];
      }
      close(transformed(local, mesh.matrix), authored, 'actual authored parent transform');
      const body = physics.addBody(model.root);
      assert.equal(body.colliders.length, 1);
      assert.equal(physics.bodyCount, 1);
      assert.equal(body.colliders[0].parent().handle, body.raw.handle);
      assertColliderBounds(body.colliders[0], authored, 'attached Box');
      assert.deepEqual([model.root, ...model.nodes].map(node => engine.store.parents[node.id]), parents, 'fitting does not detach or reparent the loaded nodes');
      assert.deepEqual([model.root, ...model.nodes].map(node => [...node.matrix]), matrices, 'fitting does not rewrite loaded transforms');
      for (const node of [model.root, ...model.nodes]) assert.equal(node.geometry, null);
    } finally {physics.dispose();}
  });
});

test('transformed real Box descendants retain rotated offsets and nonuniform root scale exactly once in the Rapier frame', async () => {
  const doc = embeddedBoxDocument(), angle = 0.43, c = Math.cos(angle), s = Math.sin(angle);
  // Keep the real 24 positions and 36 indices, but remove cube symmetry as a
  // false positive for ignored parent rotation, translation or nonuniform scale.
  doc.nodes[0].matrix = [2 * c, 2 * s, 0, 0, -0.5 * s, 0.5 * c, 0, 0, 0, 0, 3, 0, 4, -2, 5, 1];
  await withBox(({engine, model, mesh, primitive}) => {
    model.root.setPosition([9, -8, 7]).setRotation([0.2, -0.4, 0.7]).setScale([2, 3, 4]);
    engine.store.tick(false);
    const physics = new Physics(engine, {rapier: RAPIER});
    try {
      const world = transformed(primitivePositions(primitive), mesh.matrix), matrix = [...mesh.matrix];
      const body = physics.addBody(model.root);
      assert.equal(body.colliders.length, 1);
      const localToRigidBody = bodyFramePositions(world, body);
      assertColliderBounds(body.colliders[0], localToRigidBody, 'scaled root and dissimilar descendant');
      close(xyz(body.colliders[0].translationWrtParent()), [8, -6, 20], 'root scale applies once to the authored offset');
      assert.deepEqual([...mesh.matrix], matrix);
      assert.equal(engine.store.parents[mesh.id], model.nodes[0].id);
      assert.equal(mesh.geometry, null);
    } finally {physics.dispose();}
  }, doc);
});

test('Box primitive still fits directly when explicitly detached, and attached children retain the root-level guard', async () => {
  await withBox(({engine, model, mesh, primitive}) => {
    const physics = new Physics(engine, {rapier: RAPIER});
    try {
      assert.throws(() => physics.addBody(mesh), /Physics bodies need root-level meshes/);
      assert.equal(physics.bodyCount, 0);
      mesh.setParent(null).setScale([2, 3, 4]);
      const body = physics.addBody(mesh);
      assert.equal(body.colliders.length, 1);
      const local = primitivePositions(primitive);
      for (let at = 0; at < local.length; at++) local[at] *= [2, 3, 4][at % 3];
      assertColliderBounds(body.colliders[0], local, 'detached primitive');
      assert.equal(model.root.geometry, null); assert.equal(mesh.geometry, null);
    } finally {physics.dispose();}
  });
});

test('Box exportGLB retains three nodes, one primitive, raw local positions and the authored parent transform', async () => {
  await withBox(({engine, model, primitive}) => {
    const {json, bin} = readGLB(exportGLB(engine));
    assert.equal(json.nodes.length, 3);
    assert.equal(json.meshes.length, 1);
    assert.equal(json.meshes[0].primitives.length, 1);
    const output = json.meshes[0].primitives[0];
    close(accessor(json, bin, output.attributes.POSITION), primitivePositions(primitive), 'unbaked exported local positions');
    assert.deepEqual([...accessor(json, bin, output.indices)], [...primitive.indices]);
    const child = json.nodes.findIndex(node => node.mesh === 0), parent = json.nodes.find(node => node.children?.includes(child));
    assert.ok(parent, 'the mesh retains its grouping parent');
    close(gltfNodeMatrix(parent), model.asset.doc.nodes[0].matrix, 'exported authored parent matrix represented as glTF TRS');
    for (const node of [model.root, ...model.nodes]) assert.equal(node.geometry, null);
  });
});

test('the unchanged basic glTF Box loader still exports one mesh and one primitive', async () => {
  const engine = await loadedPBREngine();
  try {
    const model = parseBasicGLTF(engine, box);
    assert.equal(model.meshes.length, 1);
    assert.ok(model.meshes[0].geometry);
    assert.equal(meshTriangles(model.meshes[0]).kind, 'core');
    const {json} = readGLB(exportGLB(engine));
    assert.equal(json.meshes.length, 1);
    assert.equal(json.meshes[0].primitives.length, 1);
  } finally {engine.dispose();}
});

test('Box model.bounds, facade worldBounds and Stage.fit enclose the actual PBR world vertices', async () => {
  await withBox(({engine, model, mesh, primitive}) => {
    const {min, max} = positionBounds(transformed(primitivePositions(primitive), mesh.matrix));
    assert.equal(model.bounds.length, 6);
    assert.ok([...model.bounds].every(Number.isFinite));
    close(model.bounds, [...min, ...max], 'model world bounds');
    close(worldBounds(engine, model.nodes, new Float32Array(6)), [...min, ...max], 'facade PBR world bounds');
    new Stage(engine).fit(); engine.camera.advance(1);
    close(engine.camera.target, min.map((value, axis) => (value + max[axis]) / 2), 'facade PBR camera target');
    assert.equal(mesh.geometry, null);
    assert.equal([...engine.meshes.values()].filter(node => node.geometry).length, 0, 'bounds and fitting never register a second core draw');
  });
});

test('Box CAD and static AssemblyBVH consume only explicitly passed primitive nodes', async () => {
  await withBox(async ({engine, model, mesh, primitive}) => {
    assert.deepEqual(deduplicateParts(model.nodes), {parts: 1, unique: 1});
    assert.throws(() => deduplicateParts([model.root]), {message: 'CAD grouping contains no supported geometry'});
    assert.throws(() => deduplicateParts([engine.createMesh()]), {message: 'CAD grouping contains no supported geometry'});
    const assembly = await AssemblyBVH.create(model.nodes);
    try {
      assert.equal(assembly.count, 12, 'the real source contributes all 12 triangles');
      const world = transformed(primitivePositions(primitive), mesh.matrix), {min, max} = positionBounds(world);
      const ray = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, max[2] + 2];
      const hit = assembly.raycast(ray, [0, 0, -1]);
      assert.equal(hit?.node, mesh);
      assert.ok(hit.triangle >= 0 && hit.triangle < 12);
      close([hit.distance], [2], 'actual transformed box ray distance');
      await assert.rejects(AssemblyBVH.create([model.root]), {message: 'BVH requires 1..1000000 triangles'});
    } finally {assembly.dispose();}
    assert.equal(mesh.geometry, null);
  });
});

test('BoxHelper emits finite bounds for the primitive and no synthetic descendant box for the grouping root', async () => {
  await withBox(({engine, model, mesh}) => {
    const primitive = new BoxHelper(mesh), root = new BoxHelper(model.root);
    try {
      assert.equal(primitive.update(engine), true);
      assert.ok(primitive.points.length > 0 && [...primitive.points].every(Number.isFinite));
      assert.equal(root.update(engine), false);
      assert.equal(mesh.geometry, null);
    } finally {primitive.dispose(); root.dispose();}
  });
});

test('Box default fitting rolls back empty roots and disposed model handles without leaving a body', async () => {
  await withBox(({engine, model}) => {
    const physics = new Physics(engine, {rapier: RAPIER});
    try {
      assert.throws(() => physics.addBody(engine.createMesh()), {message: 'No geometry'});
      assert.equal(physics.bodyCount, 0);
      const leftover = model.root;
      model.dispose();
      assert.equal(meshTriangles(leftover), null);
      // Core rejects its disposed handle before optional physics can fit it.
      assert.throws(() => physics.addBody(leftover), {message: 'Mesh disposed'});
      assert.equal(physics.bodyCount, 0);
    } finally {physics.dispose();}
  });
});

test('a genuine Box morph source needs an explicit collider even when discovered below model.root', async () => {
  const doc = embeddedBoxDocument(), primitive = doc.meshes[0].primitives[0];
  // Reuse the real POSITION accessor as a valid dense target, without invented
  // replacement triangles; the ordinary static Box path above stays unchanged.
  primitive.targets = [{POSITION: primitive.attributes.POSITION}];
  doc.meshes[0].weights = [0];
  await withBox(({engine, model, mesh}) => {
    assert.equal(meshTriangles(mesh).source.morphed, true);
    const physics = new Physics(engine, {rapier: RAPIER});
    try {
      assert.throws(() => physics.addBody(model.root), {message: 'Skinned mesh needs an explicit collider'});
      assert.equal(physics.bodyCount, 0);
      const body = physics.addBody(model.root, {colliders: {shape: 'capsule', halfHeight: 0.4, radius: 0.15}});
      assert.equal(body.colliders.length, 1);
      close([body.colliders[0].halfHeight(), body.colliders[0].radius()], [0.4, 0.15], 'explicit morph collider');
      assert.equal(mesh.geometry, null);
    } finally {physics.dispose();}
  }, doc);
});
