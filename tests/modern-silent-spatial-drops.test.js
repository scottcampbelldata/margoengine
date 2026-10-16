import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseGLTF} from '@margoengine/gltf';
import {MeshBVH, Raycaster} from '@margoengine/bvh';
import {AssemblyBVH} from '@margoengine/machinery/spatial';
import {Picking, Selection} from '@margoengine/selection';
import {parseGLTF as parsePBR} from '@margoengine/gltf-pro';
import {meshTriangles} from '../packages/shared/mesh-source.js';
import {loadedPBRFixtures, serveLoadedPBRFixtures, primitivePositions} from './support/loaded-pbr-fixtures.js';

// Load both real files before registering consumer checks. Abort on load failure;
// no consumer is exercised with an invented or partially loaded replacement.
const coreControlBytes = await readFile(new URL('../packages/exporters/tests/fixtures/Box.glb', import.meta.url));
const assets = await serveLoadedPBRFixtures();
try {
  for (const fixture of loadedPBRFixtures) {
    const loaded = await assets.load(fixture);
    try {coreControl(loaded.engine).dispose();}
    finally {loaded.dispose();}
  }
} catch (error) {
  await assets.close();
  throw error;
}
after(() => assets.close());

async function withLoaded(fixture, action) {
  const loaded = await assets.load(fixture);
  try {await action(loaded);}
  finally {loaded.dispose();}
}

function coreControl(engine) {
  try {
    const model = parseGLTF(engine, coreControlBytes);
    assert.equal(model.meshes.length, 1, 'real basic glTF parser returns one control mesh');
    assert.ok(model.meshes[0].geometry, 'basic loader control owns core Geometry');
    return model;
  } catch (cause) {throw new Error('ASSET LOAD FAILED; STOP: basic glTF Box.glb control', {cause});}
}

function worldPositions(positions, matrix) {
  const world = new Float32Array(positions.length);
  for (let at = 0; at < positions.length; at += 3) {
    const [x, y, z] = positions.subarray(at, at + 3);
    for (let axis = 0; axis < 3; axis++) world[at + axis] = matrix[axis] * x + matrix[4 + axis] * y + matrix[8 + axis] * z + matrix[12 + axis];
  }
  return world;
}

// Aim at the interior of a genuine loaded triangle, from its front side. This
// oracle does not read mesh.geometry or assign Geometry to a loaded PBR node.
function triangleRay(positions, indices) {
  for (let face = 0; face < indices.length; face += 3) {
    const [a, b, c] = [...indices.subarray(face, face + 3)].map(index => positions.subarray(index * 3, index * 3 + 3));
    const u = [...b].map((value, axis) => value - a[axis]), v = [...c].map((value, axis) => value - a[axis]);
    const normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const length = Math.hypot(...normal);
    if (length < 1e-8) continue;
    const unit = normal.map(value => value / length), centroid = [...a].map((value, axis) => (value + b[axis] + c[axis]) / 3);
    const offset = Math.max(1, Math.hypot(...u), Math.hypot(...v));
    const ray = {origin: centroid.map((value, axis) => value + unit[axis] * offset), direction: unit.map(value => -value)};
    assert.ok(MeshBVH.build({positions, indices}).raycastFirst(ray), 'raw loaded positions independently prove a geometric hit');
    return ray;
  }
  assert.fail('real asset must have a nondegenerate triangle');
}

async function loadedRay({mesh, primitive, model}) {
  const ray = triangleRay(worldPositions(primitivePositions(primitive), mesh.matrix), primitive.indices);
  const raycaster = new Raycaster(ray.origin, ray.direction);
  assert.ok((await raycaster.intersectModel(model)).some(hit => hit.mesh === mesh), 'documented PBR intersectModel path hits this actual loaded mesh');
  return {ray, raycaster};
}

// Observe Selection's actual registered frame-graph pass with the fixture GPU
// shim. Rasterization is not emulated: this checks whether mask triangles are
// encoded at all. The scene contains only real PBR nodes and no core Geometry,
// so its core-mask callback has no core draw to emit.
function maskFrame(engine) {
  let indices = 0;
  const idle = {setPipeline() {}, setBindGroup() {}, setVertexBuffer() {}, setIndexBuffer() {}, draw() {}, drawIndexed() {}, dispatchWorkgroups() {}, end() {}};
  const encoder = {
    beginComputePass() {return idle;},
    beginRenderPass(descriptor) {
      const mask = descriptor.colorAttachments?.[0]?.view?.texture?.format === 'r8unorm';
      return {...idle, drawIndexed(count, instances = 1) {if (mask) indices += count * instances;}};
    },
  };
  const context = {backend: 'webgpu', device: engine.gpu, encoder, camera: engine.camera, width: 128, height: 96, delta: 0,
    color: {}, depth: {}, format: 'bgra8unorm', shader: '', bindings: [], indirect: false,
    descriptor: {layout: 'auto', vertex: {buffers: []}, multisample: {count: 1}, depthStencil: {format: 'depth32float'}}, draw() {}};
  engine.frameGraph.execute(context);
  return indices;
}

