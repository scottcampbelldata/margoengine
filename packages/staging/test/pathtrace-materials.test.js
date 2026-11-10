import test from 'node:test';
import assert from 'node:assert/strict';
import { TexturedStill, texturedSceneFromGLTF } from '../dist/pathtrace-materials.js';
import { ComposedVoxelPathTracer } from '@margoengine/voxel-pathtracer/compose';

test('textured still selects PBR, owns its snapshot and keeps idle lifecycle and replacement', async t => {
  let received;
  const tracer = {enabled:true,ready:Promise.resolve(),status:'ready',stats:{samples:0},resets:0,
    reset(){this.resets++;},dispose(){this.status='disposed';},
    async setScene(scene,{signal}={}){signal?.throwIfAborted();this.scene=scene;},
    async renderImage(o){return o;},async capture(o){return o;}};
  t.mock.method(ComposedVoxelPathTracer,'create',async (_engine,o)=>{received=o;return tracer;});
  const passes=[], plugins=new Map();
  const engine={use(p){plugins.set(p.name,p);p.setup(this);p.registerPasses({add:p=>passes.push(p)});},
    sceneOf(){return {removePlugin:n=>plugins.delete(n)};}};
  const scene={models:[],instances:[],materials:[],meshes:[],pbrMaterials:[{id:1,baseColorTexture:{width:1,height:1,data:new Uint8Array([9,8,7,255])}}]};
  const pending=TexturedStill.attach(engine,{scene,idleDelay:0.25});
  scene.pbrMaterials[0].baseColorTexture.data[0]=99;
  const still=await pending;
  try{
    assert(still instanceof TexturedStill);
    assert.equal(received.features[0].id,'mesh');
    assert.equal(received.scene.pbrMaterials[0].baseColorTexture.data[0],9);
    assert.equal(received.order,20);
    const c={delta:.125,width:8,height:8,camera:{matrix:new Float32Array(16),position:[0,0,4],target:[0,0,0],up:[0,1,0]}};
    for(let i=0;i<3;i++)passes[0].execute(c);
    assert(still.active);
    await assert.rejects(still.setScene(scene,{signal:AbortSignal.abort()}),{name:'AbortError'});
    assert(still.active);
    await still.setScene(scene);
    assert(!still.active);
    assert.equal(tracer.scene,scene);
    assert.deepEqual(await still.renderImage({width:8}),{width:8});
    assert.deepEqual(await still.capture({width:8}),{width:8});
  }finally{still.dispose();still.dispose();}
  assert.equal(tracer.status,'disposed');
  assert.equal(plugins.size,0);
});

test('glTF conversion cancels before requesting model or image data',async()=>{
  await assert.rejects(texturedSceneFromGLTF({}, {signal:AbortSignal.abort()}),{name:'AbortError'});
});
