import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseGLTF as parseCoreGLTF} from '@margoengine/gltf';
import {Stage} from 'margoengine';
import {loadedModel} from '../packages/margoengine/dist/model.js';
import {loadedPBRFixtures, serveLoadedPBRFixtures} from './support/loaded-pbr-fixtures.js';
import {meshTriangles} from '../packages/shared/mesh-source.js';

const assets = await serveLoadedPBRFixtures();
try {
  for (const fixture of loadedPBRFixtures) (await assets.load(fixture)).dispose();
} catch (error) {
  await assets.close();
  throw error;
}
after(() => assets.close());
const controlBytes = await readFile(new URL('../packages/exporters/tests/fixtures/Box.glb', import.meta.url));

function worldPositions(vertices, stride, matrix) {
  return Array.from({length: vertices.length / stride}, (_, vertex) => {
    const offset = vertex * stride, x = vertices[offset], y = vertices[offset + 1], z = vertices[offset + 2];
    return [0, 1, 2].map(axis => matrix[axis] * x + matrix[axis + 4] * y + matrix[axis + 8] * z + matrix[axis + 12]);
  });
}

for (const fixture of loadedPBRFixtures) {
  test(`${fixture.producer}: Stage.fit includes the real ${fixture.asset} mesh beside a core-loader control`, {todo:'Known frozen-stage limitation: mixed Stage.fit reads core Geometry only. Use model.bounds and camera.fitToBoundingBox.'}, async () => {
    const loaded = await assets.load(fixture), {engine, mesh, primitive} = loaded;
    try {
      // The control also comes from real file bytes. Never attach Geometry to the PBR subject.
      const controlModel = parseCoreGLTF(engine, controlBytes), control = controlModel.meshes[0];
      control.setPosition([12, 0, 0]);
      engine.store.tick(false);
      const points = [
        ...worldPositions(primitive.vertices, 20, mesh.matrix),
        ...worldPositions(control.geometry.vertices, 6, control.matrix),
      ];
      const expectedCenter = [0, 1, 2].map(axis => (
        Math.min(...points.map(point => point[axis])) + Math.max(...points.map(point => point[axis]))
      ) / 2);
      const stage = new Stage(engine);
      stage.fit([control]); engine.camera.advance(1);
      assert.deepEqual([...engine.camera.target], [12, 0, 0], 'the real core-loader control fits correctly');
      stage.fit([mesh, control]); engine.camera.advance(1);
      assert.deepEqual([...engine.camera.target], expectedCenter, 'mixed fitting must include the loaded PBR positions');
      assert.equal(mesh.geometry, null);
    } finally {loaded.dispose();}
  });

  test(`${fixture.producer}: facade raw gathering does not silently omit real ${fixture.asset}`, {todo:'Known frozen-stage limitation: its internal raw adapter reads core Geometry only. Use PBRModel.raw.'}, async () => {
    const loaded = await assets.load(fixture), {engine, model, mesh} = loaded;
    try {
      // PBRModel exposes nodes/primitives; adapt only the list shape expected by
      // this internal facade consumer. The root and mesh are actual loader objects.
      const view = loadedModel(engine, {root: model.root, meshes: [mesh], dispose: () => model.dispose()});
      assert.ok(view.raw.length > 0, 'a nonempty loader part must not silently gather zero buffers');
      assert.equal(mesh.geometry, null);
    } finally {loaded.dispose();}
  });

  test(`${fixture.producer}: model bounds and raw expose real ${fixture.asset} without changing the facade`, async()=>{
    const loaded=await assets.load(fixture),{engine,model,mesh,primitive}=loaded;
    try{
      engine.store.tick(false);
      const points=worldPositions(primitive.vertices,20,mesh.matrix);
      const expected=[0,1,2].map(axis=>Math.min(...points.map(p=>p[axis]))).concat([0,1,2].map(axis=>Math.max(...points.map(p=>p[axis]))));
      assert.deepEqual([...model.bounds],Array.from(new Float32Array(expected)));
      assert.equal(model.raw.length,model.primitives.length);
      assert.equal(model.raw[0].vertex,model.pickingPrimitives[0].vertex);
      assert.equal(model.raw[0].index,model.pickingPrimitives[0].index);
      assert.equal(model.raw[0].primitive,primitive);
      assert.equal(model.raw[0].stride,80);
      assert.equal(mesh.geometry,null);
      assert.throws(()=>new Stage(engine).fit([mesh]),/No geometry/);
    }finally{loaded.dispose();}
  });

  test(`${fixture.producer}: optional camera fitting combines real ${fixture.asset} with a core model`,async()=>{
    const loaded=await assets.load(fixture),{engine,model,mesh,primitive}=loaded;
    try{
      const controlModel=parseCoreGLTF(engine,controlBytes),control=controlModel.meshes[0];control.setPosition([12,0,0]);engine.store.tick(false);
      const points=worldPositions(control.geometry.vertices,6,control.matrix),bounds=model.bounds.slice();
      for(const point of points)for(let axis=0;axis<3;axis++){bounds[axis]=Math.min(bounds[axis],point[axis]);bounds[axis+3]=Math.max(bounds[axis+3],point[axis]);}
      engine.camera.fitToBoundingBox([...bounds.subarray(0,3)],[...bounds.subarray(3)]);engine.camera.advance(1);
      const all=[...points,...worldPositions(primitive.vertices,20,mesh.matrix)];
      assert.deepEqual([...engine.camera.target],[0,1,2].map(axis=>(Math.min(...all.map(p=>p[axis]))+Math.max(...all.map(p=>p[axis])))/2));
    }finally{loaded.dispose();}
  });

  test(`${fixture.producer}: shared triangle lookup follows ${fixture.asset} lifetime and reused mesh slots`,async()=>{
    const loaded=await assets.load(fixture),{engine,model,mesh,primitive}=loaded;
    try{
      const triangles=meshTriangles(mesh);assert.equal(triangles.kind,'pbr');assert.equal(triangles.source.model,model);
      assert.deepEqual(triangles.source.primitives,[primitive]);assert.equal(triangles.source.draws[0].primitive,primitive);
      const oldId=mesh.id;model.dispose();assert.equal(meshTriangles(mesh),null);assert.deepEqual(model.raw,[]);assert.throws(()=>model.bounds,/disposed/);
      const replacements=Array.from({length:loaded.engine.store.capacity>128?64:16},()=>engine.createMesh());
      assert.ok(replacements.some(node=>node.id===oldId));for(const node of replacements)assert.equal(meshTriangles(node),null);
    }finally{loaded.dispose();}
  });
}
