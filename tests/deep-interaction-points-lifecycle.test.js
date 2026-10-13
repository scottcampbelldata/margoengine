import test from 'node:test';
import assert from 'node:assert/strict';
import {PointsPlugin,PointCloud} from '../packages/points/dist/index.js';
import {optionalGPU} from './support/optional-gpu.js';

function harness(){
  const h=optionalGPU();globalThis.GPUShaderStage={VERTEX:1,FRAGMENT:2};h.engine.canvas={width:128,height:96,clientWidth:128,clientHeight:96};
  h.engine.gpu.createBindGroupLayout=value=>value;h.engine.gpu.createPipelineLayout=value=>value;h.engine.gpu.queue.copyExternalImageToTexture=()=>{};return h;
}

test('points setup releases resources if a later GPU object fails before the resource record exists',()=>{
  for(const method of ['createBindGroup','createSampler']){
    const h=harness(),failure=new Error(method+' failed');h.engine.gpu[method]=()=>{throw failure;};
    const points=new PointsPlugin();assert.throws(()=>h.engine.use(points),error=>error===failure);assert.ok(h.resources.length>=2);assert.ok(h.resources.every(r=>r.destroyed),'Failed setup leaked native resources');
  }
});

test('points rejects a failed image upload without retaining its texture and can retry the same source',()=>{
  const h=harness(),points=new PointsPlugin(),failure=new Error('cross-origin image');h.engine.use(points);
  const cloud=points.add(new PointCloud({positions:new Float32Array([0,0,0.5]),material:{map:{width:2,height:2}}}));
  try{
    h.engine.gpu.queue.copyExternalImageToTexture=()=>{throw failure;};assert.throws(()=>h.frame(),error=>error===failure);
    const failed=h.resources.filter(r=>r.format==='rgba8unorm-srgb');assert.equal(failed.length,1);assert.equal(failed[0].destroyed,true);
    h.engine.gpu.queue.copyExternalImageToTexture=()=>{};h.frame();assert.equal(points.stats.pointsDrawn,1);assert.equal(points.stats.drawCalls,1);assert.equal(cloud.count,1);
  }finally{points.dispose();}assert.ok(h.resources.every(r=>r.destroyed));
});
