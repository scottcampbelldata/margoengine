import test from 'node:test';
import assert from 'node:assert/strict';
import { CubeProjectorLights, MAX_CUBE_PROJECTORS, MAX_CUBE_PROJECTOR_TEXELS } from '../dist/cube-projector.js';
import { Clustered } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
const cube=()=>({faces:Array.from({length:6},(_,i)=>({width:1,height:1,data:new Uint8Array([i*30,0,0,255])}))});

test('cube entries copy six ordered faces, deduplicate and normalize rotations atomically',()=>{
 const effect=new CubeProjectorLights({lights:new Clustered()}),image=cube();
 effect.setCubes([image,{image,rotation:[0,2,0,2]},null]);
 assert.equal(effect.cubeWords[0],3);assert.equal(effect.cubeWords[1],1);
 const before=effect.cubeWords.slice();image.faces[0].data[0]=123;
 assert.deepEqual(effect.cubeWords,before,'pixels copied');
 const floats=new Float32Array(effect.cubeWords.buffer);
 assert.ok(Math.abs(floats[68+8+5]-Math.SQRT1_2)<1e-7);
 for(const bad of [{faces:[]},{faces:cube().faces.slice(0,5)}, {image:cube(),rotation:[0,0,0,0]},
   {image:cube(),colorSpace:'p3'},{faces:cube().faces.map((p,i)=>i===3?{...p,height:2}:p)}]){
   assert.throws(()=>effect.setCubes([bad]));assert.deepEqual(effect.cubeWords,before);
 }
 assert.throws(()=>effect.setCubes(Array.from({length:17},cube)),/16 images/);
 assert.equal(MAX_CUBE_PROJECTORS,16);assert.equal(MAX_CUBE_PROJECTOR_TEXELS,16777216);
 effect.setCubes([{image:cube(),rotation:[1e308,1e308,1e308,1e308]}]);
 assert.deepEqual([...new Float32Array(effect.cubeWords.buffer).subarray(72,76)],[0.5,0.5,0.5,0.5]);
});

test('cube-only and mixed spot cookies share the hook, uploads restore, empty and disposed release it',()=>{
 const h=optionalGPU(),lights=new Clustered({grid:[1,1,1]});h.engine.use(lights);
 const cookies=CubeProjectorLights.attach(h.engine,{lights}),image=cube();
 assert.equal(lights.projector,undefined);
 cookies.setCubes([image]);assert.equal(lights.projector,cookies);
 assert.deepEqual(cookies.bindings().map(b=>b.binding),[143],'cube cookies share the spot storage binding (KB5663d)');
 assert.match(cookies.term,/clusterProjector.*clusterCubeProjector/);
 assert.match(cookies.declarations(0),/cubeCookieDirection/);
 cookies.setProjectors([{width:1,height:1,data:new Uint8Array([255,255,255,255])}]);
  assert.match(lights.pbr(0).declarations,/fn cubeWord/);
 cookies.setCubes([]);assert.equal(lights.projector,cookies);
  assert.doesNotMatch(lights.pbr(0).declarations,/fn cubeWord/,'spot-only activation invalidates cached cube declarations');
 assert.deepEqual(cookies.bindings().map(b=>b.binding),[143]);
  cookies.setCubes([image]);assert.match(lights.pbr(0).declarations,/fn cubeWord/,'reactivated cubes rebuild cached declarations');const old=cookies.bindings()[0].resource.buffer;
 cookies.onDeviceRestored(h.engine);assert.ok(old.destroyed);assert.notEqual(cookies.bindings()[0].resource.buffer,old);
 cookies.setCubes([]);cookies.setProjectors([]);assert.equal(lights.projector,undefined);
 cookies.dispose();assert.throws(()=>cookies.setCubes([image]),/disposed/);lights.dispose();
});

test('cubes supplied before attachment respect the eventual device storage limit before allocation',()=>{
 const h=optionalGPU(),lights=new Clustered(),cookies=new CubeProjectorLights({lights}),
   face={width:16,height:16,data:new Uint8Array(16*16*4)};
 h.engine.gpu.limits.maxStorageBufferBindingSize=4096;
 cookies.setCubes([{faces:Array(6).fill(face)}]);
 const buffers=h.counts.buffers;
 assert.throws(()=>cookies.setup(h.engine),/device storage buffer limit/);
 assert.equal(h.counts.buffers,buffers);
 assert.equal(lights.projector,undefined);
 cookies.dispose();lights.dispose();
});

