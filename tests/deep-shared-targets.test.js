import test from 'node:test';
import assert from 'node:assert/strict';
import {SceneTarget,sceneTarget} from '../packages/shared/msaa.js';
import {gpuHarness} from './support/postfx-gpu.js';

function target(h,samples){
  const descriptor={size:[128,96],usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING};
  const color=h.engine.gpu.createTexture({...descriptor,format:'rgba16float'}),depth=h.engine.gpu.createTexture({...descriptor,format:'depth32float'});
  return new SceneTarget(h.engine.gpu,color,depth,samples);
}

test('Single-sample nested captures restore borrowed depth and the previous target owner',()=>{
  const h=gpuHarness(),c=h.context,outer=target(h,1),inner=target(h,1);
  const original={color:c.color,depth:c.depth,format:c.format,descriptor:c.descriptor};
  try{
    outer.begin(c);assert.equal(sceneTarget(c),outer);
    const captured={color:c.color,depth:c.depth,format:c.format,descriptor:c.descriptor};
    inner.begin(c);assert.equal(sceneTarget(c),inner);
    inner.restore(c);assert.equal(c.depth,captured.depth);assert.equal(sceneTarget(c),outer);
    assert.deepEqual({color:c.color,depth:c.depth,format:c.format,descriptor:c.descriptor},captured);
    outer.restore(c);assert.deepEqual({color:c.color,depth:c.depth,format:c.format,descriptor:c.descriptor},original);
    assert.equal(sceneTarget(c),undefined);
  }finally{inner.dispose();outer.dispose();for(const r of h.resources)r.destroy();}
});

test('Scene presentation invalidates destination sampling and remains stable after warming',()=>{
  const h=gpuHarness(),c=h.context,scene=target(h,1),original={color:c.color,depth:c.depth,format:c.format};
  function frame(count,format='bgra8unorm'){
    c.color=original.color;c.depth=original.depth;c.format=format;c.descriptor={multisample:{count},depthStencil:{format:'depth32float'}};
    scene.begin(c);scene.present(c);
    assert.equal(c.depth,original.depth);
    return h.pipelines.at(-1);
  }
  try{
    const first=frame(4);assert.equal(first.multisample.count,4);
    const second=frame(1);assert.notEqual(first,second);assert.equal(second.multisample.count,1);
    const third=frame(1,'rgba8unorm');assert.notEqual(second,third);assert.equal(third.fragment.targets[0].format,'rgba8unorm');
    const counts={pipelines:h.pipelines.length,groups:h.groups.length,views:h.counts.views};
    for(let i=0;i<120;i++)assert.equal(frame(1,'rgba8unorm'),third);
    assert.deepEqual({pipelines:h.pipelines.length,groups:h.groups.length,views:h.counts.views},counts);
  }finally{scene.dispose();for(const r of h.resources)r.destroy();}
});
