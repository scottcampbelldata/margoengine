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
 assert.deepEqual(cookies.bindings().map(b=>b.binding),[143,152]);
 assert.match(cookies.term,/clusterProjector.*clusterCubeProjector/);
 assert.match(cookies.declarations(0),/cubeCookieDirection/);
 cookies.setProjectors([{width:1,height:1,data:new Uint8Array([255,255,255,255])}]);
  assert.match(lights.pbr(0).declarations,/struct CubeCookieData/);
 cookies.setCubes([]);assert.equal(lights.projector,cookies);
  assert.doesNotMatch(lights.pbr(0).declarations,/struct CubeCookieData/,'spot-only activation invalidates cached cube declarations');
 assert.deepEqual(cookies.bindings().map(b=>b.binding),[143]);
  cookies.setCubes([image]);assert.match(lights.pbr(0).declarations,/struct CubeCookieData/,'reactivated cubes rebuild cached declarations');const old=cookies.cubeBuffer;
 cookies.onDeviceRestored(h.engine);assert.ok(old.destroyed);assert.notEqual(cookies.cubeBuffer,old);
 cookies.setCubes([]);cookies.setProjectors([]);assert.equal(lights.projector,undefined);
 cookies.dispose();assert.throws(()=>cookies.setCubes([image]),/disposed/);lights.dispose();
});

test('cubes supplied before attachment respect the eventual device storage limit before allocation',()=>{
 const h=optionalGPU(),lights=new Clustered(),cookies=new CubeProjectorLights({lights}),
   face={width:16,height:16,data:new Uint8Array(16*16*4)};
 h.engine.gpu.limits.maxStorageBufferBindingSize=4096;
 cookies.setCubes([{faces:Array(6).fill(face)}]);
 const buffers=h.counts.buffers;
 assert.throws(()=>cookies.setup(h.engine),/device storage limits/);
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