test('spot images removed while cube cookies keep the hook are cleared on the GPU too (R5)',async()=>{
 // A spot's image was left in binding 143 when setProjectors([]) ran while a cube kept the shared hook: the upload pass
 // ran only while spot images existed, so the GPU still projected the old image onto the spot.
 const {wgsl}=await import('../../core/src/shaders.ts');
 const h=optionalGPU(),lights=new Clustered({grid:[1,1,1]});h.engine.use(lights);
 lights.setLights([{position:[0,3,0],range:10,direction:[0,-1,0],outerAngle:0.6},{position:[4,3,0],range:10}]);
 const cookies=CubeProjectorLights.attach(h.engine,{lights});
 const frame=()=>{h.context.shader=wgsl;h.context.bindings.length=0;h.engine.frameGraph.execute(h.context);};
 cookies.setProjectors([{width:1,height:1,data:new Uint8Array([0,255,0,255])}]);cookies.setCubes([null,cube()]);frame();
 const gpu=()=>new Uint32Array(cookies.bindings().find(b=>b.binding===143).resource.buffer.data);
 assert.deepEqual([gpu()[0],gpu()[1]],[1,1],'spot image uploaded');
 cookies.setProjectors([]);frame();
 assert.equal(lights.projector,cookies,'the cube keeps the hook');
 assert.deepEqual([gpu()[0],gpu()[1]],[0,0],'no spot entries or images left on the GPU');
 cookies.dispose();lights.dispose();
});

test('the small WebGL2 preview is refused during setup with a coded WebGPU error and no retained plugin',async()=>{
 const {Engine,TransformStore}=await import('../../core/dist/extension.js');
 const engine=new Engine({width:8,height:8},await TransformStore.create(8),{backend:'webgl2',add(){},remove(){},render(){},dispose(){}});
 try{
  assert.throws(()=>engine.use(new CubeProjectorLights({lights:new Clustered()})),
   e=>e.code==='unsupported'&&/CubeProjectorLights needs WebGPU/.test(e.message)&&/https:\/\/margoengine\.com\/errors#webgpu/.test(e.message));
  assert.equal(engine.plugins.size,0);
 }finally{engine.dispose();}
});

test('spot and cube cookies use one fragment storage binding, so every clustered hook fits eight (KB5663d)',async()=>{
 // The cube pixels had their own storage buffer (binding 152) beside the spot images (143): with the three cluster
 // lists, rectangle, shape, directional and IES storage that made nine fragment storage bindings, one over the
 // WebGPU default limit of eight. The cube block now follows the spot block in binding 143.
 const {wgsl}=await import('../../core/src/shaders.ts');
 const h=optionalGPU(),lights=new Clustered({grid:[1,1,1]});h.engine.use(lights);
 lights.setLights([{position:[0,3,0],range:10,direction:[0,-1,0],outerAngle:0.6},{position:[4,3,0],range:10}]);
 const cookies=CubeProjectorLights.attach(h.engine,{lights}),image=cube();
 cookies.setProjectors([{width:2,height:1,data:new Uint8Array([0,255,0,255,9,8,7,255])}]);cookies.setCubes([null,{image,rotation:[0,1,0,1]}]);
 const declarations=lights.pbr(0).declarations;
 assert.doesNotMatch(declarations,/@binding\(152\)/);
 assert.equal((declarations.match(/@binding\(143\)/g)??[]).length,1,'one projector storage declaration');
 assert.deepEqual(cookies.bindings().map(b=>b.binding),[143]);
 h.context.shader=wgsl;h.context.bindings.length=0;h.engine.frameGraph.execute(h.context);
 const gpu=new Uint32Array(cookies.bindings()[0].resource.buffer.data),floats=new Float32Array(gpu.buffer);
 // The spot header names where the cube block starts (header.z, in words after the 68 header words).
 const base=gpu[2],cubeAt=68+base;
 assert.equal(base,1*4+2,'cube block follows one spot entry and two texels');
 assert.deepEqual([gpu[cubeAt],gpu[cubeAt+1]],[2,1],'cube header: two entries, one image');
 assert.deepEqual([...gpu.subarray(cubeAt+68+8,cubeAt+68+9)],[1],'light 1 uses cube image 1');
 assert.ok(Math.abs(floats[cubeAt+68+8+5]-Math.SQRT1_2)<1e-7,'rotation stored');
 const pixels=cubeAt+gpu[cubeAt+4];
 assert.deepEqual([...new Uint8Array(gpu.buffer,(68+pixels)*4,4)],[0,0,0,255],'first face texel');
 cookies.dispose();lights.dispose();
});