// Observe the real Picking API's render/copy/read protocol. IDs come only from
// primitives whose actual draw commands were encoded; no pixel coverage or GPU
// depth comparison is emulated here (the browser regression checks those).
function pickingCommands(engine) {
  const passes=[],events=[],geometry=new Map();let read;
  engine.geometryBuffers=value=>{let buffers=geometry.get(value);if(!buffers){buffers={vertex:{core:true},index:{},instance:engine.gpu.createBuffer({size:engine.store.capacity*96,usage:GPUBufferUsage.COPY_DST})};geometry.set(value,buffers);}return buffers;};
  engine.gpu.queue.submit=()=>events.push('submit');
  engine.gpu.createCommandEncoder=()=>({
    beginRenderPass(descriptor){const record={descriptor,vertices:[],groups:new Map(),draws:[],pipeline:null};passes.push(record);events.push('render');return {
      setPipeline(value){record.pipeline=value;},setBindGroup(index,value){record.groups.set(index,value);},setVertexBuffer(index,value){record.vertices[index]=value;},setIndexBuffer(){},
      drawIndexed(count,instances=1){record.draws.push({count,instances});},end(){},
    };},
    copyTextureToBuffer(_source,target){read=target.buffer;const words=new Uint32Array(read.data);words.fill(0);const pbr=passes.findLast(record=>record.pipeline?.vertex.module.code.includes('struct PickFrame')&&record.draws.length);if(pbr){const uniform=pbr.groups.get(0).entries.find(value=>value.binding===0).resource.buffer;words[65]=new Float32Array(uniform.data)[44];}},
    copyBufferToBuffer(source,from,target,to,size){new Uint8Array(target.data,to,size).set(new Uint8Array(source.data,from,size));},finish(){return {};},
  });
  return {passes,events,get read(){return read;},reset(){passes.length=events.length=0;},dispose(){for(const value of geometry.values())value.instance.destroy();}};
}

for (const fixture of loadedPBRFixtures) {
  // Before deformation a loader's CPU vertices are its rendered pose, so the
  // synchronous mesh APIs must retain those triangles without GPU readback.
  test(`${fixture.producer}: Raycaster.intersectMeshes retains real ${fixture.asset} at an analytic primitive hit`, async () => {
    await withLoaded(fixture, async loaded => {
      const {raycaster} = await loadedRay(loaded);
      const hits = raycaster.intersectMeshes(loaded.engine, [loaded.mesh]);
      assert.equal(hits.some(hit => hit.mesh === loaded.mesh), true, 'accepted mesh collection must retain the loaded hit instead of returning []');
    });
  });

  test(`${fixture.producer}: Raycaster.intersectEngine retains real ${fixture.asset} at an analytic primitive hit`, async () => {
    await withLoaded(fixture, async loaded => {
      const {raycaster} = await loadedRay(loaded);
      const hits = raycaster.intersectEngine(loaded.engine);
      assert.equal(hits.some(hit => hit.mesh === loaded.mesh), true, 'accepted engine collection must retain the loaded hit instead of returning []');
    });
  });

  test(`${fixture.producer}: mixed AssemblyBVH retains real ${fixture.asset} beside a loader-backed core control`, async () => {
    await withLoaded(fixture, async loaded => {
      const {engine, mesh, primitive} = loaded, {ray} = await loadedRay(loaded);
      // Parse the checked-in Box again through the real basic glTF loader only
      // as a positive control. The PBR subject keeps its loader-owned buffers.
      const controlModel = coreControl(engine), control = controlModel.meshes[0];
      controlModel.root.setPosition([1000, 1000, 1000]);
      engine.store.tick(false);
      const controlPositions = new Float32Array(control.geometry.vertices.length / 2);
      for (let at = 0; at < controlPositions.length; at += 3) controlPositions.set(control.geometry.vertices.subarray(at * 2, at * 2 + 3), at);
      const controlRay = triangleRay(worldPositions(controlPositions, control.matrix), control.geometry.indices);
      const assembly = await AssemblyBVH.create([mesh, control]);
      try {
        assert.equal(assembly.raycast(controlRay.origin, controlRay.direction)?.node === control, true, 'accepted mixed BVH is valid and its core control remains hittable');
        assert.equal(mesh.geometry, null, 'real loaded PBR node was not given a core Geometry');
        assert.ok(primitive.indices.length > 0);
        const hit = assembly.raycast(ray.origin, ray.direction);
        assert.equal(hit?.node === mesh, true, 'accepted mixed BVH must retain the real loaded part instead of silently returning null');
      } finally {assembly.dispose(); controlModel.dispose();}
    });
  });

  // Loader sources are discovered from selected nodes. Explicit registration
  // remains supported and must not duplicate the discovered primitive draws.
  test(`${fixture.producer}: Selection.set retains real ${fixture.asset} without silently encoding zero mask triangles`, async () => {
    await withLoaded(fixture, ({engine, model, mesh, primitive}) => {
      assert.ok([...engine.meshes.values()].every(node => node.geometry === null), 'only genuine PBR nodes are present');
      const selection = Selection.attach(engine);
      try {
        selection.set([mesh]);
        const unregisteredIndices = maskFrame(engine);
        const remove = selection.add(model);
        try {assert.equal(maskFrame(engine), primitive.indices.length, 'documented add(model) registration emits the real primitive mask');}
        finally {remove();}
        assert.equal(unregisteredIndices > 0, true, 'accepted Selection.set mesh must encode a mask instead of silently dropping its PBR triangles');
      } finally {selection.dispose();}
    });
  });
}

