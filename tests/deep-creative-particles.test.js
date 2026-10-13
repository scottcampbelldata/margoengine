import test from 'node:test';
import assert from 'node:assert/strict';
import {GPUParticles} from '../packages/creative/dist/particles.js';
import {optionalGPU} from './support/optional-gpu.js';

test('Moving particle frames preserve packed camera basis without temporary mapped arrays',()=>{
  const h=optionalGPU(),particles=new GPUParticles({count:1,obstacles:[{kind:'sphere',center:[0,0,0],radius:1}]});
  h.context.format='bgra8unorm';h.context.camera.position=[-0,1,4];h.context.camera.target=[0,0,0];
  h.engine.use(particles);
  const uploads=[];const write=h.engine.gpu.queue.writeBuffer;
  h.engine.gpu.queue.writeBuffer=(buffer,offset,value)=>{if(value.length===560)uploads.push(value.slice());write(buffer,offset,value);};
  try{
    const expected=[];
    for(let i=0;i<120;i++){
      const x=i*.01,y=1,z=i%2?-4:4,tx=0,ty=0,tz=0,length=Math.hypot(tx-x,ty-y,tz-z),forward=[(tx-x)/length,(ty-y)/length,(tz-z)/length],up=[0,1,0];
      let right=[forward[1]*up[2]-forward[2]*up[1],forward[2]*up[0]-forward[0]*up[2],forward[0]*up[1]-forward[1]*up[0]];const rl=Math.hypot(...right);right=right.map(v=>v/rl);
      expected.push(new Float32Array([...right,0,right[1]*forward[2]-right[2]*forward[1],right[2]*forward[0]-right[0]*forward[2],right[0]*forward[1]-right[1]*forward[0],0,x,y,z,0,...forward,0]));
    }
    const map=Array.prototype.map;let maps=0;
    try{
      Array.prototype.map=function(...args){maps++;return Reflect.apply(map,this,args);};
      for(let i=0;i<120;i++){h.context.camera.position=[i*.01,1,i%2?-4:4];h.engine.frameGraph.execute(h.context);}
    }finally{Array.prototype.map=map;}
    for(let i=0;i<120;i++)assert.deepEqual(new Uint8Array(uploads[i].buffer,28*4,16*4),new Uint8Array(expected[i].buffer));
    assert.equal(maps,0,'Particle tick rebuilt temporary direction vectors');
    const before=h.counts.groups;h.context.descriptor.depthStencil.format='depth24plus';h.engine.frameGraph.execute(h.context);
    assert.equal(h.counts.groups,before+1,'Particle pipeline ignored changed depth format');
  }finally{particles.dispose();h.cleanup();}
});

test('Failed particle texture upload destroys only its new texture and keeps the previous texture',()=>{
  const h=optionalGPU(),particles=new GPUParticles({count:1});h.engine.use(particles);
  const before=particles.texture,write=h.engine.gpu.queue.writeTexture,failure=new Error('Texture upload failed');
  h.engine.gpu.queue.writeTexture=()=>{throw failure;};
  try{
    const start=h.resources.length;
    assert.throws(()=>particles.setTexture({width:1,height:1,data:new Uint8Array(4)}),error=>error===failure);
    assert.ok(h.resources.slice(start).every(resource=>resource.destroyed),'New texture leaked after failed upload');
    assert.equal(particles.texture,before);assert.equal(before.destroyed,false);
    h.engine.gpu.queue.writeTexture=write;particles.setTexture({width:1,height:1,data:new Uint8Array([255,255,255,255])});
    assert.equal(before.destroyed,true);
  }finally{particles.dispose();h.cleanup();}
});
