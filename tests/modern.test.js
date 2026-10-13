import test from 'node:test';
import assert from 'node:assert/strict';
import { TransformStore, Camera, Geometry, box, PbrMaterial, Engine, FrameGraph } from '../packages/core/dist/extension.js';
import {Kinematics,ExplodedView,parseCAD,deduplicateParts,SectionPlanes,projectAnnotation,worldAnchor} from '../packages/machinery/dist/index.js';
import {GPUParticles,PostProcessing,ToonShading,HDRRenderTarget} from '../packages/creative/dist/index.js';
import { parseGLTF } from '../packages/gltf/dist/index.js';
import { compose } from './support/matrices.js';
import {GPURenderer} from '../packages/core/dist/renderer.js';
import {CADCameraControls} from '../packages/core/dist/controls.js';
import {AssemblyIndex,vertexAnchor,faceAnchor,holeAnchor,snapAnchor,measureDistance,boxSection,industrialMaterials,industrialMaterial} from '../packages/machinery/dist/index.js';

function activate(store,id) {store.active[id]=1;for(const key of ['qw','sx','sy','sz'])store.transforms[key][id]=1;}

test('Wasm transforms match independent JS composition and share stable memory',async()=>{
  const store=await TransformStore.create(7),t=store.transforms,buffer=t.x.buffer;
  try {
    for(let id=0;id<7;id++){
      activate(store,id);const angle=(id+1)*0.2;
      t.x[id]=id-3;t.y[id]=id*0.3;t.z[id]=-id;t.qy[id]=Math.sin(angle/2);t.qw[id]=Math.cos(angle/2);t.sx[id]=id%2?-2:1;
    }
    store.tick(false);
    for(let id=0;id<7;id++){
      const expected=new Float32Array(16);compose(expected,0,[t.x[id],t.y[id],t.z[id]],[t.qx[id],t.qy[id],t.qz[id],t.qw[id]],[t.sx[id],t.sy[id],t.sz[id]]);
      for(let i=0;i<16;i++)assert.ok(Math.abs(expected[i]-store.matrices[id*16+i])<1e-6);
    }
    for(let i=0;i<100;i++)store.tick(false);assert.equal(t.x.buffer,buffer);
  }finally{store.dispose();}
});
test('Wasm SIMD culling handles four-lane blocks, remainder and touching spheres',async()=>{
  const store=await TransformStore.create(7);
  try{
    for(let id=0;id<7;id++){activate(store,id);store.transforms.x[id]=id-2;store.bounds[id*4+3]=1;}
    store.planes[0]=-1;store.planes[3]=1;store.tick();assert.deepEqual([...store.visible],[1,1,1,1,1,0,0]);
    store.active[2]=0;store.tick();assert.equal(store.visible[2],0);
  }finally{store.dispose();}
});
test('Nested parents work regardless of slot order; cycles and invalid writes reject atomically',async()=>{
  const store=await TransformStore.create(3);
  try{
    activate(store,0);activate(store,2);store.parents[0]=2;store.transforms.x[2]=3;store.transforms.x[0]=2;store.tick(false);assert.equal(store.matrices[12],5);
    const previous=store.matrices.slice();store.parents[2]=0;assert.throws(()=>store.tick(false),/Invalid transform/);assert.deepEqual(store.matrices,previous);
    store.parents[2]=-1;store.transforms.qw[0]=0;assert.throws(()=>store.tick(false),/Invalid transform/);
  }finally{store.dispose();}assert.throws(()=>store.tick(),/disposed/);
});
test('Engine instances isolate Wasm memory and capacity is bounded',async()=>{
  const a=await TransformStore.create(1),b=await TransformStore.create(1);
  try{a.transforms.x[0]=42;assert.equal(b.transforms.x[0],0);assert.notEqual(a.transforms.x.buffer,b.transforms.x.buffer);}finally{a.dispose();b.dispose();}
  await assert.rejects(TransformStore.create(0),/Capacity/);await assert.rejects(TransformStore.create(100001),/Capacity/);
});
test('Cached hierarchy preserves late-error atomicity and rejects deep cached parents and cycles',async()=>{
  const store=await TransformStore.create(65);try{for(let i=0;i<65;i++){activate(store,i);store.transforms.x[i]=1;}for(let i=1;i<64;i++)store.parents[i]=i-1;store.tick(false);assert.equal(store.matrices[63*16+12],64);const matrices=store.matrices.slice(),visible=store.visible.slice();store.parents[64]=63;assert.throws(()=>store.tick(false),/Invalid/);assert.deepEqual(store.matrices,matrices);assert.deepEqual(store.visible,visible);store.parents[64]=-1;store.bounds[64*4+3]=-1;assert.throws(()=>store.tick(false),/Invalid/);assert.deepEqual(store.matrices,matrices);store.bounds[64*4+3]=0;store.hidden[0]=1;store.tick(false);assert.equal(store.visible[63],0);assert.equal(store.visible[64],1);store.parents[0]=63;assert.throws(()=>store.tick(false),/Invalid/);store.parents[0]=-1;store.hidden[0]=0;store.transforms.x[0]=2;store.tick(false);assert.equal(store.matrices[63*16+12],65);assert.equal(store.visible[63],1);
  }finally{store.dispose();}
});
test('Both camera depth conventions project near/far correctly and agree on visibility',()=>{
  const camera=new Camera({position:[0,0,5],near:1,far:10});
  for(const gpu of [false,true]){camera.update(1,gpu);const m=camera.matrix,project=z=>(m[10]*z+m[14])/(m[11]*z+m[15]);assert.ok(Math.abs(project(4)-(gpu?1:-1))<1e-6);assert.ok(Math.abs(project(-5)-(gpu?0:1))<1e-6);}
  camera.position=[0,0,0];assert.throws(()=>camera.update(1,false),/at target/);
});
test('Geometry validates indices and box winding; material colors use linear RGB',()=>{
  const geometry=box(2,4,6);assert.equal(geometry.indices.length,36);assert.ok(Math.abs(geometry.bounds[3]-Math.sqrt(14))<1e-6);
  for(let i=0;i<36;i+=3){const [a,b,c]=geometry.indices.slice(i,i+3),v=geometry.vertices;const ux=v[b*6]-v[a*6],uy=v[b*6+1]-v[a*6+1],uz=v[b*6+2]-v[a*6+2],vx=v[c*6]-v[a*6],vy=v[c*6+1]-v[a*6+1],vz=v[c*6+2]-v[a*6+2];assert.ok((uy*vz-uz*vy)*v[a*6+3]+(uz*vx-ux*vz)*v[a*6+4]+(ux*vy-uy*vx)*v[a*6+5]>0);}
  assert.throws(()=>new Geometry([0,0,0,1,0,0,0,1,0],[0,0,1,0,0,1,0,0,1],[0,1,3]),{name:'RangeError',message:'Invalid geometry'});
  assert.throws(()=>box(-1),/positive/);assert.throws(()=>new PbrMaterial({roughness:NaN}),{name:'RangeError',message:'Invalid material'});
  assert.ok(Math.abs(new PbrMaterial({color:'#808080'}).data[0]-0.21586)<1e-4);
});

