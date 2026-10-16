import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseGLTF as parseCoreGLTF} from '@margoengine/gltf';
import {parsePreparedPBR} from '@margoengine/gltf-pro';
import {Stage} from 'margoengine';
import {loadedModel, worldBounds} from '../packages/margoengine/dist/model.js';
import {loadedPBRFixtures, serveLoadedPBRFixtures} from './support/loaded-pbr-fixtures.js';
import {clearMeshSource, meshTriangles, setMeshSource} from '../packages/shared/mesh-source.js';

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
const pointBounds = points => Float32Array.from([
  ...[0, 1, 2].map(axis => Math.min(...points.map(point => point[axis]))),
  ...[0, 1, 2].map(axis => Math.max(...points.map(point => point[axis]))),
]);
const center = bounds => [0, 1, 2].map(axis => (bounds[axis] + bounds[axis + 3]) / 2);

function withoutGPUWork(engine, action) {
  const replacements = [];
  for (const [owner, names] of [[engine.gpu, ['createBuffer', 'createTexture', 'createCommandEncoder']], [engine.gpu.queue, ['writeBuffer', 'writeTexture', 'submit']]]) {
    for (const name of names) {
      if (typeof owner[name] !== 'function') continue;
      const original = owner[name]; replacements.push(() => {owner[name] = original;});
      owner[name] = () => {throw new Error(`Unexpected GPU work: ${name}`);};
    }
  }
  try {return action();}
  finally {for (const restore of replacements.reverse()) restore();}
}

