import test from 'node:test';
import assert from 'node:assert/strict';
import {adaptiveResolution}from'../dist/adaptive-resolution.js';
import {bridgeFrames,FrameCallbacks}from'../dist/frame-priority.js';
function fixture(){
 const draws=[],picks=[],textures=[],submits=[],plugins=new Map(),camera={};
 const device={createTexture(descriptor){const texture={...descriptor,width:descriptor.size[0],height:descriptor.size[1],destroyed:false,createView(){return{texture}},destroy(){this.destroyed=true}};textures.push(texture);return texture},createShaderModule(){return{}},createRenderPipeline(){return{getBindGroupLayout(){return{}}}},createBindGroup(d){return d},createSampler(d){return d},createCommandEncoder(){return{beginRenderPass(){return{setPipeline(){},setBindGroup(){},draw(){},end(){}}},finish(){return{}}}},queue:{submit(value){submits.push(value)}}};
 const scene={use(plugin){plugins.set(plugin.name,plugin);plugin.setup(engine)},removePlugin(name){const plugin=plugins.get(name);plugins.delete(name);plugin?.dispose()}};
 const engine={backend:'webgpu',gpu:device,renderTarget:{samples:4,format:'bgra8unorm'},canvas:{width:256,height:256,clientWidth:256,clientHeight:256,getContext(){return{getCurrentTexture(){return{createView(){return{}}}}}}},camera,scene,render(options){draws.push(options)},onFrame(){return()=>{}},pick(x,y,view){picks.push({x,y,view});return Promise.resolve({id:42})}};
 const frames={callbacks:new FrameCallbacks(),elapsed:0},release=bridgeFrames(engine,frames);
 return{engine,frames,draws,picks,textures,submits,plugins,close(){for(const plugin of plugins.values())plugin.dispose();release()}};
}
test('adaptive targets isolate Canvases, share the minimum hold and preserve native restore, picking and pending disposal',async()=>{
 const a=fixture(),b=fixture();const original=a.engine.pick;
 let scale=0.5;
 const stop=adaptiveResolution(a.engine,a.frames,()=>scale,false),second=adaptiveResolution(a.engine,a.frames,()=>0.75,true);
 try{
  a.engine.render();b.engine.render();assert.equal(a.textures[0].width,128);assert.equal(b.textures.length,0);assert.equal(a.submits.length,1);
  await a.engine.pick(128,128);assert.equal(a.picks[0].x,128);assert.deepEqual(a.picks[0].view.viewport,[0,0,1,1]);assert.equal(a.picks[0].view.target,undefined);
  scale=1;a.engine.render();assert.equal(a.textures.at(-1).width,192);assert.equal(a.textures[0].destroyed,true);
  second();a.engine.render();assert.equal(a.draws.at(-1),undefined);assert.equal(a.textures.at(-1).destroyed,true);
  scale=0.5;a.engine.render();stop();assert.equal(a.textures.at(-1).destroyed,true);
  assert.notEqual(a.engine.pick,original);await a.engine.pick(128,128);assert.equal(a.picks.at(-1).view.target,undefined);
  a.engine.render();assert.equal(a.engine.pick,original);assert.equal(a.plugins.size,0);
 }finally{a.close();b.close()}
});
test('pixel views, scissor, scene and layer ownership survive scaling; offscreen owners and restored devices remain independent',()=>{
 const a=fixture(),stop=adaptiveResolution(a.engine,a.frames,()=>0.5,false),world={},clear={color:'#123456'},target={color:{width:64,height:64}};
 const view={camera:a.engine.camera,scene:world,viewport:[32,16,192,224],scissor:[64,32,128,128],pixels:true,layers:2,clear};
 try{
  a.engine.render({views:[view]});const scaled=a.draws.at(-1).views[0];assert.deepEqual(scaled.viewport,[16,8,96,112]);assert.deepEqual(scaled.scissor,[32,16,64,64]);assert.equal(scaled.scene,world);assert.equal(scaled.clear,clear);assert.equal(scaled.layers,2);
  const count=a.textures.length;a.engine.render({views:[{...view,target}]});assert.equal(a.draws.at(-1).views[0].target,target);assert.equal(a.textures.length,count);
  a.plugins.values().next().value.onDeviceRestored();assert.equal(a.textures.at(-1).destroyed,true);a.engine.render();assert.equal(a.textures.length,count+1);
 }finally{stop();a.close()}
});