async function headlessEngine(capacity=8){const store=await TransformStore.create(capacity);const resources=new Set();const renderer={backend:'webgl2',add:g=>resources.add(g),remove:g=>resources.delete(g),render(){},dispose(){resources.clear();}};const engine=new Engine({width:200,height:200,clientWidth:200,clientHeight:200},store,renderer,undefined,null);return {engine,resources};}

test('GPU picks update scene state without a color frame and optional pickers retain stale-slot guards',async()=>{
 const store=await TransformStore.create(4);let frames=0,updates=0,finish;
 const renderer={backend:'webgpu',add(){},remove(){},render(){frames++;},dispose(){},async pick(_camera,_light,batches){assert.equal([...batches][0].instances[12],Math.fround(.1));return 0;}};
 const engine=new Engine({width:200,height:200,clientWidth:200,clientHeight:200},store,renderer,{position:[0,0,4]},null);
 try {
  const mesh=engine.createMesh().setGeometry(box());mesh.position.x=.1;
  engine.use({name:'update',setup(){},onPreUpdate(delta){assert.equal(delta,0);updates++;}});
  assert.equal(await engine.pick(100,100),mesh);assert.equal(frames,0);assert.equal(updates,1);
  engine.use({name:'picker',setup(){},onPick(){return new Promise(resolve=>{finish=resolve;});}});
  const pending=engine.pick(100,100);mesh.dispose();engine.createMesh();finish(mesh);assert.equal(await pending,null);assert.equal(frames,0);
 } finally {engine.dispose();}
});

test('Entity reuse rejects stale refs and shared geometry retires once',async()=>{
  const {engine,resources}=await headlessEngine(2);
  try{const g=box(),a=engine.createMesh().setGeometry(g),b=engine.createMesh(a).setGeometry(g);assert.equal(resources.size,1);engine.render();assert.equal(engine.stats.drawCalls,1);assert.throws(()=>engine.createMesh(),/capacity/);a.dispose();assert.equal(engine.store.parents[b.id],-1);const c=engine.createMesh();assert.equal(c.id,a.id);assert.throws(()=>{a.position.x=7;},/disposed/);b.dispose();assert.equal(resources.size,0);}finally{engine.dispose();}assert.equal(engine.store.active.every(v=>v===0),true);
});

