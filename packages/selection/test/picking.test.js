import test from 'node:test';
import assert from 'node:assert/strict';
import {Picking} from '../dist/index.js';
import {wgsl} from '../../core/dist/shaders.js';
import {box} from '../../core/dist/extension.js';
import {optionalGPU} from '../../../tests/support/optional-gpu.js';

function harness(samples=4){
 const h=optionalGPU(),e=h.engine,c=h.context;c.descriptor.multisample={count:samples};e.canvas={width:128,height:96,clientWidth:128,clientHeight:96};e.store.visible=new Uint8Array(16).fill(1);
 e.lighting={direction:new Float32Array([0,1,0,1]),radiance:new Float32Array([1,1,1,.1])};
 const geometry=box(.01,.01,.01),mesh={id:0,geometry,matrix:new Float32Array(c.camera.matrix),material:{data:new Float32Array([1,1,1,1,.5,0,1,0])}};mesh.matrix[14]=.5;e.meshes.set(0,mesh);
 c.shader=wgsl;c.descriptor.vertex={buffers:[]};e.geometryBuffers=()=>({vertex:{},index:{},instance:e.gpu.createBuffer({size:1536})});
 let pixels=[],copies=[],instances=[];
 const begin=c.encoder.beginRenderPass;c.encoder.beginRenderPass=d=>{const p=begin(d);return {...p,drawIndexed(_n,count){instances.push(count);}};};
 c.encoder.copyTextureToBuffer=(source,target,size)=>{
  copies.push({source,target,size});const data=new Uint32Array(target.buffer.data);data.fill(0);for(const [x,y,id] of pixels)data[y*64+x]=id;
 };c.encoder.finish=()=>({});e.gpu.createCommandEncoder=()=>c.encoder;e.gpu.queue.submit=()=>{};
 const effect=new Picking();e.use(effect);
 const frame=()=>{c.shader=wgsl;e.frameGraph.execute(c);};
 return {...h,mesh,effect,frame,copies,instances,setPixels:value=>{pixels=value;}};
}
test('Picking reuses MRT and readback, resolves center before orthogonal and diagonal neighbors, and clips canvas edges',async()=>{
 const h=harness(1);h.frame();const buffers=h.counts.buffers,textures=h.counts.textures;
 h.setPixels([[1,1,1],[0,1,5]]);assert.equal(await h.effect.onPick(64,48),h.mesh);assert.equal(h.copies.at(-1).source.texture.width,128);assert.equal(h.instances.length,0);
 const other={...h.mesh,id:4};h.engine.meshes.set(4,other);h.frame();h.setPixels([[0,1,5],[0,0,1]]);assert.equal(await h.effect.onPick(64,48),other);
 h.setPixels([[2,2,1]]);assert.equal(await h.effect.onPick(64,48),h.mesh);
 h.setPixels([[3,0,1]]);assert.equal(await h.effect.onPick(64,48),null,'copy padding is not a neighbor');
 h.setPixels([[0,0,1]]);assert.equal(await h.effect.onPick(0,0),h.mesh);assert.deepEqual(h.copies.at(-1).size,[2,2]);assert.deepEqual(h.copies.at(-1).source.origin,[0,0]);
 assert.equal(h.copies.at(-1).target.bytesPerRow,256);assert.equal(h.counts.buffers,buffers);assert.equal(h.counts.textures,textures);
 h.effect.dispose();assert.ok(h.resources.every(r=>r.destroyed));
});
test('Picking culls individual instances in the micro frustum and invalidates camera, transforms, graph and stale mesh slots',async()=>{
 const h=harness();h.frame();h.mesh.matrix[12]=.00001;
 for(let id=1;id<16;id++){const m={...h.mesh,id,matrix:h.mesh.matrix.slice()};m.matrix[12]=.5;h.engine.meshes.set(id,m);}
 h.setPixels([[1,1,1]]);assert.equal(await h.effect.onPick(64,48),h.mesh);assert.deepEqual(h.instances,[1]);assert.equal(h.copies.at(-1).source.texture.width,3);
 h.frame();h.context.camera.matrix[12]=.00001;await h.effect.onPick(64,48);assert.equal(h.instances.length,2);
 h.frame();h.engine.frameGraph.add({name:'change',order:5,execute(){}});await h.effect.onPick(64,48);assert.equal(h.instances.length,3);
 let finish;const read=h.copies.at(-1).target.buffer;read.mapAsync=()=>new Promise(resolve=>{finish=resolve;});
 const pending=h.effect.onPick(64,48);await assert.rejects(h.effect.onPick(64,48),/pending/);h.engine.meshes.set(0,{...h.mesh});finish();assert.equal(await pending,null);
 h.effect.dispose();h.cleanup();
});

test('MSAA keeps beauty at 4x and uses single-sample integer micro picking',async()=>{const h=harness();h.frame();assert.equal(h.context.descriptor.multisample.count,4);assert.equal(h.effect.captured,false);h.setPixels([[1,1,1]]);assert.equal(await h.effect.onPick(64,48),h.mesh);assert.equal(h.copies.at(-1).source.texture.width,3);assert.equal(h.copies.at(-1).source.texture.sampleCount,1);h.effect.dispose();h.cleanup();});
