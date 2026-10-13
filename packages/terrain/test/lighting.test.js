import test from 'node:test';
import assert from 'node:assert/strict';
import {Terrain} from '../dist/index.js';
import {optionalGPU} from '../../../tests/support/optional-gpu.js';
import {Shadows} from '../../shadows/dist/index.js';
import {Clustered} from '../../clustered/dist/index.js';
import {wgsl} from '../../core/src/shaders.ts';

function harness() {
  const h=optionalGPU(),device=h.engine.gpu;
  globalThis.GPUShaderStage={VERTEX:1,FRAGMENT:2};
  h.engine.lighting={direction:new Float32Array([3,5,4,3]),radiance:new Float32Array([1,1,1,0.15])};
  h.engine.stats={drawCalls:0};
  const texture=device.createTexture,group=device.createBindGroup;
  device.createTexture=descriptor=>Object.assign(texture(descriptor),{depthOrArrayLayers:descriptor.size[2]??1});
  device.createBindGroupLayout=descriptor=>descriptor;
  device.createPipelineLayout=descriptor=>descriptor;
  device.createRenderPipeline=descriptor=>{
    const pipeline={...descriptor,getBindGroupLayout:index=>descriptor.layout.bindGroupLayouts[index]};
    h.pipelines.push(pipeline);return pipeline;
  };
  // WebGPU snapshots buffer descriptors instead of retaining their mutable wrappers.
  device.createBindGroup=descriptor=>group({...descriptor,entries:descriptor.entries.map(({binding,resource})=>({binding,resource:'buffer' in resource?{...resource}:resource}))});
  const bound=[];
  h.context.encoder.beginRenderPass=()=>{
    h.counts.render++;
    return {setPipeline(){},setBindGroup(index,value){if(index===1)bound.push(value);},setVertexBuffer(){},setIndexBuffer(){},drawIndexed(){h.counts.indexed=(h.counts.indexed??0)+1;},end(){}};
  };
  return {...h,bound,render(){h.engine.frameGraph.execute(h.context);}};
}

function terrain(h) {
  const module=new Terrain({resolution:8,levels:2,size:[32,32],heightScale:1,
    layers:Array.from({length:4},()=>({height:[-10,10],slope:[0,1],scale:1})),
    textures:device=>({
      heightmap:device.createTexture({size:[2,2],format:'r32float',usage:GPUTextureUsage.TEXTURE_BINDING}),
      layers:device.createTexture({size:[1,1,4],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING}),
    })});
  h.engine.use(module);return module;
}

function lighting(h) {
  const state={buffer:h.engine.gpu.createBuffer({size:256,usage:GPUBufferUsage.UNIFORM}),offset:0,size:64,view:{},sampler:{},shader:''};
  const effect={owner:h.engine,shader(source,group){return `@group(${group}) @binding(1) var<uniform> terrainTest:vec4f;\n`+source+state.shader;},
    // Providers are allowed to return fresh entry/buffer wrappers each render.
    bindings(){return [{binding:1,resource:{buffer:state.buffer,offset:state.offset,size:state.size}},{binding:2,resource:state.view},{binding:3,resource:state.sampler}];}};
  return {state,effect};
}

test('terrain reuses lighting groups for stable resources despite fresh binding wrappers',()=>{
  const h=harness(),module=terrain(h),{state,effect}=lighting(h);module.addLighting(effect);
  const before=h.counts.groups;
  try {
    for(let i=0;i<120;i++){h.engine.gpu.queue.writeBuffer(state.buffer,0,new Float32Array([i,2,3,4]));h.render();}
    assert.equal(h.counts.groups-before,1,'Steady terrain lighting must allocate one group, not one per draw');
    assert.equal(new Set(h.bound).size,1);
    assert.equal(h.counts.indexed,240,'Every clipmap ring must still render on every frame');
    assert.equal(h.engine.stats.drawCalls,240);
  } finally {module.dispose();state.buffer.destroy();}
  assert.ok(h.resources.every(resource=>resource.destroyed));
});

test('terrain rebuilds bindings when buffers, ranges, views or samplers change in place',()=>{
  const h=harness(),module=terrain(h),{state,effect}=lighting(h);
  const entry={binding:1,resource:{buffer:state.buffer,offset:0,size:64}},view={binding:2,resource:state.view},sampler={binding:3,resource:state.sampler};
  effect.bindings=()=>[entry,view,sampler];module.addLighting(effect);
  const buffers=[state.buffer];
  try {
    h.render();const first=h.bound.at(-1),start=h.counts.groups;
    h.render();assert.equal(h.counts.groups,start);assert.equal(h.bound.at(-1),first);
    for(const change of [
      ()=>{entry.resource.offset=64;},
      ()=>{entry.resource.size=128;},
      ()=>{const buffer=h.engine.gpu.createBuffer({size:256,usage:GPUBufferUsage.UNIFORM});buffers.push(buffer);entry.resource.buffer=buffer;},
      ()=>{view.resource={};},
      ()=>{sampler.resource={};},
    ]){
      const previous=h.bound.at(-1),before=h.counts.groups;change();h.render();
      assert.equal(h.counts.groups,before+1);assert.notEqual(h.bound.at(-1),previous);
      assert.equal(h.bound.at(-1).entries[0].resource.buffer,entry.resource.buffer);
      assert.equal(h.bound.at(-1).entries[0].resource.offset,entry.resource.offset);
      assert.equal(h.bound.at(-1).entries[0].resource.size,entry.resource.size);
      h.render();assert.equal(h.counts.groups,before+1);
    }
    assert.equal(first.entries[0].resource.offset,0,'Cached metadata must snapshot mutable buffer ranges');
  } finally {module.dispose();for(const buffer of buffers)buffer.destroy();}
  assert.ok(h.resources.every(resource=>resource.destroyed));
});

