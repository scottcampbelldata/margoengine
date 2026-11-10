import test from 'node:test';
import assert from 'node:assert/strict';
import { ShadowAtlas, packShadowAtlas } from '../dist/shadow-atlas.js';
import { Clustered } from '../dist/index.js';
import { Camera } from '../../core/dist/index.js';
import { wgsl } from '../../core/src/shaders.ts';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

test('quadtree tiles are deterministic, disjoint, complete and reduce least-important lights first', () => {
  const requests = [{ id: 'near', resolution: 128, faces: 6, importance: 10 },
    { id: 'far', resolution: 128, faces: 6, importance: 1 }];
  const before = JSON.stringify(requests), tiles = packShadowAtlas(requests, 256, 16);
  assert.equal(JSON.stringify(requests), before);
  assert.deepEqual(tiles, packShadowAtlas(requests, 256, 16));
  assert.equal(tiles.length, 12);
  assert.ok(tiles.find(t => t.id === 'near').size >= tiles.find(t => t.id === 'far').size);
  for (const a of tiles) {
    assert.ok(a.x >= 0 && a.y >= 0 && a.x + a.size <= 256 && a.y + a.size <= 256);
    assert.ok(Object.isFrozen(a));
    for (const b of tiles) if (a !== b)
      assert.ok(a.x + a.size <= b.x || b.x + b.size <= a.x || a.y + a.size <= b.y || b.y + b.size <= a.y);
  }
  assert.throws(() => packShadowAtlas([{ id: 'point', resolution: 16, faces: 6, importance: 1 }], 16, 16), /full/);
  assert.throws(() => packShadowAtlas([...requests, requests[0]], 256), /unique/);
});

test('sixteen small point lights rasterize fewer texels than four large lights without losing a face', () => {
  const small = packShadowAtlas(Array.from({length:16},(_,i)=>({id:String(i),resolution:16,faces:6,importance:1})),256,16),
    large = packShadowAtlas(Array.from({length:4},(_,i)=>({id:String(i),resolution:64,faces:6,importance:1})),256,16),
    texels = tiles => tiles.reduce((n,t)=>n+t.size**2,0);
  assert.equal(small.length,96);
  assert.equal(texels(small),24576);
  assert.equal(texels(large),61440);
});

test('camera coverage changes actual viewport/matrices, one physical layer stays allocated, clean frames cache', () => {
  const h = optionalGPU(), passes = [];
  globalThis.GPUShaderStage = { VERTEX:1, FRAGMENT:2 };
  Object.assign(h.engine.gpu.limits,{maxTextureDimension2D:8192,maxTextureArrayLayers:256});
  h.engine.gpu.createPipelineLayout = d=>d;
  const begin = h.context.encoder.beginRenderPass;
  h.context.encoder.beginRenderPass = d=>{
    const record = {load:d.depthStencilAttachment.depthLoadOp}; passes.push(record);
    return {...begin(d),setViewport(...v){record.viewport=v;},setScissorRect(...v){record.scissor=v;}};
  };
  const camera = new Camera({position:[0,0,10],target:[0,0,0],fov:50,near:0.1,far:1000});
  h.engine.camera=h.context.camera=camera;
  const lights=Clustered.attach(h.engine,{grid:[1,1,1]}), atlas=ShadowAtlas.attach(h.engine,{lights,resolution:256,minResolution:16,maxResolution:128});
  lights.setLights([{position:[0,0,0],range:1,castShadow:true}]);
  const frame=()=>{passes.length=0;camera.update(1,true);h.context.shader=wgsl;h.engine.frameGraph.execute(h.context);};
  frame();
  const near=atlas.layout[0].size;
  assert.equal(atlas['map'].size[2],1);
  assert.equal(passes.length,6);
  assert.equal(passes[0].load,'clear');
  assert.ok(passes.slice(1).every(p=>p.load==='load'));
  assert.match(lights.pbr(0).declarations,/atlasCompare\(/);
  assert.doesNotMatch(lights['unshadowed'].pbr(0).declarations,/shadowAtlas/);
  frame();assert.equal(passes.length,0);
  camera.position=[0,0,100];frame();
  assert.ok(atlas.layout[0].size < near);
  for(const [i,p] of passes.entries()){
    const tile=atlas.layout[i];
    assert.deepEqual(p.viewport.slice(0,4),[tile.x,tile.y,tile.size,tile.size]);
    assert.deepEqual(p.scissor,[tile.x,tile.y,tile.size,tile.size]);
  }
  assert.equal(atlas.allocatedTexels,65536);
  atlas.dispose();lights.dispose();
});
