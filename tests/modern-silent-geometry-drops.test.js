import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';
import validator from 'gltf-validator';
import {Physics} from '@margoengine/physics';
import {exportGLTF} from '@margoengine/exporters';
import {deduplicateParts} from '@margoengine/machinery/cad';
import {accessor} from '../packages/exporters/tests/helpers.js';
import {loadedPBRFixtures, loadedPBREngine, serveLoadedPBRFixtures, primitivePositions, positionBounds} from './support/loaded-pbr-fixtures.js';
import {meshTriangles} from '../packages/shared/mesh-source.js';

// Load both real files before registering consumer checks. A fixture failure aborts the suite,
// instead of reporting consumer failures against an invented or incomplete replacement mesh.
const assets = await serveLoadedPBRFixtures();
try {
  for (const fixture of loadedPBRFixtures) (await assets.load(fixture)).dispose();
} catch (error) {
  await assets.close();
  throw error;
}
after(() => assets.close());
await RAPIER.init();

async function withLoaded(fixture, action) {
  const loaded = await assets.load(fixture);
  try {await action(loaded);}
  finally {loaded.dispose();}
}
const xyz = vector => [vector.x, vector.y, vector.z];
function close(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label} length`);
  for (let index = 0; index < actual.length; index++) assert.ok(Math.abs(actual[index] - expected[index]) < 1e-5,
    `${label}[${index}]: ${actual[index]} vs ${expected[index]}`);
}

for (const fixture of loadedPBRFixtures) {
  test(`${fixture.producer}: default PhysicsBody creates a collider for real ${fixture.asset}`, async () => {
    await withLoaded(fixture, ({engine, mesh, primitive}) => {
      const physics = new Physics(engine, {rapier: RAPIER});
      try {
        // Physics requires a root-level mesh. It is still the actual loaded mesh with its original primitive.
        mesh.setParent(null);
        const {min, max} = positionBounds(primitivePositions(primitive), xyz(mesh.scale));
        const body = physics.addBody(mesh);
        assert.equal(body.colliders.length, 1);
        close(xyz(body.colliders[0].halfExtents()), max.map((value, axis) => (value - min[axis]) / 2), 'bind-pose collider half extents');
        close(xyz(body.colliders[0].translationWrtParent()), max.map((value, axis) => (value + min[axis]) / 2), 'bind-pose collider center');
        assert.equal(mesh.geometry, null, 'physics does not attach a second core Geometry');
      } finally {physics.dispose();}
    });
  });

  test(`${fixture.producer}: an explicit capsule attaches to the real ${fixture.asset} mesh`, async () => {
    await withLoaded(fixture, ({engine, mesh}) => {
      const physics = new Physics(engine, {rapier: RAPIER});
      try {
        mesh.setParent(null);
        const body = physics.addBody(mesh, {colliders: {shape: 'capsule', halfHeight: 0.4, radius: 0.15}});
        assert.equal(body.colliders.length, 1);
        assert.equal(body.colliders[0].parent().handle, body.raw.handle, 'explicit collider belongs to the loaded mesh body');
        close([body.colliders[0].halfHeight(), body.colliders[0].radius()], [0.4, 0.15], 'explicit capsule dimensions');
        assert.equal(mesh.geometry, null, 'explicit collision does not attach a second core Geometry');
      } finally {physics.dispose();}
    });
  });

  test(`${fixture.producer}: PhysicsBody rejects the real ${fixture.asset} mesh after model disposal`, async () => {
    await withLoaded(fixture, ({engine, model, mesh}) => {
      const physics = new Physics(engine, {rapier: RAPIER});
      try {
        mesh.setParent(null);
        assert.equal(meshTriangles(mesh)?.kind, 'pbr');
        model.dispose();
        assert.equal(meshTriangles(mesh), null, 'disposal clears the registered triangle source');
        assert.throws(() => physics.addBody(mesh), {name: 'Error', message: 'Mesh disposed'});
        assert.equal(physics.bodyCount, 0, 'a disposed loader mesh cannot retain an empty body');
        assert.equal(mesh.geometry, null);
      } finally {physics.dispose();}
    });
  });

  test(`${fixture.producer}: default glTF export retains the mesh from real ${fixture.asset}`, async () => {
    await withLoaded(fixture, async ({engine, model, mesh, primitive}) => {
      const result = exportGLTF(engine), {json} = result;
      assert.equal(json.meshes?.length ?? 0, 1);
      const output = json.meshes[0].primitives[0], binary = new Uint8Array(Buffer.from(json.buffers[0].uri.split(',')[1], 'base64'));
      close(accessor(json, binary, output.attributes.POSITION), primitivePositions(primitive), 'exported bind-pose positions');
      assert.deepEqual([...accessor(json, binary, output.indices)], [...primitive.indices]);
      const sourceNode = model.asset.doc.nodes[primitive.nodeIndex], sourceSkinIndex = sourceNode.skin;
      if (sourceSkinIndex !== undefined) {
        const sourceSkin = model.asset.doc.skins[sourceSkinIndex], attributes = primitive.definition.attributes;
        assert.equal(json.skins?.length, 1, 'skinned FBX stays skinned');
        assert.equal(json.nodes.find(node => node.mesh === 0)?.skin, 0);
        assert.equal(json.skins[0].joints.length, sourceSkin.joints.length);
        assert.deepEqual([...accessor(json, binary, output.attributes.JOINTS_0)], [...model.asset.accessor(attributes.JOINTS_0)]);
        close(accessor(json, binary, output.attributes.WEIGHTS_0), model.asset.accessor(attributes.WEIGHTS_0), 'exported skin weights');
        close(accessor(json, binary, json.skins[0].inverseBindMatrices), model.asset.accessor(sourceSkin.inverseBindMatrices), 'exported inverse bind matrices');
      }
      const report = await validator.validateString(result.text, {maxIssues: 0});
      assert.equal(report.issues.numErrors, 0, JSON.stringify(report.issues.messages));
      // Preserve the authored +1 X skin transform and the real loader's grouping
      // root. These specific glTF skin warnings follow from that retained hierarchy.
      const expectedWarnings = [];
      if (fixture.producer === 'fbx' && sourceSkinIndex !== undefined) {
        if (sourceNode.translation?.some(value => value !== 0)) expectedWarnings.push('NODE_SKINNED_MESH_LOCAL_TRANSFORMS');
        const meshNode = json.nodes.findIndex(node => node.mesh === 0);
        if (json.nodes.some(node => node.children?.includes(meshNode))) expectedWarnings.push('NODE_SKINNED_MESH_NON_ROOT');
      }
      assert.deepEqual(report.issues.messages.filter(issue => issue.severity === 1).map(issue => issue.code).sort(), expectedWarnings.sort());
      assert.equal(mesh.geometry, null, 'export does not attach a second core Geometry');
    });
  });

  test(`${fixture.producer}: default CAD grouping counts the part from real ${fixture.asset}`, async () => {
    await withLoaded(fixture, ({mesh}) => {
      assert.deepEqual(deduplicateParts([mesh]), {parts: 1, unique: 1});
      assert.equal(mesh.geometry, null, 'CAD grouping does not attach a second core Geometry');
    });
  });
}

test('default PhysicsBody rejects a mesh with neither core geometry nor a PBR primitive', async () => {
  const engine = await loadedPBREngine(), physics = new Physics(engine, {rapier: RAPIER});
  try {
    const mesh = engine.createMesh();
    assert.throws(() => physics.addBody(mesh), /geometry|primitive/i);
    assert.equal(physics.bodyCount, 0, 'failed default fitting does not retain an empty body');
  } finally {physics.dispose(); engine.dispose();}
});

test('default glTF export rejects a mesh with neither core geometry nor a PBR primitive', async () => {
  const engine = await loadedPBREngine();
  try {engine.createMesh(); assert.throws(() => exportGLTF(engine), /geometry|primitive/i);}
  finally {engine.dispose();}
});

test('default CAD grouping rejects a mesh with neither core geometry nor a PBR primitive', async () => {
  const engine = await loadedPBREngine();
  try {assert.throws(() => deduplicateParts([engine.createMesh()]), /geometry|primitive/i);}
  finally {engine.dispose();}
});

test('real-loader PBR source metadata is nonenumerable and removed on model disposal', async () => {
  const key = Symbol.for('margoengine.pbr-source.v1');
  for (const fixture of loadedPBRFixtures) await withLoaded(fixture, ({engine, model, mesh}) => {
    const descriptor = Object.getOwnPropertyDescriptor(mesh, key);
    assert.equal(descriptor?.value, model);
    assert.equal(descriptor?.enumerable, false);
    model.dispose();
    assert.equal(Object.hasOwn(mesh, key), false, 'retained disposed handles no longer retain their model');
    assert.equal(engine.meshes.size, 0);
    assert.equal(mesh.geometry, null);
  });
});
