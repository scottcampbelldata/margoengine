import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Engine,TransformStore} from '../packages/core/dist/extension.js';
import {parseGLTF} from '../packages/gltf-pro/dist/index.js';
import {Shadows} from '../packages/shadows/dist/index.js';
import {optionalGPU} from './support/optional-gpu.js';
import {materialQuad} from './support/materials-fixture.js';

async function scene(){
  const h=optionalGPU(),store=await TransformStore.create(32),device=h.engine.gpu;
  device.limits.maxTextureDimension2D=8192;device.limits.maxTextureArrayLayers=256;
  const engine=new Engine({width:128,height:128,clientWidth:128,clientHeight:128},store,{backend:'webgpu',gpu:device,add(){},remove(){},render(){},dispose(){}},{position:[0,0,3],target:[0,0,0]},null);
  const f=materialQuad();f.doc.images=[{uri:'alpha.png'}];f.doc.textures=[{source:0}];f.doc.materials[0].alphaMode='MASK';f.doc.materials[0].pbrMetallicRoughness.baseColorTexture={index:0};
  device.queue.copyExternalImageToTexture=()=>{};
  const model=parseGLTF(engine,f.doc,f.buffers,[{width:1,height:1,close(){}}]);
  engine.camera.update(1,true);store.tick(false);
  const shadows=Shadows.attach(engine,{resolution:64}),context={...h.context,camera:engine.camera};
  return {...h,engine,model,shadows,context,frame(){context.shader='var color=direct+ambient(s);';context.bindings=[];engine.frameGraph.execute(context);},dispose(){engine.dispose();}};
}
const shadowPipelines=h=>h.pipelines.filter(p=>p.depthStencil?.depthCompare==='less-equal'&&p.fragment.targets.length===0);
const digest=value=>createHash('sha256').update(value).digest('hex');

test('untransformed shadow casters retain the recorded shader and 144-byte uniform buffers',async()=>{
  const s=await scene();s.shadows.add(s.model);
  try{
    s.frame();const pipelines=shadowPipelines(s);assert.equal(pipelines.length,1);
    assert.equal(digest(pipelines[0].vertex.module.code),'f8d50d66edc6126585b54be2138ec93f0f98cf6dc7da45405c7953fdfc3cf47f');
    assert.equal(s.resources.filter(r=>r.size===144&&!r.destroyed).length,4);assert.equal(s.resources.filter(r=>r.size===176).length,0);
  }finally{s.dispose();}
  assert.ok(s.resources.every(resource=>resource.destroyed));
});

test('transformed mask casters select UV1 then apply affine rows in a separate shadow pipeline',async()=>{
  const s=await scene(),map=s.model.primitives[0].material.maps[0];s.shadows.add(s.model);
  try{
    s.frame();const old=s.resources.filter(r=>r.size===144&&!r.destroyed),baseline=shadowPipelines(s)[0];
    map.extensions={KHR_texture_transform:{texCoord:1,offset:[0.25,0.5],scale:[2,3],rotation:Math.PI/2}};
    const primitive=s.model.shadowPrimitives[0];assert.equal(primitive.texCoord,1);assert.equal(primitive.alphaTransform.length,8);
    s.frame();const transformed=shadowPipelines(s).find(p=>p!==baseline);
    assert.ok(transformed);assert.match(transformed.vertex.module.code,/alphaUV0:vec4f,alphaUV1:vec4f/);
    assert.match(transformed.vertex.module.code,/select\(i\.uv\.xy,i\.uv\.zw,f\.alpha\.z>0\.5\).*sourceUV=o\.uv/);
    assert.match(transformed.vertex.module.code,/dot\(f\.alphaUV0\.xy,sourceUV\)\+f\.alphaUV0\.z/);
    const uniforms=s.resources.filter(r=>r.size===176&&!r.destroyed);assert.equal(uniforms.length,4);assert.ok(old.every(r=>r.destroyed));
    for(const uniform of uniforms){const values=new Float32Array(uniform.data);assert.equal(values[34],1);assert.deepEqual(values.slice(36),primitive.alphaTransform);}
    const total=s.counts.buffers;map.extensions.KHR_texture_transform.offset=[0.75,-0.25];s.frame();assert.equal(s.counts.buffers,total);assert.equal(shadowPipelines(s).length,2);
    assert.equal(new Float32Array(uniforms[0].data)[38],0.75);assert.equal(new Float32Array(uniforms[0].data)[42],-0.25);
    delete map.extensions;s.frame();assert.equal(shadowPipelines(s).length,2);assert.ok(uniforms.every(r=>r.destroyed));assert.equal(s.resources.filter(r=>r.size===144&&!r.destroyed).length,4);
  }finally{s.dispose();}
  assert.ok(s.resources.every(resource=>resource.destroyed));
});

test('invalid shadow alpha transforms fail before caster pipeline or uniform allocation',async()=>{
  for(const transform of [[],new Float32Array(7),new Float32Array([1,0,0,0,0,1,Infinity,0])]){
    const s=await scene(),primitive=s.model.shadowPrimitives[0];primitive.alphaTransform=transform;s.shadows.add({shadowPrimitives:[primitive]});
    try{const before=s.counts.buffers;assert.throws(()=>s.frame(),/alpha transform|affine|PBR/);assert.equal(shadowPipelines(s).length,0);assert.equal(s.counts.buffers,before);}
    finally{s.dispose();}
    assert.ok(s.resources.every(resource=>resource.destroyed));
  }
});

test('transformed caster allocation failures clean partial uniforms and recover on the next frame',async()=>{
  const s=await scene(),map=s.model.primitives[0].material.maps[0];map.extensions={KHR_texture_transform:{offset:[0.5,0]}};s.shadows.add(s.model);
  const original=s.engine.gpu.createBindGroup;let fail=true;
  s.engine.gpu.createBindGroup=descriptor=>{if(fail&&descriptor.entries.some(entry=>entry.resource?.buffer?.size===176)){fail=false;throw new Error('transformed group failure');}return original(descriptor);};
  try{
    assert.throws(()=>s.frame(),/transformed group failure/);assert.ok(s.resources.filter(r=>r.size===176).every(r=>r.destroyed));
    s.frame();assert.equal(s.resources.filter(r=>r.size===176&&!r.destroyed).length,4);
    const old=s.resources.filter(r=>r.size===176&&!r.destroyed);s.shadows.onDeviceRestored(s.engine);assert.ok(old.every(r=>r.destroyed));s.frame();assert.equal(s.resources.filter(r=>r.size===176&&!r.destroyed).length,4);
  }finally{s.dispose();}
  assert.ok(s.resources.every(resource=>resource.destroyed));
});