for (const fixture of loadedPBRFixtures) {
  test(`${fixture.producer}: Stage.fit includes real ${fixture.asset} positions beside a core-loader control`, async () => {
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
      const expectedCenter = center(pointBounds(points));
      if (fixture.producer === 'gltf-pro') assert.deepEqual(expectedCenter, [6, 0, 0]);
      else for (const [axis, value] of [5.304, 0, -0.361].entries()) assert.ok(Math.abs(expectedCenter[axis] - value) < 0.001);
      const stage = new Stage(engine);
      stage.fit([control]); engine.camera.advance(1);
      assert.deepEqual([...engine.camera.target], [12, 0, 0], 'the real core-loader control fits correctly');
      for (const meshes of [[mesh, control], [control, mesh]]) {
        withoutGPUWork(engine, () => stage.fit(meshes));
        engine.camera.advance(1);
        assert.deepEqual([...engine.camera.target], expectedCenter, 'mixed fitting includes PBR and core positions');
      }
      stage.fit(); engine.camera.advance(1);
      assert.deepEqual([...engine.camera.target], expectedCenter, 'the default scene scan includes registered PBR nodes');
      stage.fit([mesh]); engine.camera.advance(1);
      assert.deepEqual([...engine.camera.target], center(pointBounds(worldPositions(primitive.vertices, 20, mesh.matrix))));
      loaded.model.root.setPosition([3, 2, -4]).setRotation([0.2, -0.3, 0.4]).setScale([2, 1.5, 0.75]);
      engine.store.tick(false);
      const transformed = pointBounds([
        ...worldPositions(primitive.vertices, 20, mesh.matrix),
        ...worldPositions(control.geometry.vertices, 6, control.matrix),
      ]);
      stage.fit([mesh, control]); engine.camera.advance(1);
      assert.deepEqual([...engine.camera.target], center(transformed), 'PBR positions use the complete primitive node world matrix');
      mesh.visible = false;
      stage.fit([mesh, control]); engine.camera.advance(1);
      assert.deepEqual([...engine.camera.target], [12, 0, 0], 'hidden PBR geometry stays excluded from fitting');
      const view = loadedModel(engine, {root: loaded.model.root, meshes: [control, mesh], dispose() {}});
      assert.deepEqual(view.bounds, transformed, 'model bounds include hidden geometry like the core path');
      mesh.visible = true; loaded.model.root.visible = false;
      stage.fit([mesh, control]); engine.camera.advance(1);
      assert.deepEqual([...engine.camera.target], [12, 0, 0], 'a hidden ancestor excludes the PBR part from fitting');
      assert.deepEqual(view.bounds, transformed);
      assert.equal(mesh.geometry, null);
    } finally {loaded.dispose();}
  });

  test(`${fixture.producer}: facade raw borrows real ${fixture.asset} draw records without a core instance buffer`, async () => {
    const loaded = await assets.load(fixture), {engine, model, mesh, primitive} = loaded;
    try {
      // PBRModel exposes nodes/primitives; adapt only the list shape expected by
      // this internal facade consumer. The root and mesh are actual loader objects.
      const view = loadedModel(engine, {root: model.root, meshes: [model.root, mesh, mesh], dispose: () => model.dispose()});
      const source = meshTriangles(mesh).source, descriptor = Object.getOwnPropertyDescriptor(source, 'draws'), draws = source.draws;
      Object.defineProperty(source, 'draws', {get: () => draws, configurable: true});
      try {
        const raw = withoutGPUWork(engine, () => view.raw);
        assert.equal(raw.length, model.primitives.length, 'duplicate handles do not duplicate primitive records');
        assert.equal(raw[0], draws[0], 'the source draw record is borrowed without copying');
        assert.equal(raw[0].vertex, model.raw[0].vertex); assert.equal(raw[0].index, model.raw[0].index);
        assert.equal(raw[0].primitive, primitive); assert.equal(raw[0].stride, 80);
        assert.equal(raw[0].instance, undefined);
        mesh.visible = false;
        assert.equal(view.raw[0], draws[0], 'raw includes hidden parts');
      } finally {Object.defineProperty(source, 'draws', descriptor);}
      const first = view.raw[0]; model.onDeviceRestored(engine);
      assert.notEqual(view.raw[0].vertex, first.vertex, 'a fresh raw query follows restored loader resources');
      assert.equal(view.raw[0].vertex, model.raw[0].vertex);
      const deformed = engine.gpu.createBuffer({size: primitive.vertices.byteLength, usage: GPUBufferUsage.VERTEX});
      primitive.deformed = deformed;
      try {
        assert.equal(withoutGPUWork(engine, () => view.raw)[0].vertex, deformed, 'raw borrows the current deformed buffer without preparing another pose');
      } finally {primitive.deformed = undefined; deformed.destroy();}
      const controlModel = parseCoreGLTF(engine, controlBytes), control = controlModel.meshes[0];
      const original = engine.geometryBuffers, buffers = {vertex: {}, index: {}, instance: {}};
      engine.geometryBuffers = () => buffers;
      try {
        for (const meshes of [[mesh, control], [control, mesh]]) {
          const mixed = loadedModel(engine, {root: model.root, meshes, dispose() {}});
          const raw = withoutGPUWork(engine, () => mixed.raw);
          assert.equal(raw.length, 2); assert.equal(raw[0], buffers);
          assert.equal(raw[0].instance, buffers.instance);
          assert.equal(raw[1].vertex, model.raw[0].vertex); assert.equal(raw[1].index, model.raw[0].index);
        }
      } finally {engine.geometryBuffers = original;}
      assert.equal(mesh.geometry, null);
    } finally {loaded.dispose();}
  });

  test(`${fixture.producer}: model and facade bounds agree for real ${fixture.asset} without core Geometry`, async()=>{
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
      const view=loadedModel(engine,{root:model.root,meshes:[mesh],dispose(){}});
      assert.deepEqual(view.bounds,model.bounds);
      new Stage(engine).fit([mesh]);engine.camera.advance(1);
      assert.deepEqual([...engine.camera.target],center(view.bounds));
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

  test(`${fixture.producer}: facade skips missing or disposed source metadata and rejects stale handles`, async () => {
    const loaded = await assets.load(fixture), {engine, model, mesh} = loaded;
    try {
      const control = parseCoreGLTF(engine, controlBytes).meshes[0]; control.setPosition([12, 0, 0]);
      const source = meshTriangles(mesh).source, original = engine.geometryBuffers, buffers = {vertex: {}, index: {}, instance: {}};
      engine.geometryBuffers = () => buffers;
      const view = loadedModel(engine, {root: control, meshes: [mesh, control], dispose() {}});
      try {
        for (const registryState of ['missing', 'disposed']) {
          if (registryState === 'missing') clearMeshSource(mesh);
          else setMeshSource(mesh, {...source, model: {...model, disposed: true}});
          assert.deepEqual([...view.bounds], [11.5, -0.5, -0.5, 12.5, 0.5, 0.5]);
          assert.deepEqual(view.raw, [buffers]);
          assert.throws(() => worldBounds(engine, [mesh], new Float32Array(6)), /No geometry/);
        }
      } finally {setMeshSource(mesh, source); engine.geometryBuffers = original;}
      const id = mesh.id, stage = new Stage(engine); model.dispose();
      assert.throws(() => stage.fit([mesh]), /Mesh disposed/);
      assert.throws(() => view.raw, /Mesh disposed/);
      assert.throws(() => view.bounds, /Mesh disposed/);
      const replacements = Array.from({length: 16}, () => engine.createMesh()), replacement = replacements.find(node => node.id === id);
      assert.ok(replacement); assert.equal(meshTriangles(replacement), null);
      stage.fit([replacement, control]); engine.camera.advance(1);
      assert.deepEqual([...engine.camera.target], [12, 0, 0]);
      assert.deepEqual(loadedModel(engine, {root: replacement, meshes: [replacement], dispose() {}}).raw, []);
    } finally {loaded.dispose();}
  });
}

test('facade still skips ordinary empty and grouping nodes around core geometry', async () => {
  const loaded = await assets.load(loadedPBRFixtures[0]), {engine} = loaded;
  try {
    const model = parseCoreGLTF(engine, controlBytes), mesh = model.meshes[0], empty = engine.createMesh(model.root);
    mesh.setPosition([12, 0, 0]);
    const stage = new Stage(engine), parts = [loaded.model.root, model.root, empty, mesh];
    stage.fit(parts); engine.camera.advance(1);
    assert.deepEqual([...engine.camera.target], [12, 0, 0]);
    const buffers = {vertex: {}, index: {}, instance: {}}, original = engine.geometryBuffers;
    engine.geometryBuffers = geometry => {assert.equal(geometry, mesh.geometry); return buffers;};
    try {
      const view = loadedModel(engine, {root: model.root, meshes: parts, dispose: () => model.dispose()});
      assert.deepEqual([...view.bounds], [11.5, -0.5, -0.5, 12.5, 0.5, 0.5]);
      assert.deepEqual(view.raw, [buffers]);
      assert.deepEqual(loadedModel(engine, {root: empty, meshes: [empty], dispose() {}}).raw, []);
    } finally {engine.geometryBuffers = original;}
  } finally {loaded.dispose();}
});

test('facade raw preserves separate primitive records even when the loader shares GPU buffers', async () => {
  const loaded = await assets.load(loadedPBRFixtures[0]), {engine, model} = loaded;
  try {
    const doc = structuredClone(model.asset.doc);
    delete doc.buffers; delete doc.bufferViews; delete doc.accessors;
    doc.meshes[0].primitives = [{attributes: {}, material: 0}, {attributes: {}, material: 0}];
    const {vertices, indices} = model.primitives[0], data = {vertices, indices};
    const doubled = parsePreparedPBR(engine, doc, [[data, data]]), mesh = doubled.primitives[0].node;
    try {
      const view = loadedModel(engine, {root: doubled.root, meshes: [doubled.root, mesh, mesh], dispose() {}});
      const raw = withoutGPUWork(engine, () => view.raw);
      assert.equal(raw.length, 2); assert.equal(raw[0].vertex, raw[1].vertex); assert.equal(raw[0].index, raw[1].index);
      assert.notEqual(raw[0].primitive, raw[1].primitive);
      assert.deepEqual(new Set(raw.map(draw => draw.primitive)), new Set(doubled.primitives));
      assert.deepEqual(view.bounds, doubled.bounds);
      assert.equal(mesh.geometry, null);
    } finally {doubled.dispose();}
  } finally {loaded.dispose();}
});
