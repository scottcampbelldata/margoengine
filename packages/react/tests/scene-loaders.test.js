import test,{afterEach,mock} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import React,{StrictMode,Suspense} from 'react';

const engines=[],models=[],requests=[];
let deferred=false;
function mesh(engine){const node={engine,id:engine.next++,visible:true,setPosition(v){this.position=[...v];return this;},setRotation(v){this.rotation=[...v];return this;},setScale(v){this.scale=[...v];return this;},setParent(parent){this.parent=parent;return this;},dispose(){engine.meshes.delete(this.id);}};engine.meshes.set(node.id,node);return node;}
mock.module('@margoengine/core/extension',{namedExports:{
  Engine:{async create(canvas){const engine={canvas,next:0,meshes:new Map(),plugins:new Map(),callbacks:new Set(),camera:{},disposed:false,start(){},onFrame(callback){this.callbacks.add(callback);return()=>this.callbacks.delete(callback);},use(plugin){assert.ok(!this.plugins.has(plugin.name));this.plugins.set(plugin.name,plugin);return this;},removePlugin(name){const plugin=this.plugins.get(name);this.plugins.delete(name);plugin?.dispose();},dispose(){if(this.disposed)return;this.disposed=true;for(const name of this.plugins.keys())this.removePlugin(name);this.callbacks.clear();},createMesh(){return mesh(this);}};engines.push(engine);return engine;}},
  Mesh:class{},PbrMaterial:class{},box(){},engineRuntime:engine=>engine,meshRuntime:node=>node,
}});
function model(engine,asset={doc:{images:[]}}){const result={name:'loader:'+models.length,asset,root:mesh(engine),nodes:[],primitives:[],disposed:false,disposals:0,addLighting(){return()=>{};},dispose(){if(this.disposed)return;this.disposed=true;this.disposals++;engine.removePlugin(this.name);this.root.dispose();}};models.push(result);return result;}
async function load(kind,engine,src,{signal}){const request={kind,engine,src,signal};requests.push(request);if(deferred)await new Promise((resolve,reject)=>Object.assign(request,{resolve,reject}));const result=model(engine);engine.use(result);return result;}
mock.module('@margoengine/gltf-pro',{namedExports:{PBRModel:class{constructor(engine,asset){return model(engine,asset);}},loadGLTF:(...args)=>load('gltf',...args)}});
mock.module('@margoengine/fbx',{namedExports:{loadFBX:(...args)=>load('fbx',...args)}});
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost'});
for(const key of ['window','document','navigator','HTMLElement','HTMLCanvasElement'])Object.defineProperty(globalThis,key,{configurable:true,value:dom.window[key]});
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
globalThis.ResizeObserver=class{observe(){}disconnect(){}};
const {render,act,cleanup}=await import('@testing-library/react');
const {Canvas,Model}=await import('@margoengine/react');
const {Fbx,Gltf,preload}=await import('@margoengine/react/kit');
const tree=child=>React.createElement(StrictMode,null,React.createElement(Canvas,null,React.createElement(Suspense,{fallback:React.createElement('p',null,'Loading')},child)));
const flush=()=>act(async()=>{});
afterEach(async()=>{cleanup();deferred=false;for(const request of requests)request.resolve?.();await flush();assert.ok(models.every(value=>value.disposals===1));assert.ok(engines.every(value=>value.disposed&&value.meshes.size===0&&value.plugins.size===0));});

test('kit Gltf keeps the existing Model identity and native FBX loader suspends once in StrictMode',async()=>{
  assert.equal(Gltf,Model);deferred=true;const before=requests.length,loaded=[];
  const view=render(tree(React.createElement(Fbx,{src:'/character.fbx',position:[1,2,3],onLoad:node=>loaded.push(node)})));await flush();
  assert.equal(view.getByText('Loading').tagName,'P');assert.equal(requests.length,before+1);assert.equal(requests.at(-1).kind,'fbx');
  await act(async()=>requests.at(-1).resolve());await flush();assert.equal(view.queryByText('Loading'),null);assert.equal(loaded.length,1);assert.deepEqual(loaded[0].position,[1,2,3]);
});
test('an empty Model still completes its load callback with the transformed root',async()=>{
  const loaded=[];
  render(tree(React.createElement(Model,{src:'/empty-audit.glb',position:[2,3,4],onLoad:node=>loaded.push(node)})));
  await flush();
  assert.equal(models.at(-1).primitives.length,0);
  assert.equal(loaded.length,1);
  assert.equal(loaded[0],models.at(-1).root);
  assert.deepEqual(loaded[0].position,[2,3,4]);
});

test('FBX preload and independent remounts share the native URL cache',async()=>{
  const before=requests.length;const view=render(tree(null));await flush();await act(async()=>preload('/preloaded.FBX?version=1'));
  assert.equal(requests.length,before+1);assert.equal(requests.at(-1).kind,'fbx');assert.ok(models.at(-1).disposed,'preloading must not display an attached model');
  view.rerender(tree(React.createElement(Fbx,{src:'/preloaded.FBX?version=1',position:[4,0,0]})));await flush();const first=models.at(-1);assert.deepEqual(first.root.position,[4,0,0]);
  view.rerender(tree(null));await flush();assert.equal(first.disposals,1);
  view.rerender(tree(React.createElement(Fbx,{src:'/preloaded.FBX?version=1',position:[5,0,0]})));await flush();assert.notEqual(models.at(-1),first);assert.deepEqual(models.at(-1).root.position,[5,0,0]);assert.equal(requests.length,before+1);
});
test('removing a pending FBX aborts without notifying onLoad and disposes a late model',async()=>{
  deferred=true;let loaded=0;const view=render(tree(React.createElement(Fbx,{src:'/aborted.fbx',onLoad:()=>loaded++})));await flush();const request=requests.at(-1);
  view.rerender(tree(null));await flush();assert.equal(request.signal.aborted,true);await act(async()=>request.resolve());assert.equal(loaded,0);assert.equal(models.at(-1).disposals,1);
});
test('FBX load errors report through both component and Canvas callbacks without a retry loop',async()=>{
  deferred=true;const errors=[],failure=new Error('Invalid native FBX');const view=render(React.createElement(Canvas,{onError:error=>errors.push(error)},React.createElement(Suspense,{fallback:'Loading'},React.createElement(Fbx,{src:'/invalid.fbx',onError:error=>errors.push(error)}))));await flush();
  await act(async()=>requests.at(-1).reject(failure));await flush();assert.deepEqual(errors,[failure,failure]);assert.match(view.getByRole('alert').textContent,/Invalid native FBX/);
});
