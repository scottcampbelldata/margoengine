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

// Per-face caching: a face re-renders only when its light or tile changes or a changed caster's bounds reach it.
function cached() {
  const h = optionalGPU(), passes = [];
  globalThis.GPUShaderStage = { VERTEX:1, FRAGMENT:2 };
  Object.assign(h.engine.gpu.limits,{maxTextureDimension2D:8192,maxTextureArrayLayers:256});
  h.engine.gpu.createPipelineLayout = d=>d;
  const begin = h.context.encoder.beginRenderPass;
  h.context.encoder.beginRenderPass = d=>{
    const record = {load:d.depthStencilAttachment.depthLoadOp,clears:0,draws:0}; passes.push(record);
    return {...begin(d),setViewport(...v){record.viewport=v;},setScissorRect(...v){record.scissor=v;},
      draw(){record.clears++;},drawIndexed(){record.draws++;}};
  };
  const camera = new Camera({position:[20,8,20],target:[20,0,0],fov:60,near:0.1,far:1000});
  h.engine.camera=h.context.camera=camera;
  const frame=()=>{passes.length=0;camera.update(1,true);h.context.shader=wgsl;h.engine.frameGraph.execute(h.context);return passes.length;};
  return {h,passes,frame};
}
const box=(engine,at,id)=>({shadowPrimitives:[{node:{id,engine,check(){},
  matrix:new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,at[0],at[1],at[2],1])},vertex:{},index:{},count:36,stride:80,bounds:[0,0,0,0.5]}]});

test('cached atlas faces: first frame draws all, a still frame none, a moved box only the faces it reaches', () => {
  const {h,passes,frame}=cached(),
    lights=Clustered.attach(h.engine,{grid:[1,1,1]}),
    atlas=ShadowAtlas.attach(h.engine,{lights,resolution:1024,minResolution:16,maxResolution:256});
  const point={position:[0,3,0],range:4,castShadow:true},
    spot={position:[40,3,0],range:4,direction:[0,-1,0],outerAngle:0.6,castShadow:true},
    near=box(h.engine,[0,1,0],1),far=box(h.engine,[40,1,0],2);
  lights.setLights([point,spot]);
  atlas.add(near);atlas.add(far);
  assert.equal(frame(),7,'first frame: six cube faces and the spot face');
  assert.equal(passes[0].load,'clear');
  const before=atlas.layout;
  assert.equal(frame(),0,'still frame: nothing re-renders');
  assert.equal(atlas.stats.layers,0);
  // The box under the point light moves: only the -y cube face (layer 3) reaches it; the tiles stay put.
  near.shadowPrimitives[0].node.matrix[13]=0.5;
  assert.equal(frame(),1,'moved box: one face');
  assert.deepEqual(passes[0].viewport.slice(0,4),[before[3].x,before[3].y,before[3].size,before[3].size]);
  assert.equal(passes[0].load,'load','a partial redraw keeps the other tiles');
  assert.equal(passes[0].clears,1,'and clears its own tile with one triangle');
  assert.equal(passes[0].draws,1,'then draws the box');
  assert.deepEqual(atlas.layout,before);
  // Hiding, showing and removing the far box re-render the spot face alone.
  h.engine.store.hidden[2]=1;
  assert.equal(frame(),1,'hidden box: the spot face');
  assert.deepEqual(passes[0].viewport.slice(0,4),[before[6].x,before[6].y,before[6].size,before[6].size]);
  assert.equal(passes[0].draws,0,'the hidden box is not drawn');
  h.engine.store.hidden[2]=0;
  assert.equal(frame(),1,'shown box: the spot face');
  const remove=atlas.add(box(h.engine,[40,1.5,0],3));
  assert.equal(frame(),1,'added box under the spot: the spot face');
  assert.equal(passes[0].draws,2);
  remove();
  assert.equal(frame(),1,'removed box: the spot face');
  assert.equal(passes[0].draws,1);
  assert.equal(frame(),0);
  // Moving the spot light re-renders its face alone.
  lights.setLights([point,{...spot,position:[40,3,1]}]);
  assert.equal(frame(),1,'moved spot light: its face');
  // A third light keeps the other tiles where they are and draws only its own face.
  lights.setLights([point,{...spot,position:[40,3,1]},{...spot,position:[20,3,0]}]);
  assert.equal(frame(),1,'added spot light: its face');
  assert.deepEqual(atlas.layout.slice(0,7),before);
  // A smaller size class for one light moves only its tile; the cube faces keep theirs.
  lights.setLights([point,{...spot,position:[40,3,1],shadow:{resolution:16}},{...spot,position:[20,3,0]}]);
  assert.equal(frame(),1,'resized spot light: its face');
  assert.equal(atlas.layout[6].size,16);
  assert.deepEqual(atlas.layout.slice(0,6),before.slice(0,6));
  atlas.invalidate();
  assert.equal(frame(),8,'invalidate re-renders every face');
  atlas.dispose();lights.dispose();
});

test('a layer that leaves the atlas and returns to its old rectangle re-renders (another face may have drawn there)', () => {
  const {h}=cached(), lights=Clustered.attach(h.engine,{grid:[1,1,1]}),
    atlas=ShadowAtlas.attach(h.engine,{lights,resolution:256,minResolution:16,maxResolution:64}),
    c={device:h.engine.gpu}, dirty=new Uint8Array(4),
    a=Object.freeze({id:'a',face:0,x:0,y:0,size:64}), b=Object.freeze({id:'b',face:0,x:64,y:0,size:64});
  atlas['tiles']=[a,b];atlas['placeMaps'](c,2,dirty);
  assert.deepEqual([...dirty],[1,1,0,0]);
  dirty.fill(0);atlas['placeMaps'](c,2,dirty);
  assert.deepEqual([...dirty],[0,0,0,0],'unchanged rectangles stay cached');
  atlas['tiles']=[a];atlas['placeMaps'](c,1,dirty);
  atlas['tiles']=[a,b];atlas['placeMaps'](c,2,dirty);
  assert.deepEqual([...dirty],[0,1,0,0]);
  atlas.dispose();lights.dispose();
});
