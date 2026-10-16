import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine,TransformStore} from '../packages/core/dist/extension.js';
import {GLTFAsset,PBRModel} from '../packages/gltf-pro/dist/index.js';
import {Animation} from '../packages/animation/dist/index.js';
import {Animator} from '../packages/animator/dist/index.js';
import {animatedTriangle} from './support/gltf-pro-fixture.js';
async function scene(edit=()=>{}) {
  const store=await TransformStore.create(32),engine=new Engine({width:64,height:64,clientWidth:64,clientHeight:64},store,{backend:'webgl2',add(){},remove(){},render(){},dispose(){}});
  const fixture=animatedTriangle();edit(fixture);
  const model=new PBRModel(engine,new GLTFAsset(fixture.doc,fixture.buffers));return {engine,model};
}
const duplicate=({doc})=>{delete doc.meshes[0].weights;doc.meshes[0].primitives.push(structuredClone(doc.meshes[0].primitives[0]));};
test('inconsistent primitive morph widths reject before Animation or Animator can overwrite them',async()=>{
  const {engine,model}=await scene(f=>{duplicate(f);f.doc.meshes[0].primitives[1].targets.push({...f.doc.meshes[0].primitives[1].targets[0]});});
  try{assert.throws(()=>new Animation(model),/morph target counts/i);}finally{model.dispose();engine.dispose();}
  const valid=await scene(duplicate);
  try{const animation=new Animation(valid.model);valid.model.primitives[1].weights=new Float32Array(2);assert.throws(()=>new Animator(animation,{initial:'move',states:{move:'Move'}}),/morph target counts/i);}finally{valid.model.dispose();valid.engine.dispose();}
});
test('valid multi-primitive morph animation writes the same node weights to every primitive',async()=>{
  const {engine,model}=await scene(f=>{duplicate(f);const output=f.doc.accessors.length,buffer=f.buffers.length,data=new Float32Array([0,1]);f.buffers.push(data);f.doc.buffers.push({byteLength:data.byteLength});f.doc.bufferViews.push({buffer,byteLength:data.byteLength});f.doc.accessors.push({bufferView:buffer,componentType:5126,count:2,type:'SCALAR'});f.doc.animations[0].channels=[{sampler:0,target:{node:0,path:'weights'}}];f.doc.animations[0].samplers[0].output=output;});
  const animation=new Animation(model),animator=new Animator(animation,{initial:'move',states:{move:'Move'}});
  try{animation.seek(0.25);assert.deepEqual(model.primitives.map(p=>[...p.weights]),[[0.25],[0.25]]);animator.onPreUpdate(0.5);assert.deepEqual(model.primitives.map(p=>[...p.weights]),[[0.5],[0.5]]);}finally{animator.dispose();model.dispose();engine.dispose();}
});
test('additive scale uses an identity delta for zero reference axes and preserves finite ratios elsewhere',async()=>{
  const {engine,model}=await scene(f=>{f.doc.nodes[1].scale=[2,3,4];f.doc.animations.push({name:'Idle',channels:[],samplers:[]});const track=f.doc.animations[0];track.channels[0].target.path='scale';f.buffers[track.samplers[0].output].set([0,2,0,4,4,0]);});
  const animation=new Animation(model),animator=new Animator(animation,{initial:'idle',states:{idle:'Idle'}});
  try{const layer={clip:'Move',weight:0.5,mask:[1]};animator.addLayer(layer);animator.onPreUpdate(0.5);assert.deepEqual([model.nodes[1].scale.x,model.nodes[1].scale.y,model.nodes[1].scale.z],[2,3.75,4]);layer.weight=0;animator.onPreUpdate(0);assert.deepEqual([model.nodes[1].scale.x,model.nodes[1].scale.y,model.nodes[1].scale.z],[2,3,4]);}finally{animator.dispose();model.dispose();engine.dispose();}
});
