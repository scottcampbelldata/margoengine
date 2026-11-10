import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseGLTF } from '../../gltf-pro/dist/index.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
async function ownerEngine(t) {
 const gpu=optionalGPU(), engine=new Engine({width:8,height:8,clientWidth:8,clientHeight:8},await TransformStore.create(64),{backend:'webgpu',gpu:gpu.engine.gpu,add(){},remove(){},render(){},dispose(){}},undefined,null);
 t.after(()=>{engine.dispose();gpu.cleanup();});return engine;
}
import { HAND_JOINT_NAMES, SkinnedHands } from '../dist/hands.js';
import { XRController } from '../dist/index.js';
const matrix=(x=0,y=0,z=0)=>new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,x,y,z,1]);
async function fixture(t,options={}){
 const engine=await ownerEngine(t),bytes=await readFile(new URL('./fixtures/hands/left.glb',import.meta.url));
 const model=parseGLTF(engine,bytes);
 const source={handedness:'left',profiles:['generic-hand'],targetRayMode:'tracked-pointer',targetRaySpace:{},hand:new Map(HAND_JOINT_NAMES.map(name=>[name,{}]))};
 const input=new XRController(source);input.handTracked.fill(1);
 const listeners=new Set(),session=new EventTarget();
 const host={session,controllers:[input],onFrame(fn){listeners.add(fn);return()=>listeners.delete(fn);}};
 let hands=await SkinnedHands.create(host,{left:model},options);
 const step=()=>{for(const fn of listeners)fn({frame:{session:host.session},delta:1/90});};
 const target=(name)=>matrix(HAND_JOINT_NAMES.indexOf(name)*.01,1,.2);
 const poses=()=>Array.from(input.source.hand.keys()).forEach((name,i)=>input.handMatrices.set(target(name),i*16));
 poses();t.after(()=>hands.dispose());
 return {engine,model,source,input,host,listeners,session,hands,step,poses,target};
}
const near=(a,b)=>{assert.equal(a.length,b.length);for(let i=0;i<a.length;i++)assert.ok(Math.abs(a[i]-b[i])<2e-5,`${i}: ${a[i]} != ${b[i]}`);};
test('standard hand profile maps every one of the 25 named skin joints',async t=>{
 const f=await fixture(t);assert.equal(HAND_JOINT_NAMES.length,25);f.step();f.engine.render();
 for(const name of HAND_JOINT_NAMES){const i=f.model.asset.doc.nodes.findIndex(node=>node.name===name);near(f.model.nodes[i].matrix,f.target(name));}
 assert.equal(f.model.root.visible,true);
});
test('partial tracking and system-rendered hands hide the entire skinned surface',async t=>{
 const f=await fixture(t);f.step();assert.equal(f.model.root.visible,true);
 f.input.handTracked[10]=0;f.step();assert.equal(f.model.root.visible,false);
 f.input.handTracked[10]=1;f.source.skipRendering=true;f.step();assert.equal(f.model.root.visible,false);
 f.source.skipRendering=false;f.step();assert.equal(f.model.root.visible,true);
});
test('input replacement maps by joint name instead of assuming map iteration order',async t=>{
 const f=await fixture(t);const source={...f.source,hand:new Map([...f.source.hand].reverse())},input=new XRController(source);
 input.handTracked.fill(1);Array.from(source.hand.keys()).forEach((name,i)=>input.handMatrices.set(f.target(name),i*16));
 f.host.controllers=[input];f.step();f.engine.render();
 for(const name of HAND_JOINT_NAMES){const i=f.model.asset.doc.nodes.findIndex(node=>node.name===name);near(f.model.nodes[i].matrix,f.target(name));}
});
test('source removal and session end hide stale hand meshes',async t=>{
 const f=await fixture(t);f.step();f.host.controllers=[];f.step();assert.equal(f.model.root.visible,false);
 f.host.controllers=[f.input];f.step();f.session.dispatchEvent(new Event('end'));assert.equal(f.model.root.visible,false);
});
test('abort restores borrowed models and removes frame hooks',async t=>{
 const controller=new AbortController(),f=await fixture(t,{signal:controller.signal});
 const rest=f.model.nodes.map(node=>[node.position.x,node.position.y,node.position.z]);
 f.step();controller.abort();assert.equal(f.listeners.size,0);assert.equal(f.model.root.visible,true);
 f.model.nodes.forEach((node,i)=>near([node.position.x,node.position.y,node.position.z],rest[i]));f.hands.dispose();
});
test('pre-aborted creation and invalid model maps leave no hand owner attached',async t=>{
 const f=await fixture(t),signal=new AbortController();signal.abort(new Error('stop'));
 await assert.rejects(SkinnedHands.create(f.host,{left:f.model},{signal:signal.signal}),/stop/);
 await assert.rejects(SkinnedHands.create(f.host,{}),/at least one/);
 await assert.rejects(SkinnedHands.create(f.host,{left:f.model,right:f.model}),/separate/);
});
test('disposing a borrowed model before its hand controller is safe',async t=>{
 const f=await fixture(t);f.model.dispose();f.step();assert.doesNotThrow(()=>f.hands.dispose());assert.equal(f.listeners.size,0);
});

test('secondary scene ownership releases skin players and callbacks when the owner closes',async t=>{
 const f=await fixture(t);f.hands.dispose();const scene=f.engine.createScene('hands');let model;
 scene.use({name:'create-hand',setup(){},onUpdate(){}});
 // Parse explicitly in the selected scene, independently of the default scene.
 const bytes=await readFile(new URL('./fixtures/hands/left.glb',import.meta.url));
 const {GLTFAsset,PBRModel}=await import('../../gltf-pro/dist/index.js');
 scene.use({name:'load-hand',setup(){model=parseGLTF(f.engine,bytes);}});
 const hands=await SkinnedHands.create(f.host,{left:model});f.step();scene.dispose();
 assert.equal(f.listeners.size,0);assert.equal(scene.plugins.size,0);assert.doesNotThrow(()=>hands.dispose());
});