function triangle(){const positions=new Float32Array([-1,-1,0,1,-1,0,0,1,0]),normals=new Float32Array([0,0,1,0,0,1,0,0,1]);const bytes=new Uint8Array(72);bytes.set(new Uint8Array(positions.buffer));bytes.set(new Uint8Array(normals.buffer),36);return {asset:{version:'2.0'},buffers:[{byteLength:72,uri:`data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}`}],bufferViews:[{buffer:0,byteLength:36},{buffer:0,byteOffset:36,byteLength:36}],accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3'},{bufferView:1,componentType:5126,count:3,type:'VEC3'}],meshes:[{primitives:[{attributes:{POSITION:0,NORMAL:1},material:0}]}],materials:[{pbrMetallicRoughness:{baseColorFactor:[0.9,0.3,0.1,1],metallicFactor:0,roughnessFactor:0.6}}],nodes:[{mesh:0,translation:[2,0,0]}],scenes:[{nodes:[0]}],scene:0};}
test('glTF loader preserves hierarchy and rolls back unsupported materials',async()=>{
  const {engine,resources}=await headlessEngine();
  try{const doc=triangle(),model=parseGLTF(engine,doc);assert.equal(model.meshes.length,1);engine.render();assert.equal(model.meshes[0].matrix[12],2);model.dispose();assert.equal(engine.meshes.size,0);assert.equal(resources.size,0);doc.materials[0].alphaMode='BLEND';assert.throws(()=>parseGLTF(engine,doc),/opaque/);assert.equal(engine.meshes.size,0);assert.equal(resources.size,0);doc.buffers[0].byteLength=1000;assert.throws(()=>parseGLTF(engine,doc),/Truncated/);}finally{engine.dispose();}
});
test('GLB, generated normals, reflected matrix nodes and shared primitives import; malformed input rolls back',async()=>{
  const {engine,resources}=await headlessEngine(10);
  try{
    const doc=triangle(),binary=Buffer.from(doc.buffers[0].uri.split(',')[1],'base64');delete doc.buffers[0].uri;delete doc.meshes[0].primitives[0].attributes.NORMAL;
    doc.nodes=[{name:'Axis_1',mesh:0,matrix:[-2,0,0,0,0,3,0,0,0,0,4,0,2,0,0,1],children:[1]},{mesh:0,translation:[1,0,0]}];
    const json=Buffer.from(JSON.stringify(doc)),padded=Buffer.alloc(Math.ceil(json.length/4)*4,32);json.copy(padded);
    const glb=Buffer.alloc(28+padded.length+binary.length),header=new DataView(glb.buffer,glb.byteOffset,glb.byteLength);
    for(const [offset,value]of [[0,0x46546c67],[4,2],[8,glb.length],[12,padded.length],[16,0x4e4f534a],[20+padded.length,binary.length],[24+padded.length,0x004e4942]])header.setUint32(offset,value,true);
    padded.copy(glb,20);binary.copy(glb,28+padded.length);
    const model=parseGLTF(engine,glb);engine.render({culling:false});assert.equal(model.nodes.find(n=>n.name==='Axis_1').matrix[0],-2);assert.equal(model.meshes[1].matrix[12],0);
    assert.equal(model.meshes[0].geometry,model.meshes[1].geometry);assert.equal(resources.size,1);assert.ok(model.meshes[0].geometry.vertices[5]>0);model.dispose();assert.equal(resources.size,0);
    header.setUint32(8,glb.length+4,true);assert.throws(()=>parseGLTF(engine,glb),/header/);
    doc.nodes[0].matrix[4]=1;assert.throws(()=>parseGLTF(engine,doc,[binary]),/Sheared/);assert.equal(engine.meshes.size,0);assert.equal(resources.size,0);
    doc.nodes=[{mesh:0}];doc.accessors[0].byteOffset=4;assert.throws(()=>parseGLTF(engine,doc,[binary]),/bounds/);assert.equal(engine.meshes.size,0);
    delete doc.accessors[0].byteOffset;doc.accessors[0].sparse={};assert.throws(()=>parseGLTF(engine,doc,[binary]),/accessor/);
  }finally{engine.dispose();}
  const {engine:small,resources:smallResources}=await headlessEngine(2);
  try{assert.throws(()=>parseGLTF(small,triangle()),/capacity/);assert.equal(small.meshes.size,0);assert.equal(smallResources.size,0);}finally{small.dispose();}
});
test('Float32 transform validation is atomic; failed and recursive plugin cleanup retires every resource',async()=>{
  const {engine,resources}=await headlessEngine();const mesh=engine.createMesh().setGeometry(box());
  assert.throws(()=>mesh.setScale([2,1e-99,3]),/nonzero/);assert.equal(mesh.scale.x,1);assert.throws(()=>{mesh.scale.y=1e-99;},/transform/);
  assert.throws(()=>mesh.setPosition(['2',0,0]),/finite/);engine.createMesh().setGeometry(mesh.geometry).setMaterial(mesh.material);engine.render();mesh.material.data[4]=0;assert.throws(()=>engine.render(),/material/);mesh.material.data[4]=0.5;
  let secondCleaned=false;
  engine.use({name:'first',setup(){},dispose(){engine.dispose();assert.throws(()=>engine.createMesh(),/disposed/);throw new Error('cleanup failure');}});
  engine.use({name:'second',setup(){},dispose(){secondCleaned=true;}});
  assert.throws(()=>engine.dispose(),/cleanup failure/);assert.ok(secondCleaned);assert.ok(engine.disposed);assert.equal(engine.meshes.size,0);assert.equal(resources.size,0);assert.ok(engine.store.active.every(v=>v===0));engine.dispose();
});
test('Frame graph orders passes, prevents edits during execution, and releases plugin passes',async()=>{
  const graph=new FrameGraph(),order=[],context={draw:()=>order.push('main')};
  graph.withOwner('custom',()=>{graph.add({name:'late',order:10,execute:()=>order.push('late')});graph.add({name:'early',order:-10,execute:()=>order.push('early')});});
  graph.execute(context);assert.deepEqual(order,['early','main','late']);graph.removeOwner('custom');order.length=0;graph.execute(context);assert.deepEqual(order,['main']);
  const remove=graph.add({name:'bad',order:5,execute:()=>graph.add({name:'nested',order:0,execute(){}})});assert.throws(()=>graph.execute(context),/Graph executing/);remove();
  const {engine}=await headlessEngine();let cleaned=0;
  try{assert.throws(()=>engine.use({name:'bad',setup(){},registerPasses(g){g.add({name:'incomplete',order:1,execute(){}});throw new Error('setup failure');},dispose(){cleaned++;}}),/setup failure/);assert.equal(cleaned,1);engine.frameGraph.add({name:'incomplete',order:1,execute(){}});
    const plugin={name:'owned',setup(){},dispose(){cleaned++;}};engine.use(plugin);assert.throws(()=>engine.use(plugin),/Invalid plugin/);engine.removePlugin('owned');assert.equal(cleaned,2);
  }finally{engine.dispose();}
});
test('Machinery pack enforces limits and controls explode positions; particles validate and require WebGPU',async()=>{
  const {engine}=await headlessEngine();
  try{const node=engine.createMesh(),joints=new Kinematics([{node,axis:'y',min:-1,max:1,velocity:2}]);engine.use(joints);engine.render({delta:1});assert.equal(node.rotation.y,1);assert.throws(()=>joints.setAngle(0,2),/limits/);
    const explode=new ExplodedView([{node,offset:[4,0,0]}]);engine.use(explode);explode.amount=0.5;engine.render();assert.equal(node.position.x,2);explode.amount=1.1;assert.throws(()=>engine.render(),/amount/);engine.removePlugin(explode.name);
    const huge=engine.createMesh().setPosition([3e38,0,0]),overflow=new ExplodedView([{node:huge,offset:[3e38,0,0]}]);engine.use(overflow);overflow.amount=1;const saved=huge.position.x;assert.throws(()=>overflow.onPreUpdate(),/position/);assert.equal(huge.position.x,saved);overflow.amount=0;huge.dispose();const reused=engine.createMesh();assert.throws(()=>overflow.onPreUpdate(),/disposed/);assert.equal(reused.position.x,0);engine.removePlugin(overflow.name);
    assert.throws(()=>new GPUParticles({count:100001}),/options/);assert.throws(()=>engine.use(new GPUParticles({count:10})),/WebGPU/);
  }finally{engine.dispose();}
});

function asciiSTL(triangles){return `solid fixture\n${triangles.map(points=>`facet normal 0 0 1\nouter loop\n${points.map(p=>`vertex ${p.join(' ')}`).join('\n')}\nendloop\nendfacet`).join('\n')}\nendsolid fixture`;}
test('CAD welding preserves hard normals, binary STL imports, OBJ concave groups deduplicate and failures roll back',async()=>{
  const {engine,resources}=await headlessEngine(16);
  try{
    const square=[[[0,0,0],[1,0,0],[1,1,0]],[[0,0,0],[1,1,0],[0,1,0]]];const model=parseCAD(engine,asciiSTL(square),'stl'),g=model.meshes[0].geometry;assert.equal(g.vertices.length/6,4);assert.equal(g.indices.length,6);model.dispose();
    const cube=box(),bytes=new Uint8Array(84+12*50),view=new DataView(bytes.buffer);view.setUint32(80,12,true);for(let f=0;f<12;f++)for(let i=0;i<9;i++)view.setFloat32(84+f*50+12+i*4,cube.vertices[cube.indices[f*3+Math.floor(i/3)]*6+i%3],true);
    const binary=parseCAD(engine,bytes,'stl');assert.equal(binary.meshes[0].geometry.vertices.length/6,24,'Hard edges were smoothed');assert.equal(binary.meshes[0].geometry.indices.length,36);binary.dispose();
    const obj='v 0 0 0\nv 2 0 0\nv 2 1 0\nv 1 1 0\nv 1 2 0\nv 0 2 0\ng first\nf 1 2 3 4 5 6\ng repeat\nf -6 -5 -4 -3 -2 -1';const assembly=parseCAD(engine,obj,'obj');assert.equal(assembly.meshes.length,2);assert.equal(assembly.meshes[0].geometry,assembly.meshes[1].geometry);assert.equal(resources.size,1);assert.deepEqual(deduplicateParts(assembly.meshes),{parts:2,unique:1});assert.equal(assembly.meshes[0].geometry.indices.length,12);assembly.dispose();
    for(const [input,format] of [['v 0 0 0\nf 1 2 3','obj'],[asciiSTL([[[0,0,0],[0,0,0],[1,0,0]]]),'stl'],[asciiSTL([[[0,0,0],[0.000001,0,0],[0,1,0]]]),'stl']])assert.throws(()=>parseCAD(engine,input,format));assert.equal(engine.meshes.size,0);assert.equal(resources.size,0);
    const limited=await headlessEngine(1);try{assert.throws(()=>parseCAD(limited.engine,asciiSTL(square),'stl'),/capacity/);assert.equal(limited.engine.meshes.size,0);}finally{limited.engine.dispose();}
  }finally{engine.dispose();}
});
test('Machinery prismatic, gears and slider-crank are bounded and failed coupling writes are atomic',async()=>{
  const {engine}=await headlessEngine();try{const shaft=engine.createMesh(),gear=engine.createMesh(),slider=engine.createMesh().setPosition([10,0,0]);const k=new Kinematics([{node:shaft,axis:'z',min:-Math.PI,max:Math.PI},{node:gear,axis:'z',min:-1,max:1},{node:slider,axis:'x',kind:'prismatic',min:1,max:3}],{gears:[{source:0,target:1,ratio:-2}],pistons:[{source:0,target:2,radius:0.5,rodLength:2}]});engine.use(k);k.setValue(0,0);assert.equal(slider.position.x,12.5);k.setAngle(0,0.4);assert.ok(Math.abs(gear.rotation.z+0.8)<1e-6);const saved=[shaft.rotation.z,gear.rotation.z,slider.position.x];assert.throws(()=>k.setAngle(0,1),/Coupling/);assert.deepEqual([shaft.rotation.z,gear.rotation.z,slider.position.x],saved);assert.throws(()=>k.setValue(1,0),/coupled/);assert.throws(()=>k.setAngle(2,0),/Prismatic/);}finally{engine.dispose();}
});
test('Bounded IK and distance constraints solve reachable goals and report unreachable residuals',async()=>{
  const {engine}=await headlessEngine();try{const a=engine.createMesh(),b=engine.createMesh(a).setPosition([1,0,0]),tip=engine.createMesh(b).setPosition([1,0,0]);const target={node:tip,target:[1,1,0]};const k=new Kinematics([{node:a,axis:'z',min:-Math.PI,max:Math.PI},{node:b,axis:'z',min:-Math.PI,max:Math.PI}],{targets:[target],iterations:100});engine.use(k);const result=k.solve();assert.ok(result.converged,JSON.stringify(result));assert.ok(Math.hypot(tip.matrix[12]-1,tip.matrix[13]-1)<0.002);target.target=[4,4,0];assert.equal(k.solve().converged,false);assert.ok(k.result.error>1);engine.removePlugin(k.name);
    const slider=engine.createMesh(),anchor=engine.createMesh().setPosition([2,0,0]);const distance=new Kinematics([{node:slider,axis:'x',kind:'prismatic',min:0,max:4}],{distances:[{a:slider,b:anchor,length:1}]});engine.use(distance);assert.ok(distance.solve().converged);assert.ok(Math.abs(slider.position.x-1)<0.002);
  }finally{engine.dispose();}
});
test('240 coupled shafts write flat Wasm Euler state and retain atomic rollback without per-tick snapshots',async()=>{
  const {engine}=await headlessEngine(250);try{const nodes=Array.from({length:241},()=>engine.createMesh()),joints=nodes.map(node=>({node,axis:'z',min:-1,max:1})),gears=nodes.slice(1).map((_,i)=>({source:0,target:i+1,ratio:i===239?-2:1})),k=new Kinematics(joints,{gears});engine.use(k);const snapshot=k.previous;
    for(let i=0;i<100;i++){k.setAngle(0,0.4);k.onPreUpdate(1/60);engine.store.tick(false);}assert.equal(k.previous,snapshot);for(let i=1;i<240;i++){assert.equal(nodes[i].euler.buffer,engine.store.rotations.buffer);assert.ok(Math.abs(nodes[i].rotation.z-0.4)<1e-6);assert.ok(Math.abs(nodes[i].matrix[0]-Math.cos(0.4))<1e-6);}assert.ok(Math.abs(nodes[240].rotation.z+0.8)<1e-6);assert.throws(()=>k.setAngle(0,0.8),/Coupling/);assert.ok(Math.abs(nodes[0].rotation.z-0.4)<1e-6);assert.throws(()=>k.onPreUpdate(NaN),/delta/);assert.throws(()=>new Kinematics(joints,{targets:[{node:nodes[0],target:[0,0,0]}]}),/solver limits/);engine.removePlugin(k.name);assert.ok(engine.store.constrained.every(v=>v===0));
  }finally{engine.dispose();}
});
test('Overlay projection follows world hierarchy; GPU extension boundaries validate before attachment',async()=>{
  const {engine}=await headlessEngine();try{const parent=engine.createMesh().setPosition([1,0,0]),node=engine.createMesh(parent).setPosition([0,1,0]);engine.render();assert.deepEqual(worldAnchor({node,point:[0,0,0]}),[1,1,0]);const camera=new Camera({position:[0,0,4]});camera.update(1,true);assert.deepEqual(projectAnnotation(camera,[0,0,0],200,200),[100,100]);assert.equal(projectAnnotation(camera,[0,0,5],200,200),null);assert.throws(()=>new SectionPlanes({planes:[[0,0,0,1]]}),/plane/);assert.throws(()=>engine.use(new SectionPlanes({planes:[[0,0,1,0]]})),/WebGPU/);assert.throws(()=>new GPUParticles({obstacles:[{kind:'sphere',center:[0,0,0],radius:-1}]}),/obstacle/);assert.throws(()=>new GPUParticles({texture:{width:1,height:1,data:new Uint8Array(3)}}),/texture/);assert.throws(()=>new ToonShading({bands:1}),/toon/);assert.throws(()=>new PostProcessing({bloom:-1}),/post/);assert.throws(()=>new HDRRenderTarget({features:new Set(),limits:{maxTextureDimension2D:4096}},0,1),/size/);}finally{engine.dispose();}
});

test('Interrupted GPU encoding skips submission and future canvas acquisition; unrelated errors remain visible',()=>{
  const saved=globalThis.GPUBufferUsage,savedTexture=globalThis.GPUTextureUsage;globalThis.GPUBufferUsage={UNIFORM:64,COPY_DST:8};globalThis.GPUTextureUsage={RENDER_ATTACHMENT:16};let submits=0,acquires=0,recoveries=0;
  const buffer={destroy(){}},texture={createView:()=>({}),destroy(){}},device={createBuffer:()=>buffer,createBindGroup:()=>({}),lost:new Promise(()=>{}),addEventListener(){},destroy(){},createTexture:()=>texture,createCommandEncoder:()=>({finish:()=>({})}),queue:{writeBuffer(){},submit(){submits++;}}};
  const context={configure(){},unconfigure(){},getCurrentTexture(){acquires++;return texture;}},camera=new Camera(),graph=new FrameGraph();graph.add({name:'loss',order:-1,execute(){throw new DOMException('Device destroyed','InvalidStateError');}});
  try{const renderer=new GPURenderer({width:1,height:1},device,context,'bgra8unorm',{getBindGroupLayout:()=>({})},{multisample:{count:4},depthStencil:{format:'depth32float'}});renderer.onLost=()=>recoveries++;const light={direction:new Float32Array(4),radiance:new Float32Array(4)};renderer.render(camera,light,[],graph,0);renderer.render(camera,light,[],graph,0);assert.equal(submits,0);assert.equal(acquires,1);assert.equal(recoveries,1);renderer.dispose();
    const other=new GPURenderer({width:1,height:1},device,context,'bgra8unorm',{getBindGroupLayout:()=>({})},{multisample:{count:4},depthStencil:{format:'depth32float'}}),bad=new FrameGraph();bad.add({name:'bug',order:-1,execute(){throw new Error('Bad plugin');}});assert.throws(()=>other.render(camera,light,[],bad,0),/Bad plugin/);other.dispose();
  }finally{if(saved===undefined)delete globalThis.GPUBufferUsage;else globalThis.GPUBufferUsage=saved;if(savedTexture===undefined)delete globalThis.GPUTextureUsage;else globalThis.GPUTextureUsage=savedTexture;}
});
test('Reusable frame context resets plugin overrides and cap passes load beauty depth on every frame',()=>{
  const oldBuffer=globalThis.GPUBufferUsage,oldTexture=globalThis.GPUTextureUsage;globalThis.GPUBufferUsage={UNIFORM:1,COPY_DST:2};globalThis.GPUTextureUsage={RENDER_ATTACHMENT:1};
  const calls=[],pipeline={getBindGroupLayout:()=>({})},camera=new Camera(),lighting={direction:new Float32Array(4),radiance:new Float32Array(4)};let frame=0,passContext;
  const device={createShaderModule:()=>({}),createRenderPipeline:()=>pipeline,createBuffer:()=>({destroy(){}}),createBindGroup:()=>({}),createTexture:d=>({createView:()=> d.format==='bgra8unorm'?'core-color':'core-depth',destroy(){}}),lost:new Promise(()=>{}),addEventListener(){},destroy(){},queue:{writeBuffer(){},submit(){}},createCommandEncoder:()=>({finish:()=>({}),beginRenderPass(d){calls.push({color:d.colorAttachments[0].view,load:d.colorAttachments[0].loadOp,depth:d.depthStencilAttachment.view,depthLoad:d.depthStencilAttachment.depthLoadOp,stencilLoad:d.depthStencilAttachment.stencilLoadOp});return {setPipeline(){},setBindGroup(){},end(){}};}})},canvas={width:10,height:10},context={configure(){},unconfigure(){},getCurrentTexture:()=>({createView:()=> 'canvas-'+(++frame)})},renderer=new GPURenderer(canvas,device,context,'bgra8unorm',pipeline,{multisample:{count:4},depthStencil:{format:'depth32float-stencil8'}}),graph=new FrameGraph();
  const remove=graph.add({name:'hdr',order:-1,execute(c){passContext=c;c.color='hdr-color';c.depth='hdr-depth';c.bindings.push({binding:1,resource:{buffer:{}}});const draw=c.draw;c.draw=options=>draw(options);}}),cap=graph.add({name:'cap',order:5,execute:c=>c.draw({clear:false,stencilClear:0})});try{renderer.render(camera,lighting,[],graph,0);remove();cap();renderer.render(camera,lighting,[],graph,0);assert.deepEqual(calls,[{color:'hdr-color',load:'clear',depth:'hdr-depth',depthLoad:'clear',stencilLoad:'clear'},{color:'hdr-color',load:'load',depth:'hdr-depth',depthLoad:'load',stencilLoad:'clear'},{color:'core-color',load:'load',depth:'core-depth',depthLoad:'load',stencilLoad:undefined},{color:'core-color',load:'clear',depth:'core-depth',depthLoad:'clear',stencilLoad:'clear'},{color:'core-color',load:'load',depth:'core-depth',depthLoad:'load',stencilLoad:undefined}]);assert.equal(passContext.bindings.length,0);}finally{renderer.dispose();if(oldBuffer===undefined)delete globalThis.GPUBufferUsage;else globalThis.GPUBufferUsage=oldBuffer;if(oldTexture===undefined)delete globalThis.GPUTextureUsage;else globalThis.GPUTextureUsage=oldTexture;}
});

test('Particle texture blueprints copy Buffer and native ImageData pixel arrays',()=>{
  for(const data of [Buffer.from([255,0,0,255]),new Uint8ClampedArray([255,0,0,255])]){const p=new GPUParticles({count:1,texture:{width:1,height:1,data}});data[0]=0;assert.equal(p.sprite.data[0],255);assert.ok(p.sprite.data instanceof Uint8Array);p.dispose();}
});

test('Rust limits clamp direct writes, parent visibility cascades and reused slots reset masks',async()=>{
  const {engine}=await headlessEngine();try {const root=engine.createMesh(),joint=engine.createMesh(root),leaf=engine.createMesh(joint).setGeometry(box());const k=new Kinematics([{node:joint,axis:'z',min:-0.5,max:0.5},{node:joint,axis:'x',kind:'prismatic',min:0,max:2}]);engine.use(k);joint.rotation.z=5;joint.position.x=9;engine.store.tick(false);assert.equal(joint.rotation.z,0.5);assert.equal(joint.position.x,2);assert.ok(Math.abs(joint.matrix[0]-Math.cos(0.5))<1e-6);root.visible=false;engine.store.tick(false);assert.equal(engine.store.visible[leaf.id],0);joint.visible=false;root.visible=true;engine.store.tick(false);assert.equal(engine.store.visible[leaf.id],0);joint.visible=true;engine.store.tick(false);assert.equal(engine.store.visible[leaf.id],1);joint.dispose();const reused=engine.createMesh();assert.equal(reused.visible,true);assert.equal(engine.store.constrained[reused.id],0);}finally{engine.dispose();}
});
test('Assembly names, tags, subtrees and refresh handle renames and disposal',async()=>{
 const {engine}=await headlessEngine();try{const root=engine.createMesh(),a=engine.createMesh(root),b=engine.createMesh();a.name='Roller_Assembly_1';b.name='Roller_Assembly_2';const query=new AssemblyIndex(engine);query.tag(a,'roller');assert.throws(()=>query.tag(a,42),/tag/);assert.deepEqual(query.findChildrenByName('Roller_Assembly_*',root),[a]);assert.deepEqual(query.findByTag('roller'),[a]);a.name='Drive[1]';query.refresh();assert.deepEqual(query.findChildrenByName('Drive[1]'),[a]);engine.store.parents[a.id]=a.id;assert.deepEqual(query.findChildrenByName('Drive[1]',root),[]);engine.store.parents[a.id]=root.id;query.setSubtreeVisible(root,false);engine.render();assert.equal(engine.store.visible[a.id],0);a.dispose();query.refresh();assert.deepEqual(query.findByTag('roller'),[]);}finally{engine.dispose();}
});
test('Metrology snaps vertices, triangle midpoints and circular holes in transformed world space',async()=>{
 const {engine}=await headlessEngine();try{const node=engine.createMesh().setGeometry(new Geometry([1,0,0,0,1,0,-1,0,0,0,-1,0],[0,0,1,0,0,1,0,0,1,0,0,1],[0,1,2,0,2,3])).setPosition([2,3,0]).setScale([2,2,2]);engine.render();const a=vertexAnchor(node,0),b=vertexAnchor(node,2);assert.equal(measureDistance(a,b),4000);assert.ok(Math.abs(measureDistance(a,b,'in')-4/0.0254)<1e-9);assert.deepEqual(worldAnchor(holeAnchor(node,[0,1,2,3])),[2,3,0]);assert.deepEqual(worldAnchor(faceAnchor(node,0)),[2,3+2/3,0]);assert.deepEqual(snapAnchor(node,[4.01,3,0],{maxDistance:0.02})?.point,[1,0,0]);assert.equal(snapAnchor(node,[10,10,0],{maxDistance:0.1}),null);assert.throws(()=>holeAnchor(node,[0,0,0]),/collinear/);assert.throws(()=>vertexAnchor(node,9),/vertex/);}finally{engine.dispose();}
});
test('CAD controls orbit an arbitrary pivot, pan, smooth zoom, fit portrait bounds and release listeners',()=>{
 const listeners=new Map(),element={clientHeight:400,style:{touchAction:'auto'},addEventListener:(n,fn)=>listeners.set(n,fn),removeEventListener:n=>listeners.delete(n),hasPointerCapture:()=>false},camera=new Camera({position:[4,3,7],target:[2,1,3],near:0.001,far:10000}),controls=new CADCameraControls(camera,element);const distance=Math.hypot(...camera.position.map((v,i)=>v-camera.target[i]));controls.orbit(0.4,0.2);assert.ok(Math.abs(Math.hypot(...camera.position.map((v,i)=>v-camera.target[i]))-distance)<1e-10);controls.pan(0.1,-0.1);assert.ok(Math.abs(Math.hypot(...camera.position.map((v,i)=>v-camera.target[i]))-distance)<1e-10);listeners.get('wheel')({preventDefault(){},deltaY:100,deltaMode:0});controls.update(0.1);assert.ok(Math.hypot(...camera.position.map((v,i)=>v-camera.target[i]))>distance);camera.fitToBoundingBox([-3,-1,-1],[3,1,1],{aspect:0.5,duration:0.2});camera.advance(0.2);camera.update(0.5,true);for(const x of [-3,3])for(const y of [-1,1])for(const z of [-1,1]){const m=camera.matrix,w=m[3]*x+m[7]*y+m[11]*z+m[15];assert.ok(Math.abs((m[0]*x+m[4]*y+m[8]*z+m[12])/w)<1);assert.ok(Math.abs((m[1]*x+m[5]*y+m[9]*z+m[13])/w)<1);}controls.dispose();assert.equal(listeners.size,0);assert.equal(element.style.touchAction,'auto');
});
test('Reversed float depth separates sub-millimeter surfaces at industrial range; presets and six-plane boxes validate',()=>{
 const camera=new Camera({position:[0,0,0],target:[0,0,-1],near:0.001,far:10000});camera.update(1,true);const m=camera.matrix,depth=z=>Math.fround((m[10]*z+m[14])/-z);assert.notEqual(depth(-500),depth(-500.0001));assert.equal(boxSection([-1,-2,-3],[1,2,3]).length,6);assert.throws(()=>boxSection([1,0,0],[0,1,1]),/box/);assert.equal(industrialMaterials.neoprene.roughness,0.85);assert.equal(industrialMaterial('galvanizedZinc').data[5],Math.fround(0.95));assert.ok(Object.isFrozen(industrialMaterials.machinedSteel));
});
test('Frozen public entry exposes portable API; device and Wasm access use the explicit extension entry',async()=>{
 const api=await import('../packages/core/dist/index.js'),react=await import('../packages/react/dist/index.js');assert.deepEqual(Object.keys(api).sort(),['CADCameraControls','Camera','Engine','EngineKernel','Geometry','PbrMaterial','box'].sort());assert.equal(api.EngineKernel,api.Engine);assert.deepEqual(Object.keys(react).sort(),['BoxGeometry','Canvas','Environment','GeometryResource','MargoCanvas','MargoContext','Mesh','Model','OrbitControls','PbrMaterial','useFrame','useMargo','useMargoStage'].sort());const graph=new FrameGraph();graph.add({name:'prepare',order:-1,execute(){},prepare(){assert.throws(()=>graph.add({name:'edit',order:1,execute(){}}),/executing/);}});graph.prepare({});
});
