import test from 'node:test';
import assert from 'node:assert/strict';
import {GLTFAsset,PBRModel,parseGLTF} from '../packages/gltf-pro/dist/index.js';
import {Animation} from '../packages/animation/dist/index.js';
import {SSAO} from '../packages/post/dist/index.js';
import {sampleTrack,multiplyMatrices} from '../packages/animation/src/sampling.ts';
import {Engine,TransformStore} from '../packages/core/dist/extension.js';
import {animatedTriangle} from './support/gltf-pro-fixture.js';

test('glTF accessors enforce bounds, decode normalized data, and apply sparse deltas',()=>{
  const bytes=new Uint8Array([0,127,255,0,1,0,0,0]),doc={asset:{version:'2.0'},buffers:[{byteLength:8}],bufferViews:[{buffer:0,byteLength:3},{buffer:0,byteOffset:4,byteLength:1},{buffer:0,byteOffset:2,byteLength:1}],
    accessors:[{bufferView:0,componentType:5121,normalized:true,count:3,type:'SCALAR'},{componentType:5121,count:3,type:'SCALAR',sparse:{count:1,indices:{bufferView:1,componentType:5121},values:{bufferView:2}}}]};
  const asset=new GLTFAsset(doc,[bytes]);assert.deepEqual([...asset.accessor(1)],[0,255,0]);assert.ok(Math.abs(asset.accessor(0)[1]-127/255)<1e-7);
  doc.accessors[0].count=4;assert.throws(()=>new GLTFAsset(doc,[bytes]).accessor(0),/bounds/);
  doc.accessors[0].count=3;doc.bufferViews[1].byteStride=4;assert.throws(()=>new GLTFAsset(doc,[bytes]).accessor(1),/stride/);delete doc.bufferViews[1].byteStride;
  doc.extensionsRequired=['KHR_draco_mesh_compression'];assert.throws(()=>new GLTFAsset(doc,[bytes]),/Required/);
});
test('animation handles endpoint clamps, step, cubic tangents, and antipodal quaternions',()=>{
  const times=new Float32Array([0,1]),values=new Float32Array([0,2]);
  assert.equal(sampleTrack(times,values,1,0.5,'LINEAR')[0],1);
  assert.equal(sampleTrack(times,values,1,0.9,'STEP')[0],0);
  assert.equal(sampleTrack(times,values,1,2,'LINEAR')[0],2);
  assert.equal(sampleTrack(times,new Float32Array([0,0,2,2,2,0]),1,0.5,'CUBICSPLINE')[0],1);
  const q=sampleTrack(times,new Float32Array([0,0,0,1,0,0,0,-1]),4,0.5,'LINEAR',true);assert.deepEqual([...q],[0,0,0,1]);
  assert.throws(()=>sampleTrack(times,values,3,0.5,'LINEAR'),/count/);
  const id=new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]),translated=id.slice();translated[12]=2;const out=new Float32Array(16);multiplyMatrices(out,id,translated);assert.deepEqual(out,translated);
});
async function headless(capacity=64) {
  const store=await TransformStore.create(capacity),renderer={backend:'webgl2',add(){},remove(){},render(){},dispose(){}};
  return new Engine({width:256,height:256,clientWidth:256,clientHeight:256},store,renderer);
}
test('PBR construction rolls back invalid hierarchy/transforms and exhausted capacity',async()=>{
  const engine=await headless(),fixture=animatedTriangle();
  try {
    const asset=new GLTFAsset(fixture.doc,fixture.buffers),model=new PBRModel(engine,asset);assert.equal(model.nodes.length,2);assert.equal(model.primitives[0].weights.length,1);
    const animation=new Animation(model);animation.seek(0.5);assert.ok(Math.abs(model.nodes[1].position.x-0.2)<1e-6);
    animation.setMorph(0,0,0.5);assert.equal(model.primitives[0].weights[0],0.5);assert.throws(()=>animation.setMorph(0,1,0.5),/morph/);
    model.nodes[0].position.x=4;animation.play(0);assert.equal(model.nodes[0].position.x,0,'Clip switching restores rest transforms');
    model.dispose();assert.equal(engine.meshes.size,0);
    assert.throws(()=>parseGLTF(engine,fixture.doc,fixture.buffers),/WebGPU/);assert.equal(engine.meshes.size,0);
    fixture.doc.nodes[1].children=[0];assert.throws(()=>new PBRModel(engine,new GLTFAsset(fixture.doc,fixture.buffers)),/hierarchy cycle/);assert.equal(engine.meshes.size,0);delete fixture.doc.nodes[1].children;
    fixture.doc.nodes[1].scale=[0,1,1];assert.throws(()=>new PBRModel(engine,new GLTFAsset(fixture.doc,fixture.buffers)),/nonzero/);assert.equal(engine.meshes.size,0);
    delete fixture.doc.nodes[1].scale;
    const indices=new Uint32Array([0,1,0xffffffff]),id=fixture.doc.accessors.length;
    fixture.doc.buffers.push({byteLength:indices.byteLength});fixture.doc.bufferViews.push({buffer:id,byteLength:indices.byteLength});fixture.doc.accessors.push({bufferView:id,componentType:5125,count:3,type:'SCALAR'});fixture.buffers.push(indices);fixture.doc.meshes[0].primitives[0].indices=id;
    assert.throws(()=>new PBRModel(engine,new GLTFAsset(fixture.doc,fixture.buffers)),/indices/);assert.equal(engine.meshes.size,0,'Oversized UInt32 indices cannot wrap into valid vertices');
  } finally {engine.dispose();}
  const small=await headless(1);try{const f=animatedTriangle();assert.throws(()=>new PBRModel(small,new GLTFAsset(f.doc,f.buffers)),/capacity/);assert.equal(small.meshes.size,0);}finally{small.dispose();}
});
test('SSAO validates radius, bias, samples and toggles before GPU allocation',async()=>{
  for(const options of [{radius:0},{radius:NaN},{bias:-1},{bias:1,radius:0.5},{samples:33},{samples:2.5},{enabled:'yes'}])assert.throws(()=>new SSAO(options),/options/);
  const effect=new SSAO();effect.enabled=false;assert.equal(effect.enabled,false);assert.throws(()=>{effect.enabled=1;},/boolean/);
  const engine=await headless();try{assert.throws(()=>SSAO.attach(engine),/WebGPU/);assert.equal(engine.hasPlugin('ssao'),false);}finally{engine.dispose();}
});
