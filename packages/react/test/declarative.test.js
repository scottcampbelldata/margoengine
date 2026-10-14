import test, {mock, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import React, {StrictMode} from 'react';
import {renderToString} from 'react-dom/server';

const engines=[],models=[],environments=[],backgrounds=[],controls=[],shadows=[],requests=[],imageRequests=[],observers=[];
let deferModel=false,deferEnvironment=false,modelFailure=null;
const pendingModels=[],pendingEnvironments=[];
function resource() {return {destroyed:0,destroy(){this.destroyed++;}};}
function mesh(engine) {
  const node={engine,id:engine.next++,position:[0,0,0],rotation:[0,0,0],scale:[1,1,1],disposed:false,
    setPosition(value){this.position=[...value];return this;},setRotation(value){this.rotation=[...value];return this;},setScale(value){if(value.includes(0))throw new RangeError('Scale must be nonzero');this.scale=[...value];return this;},setParent(parent){this.parent=parent;return this;},
    dispose(){if(this.disposed)return;this.disposed=true;engine.meshes.delete(this.id);}};
  engine.meshes.set(node.id,node);return node;
}
mock.module('@margoengine/core/extension',{namedExports:{
  Engine:{async create(canvas,options){
    const engine={canvas,options,next:0,meshes:new Map(),plugins:new Map(),callbacks:new Set(),errors:[],disposed:false,disposals:0,
      camera:{position:[0,2,5],target:[0,0,0],fov:60,...options.camera},lighting:{direction:new Float32Array([1,2,3,2]),radiance:new Float32Array([0.8,0.7,0.6,0.2])},
      createMesh(){return mesh(this);},start(){this.started=true;},
      use(plugin){assert.ok(!this.disposed);assert.ok(!this.plugins.has(plugin.name));plugin.setup?.(this);this.plugins.set(plugin.name,plugin);return this;},
      removePlugin(name){const plugin=this.plugins.get(name);this.plugins.delete(name);plugin?.dispose?.();},hasPlugin(name){return this.plugins.has(name);},
      onFrame(callback){this.callbacks.add(callback);return()=>this.callbacks.delete(callback);},
      dispose(){if(this.disposed)return;this.disposals++;this.disposed=true;for(const name of this.plugins.keys())this.removePlugin(name);for(const node of this.meshes.values())node.dispose();this.callbacks.clear();}};
    engines.push(engine);return engine;
  }},Mesh:class {},box(){},PbrMaterial:class {},engineRuntime:engine=>engine,meshRuntime:node=>node,
}});
mock.module('@margoengine/gltf-pro',{namedExports:{async loadGLTF(engine,src,{signal}){
  requests.push({src,signal});if(modelFailure)throw modelFailure;
  const material={name:'Upper',base:[1,0.5,0.25,0.8],factors:[0.6,0.4,1,1],emission:[0,0,0],settings:[0,0.5,0,0],maps:[]};
  const model={name:'model:'+models.length,root:mesh(engine),nodes:[mesh(engine)],primitives:[{material},{material}],lighting:new Set(),disposed:false,disposals:0,buffers:[resource(),resource()],textures:[resource()],
    addLighting(effect){assert.ok(!this.disposed);this.lighting.add(effect);return()=>this.lighting.delete(effect);},get shadowPrimitives(){return [];},
    dispose(){if(this.disposed)return;this.disposed=true;this.disposals++;engine.removePlugin(this.name);this.lighting.clear();this.root.dispose();for(const node of this.nodes)node.dispose();for(const owned of [...this.buffers,...this.textures])owned.destroy();}};
  models.push(model);engine.use(model);
  if(deferModel)await new Promise(resolve=>pendingModels.push(resolve));return model;
}}});
mock.module('@margoengine/environment',{namedExports:{
  async loadEnvironmentImage(src,{signal}){imageRequests.push({src,signal});return {};},
  Environment:{async create(engine){
    const environment={name:'environment',intensity:1,disposed:false,disposals:0,version:0,listeners:new Set(),device:{},specularView:{version:0},sampler:{},brdfLutView:{},shBuffer:{},paramsBuffer:{},buffers:[resource(),resource()],textures:[resource(),resource(),resource()],
      onChange(callback){this.listeners.add(callback);return()=>this.listeners.delete(callback);},
      restore(){this.version++;this.specularView={version:this.version};for(const callback of this.listeners)callback(this);},
      dispose(){if(this.disposed)return;this.disposed=true;this.disposals++;for(const owned of [...this.buffers,...this.textures])owned.destroy();this.listeners.clear();}};
    environments.push(environment);if(deferEnvironment)await new Promise(resolve=>pendingEnvironments.push(resolve));return environment;
  }},
  EnvironmentBackground:class {
    constructor(environment){this.name='environment:background';this.environment=environment;this.exposure=1;this.buffer=resource();backgrounds.push(this);}
    dispose(){if(this.disposed)return;this.disposed=true;this.buffer.destroy();}
  },EnvironmentLighting:(await import('../../environment/dist/index.js')).EnvironmentLighting??assert.fail('Stale @margoengine/environment dist: run npm run build:packages'),
}});
mock.module('@margoengine/controls',{namedExports:{OrbitControls:class {
  constructor(camera,canvas){this.camera=camera;this.canvas=canvas;this.updates=[];this.listener=()=>{};canvas.addEventListener('pointerdown',this.listener);this.disposals=0;controls.push(this);}
  update(delta){this.updates.push(delta);}
  dispose(){if(this.disposals)return;this.disposals++;this.canvas.removeEventListener('pointerdown',this.listener);}
}}});
mock.module('@margoengine/shadows',{namedExports:{Shadows:class {
  static attach(engine){const effect=new this();effect.owner=engine;effect.name='shadows';effect.sources=new Set();effect.buffer=resource();effect.texture=resource();effect.disposals=0;engine.use(effect);shadows.push(effect);return effect;}
  add(source){this.sources.add(source);return()=>this.sources.delete(source);}
  bindings(){return [1,2,3].map(binding=>({binding,resource:{}}));}
  shader(source){const result=source.replace('direct+ambient(s)','direct*shadowVisibility(i.position,s.n)+ambient(s)');assert.notEqual(result,source);return result;}
  dispose(){if(this.disposals)return;this.disposals++;this.owner.removePlugin(this.name);this.sources.clear();this.buffer.destroy();this.texture.destroy();}
}}});
// The React dist is built only by build-modern.js; an older build still carries the private IBL adapter.
assert.match(await readFile(new URL('../dist/components.js',import.meta.url),'utf8'),/EnvironmentLighting/,'Stale @margoengine/react dist: run npm run build:packages');
const {MargoCanvas,MargoContext,Model,Environment,OrbitControls,useMargo,useMargoStage,useFrame}=await import('../dist/index.js');
test('SSR skips all optional resources and hooks reject missing canvas providers',()=>{
  const result=renderToString(React.createElement(MargoCanvas,null,React.createElement(Model,{src:'/model.glb'}),React.createElement(Environment,{src:'/studio.hdr'}),React.createElement(OrbitControls)));
  assert.match(result,/aria-label/);assert.equal(engines.length,0);assert.equal(requests.length,0);
  function Outside(){useMargo();return null;}
  assert.throws(()=>renderToString(React.createElement(Outside)),/requires <MargoCanvas>/);
});
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost'});
for(const key of ['window','document','HTMLElement','HTMLCanvasElement','navigator'])Object.defineProperty(globalThis,key,{configurable:true,value:dom.window[key]});
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
globalThis.ResizeObserver=class {constructor(callback){this.callback=callback;observers.push(this);}observe(canvas){this.canvas=canvas;}disconnect(){this.disconnected=true;}};
const {render,act,cleanup}=await import('@testing-library/react');
const flush=()=>act(async()=>{});
function tree(children,props={}){return React.createElement(StrictMode,null,React.createElement(MargoCanvas,props,children));}
afterEach(()=>{
  cleanup();deferModel=deferEnvironment=false;modelFailure=null;
  assert.ok(engines.every(engine=>engine.disposed&&engine.disposals===1&&engine.callbacks.size===0&&engine.meshes.size===0&&engine.plugins.size===0));
  for(const owned of [...models,...environments]){assert.equal(owned.disposals,1);for(const value of [...owned.buffers,...owned.textures])assert.equal(value.destroyed,1);}
  assert.ok(backgrounds.every(background=>background.disposed&&background.buffer.destroyed===1));
  assert.ok(controls.every(control=>control.disposals===1));assert.ok(observers.every(observer=>observer.disconnected));
});
test('StrictMode provides the Stage facade, preserves the imperative hook and forwards delta unchanged',async()=>{
  let context,kernel,created,delta;
  function Child(){context=useMargo();kernel=useMargoStage();useFrame((engine,value)=>{assert.equal(engine,kernel);delta=value;});return null;}
  const view=render(tree(React.createElement(Child),{camera:{position:[1,2,6],fov:42},onCreated:stage=>{created=stage;assert.deepEqual(stage.engine.camera.position,[1,2,6]);}}));await flush();
  const engine=engines.at(-1),callback=engine.callbacks.values().next().value;
  assert.equal(context.stage,created);assert.equal(context.stage.engine,kernel);assert.equal(context.canvas,engine.canvas);assert.equal(context.ready,true);
  assert.equal(engine.callbacks.size,1);
  for(let i=0;i<100;i++)callback(engine,0.0125);
  assert.equal(delta,0.0125);assert.equal(engine.callbacks.values().next().value,callback);
  view.rerender(tree(React.createElement(Child),{camera:{position:[2,3,7],target:[1,0,0],fov:35}}));
  assert.equal(engines.at(-1),engine);assert.deepEqual(engine.camera.position,[2,3,7]);assert.equal(engine.camera.fov,35);
  view.unmount();assert.equal(created.engine.disposals,1);
});
test('Model prop mutations preserve the load, synchronize transforms and restore removed material overrides',async()=>{
  const before=requests.length,loaded=[];
  const child=props=>React.createElement(Model,{src:'/a.glb',onLoad:node=>loaded.push(node),...props});
  const view=render(tree(child({position:[1,2,3],materials:{Upper:{baseColor:[0.2,0.3,0.4],roughness:0.2}}})));await flush();
  const model=models.at(-1),material=model.primitives[0].material;
  assert.equal(requests.length,before+1);assert.equal(loaded.length,1);assert.equal(loaded[0],model.root);
  assert.deepEqual(model.root.position,[1,2,3]);assert.deepEqual(material.base,[0.2,0.3,0.4,0.8]);
  view.rerender(tree(child({position:[4,5,6],rotation:[0.1,0.2,0.3],scale:[2,3,4],materials:{Upper:{metalness:0.9,emissive:[0.1,0,0],doubleSided:true}}})));
  assert.equal(requests.length,before+1);assert.equal(models.at(-1),model);assert.deepEqual(model.root.position,[4,5,6]);assert.deepEqual(model.root.rotation,[0.1,0.2,0.3]);assert.deepEqual(model.root.scale,[2,3,4]);
  assert.deepEqual(material.base,[1,0.5,0.25,0.8]);assert.equal(material.factors[0],0.6);assert.equal(material.factors[1],0.9);assert.equal(material.settings[2],1);
  view.rerender(tree(child({})));assert.deepEqual(model.root.position,[0,0,0]);assert.deepEqual(model.root.scale,[1,1,1]);assert.equal(material.factors[1],0.4);assert.equal(material.settings[2],0);
  view.rerender(tree(null));await flush();assert.equal(model.disposals,1);assert.equal(engines.at(-1).meshes.size,0);assert.equal(engines.at(-1).hasPlugin(model.name),false);
});
test('changing src or removing Model aborts pending loads and disposes late results without onLoad',async()=>{
  deferModel=true;const loaded=[];
  const view=render(tree(React.createElement(Model,{src:'/old.glb',onLoad:node=>loaded.push(node)})));await flush();
  const old=models.at(-1),oldRequest=requests.at(-1);
  view.rerender(tree(React.createElement(Model,{src:'/new.glb',position:[3,0,0],onLoad:node=>loaded.push(node)})));await flush();
  const current=models.at(-1);assert.ok(oldRequest.signal.aborted);
  await act(async()=>pendingModels.shift()());assert.equal(old.disposals,1);assert.equal(loaded.length,0);
  await act(async()=>pendingModels.shift()());assert.equal(loaded[0],current.root);assert.deepEqual(current.root.position,[3,0,0]);
  view.rerender(tree(React.createElement(Model,{src:'/late.glb',onLoad:node=>loaded.push(node)})));await flush();
  const late=models.at(-1),lateRequest=requests.at(-1);view.rerender(tree(null));assert.ok(lateRequest.signal.aborted);
  await act(async()=>pendingModels.shift()());assert.equal(late.disposals,1);assert.equal(loaded.length,1);
});
test('pending Model reads the latest props and callback on completion',async()=>{
  deferModel=true;let first=0,second=0;
  const view=render(tree(React.createElement(Model,{src:'/pending.glb',onLoad:()=>first++})));await flush();
  view.rerender(tree(React.createElement(Model,{src:'/pending.glb',position:[8,0,0],materials:{Upper:{roughness:0.1}},onLoad:()=>second++})));
  await act(async()=>pendingModels.shift()());assert.equal(first,0);assert.equal(second,1);assert.deepEqual(models.at(-1).root.position,[8,0,0]);assert.equal(models.at(-1).primitives[0].material.factors[0],0.1);
});
test('model errors and throwing onLoad report through the canvas and release all resources',async()=>{
  const errors=[];modelFailure=new Error('fetch failed');
  const view=render(tree(React.createElement(Model,{src:'/missing.glb'}),{onError:error=>errors.push(error)}));await flush();assert.match(view.getByRole('alert').textContent,/fetch failed/);
  modelFailure=null;
  view.rerender(tree(React.createElement(Model,{src:'/callback.glb',onLoad(){throw new Error('callback failed');}}),{onError:error=>errors.push(error)}));await flush();
  assert.match(view.getByRole('alert').textContent,/callback failed/);assert.equal(models.at(-1).disposals,1);assert.equal(errors.length,2);
});
test('invalid initial material overrides report and dispose the model',async()=>{
  const view=render(tree(React.createElement(Model,{src:'/invalid.glb',materials:{Upper:{baseColor:[NaN,0,0]}}})));await flush();
  assert.match(view.getByRole('alert').textContent,/Invalid base color/);assert.equal(models.at(-1).disposals,1);
});
test('studio exposure changes in place and unmount restores previous directional lighting',async()=>{
  const before=environments.length;
  const view=render(tree(React.createElement(Environment,{exposure:2})));await flush();const engine=engines.at(-1);
  assert.equal(environments.length,before);assert.deepEqual([...engine.lighting.radiance],[2,2,2,Math.fround(0.3)]);
  view.rerender(tree(React.createElement(Environment,{exposure:0.5,background:false})));assert.deepEqual([...engine.lighting.radiance],[0.5,0.5,0.5,Math.fround(0.075)]);
  view.rerender(tree(null));assert.deepEqual([...engine.lighting.direction],[1,2,3,2]);assert.deepEqual([...engine.lighting.radiance],[Math.fround(0.8),Math.fround(0.7),Math.fround(0.6),Math.fround(0.2)]);
});
test('HDR exposure and background mutate without reload, models join IBL regardless of mounting order',async()=>{
  const before=imageRequests.length;
  const children=(exposure,background,showModel=true)=>[React.createElement(Environment,{key:'env',src:'/studio.hdr',exposure,background}),showModel&&React.createElement(Model,{key:'model',src:'/lit.glb'})];
  const view=render(tree(children(1,true)));await flush();const environment=environments.at(-1),model=models.at(-1),background=backgrounds.at(-1),effect=[...model.lighting][0];
  assert.equal(model.lighting.size,1);assert.equal(engines.at(-1).plugins.get('environment:lighting'),effect,'core meshes are lit too');const entries=effect.bindings();assert.equal(effect.bindings(),entries);
  environment.restore();assert.notEqual(effect.bindings(),entries);assert.equal(effect.bindings()[0].resource.version,1);
  view.rerender(tree(children(2,true)));assert.equal(environment.intensity,2);assert.equal(background.exposure,2);assert.equal(backgrounds.at(-1),background);assert.equal(imageRequests.length,before+1);
  view.rerender(tree(children(0.5,false)));assert.equal(background.disposed,true);assert.equal(environment.intensity,0.5);assert.equal(model.lighting.size,1);
  view.rerender(tree(children(0.5,true,false)));await flush();assert.equal(model.disposals,1);
  view.rerender(tree(children(0.5,true)));await flush();assert.equal(models.at(-1).lighting.size,1);
  view.rerender(tree(React.createElement(Model,{src:'/lit.glb'})));await flush();assert.equal(environment.disposals,1);assert.equal(models.at(-1).lighting.size,0);assert.equal(environment.listeners.size,0);
});
test('Environment src replacement and unmount destroy environments finishing asynchronously',async()=>{
  deferEnvironment=true;
  const view=render(tree(React.createElement(Environment,{src:'/old.hdr'})));await flush();const old=environments.at(-1),oldRequest=imageRequests.at(-1);
  view.rerender(tree(React.createElement(Environment,{src:'/new.hdr',exposure:3,background:false})));await flush();assert.ok(oldRequest.signal.aborted);
  await act(async()=>pendingEnvironments.shift()());assert.equal(old.disposals,1);
  await act(async()=>pendingEnvironments.shift()());assert.equal(environments.at(-1).intensity,3);
  view.rerender(tree(React.createElement(Environment,{src:'/late.hdr'})));await flush();const late=environments.at(-1);view.unmount();
  await act(async()=>pendingEnvironments.shift()());assert.equal(late.disposals,1);
});
test('shadow flags update registration independently and HDR composes with the shadow shader',async()=>{
  const children=(castShadow,receiveShadow)=>[React.createElement(Model,{key:'model',src:'/shadow.glb',castShadow,receiveShadow}),React.createElement(Environment,{key:'env',src:'/studio.hdr',background:false})];
  const view=render(tree(children(true,true),{shadows:true}));await flush();const model=models.at(-1),effect=shadows.at(-1);
  assert.equal(effect.sources.size,1);assert.equal(model.lighting.size,2);assert.ok(model.lighting.has(effect));
  const source=(await readFile(new URL('../../gltf-pro/src/shader.ts',import.meta.url),'utf8')).split('`')[1];
  const ibl=[...model.lighting].find(value=>value!==effect);
  // The IBL reaches gltf-pro through its lighting hooks (one stable object for steady frames); the mock shadows still patch text.
  const {lightPBR}=await import('../../gltf-pro/src/shader.ts'),hooks=ibl.pbr(2);for(let i=0;i<100;i++)assert.equal(ibl.pbr(2),hooks,'steady frames must reuse the hooks');
  for(const order of [[ibl,effect],[effect,ibl]]){let code=source;for(const lighting of order)code=lighting===ibl?lightPBR(code,lighting.pbr(2)):lighting.shader(code,2);assert.match(code,/shadowVisibility/);assert.match(code,/iblShade\(iblSpecular/);assert.match(code,/@binding\(24\)/);}
  view.rerender(tree(children(false,true),{shadows:true}));assert.equal(effect.sources.size,0);assert.ok(model.lighting.has(effect));
  view.rerender(tree(children(true,false),{shadows:true}));assert.equal(effect.sources.size,1);assert.equal(model.lighting.has(effect),false);
  view.rerender(tree(children(true,true),{shadows:false}));await flush();assert.equal(effect.disposals,1);assert.equal(effect.sources.size,0);assert.equal(model.lighting.size,1);
});
test('OrbitControls retains listeners and its frame subscription across prop mutations, then disposes both',async()=>{
  const view=render(tree(React.createElement(OrbitControls,{autoRotate:true,enableDamping:true,minDistance:1,maxDistance:20})));await flush();
  const control=controls.at(-1),engine=engines.at(-1),callback=engine.callbacks.values().next().value;
  assert.equal(control.camera,engine.camera);assert.equal(control.canvas,engine.canvas);assert.equal(engine.callbacks.size,1);
  callback(engine,0.02);assert.deepEqual(control.updates,[0.02]);
  view.rerender(tree(React.createElement(OrbitControls,{autoRotateSpeed:4,minDistance:2,maxDistance:8})));
  assert.equal(controls.at(-1),control);assert.equal(engine.callbacks.values().next().value,callback);assert.equal(control.autoRotate,false);assert.equal(control.enableDamping,false);assert.equal(control.autoRotateSpeed,4);assert.equal(control.minDistance,2);assert.equal(control.maxDistance,8);
  view.rerender(tree(null));assert.equal(control.disposals,1);assert.equal(engine.callbacks.size,0);
});