test('real loader primitives remain distinct on one node and Selection only masks selected nodes', async () => {
  await withLoaded(loadedPBRFixtures[0], async loaded => {
    // Extend the genuine checked-in Box document without inventing replacement
    // mesh data: both primitives retain the original accessor/buffer bytes.
    const doc=structuredClone(loaded.model.asset.doc),definition=doc.nodes[loaded.primitive.nodeIndex];
    doc.buffers=loaded.model.asset.buffers.map(bytes=>({byteLength:bytes.byteLength,uri:'data:application/octet-stream;base64,'+Buffer.from(bytes).toString('base64')}));
    doc.meshes[definition.mesh].primitives.push(structuredClone(doc.meshes[definition.mesh].primitives[0]));
    const extra=doc.nodes.length;doc.nodes.push({mesh:definition.mesh,translation:[20,0,0]});doc.scenes[doc.scene??0].nodes.push(extra);
    const model=parsePBR(loaded.engine,doc),mesh=model.nodes[loaded.primitive.nodeIndex];loaded.mesh.visible=false;loaded.engine.store.tick(false);
    try {
      assert.equal(mesh.geometry,null);assert.equal(meshTriangles(mesh).source.primitives.length,2);
      const primitive=model.primitives.find(value=>value.node===mesh),ray=triangleRay(worldPositions(primitivePositions(primitive),mesh.matrix),primitive.indices),caster=new Raycaster(ray.origin,ray.direction);
      const hits=caster.intersectMeshes(loaded.engine,[mesh]);assert.equal(hits.length%2,0);assert.ok(hits.length>=2,'both source primitives contribute hits');
      const assembly=await AssemblyBVH.create([mesh]);try{const hit=assembly.raycast(ray.origin,ray.direction);assert.equal(hit.node,mesh);assert.ok(assembly.snap(hit,{kind:'edge'}));}finally{assembly.dispose();}
      const selection=Selection.attach(loaded.engine);try{selection.set([mesh]);const count=primitive.indices.length*2;assert.equal(maskFrame(loaded.engine),count,'unselected second node is excluded');const remove=selection.add(model);try{assert.equal(maskFrame(loaded.engine),count,'explicit source is deduplicated');}finally{remove();}selection.set([]);assert.equal(maskFrame(loaded.engine),0);}finally{selection.dispose();}
      model.dispose();assert.equal(meshTriangles(mesh),null);assert.deepEqual(caster.intersectMeshes(loaded.engine,[mesh]),[]);
    }finally{if(!model.disposed)model.dispose();}
  });
});

