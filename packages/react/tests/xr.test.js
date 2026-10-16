import test,{afterEach,mock} from 'node:test';
import assert from 'node:assert/strict';
import React,{StrictMode} from 'react';
import {engines,render,act,flush,close,near} from './physics-xr-support.js';
const managers=[],requests=[];let deferCreate=false,failCreate=null;
class Manager {
  static async create(engine){if(failCreate)throw failCreate;const manager=new Manager(engine);managers.push(manager);if(deferCreate)await new Promise(resolve=>manager.resolve=resolve);if(engine.disposed)return manager;engine.use(manager);return manager;}
  constructor(engine){this.engine=engine;this.name='xr';this.session=null;this.controllers=[];this.disposals=0;}
  setup(){}
  requestSession(mode,options){assert.equal(this.disposals,0);requests.push({manager:this,mode,options});this.options=options;this.session=new Session;return Promise.resolve(this.session);}
  async end(){if(this.session){const session=this.session;this.session=null;await session.end();}}
  dispose(){if(this.disposals)return;this.disposals++;void this.end();if(this.engine.hasPlugin(this.name))this.engine.removePlugin(this.name);}
}
class Session extends EventTarget {constructor(){super();this.ends=0;this.listeners=new Map();}addEventListener(type,handler,options){let list=this.listeners.get(type);if(!list)this.listeners.set(type,list=new Set());list.add(handler);super.addEventListener(type,handler,options);}removeEventListener(type,handler){this.listeners.get(type)?.delete(handler);super.removeEventListener(type,handler);}async end(){this.ends++;this.dispatchEvent(new Event('end'));}}
mock.module('@margoengine/xr',{namedExports:{XR:Manager}});
const {Canvas,Mesh,BoxGeometry,useFrame,useMargo}=await import('../dist/index.js');
const {XR,Controller,useXR}=await import('../dist/xr.js');
const {worldPose}=await import('../dist/scene-transform.js');
const h=React.createElement,tree=children=>h(StrictMode,null,h(Canvas,{frameloop:'demand'},children));
const pose=(x,y,z)=>({transform:{position:{x,y,z,w:1},orientation:{x:0,y:0,z:0,w:1}}});
afterEach(async()=>{deferCreate=false;failCreate=null;for(const manager of managers)manager.resolve?.();await close();for(const manager of managers)assert.equal(manager.disposals,1);});

test('XR prepares once in StrictMode and enters only when useXR().enter is called explicitly',async()=>{
  let context,ready=0;function Probe(){context=useXR();return null;}
  const before=requests.length,view=render(tree(h(XR,{mode:'immersive-ar',onReady:()=>ready++},h(Probe),h(Controller))));await flush();
  assert.equal(ready,1);assert.equal(context.ready,true);assert.equal(context.manager,managers.at(-1));assert.equal(requests.length,before,'mount never requests browser permission');
  let session;await act(async()=>{const result=context.enter();assert.equal(requests.length,before+1,'requestSession is invoked synchronously in the user gesture');session=await result;});
  assert.equal(requests.at(-1).mode,'immersive-ar');assert.equal(context.session,session);
  view.unmount();await flush();assert.equal(session.ends,1);assert.equal(engines.at(-1).hasPlugin('xr'),false);
});

test('XR session exit and browser end clear context and detach Controller event listeners',async()=>{
  let context,starts=0,ends=0;function Probe(){context=useXR();return null;}
  render(tree(h(XR,{onSessionStart:()=>starts++,onSessionEnd:()=>ends++},h(Probe),h(Controller))));await flush();
  let session;await act(async()=>{session=await context.enter('inline');});assert.equal(starts,1);assert.ok(session.listeners.get('select').size===1);
  await act(async()=>context.exit());await flush();assert.equal(ends,1);assert.equal(context.session,null);assert.equal(session.listeners.get('select').size,0);
  await act(async()=>{session=await context.enter('inline');});await act(async()=>session.end());assert.equal(ends,2);assert.equal(context.session,null);
});

