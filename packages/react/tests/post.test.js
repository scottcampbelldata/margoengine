import test,{afterEach,mock} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {JSDOM} from 'jsdom';
import React,{StrictMode} from 'react';
import {renderToString} from 'react-dom/server';

// Use the native constructors for option validation, and test their ownership
// guards separately. GPU allocation is replaced only in these lifecycle tests.
const {Bloom:NativeBloom}=await import('../../post/dist/bloom.js');
const {SSAO:NativeSSAO}=await import('../../post/dist/ssao.js');
const {DOF:NativeDOF}=await import('../../dof/dist/index.js');
const {Tonemap:NativeTonemap}=await import('../../tonemap/dist/index.js');
const {TAA:NativeTAA}=await import('../../taa/dist/index.js');
const effects=[],scenes=[],devices=[];
globalThis.GPUBufferUsage={VERTEX:32,STORAGE:128,COPY_DST:8};
function gpu() {
  const device={buffers:[],writes:[],failUpload:false,createBuffer(options){const buffer={...options,disposals:0,destroy(){this.disposals++;}};this.buffers.push(buffer);return buffer;},
    queue:{writeBuffer(buffer,offset,data){if(device.failUpload)throw new Error('Upload failed');device.writes.push({buffer,offset,data:data.slice()});}}};
  devices.push(device);return device;
}
function model(count=0) {
  const node={},primitives=Array.from({length:count},(_,index)=>({node,vertices:new Float32Array(60).fill(index+1),indices:new Uint32Array([0,1,2]),material:{settings:[0,0,0,0]},vertex:{size:240,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST,disposals:0,destroy(){this.disposals++;}},index:{id:index}}));
  return {disposed:false,primitives,get shadowPrimitives(){return this.primitives.filter(primitive=>primitive.material.settings[0]!==2).map(primitive=>({node:primitive.node,vertex:primitive.deformed??primitive.vertex,index:primitive.index,count:primitive.indices.length,stride:80,alphaTexture:primitive.alphaTexture,alphaSampler:primitive.alphaSampler,alpha:0.8,cutoff:0.4,texCoord:1}));}};
}
function implementation(name,Native) {
  return class Plugin {
    static attach(engine,options) {
      new Native(options);
      const effect=new Plugin();Object.assign(effect,{name,engine,options,sources:new Set(),disposals:0,resets:0,luts:[],depthTexture:{name:name+' depth'},outputTexture:{name:name+' output'}});
      effects.push(effect);engine.use(effect);return effect;
    }
    add(model){assert.equal(this.sources.has(model),false);if(name==='taa')assert.ok(Array.isArray(model.shadowPrimitives));this.sources.add(model);return()=>this.sources.delete(model);}
    reset(){this.resets++;}
    setLUT(value){this.luts.push(value);}
    dispose(){if(this.disposals)return;this.disposals++;this.sources.clear();this.engine.removePlugin(this.name);}
  };
}
mock.module('@margoengine/post/bloom',{namedExports:{Bloom:implementation('bloom',NativeBloom)}});
mock.module('@margoengine/post/ssao',{namedExports:{SSAO:implementation('ssao',NativeSSAO)}});
mock.module('@margoengine/dof',{namedExports:{DOF:implementation('dof',NativeDOF)}});
mock.module('@margoengine/tonemap',{namedExports:{Tonemap:implementation('tonemap',NativeTonemap)}});
mock.module('@margoengine/taa',{namedExports:{TAA:implementation('taa',NativeTAA)}});
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost'});
for(const key of ['window','document','HTMLElement','HTMLCanvasElement','navigator'])Object.defineProperty(globalThis,key,{configurable:true,value:dom.window[key]});
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const {Context}=await import('../dist/internal.js');
const {EffectComposer,Bloom,SSAO,DepthOfField,Tonemap,TAA}=await import('../dist/post.js');
const {render,act,cleanup}=await import('@testing-library/react');
const flush=()=>act(async()=>{});
const h=React.createElement;
function scene(backend='webgpu') {
  const errors=[],plugins=new Map();
  const value={engine:{backend,gpu:backend==='webgpu'?gpu():null,disposed:false,onError:error=>errors.push(error),plugins,
    use(effect){assert.equal(plugins.has(effect.name),false);plugins.set(effect.name,effect);return this;},
    removePlugin(name){const effect=plugins.get(name);plugins.delete(name);effect?.dispose();},
    hasPlugin:name=>plugins.has(name),
    onFrame(){throw new Error('Post bindings must use the demand-compatible frame registry');},
  },resources:{models:new Set(),lighting:new Map()},frames:{callbacks:new Set()},errors};
  scenes.push(value);return value;
}
const tree=(value,children,props={})=>h(StrictMode,null,h(Context.Provider,{value},h(EffectComposer,props,children)));
afterEach(async()=>{
  cleanup();await flush();
  for(const value of scenes){assert.equal(value.engine.plugins.size,0);assert.equal(value.frames.callbacks.size,0);}
  assert.ok(effects.every(effect=>effect.disposals===1),'Every created plugin is disposed exactly once');
  assert.ok(devices.flatMap(device=>device.buffers).every(buffer=>buffer.disposals===1),'Every owned TAA vertex copy is destroyed exactly once');
});