test('active GPU deformation rejects synchronous bind-pose queries and selection prepares the live model once',async()=>{
  await withLoaded(loadedPBRFixtures[1],async loaded=>{
    const {engine,model,mesh,primitive}=loaded,{raycaster}=await loadedRay(loaded),assembly=await AssemblyBVH.create([mesh]);
    let prepared=0;const deformed=engine.gpu.createBuffer({size:primitive.vertices.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST});
    const posed=primitive.vertices.slice();for(let at=0;at<posed.length;at+=20)posed[at]+=10;
    engine.gpu.queue.writeBuffer(deformed,0,posed);primitive.deformed=deformed;
    // The shared Node fixture only installs render commands by default. Model
    // readback needs the protocol's actual buffer bytes copied into staging.
    engine.gpu.createCommandEncoder=()=>({copyBufferToBuffer(source,from,target,to,size){new Uint8Array(target.data,to,size).set(new Uint8Array(source.data,from,size));},finish(){return {};}});
    engine.gpu.queue.submit=()=>{};
    try{
      assert.throws(()=>raycaster.intersectMeshes(engine,[mesh]),/Deformed.*intersectModel/);assert.throws(()=>raycaster.intersectEngine(engine),/Deformed.*intersectModel/);
      await assert.rejects(AssemblyBVH.create([mesh]),/Deformed.*intersectModel/);assert.throws(()=>assembly.rebuild(),/Deformed.*intersectModel/);
      const posedRay=triangleRay(worldPositions(primitivePositions({vertices:posed}),mesh.matrix),primitive.indices),posedCaster=new Raycaster(posedRay.origin,posedRay.direction);
      assert.ok((await posedCaster.intersectModel(model)).some(hit=>hit.mesh===mesh),'async path reads the moved GPU output outside bind-pose bounds');
      model.prepareDeformation=context=>{assert.equal(context.device,engine.gpu);prepared++;};const selection=Selection.attach(engine);try{selection.set([mesh]);const remove=selection.add(model);try{assert.equal(maskFrame(engine),primitive.indices.length);assert.equal(prepared,1,'automatic and explicit source share one deformation callback');}finally{remove();}}finally{selection.dispose();}
      model.dispose();assert.equal(meshTriangles(mesh),null);
    }finally{primitive.deformed=undefined;deformed.destroy();assembly.dispose();}
  });
});

for(const fixture of loadedPBRFixtures){
  test(`${fixture.producer}: engine.pick discovers loader buffers, prepares once and shares core depth without add(model)`,async()=>{
    await withLoaded(fixture,async loaded=>{
      const {engine,model,mesh,primitive}=loaded,h=pickingCommands(engine),picking=Picking.attach(engine,{capture:false}),initial=model.pickingPrimitives[0].vertex;
      const current=engine.gpu.createBuffer({size:primitive.vertices.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST});engine.gpu.queue.writeBuffer(current,0,primitive.vertices);
      try{
        assert.equal(await engine.pick(64,48),mesh,'first pick requires no beauty render or explicit source');
        assert.equal(h.passes.length,2);assert.equal(h.passes[1].vertices[0],initial);assert.equal(h.passes[1].draws.length,1);
        let prepared=0;model.prepareDeformation=context=>{assert.equal(context.device,engine.gpu);h.events.push('prepare');prepared++;primitive.deformed=current;};
        const remove=picking.add(model);h.reset();assert.equal(await engine.pick(64,48),mesh);assert.equal(prepared,1);assert.equal(h.events[0],'prepare');assert.equal(h.passes[1].vertices[0],current);assert.equal(h.passes[1].draws.length,1,'automatic and explicit sources draw once');
        remove();h.reset();assert.equal(await engine.pick(64,48),mesh,'removing explicit registration retains loader discovery');assert.equal(prepared,2);
        const core=coreControl(engine);try{h.reset();assert.equal(await engine.pick(64,48),mesh);assert.ok(h.passes[0].draws.length>0,'core control was drawn before PBR');assert.equal(h.passes[0].descriptor.depthStencilAttachment.depthLoadOp,'clear');assert.equal(h.passes[1].descriptor.depthStencilAttachment.depthLoadOp,'load');assert.equal(h.passes[1].descriptor.depthStencilAttachment.view,h.passes[0].descriptor.depthStencilAttachment.view);assert.equal(h.passes[1].pipeline.depthStencil.depthCompare,'greater-equal');}finally{core.dispose();}
      }finally{picking.dispose();primitive.deformed=undefined;current.destroy();h.dispose();}
    });
  });
}

test('automatic Picking rejects removed loader nodes, model disposal and reused slots while readback is pending',async()=>{
  for(const action of ['remove-node','dispose-model','reuse-slot'])await withLoaded(loadedPBRFixtures[0],async loaded=>{
    const {engine,model,mesh}=loaded,h=pickingCommands(engine),picking=Picking.attach(engine,{capture:false});
    try{
      assert.equal(await engine.pick(64,48),mesh);let release;h.read.mapAsync=()=>new Promise(resolve=>{release=resolve;});h.reset();
      const result=picking.onPick(64,48);assert.equal(typeof release,'function','readback is pending before mutation');
      if(action==='dispose-model')model.dispose();else{const id=mesh.id;mesh.dispose();if(action==='reuse-slot'){const replacement=engine.createMesh();assert.equal(replacement.id,id);}}
      release();assert.equal(await result,null,action);
    }finally{picking.dispose();h.dispose();}
  });
});