test('Controller binds handedness, parent-local transforms and native selection events',async()=>{
  let context,connected=0,disconnected=0,selected=0,frames=0;function Probe(){context=useXR();return null;}
  render(tree(h(XR,null,h(Probe),h(Mesh,{position:[10,0,0],scale:[2,2,2]},h(Controller,{handedness:'right',onConnected:()=>connected++,onDisconnected:()=>disconnected++,onSelect:()=>selected++,onFrame:()=>frames++},h(Mesh,null,h(BoxGeometry)))))));await flush();
  let session;await act(async()=>{session=await context.enter('inline');});
  const manager=managers.at(-1),left={source:{handedness:'left'},grip:pose(100,0,0),targetRay:null},right={source:{handedness:'right'},grip:pose(14,2,0),targetRay:null};
  await act(async()=>manager.options.onFrame({time:0,delta:0,frame:{session},viewer:null,inputs:[left,right]}));
  const engine=engines.at(-1),controller=[...engine.meshes.values()].find(mesh=>!mesh.geometry&&engine.store.parents[mesh.id]!==-1);
  assert.equal(connected,1);assert.equal(frames,1);near(controller.position.x,2);near(controller.position.y,1);near(worldPose(controller).position[0],14);assert.equal(controller.visible,true);
  const event=new Event('select');event.inputSource=right.source;await act(async()=>session.dispatchEvent(event));assert.equal(selected,1);
  const other=new Event('select');other.inputSource=left.source;await act(async()=>session.dispatchEvent(other));assert.equal(selected,1);
  await act(async()=>manager.options.onFrame({time:1,delta:0,frame:{session},viewer:null,inputs:[]}));assert.equal(disconnected,1);assert.equal(controller.visible,false);
});

test('Controller falls back to target ray poses and forwards fresh callbacks without reinitializing XR',async()=>{
  let context,first=0,second=0;function Probe(){context=useXR();return null;}
  const scene=callback=>tree(h(XR,{onFrame:callback},h(Probe),h(Controller,{pose:'targetRay'})));
  const view=render(scene(()=>first++));await flush();await act(async()=>context.enter('inline'));const manager=managers.at(-1),source={handedness:'none'};
  const frame={time:0,delta:0,frame:{session:manager.session},viewer:null,inputs:[{source,targetRay:pose(1,2,3),grip:null}]};
  await act(async()=>manager.options.onFrame(frame));view.rerender(scene(()=>second++));await flush();await act(async()=>manager.options.onFrame(frame));assert.equal(first,1);assert.equal(second,1);assert.equal(context.manager,manager);
});

test('immersive XR drives useFrame and clock once per native frame and restores demand rendering after exit',async()=>{
  let context,margo,count=0,delta;function Probe(){context=useXR();margo=useMargo();useFrame((_,value)=>{count++;delta=value;});return null;}
  render(tree(h(XR,null,h(Probe))));await flush();await act(async()=>context.enter('immersive-vr'));const manager=managers.at(-1),engine=engines.at(-1);
  await act(async()=>manager.options.onFrame({time:0,delta:0.02,frame:{session:manager.session},viewer:null,inputs:[]}));assert.equal(count,1);assert.equal(delta,0.02);near(margo.clock,0.02);
  // The underlying native manager resumes the desktop engine on end. The React provider
  // immediately stops that loop again for demand canvases.
  let stops=0;engine.stop=()=>{stops++;};await act(async()=>context.exit());assert.ok(stops>=1);
  await act(async()=>context.enter('inline'));await act(async()=>manager.options.onFrame({time:1,delta:0.03,frame:{session:manager.session},viewer:null,inputs:[]}));assert.equal(count,1,'inline sessions already use the engine desktop frame loop');near(margo.clock,0.02);
});

test('an XR manager prepared after unmount is disposed without requesting a session',async()=>{
  deferCreate=true;const before=requests.length,view=render(tree(h(XR,null,h(Controller))));await flush();const manager=managers.at(-1);assert.equal(typeof manager.resolve,'function');view.unmount();await flush();await act(async()=>manager.resolve());assert.equal(manager.disposals,1);assert.equal(requests.length,before);
});

test('XR initialization errors reach the explicit error handler',async()=>{
  failCreate=new Error('WebXR unavailable');const errors=[];render(tree(h(XR,{onError:error=>errors.push(error)})));await flush();assert.equal(errors.length,1);assert.equal(errors[0],failCreate);
});