test('post subpath has only its six runtime exports and isolates dynamic optional imports',async()=>{
  const api=await import('../dist/post.js');
  assert.deepEqual(Object.keys(api).sort(),['Bloom','DepthOfField','EffectComposer','SSAO','TAA','Tonemap']);
  const source=await readFile(new URL('../dist/post.js',import.meta.url),'utf8');
  for(const name of ['@margoengine/post/bloom','@margoengine/post/ssao','@margoengine/dof','@margoengine/tonemap','@margoengine/taa'])assert.ok(source.includes(`import('${name}')`)||source.includes(`import("${name}")`));
  assert.equal(/from ['"]@margoengine\/(?:post|dof|tonemap|taa)/.test(source),false);
  assert.equal(source.includes('react-reconciler'),false);
});

test('the documented composer JSX is renderable on the server without loading plugins',()=>{
  const before=effects.length,value=scene();
  assert.equal(renderToString(tree(value,[h(Bloom,{key:'b'}),h(SSAO,{key:'s'}),h(DepthOfField,{key:'d'})])), '');
  assert.equal(effects.length,before);
});

test('StrictMode creates one Bloom, updates native options in place, and disposes on removal',async()=>{
  const value=scene(),ready=[],before=effects.length;
  const child=strength=>h(Bloom,{strength,onReady:effect=>ready.push(effect)});
  const view=render(tree(value,child(0.4)));await flush();
  const bloom=value.engine.plugins.get('bloom');assert.ok(bloom);assert.equal(effects.length,before+1);assert.deepEqual(ready,[bloom]);assert.equal(bloom.options.strength,0.4);
  view.rerender(tree(value,child(1.8)));await flush();assert.equal(value.engine.plugins.get('bloom'),bloom);assert.equal(bloom.options.strength,1.8);
  view.rerender(tree(value,h(Bloom)));await flush();assert.equal('strength' in bloom.options,false,'Removing a prop restores its native default');
  view.rerender(tree(value,null));await flush();assert.equal(bloom.disposals,1);assert.equal(value.engine.plugins.size,0);
});

test('DOF and Tonemap attach in dependency order, share HDR, update LUT, and TAA gets current depth',async()=>{
  const value=scene(),before=effects.length,lut={data:new Float32Array(1)};
  const child=(focalDistance,exposure,lutValue,weight)=>[
    h(Tonemap,{key:'tone',exposure,lut:lutValue}),h(TAA,{key:'taa',historyWeight:weight}),h(DepthOfField,{key:'dof',focalDistance}),
  ];
  const view=render(tree(value,child(8,1,lut,0.8)));await flush();
  const [dof,tone,taa]=effects.slice(before);assert.deepEqual([dof.name,tone.name,taa.name],['dof','tonemap','taa']);
  assert.equal(tone.options.source(),dof.outputTexture);assert.equal(taa.options.depth(),dof.depthTexture);assert.deepEqual(tone.luts,[lut]);
  view.rerender(tree(value,child(12,2,null,0.7)));await flush();assert.equal(effects.length,before+3);
  assert.equal(dof.options.focalDistance,12);assert.equal(tone.options.exposure,2);assert.deepEqual(tone.luts,[lut,null]);assert.equal(taa.options.historyWeight,0.7);assert.equal(taa.resets,1);
  assert.deepEqual(value.errors,[]);
});

test('Tonemap reattaches when its fixed source changes and when automatic DOF capture is removed',async()=>{
  const value=scene(),sourceA=()=>({a:true}),sourceB=()=>({b:true});
  const view=render(tree(value,h(Tonemap,{source:sourceA})));await flush();const first=value.engine.plugins.get('tonemap');
  view.rerender(tree(value,h(Tonemap,{source:sourceB})));await flush();const second=value.engine.plugins.get('tonemap');assert.notEqual(second,first);assert.equal(first.disposals,1);assert.equal(second.options.source,sourceB);
  view.rerender(tree(value,[h(DepthOfField,{key:'dof'}),h(Tonemap,{key:'tone'})]));await flush();const third=value.engine.plugins.get('tonemap');assert.equal(third.options.source(),value.engine.plugins.get('dof').outputTexture);
  view.rerender(tree(value,[h(Tonemap,{key:'tone'})]));await flush();const fourth=value.engine.plugins.get('tonemap');assert.notEqual(fourth,third);assert.equal(third.disposals,1);assert.equal(fourth.options.source,undefined);
});

test('SSAO and TAA register current and future PBR models through demand frame callbacks',async()=>{
  const value=scene(),first=model(),later=model();value.resources.models.add(first);
  render(tree(value,[h(SSAO,{key:'s'}),h(TAA,{key:'t'})]));await flush();
  const ssao=value.engine.plugins.get('ssao'),taa=value.engine.plugins.get('taa');assert.deepEqual([...ssao.sources],[first]);assert.equal(taa.sources.size,1);assert.notEqual([...taa.sources][0],first);assert.equal(taa.options.depth(),ssao.depthTexture);
  value.resources.models.add(later);for(const callback of value.frames.callbacks)callback(value.engine,0);
  assert.deepEqual([...ssao.sources],[first,later]);assert.equal(taa.sources.size,2);
  value.resources.models.delete(first);later.disposed=true;for(const callback of value.frames.callbacks)callback(value.engine,0);
  assert.equal(ssao.sources.size,0);assert.equal(taa.sources.size,0);
});

test('explicit sources and depth callbacks are preserved',async()=>{
  const value=scene(),source=()=>({hdr:true}),depth=()=>({depth:true});
  render(tree(value,[h(SSAO,{key:'s'}),h(Tonemap,{key:'tone',source}),h(TAA,{key:'taa',depth})]));await flush();
  assert.equal(value.engine.plugins.get('tonemap').options.source,source);assert.equal(value.engine.plugins.get('taa').options.depth,depth);assert.deepEqual(value.errors,[]);
});

test('TAA copies static PBR vertices once with storage usage and preserves distinct mesh primitives and alpha bindings',async()=>{
  const value=scene(),loaded=model(2),device=value.engine.gpu;value.resources.models.add(loaded);
  loaded.primitives[0].alphaTexture={texture:true};loaded.primitives[0].alphaSampler={sampler:true};
  render(tree(value,h(TAA)));await flush();assert.deepEqual(value.errors,[]);
  const taa=value.engine.plugins.get('taa'),source=[...taa.sources][0],first=source.shadowPrimitives;
  assert.equal(device.buffers.length,2);assert.equal(device.writes.length,2);
  for(let index=0;index<first.length;index++) {
    const original=loaded.shadowPrimitives[index],adapted=first[index];assert.notEqual(adapted.vertex,original.vertex);
    assert.equal(adapted.vertex.usage,GPUBufferUsage.VERTEX|GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST);
    assert.equal(adapted.node,original.node);assert.equal(adapted.index,original.index);assert.equal(adapted.count,3);assert.equal(adapted.stride,80);
    assert.equal(adapted.alphaTexture,original.alphaTexture);assert.equal(adapted.alphaSampler,original.alphaSampler);assert.equal(adapted.alpha,0.8);assert.equal(adapted.cutoff,0.4);assert.equal(adapted.texCoord,1);
    assert.deepEqual(device.writes[index].data,loaded.primitives[index].vertices);
  }
  for(const callback of value.frames.callbacks)callback(value.engine,0.016);
  assert.equal(source.shadowPrimitives[0].vertex,first[0].vertex);assert.equal(device.buffers.length,2);assert.equal(device.writes.length,2,'Stable static data is uploaded once');
  assert.ok(loaded.primitives.every(primitive=>primitive.vertex.disposals===0),'Original model buffers remain model-owned');
});

test('TAA preserves animated storage vertices and releases static copies when deformation changes',async()=>{
  const value=scene(),loaded=model(1),device=value.engine.gpu;value.resources.models.add(loaded);
  const view=render(tree(value,h(TAA)));await flush();const source=[...value.engine.plugins.get('taa').sources][0],copy=source.shadowPrimitives[0].vertex;
  const deformed={size:240,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.STORAGE,disposals:0,destroy(){this.disposals++;}};
  loaded.primitives[0].deformed=deformed;for(const callback of value.frames.callbacks)callback(value.engine,0.016);
  assert.equal(source.shadowPrimitives[0].vertex,deformed);assert.equal(copy.disposals,1);assert.equal(device.buffers.length,1);
  const replacement={...deformed};loaded.primitives[0].deformed=replacement;assert.equal(source.shadowPrimitives[0].vertex,replacement);assert.equal(device.buffers.length,1);
  loaded.primitives[0].deformed=undefined;const next=source.shadowPrimitives[0].vertex;assert.notEqual(next,copy);assert.equal(device.buffers.length,2);
  view.unmount();await flush();assert.equal(next.disposals,1);assert.equal(deformed.disposals,0);assert.equal(replacement.disposals,0);
});

test('TAA replaces owned copies after device restoration and model buffer replacement without losing primitive identity',async()=>{
  const value=scene(),loaded=model(2);value.resources.models.add(loaded);render(tree(value,h(TAA)));await flush();
  const source=[...value.engine.plugins.get('taa').sources][0],oldDevice=value.engine.gpu,old=source.shadowPrimitives.map(primitive=>primitive.vertex);
  value.engine.gpu=gpu();loaded.primitives.forEach(primitive=>{primitive.vertex={...primitive.vertex};primitive.index={...primitive.index};});
  for(const callback of value.frames.callbacks)callback(value.engine,0.016);
  const next=source.shadowPrimitives;assert.ok(old.every(buffer=>buffer.disposals===1));assert.equal(oldDevice.writes.length,2);assert.equal(value.engine.gpu.writes.length,2);
  assert.ok(next.every((primitive,index)=>primitive.index===loaded.primitives[index].index&&primitive.vertex!==old[index]));
  const replaced=next[0].vertex;loaded.primitives[0].vertex={...loaded.primitives[0].vertex};
  const refreshed=source.shadowPrimitives;assert.equal(replaced.disposals,1);assert.notEqual(refreshed[0].vertex,replaced);assert.equal(refreshed[1].vertex,next[1].vertex);
  value.resources.models.delete(loaded);for(const callback of value.frames.callbacks)callback(value.engine,0.016);
  assert.equal(source.disposed,true);assert.ok(value.engine.gpu.buffers.every(buffer=>buffer.disposals===1));
});

test('TAA shares one static upload across primitives sharing a GPU vertex buffer and prunes removed primitives',async()=>{
  const value=scene(),loaded=model(2);loaded.primitives[1].vertex=loaded.primitives[0].vertex;loaded.primitives[1].vertices=loaded.primitives[0].vertices;
  value.resources.models.add(loaded);render(tree(value,h(TAA)));await flush();const source=[...value.engine.plugins.get('taa').sources][0],primitives=source.shadowPrimitives;
  assert.equal(primitives[0].vertex,primitives[1].vertex);assert.notEqual(primitives[0].index,primitives[1].index);assert.equal(value.engine.gpu.writes.length,1);
  loaded.primitives[0].material.settings[0]=2;assert.equal(source.shadowPrimitives.length,1);assert.equal(primitives[0].vertex.disposals,0);
  loaded.primitives[1].material.settings[0]=2;assert.deepEqual(source.shadowPrimitives,[]);assert.equal(primitives[0].vertex.disposals,1);
});

test('TAA adapter cleans partial upload failures and refuses stale CPU data for non-storage deformation',async()=>{
  const value=scene(),loaded=model(1);value.resources.models.add(loaded);value.engine.gpu.failUpload=true;
  render(tree(value,h(TAA)));await flush();assert.equal(value.engine.plugins.size,0);assert.equal(value.errors.length,1);assert.match(value.errors[0].message,/Upload failed/);assert.equal(value.engine.gpu.buffers[0].disposals,1);
  const second=scene(),deforming=model(1);deforming.primitives[0].deformed={size:240,usage:GPUBufferUsage.VERTEX};second.resources.models.add(deforming);
  render(tree(second,h(TAA)));await flush();assert.equal(second.engine.plugins.size,0);assert.equal(second.engine.gpu.buffers.length,0);assert.match(second.errors[0].message,/storage-capable deformed buffer/);
});

test('the native capture ownership restrictions reject the documented conflicting pass combination before attachment',async()=>{
  const value=scene(),errors=[],before=effects.length;
  render(tree(value,[h(Bloom,{key:'b'}),h(SSAO,{key:'s'}),h(DepthOfField,{key:'d'})],{onError:error=>errors.push(error)}));await flush();
  assert.equal(effects.length,before);assert.equal(errors.length,1);assert.match(errors[0].message,/own scene capture/);assert.equal(value.errors.length,0);
  assert.throws(()=>new NativeBloom().setup({gpu:{},hasPlugin:name=>name==='ssao'}),/owns the output target/);
  assert.throws(()=>new NativeSSAO().setup({gpu:{},hasPlugin:name=>name==='bloom'}),/owns the output target/);
  assert.throws(()=>new NativeDOF().setup({gpu:{},hasPlugin:name=>name==='ssao'}),/owns scene capture/);
});

test('ownership checks reject conflicting capture pairs, duplicate passes and redundant Bloom tonemapping',async()=>{
  for(const [children,pattern] of [
    [[h(Bloom,{key:'b'}),h(DepthOfField,{key:'d'})],/own scene capture/],
    [[h(SSAO,{key:'s'}),h(DepthOfField,{key:'d'})],/own scene capture/],
    [[h(Bloom,{key:'b'}),h(Tonemap,{key:'t'})],/already owns tone mapping/],
    [[h(Bloom,{key:'a'}),h(Bloom,{key:'b'})],/duplicate bloom/],
    [[h(SSAO,{key:'s'}),h(Tonemap,{key:'t'})],/explicit HDR source/],
  ]) {
    const value=scene(),view=render(tree(value,children));await flush();assert.equal(value.engine.plugins.size,0);assert.equal(value.errors.length,1);assert.match(value.errors[0].message,pattern);view.unmount();await flush();
  }
});

test('native option validation errors reach pass onError with no plugin leak',async()=>{
  const value=scene(),errors=[];render(tree(value,h(Bloom,{strength:-1,onError:error=>errors.push(error)})));await flush();
  assert.equal(value.engine.plugins.size,0);assert.equal(errors.length,1);assert.match(errors[0].message,/Invalid bloom options/);assert.equal(value.errors.length,0);
});

test('missing optional peers report the original import failure once to pass, composer or engine onError',async()=>{
  const source=`import assert from 'node:assert/strict';
    import {registerHooks} from 'node:module';import React from 'react';import {JSDOM} from 'jsdom';
    registerHooks({resolve(specifier,context,next){if(specifier==='@margoengine/post/bloom'){const error=new Error('Cannot find optional peer @margoengine/post/bloom');error.code='ERR_MODULE_NOT_FOUND';throw error;}return next(specifier,context);}});
    const dom=new JSDOM('<!doctype html><html><body></body></html>');
    for(const key of ['window','document','HTMLElement','HTMLCanvasElement','navigator'])Object.defineProperty(globalThis,key,{configurable:true,value:dom.window[key]});
    globalThis.IS_REACT_ACT_ENVIRONMENT=true;
    const {Context}=await import(${JSON.stringify(new URL('../dist/internal.js',import.meta.url).href)});
    const {EffectComposer,Bloom}=await import('@margoengine/react/post');
    const {render,act,cleanup}=await import('@testing-library/react');const h=React.createElement;
    for(const destination of ['pass','composer','engine']){
      const received={pass:[],composer:[],engine:[]};
      const scene={engine:{backend:'webgpu',gpu:{},disposed:false,onError:error=>received.engine.push(error)},resources:{models:new Set()},frames:{callbacks:new Set()}};
      render(h(Context.Provider,{value:scene},h(EffectComposer,{onError:destination==='engine'?undefined:error=>received.composer.push(error)},h(Bloom,{onError:destination==='pass'?error=>received.pass.push(error):undefined}))));
      await act(async()=>{});
      for(const level of ['pass','composer','engine'])assert.equal(received[level].length,level===destination?1:0,destination+' receives exactly one report');
      assert.equal(received[destination][0].code,'ERR_MODULE_NOT_FOUND');assert.match(received[destination][0].message,/Cannot find optional peer/);
      cleanup();await act(async()=>{});assert.equal(scene.frames.callbacks.size,0);
    }
    console.log('Missing-peer errors preserve per-pass precedence and report once');`;
  const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','--eval',source],{cwd:fileURLToPath(new URL('../../..',import.meta.url)),maxBuffer:1024*1024});
  assert.match(stdout,/Missing-peer errors preserve per-pass precedence/);
});

test('WebGL canvases report the WebGPU requirement without attaching optional plugins',async()=>{
  const value=scene('webgl2'),before=effects.length;render(tree(value,h(Bloom)));await flush();assert.equal(effects.length,before);assert.equal(value.errors.length,1);assert.match(value.errors[0].message,/requires WebGPU/);
});

test('composer disabling disposes passes and re-enabling creates fresh plugins',async()=>{
  const value=scene(),child=h(Bloom);const view=render(tree(value,child));await flush();const first=value.engine.plugins.get('bloom');
  view.rerender(tree(value,child,{enabled:false}));await flush();assert.equal(first.disposals,1);assert.equal(value.engine.plugins.size,0);
  view.rerender(tree(value,child,{enabled:true}));await flush();assert.ok(value.engine.plugins.get('bloom'));assert.notEqual(value.engine.plugins.get('bloom'),first);
});

test('unmount while optional imports are in flight prevents late plugin creation',async()=>{
  const value=scene(),before=effects.length;const view=render(tree(value,h(Bloom)));
  await act(async()=>{await Promise.resolve();await Promise.resolve();view.unmount();});await flush();
  assert.equal(effects.length,before);assert.equal(value.engine.plugins.size,0);assert.equal(value.frames.callbacks.size,0);
});

test('post components require their composer and composer requires a scene',()=>{
  assert.throws(()=>renderToString(h(Bloom)),/require <EffectComposer>/);
  assert.throws(()=>renderToString(h(EffectComposer)),/require <Canvas>/);
});