test('terrain lighting groups follow exact pipelines and preserve effect removal',()=>{
  const h=harness(),module=terrain(h),{state,effect}=lighting(h),remove=module.addLighting(effect);
  try {
    h.render();const first=h.bound.at(-1),start=h.counts.groups;
    h.context.format='rgba16float';h.render();assert.equal(h.counts.groups,start+1);assert.notEqual(h.bound.at(-1),first);
    h.context.format='bgra8unorm';h.render();assert.equal(h.counts.groups,start+1);assert.equal(h.bound.at(-1),first);
    h.context.descriptor.multisample={count:1};h.render();assert.equal(h.counts.groups,start+2);
    h.context.descriptor.depthStencil={format:'depth24plus-stencil8'};h.render();assert.equal(h.counts.groups,start+3);
    state.shader='\n// changed lighting shader';h.render();assert.equal(h.counts.groups,start+4);
    const bound=h.bound.length;remove();h.render();assert.equal(h.bound.length,bound);assert.equal(h.counts.groups,start+4);
    module.addLighting(effect);h.render();assert.equal(h.counts.groups,start+4);
  } finally {module.dispose();state.buffer.destroy();}
  assert.ok(h.resources.every(resource=>resource.destroyed));
});

test('terrain clears cached lighting groups and owned resources after device restoration',()=>{
  const h=harness(),module=terrain(h),owned=h.resources.slice(),{state,effect}=lighting(h);module.addLighting(effect);
  h.render();const first=h.bound.at(-1),next=harness(),previousBuffer=state.buffer;
  h.engine.gpu=next.engine.gpu;h.context.device=next.engine.gpu;state.buffer=next.engine.gpu.createBuffer({size:256,usage:GPUBufferUsage.UNIFORM});
  try {
    module.onDeviceRestored(h.engine);assert.ok(owned.every(resource=>resource.destroyed));
    const before=next.counts.groups;h.render();assert.equal(next.counts.groups,before+1);assert.notEqual(h.bound.at(-1),first);
    assert.equal(h.bound.at(-1).entries[0].resource.buffer,state.buffer);
    h.render();assert.equal(next.counts.groups,before+1);
  } finally {module.dispose();previousBuffer.destroy();state.buffer.destroy();}
  assert.ok(h.resources.every(resource=>resource.destroyed));assert.ok(next.resources.every(resource=>resource.destroyed));
});

test('terrain preserves binding failures and does not cache a failed replacement',()=>{
  const h=harness(),module=terrain(h),{state,effect}=lighting(h);module.addLighting(effect);
  const failure=new Error('Invalid terrain lighting binding'),create=h.engine.gpu.createBindGroup;
  try {
    h.render();const first=h.bound.at(-1),before=h.counts.groups;state.offset=64;
    h.engine.gpu.createBindGroup=()=>{throw failure;};
    assert.throws(()=>h.render(),error=>error===failure);assert.equal(h.counts.groups,before);
    h.engine.gpu.createBindGroup=create;h.render();assert.equal(h.counts.groups,before+1);assert.notEqual(h.bound.at(-1),first);
    effect.bindings=()=>{throw failure;};assert.throws(()=>h.render(),error=>error===failure);
    assert.throws(()=>module.addLighting({...effect,owner:{}}),/another engine/);
  } finally {h.engine.gpu.createBindGroup=create;module.dispose();state.buffer.destroy();}
  assert.throws(()=>module.addLighting(effect),/Invalid terrain lighting/);
  assert.ok(h.resources.every(resource=>resource.destroyed));
});

test('terrain reuses real shadow and clustered bindings and follows restored provider resources',()=>{
  const h=harness(),module=terrain(h),shadows=new Shadows({resolution:32,distance:30}),clustered=new Clustered({grid:[2,2,2]});
  h.engine.use(shadows);h.engine.use(clustered);shadows.add(module,{static:true});clustered.add(module);
  clustered.setLights([{position:[0,2,1],range:6,intensity:2}]);
  const render=()=>{h.context.shader=wgsl;h.context.bindings=[];h.render();};
  try {
    render();const before=h.counts.groups,first=h.bound.at(-1);
    for(let i=0;i<20;i++)render();
    assert.equal(h.counts.groups,before);assert.equal(h.bound.at(-1),first);
    for(const entry of [...shadows.bindings(),...clustered.bindings()]){
      assert.equal(first.entries.find(value=>value.binding===entry.binding).resource.buffer??first.entries.find(value=>value.binding===entry.binding).resource,entry.resource.buffer??entry.resource);
    }
    shadows.onDeviceRestored(h.engine);clustered.onDeviceRestored(h.engine);
    const restored=h.counts.groups;render();assert.equal(h.counts.groups,restored+1);assert.notEqual(h.bound.at(-1),first);
    const group=h.bound.at(-1);render();assert.equal(h.counts.groups,restored+1);assert.equal(h.bound.at(-1),group);
  } finally {clustered.dispose();shadows.dispose();module.dispose();}
  assert.ok(h.resources.every(resource=>resource.destroyed));
});
