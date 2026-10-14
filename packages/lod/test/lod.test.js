import test from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import vm from 'node:vm';
import {Engine,TransformStore,box,PbrMaterial} from '../../core/dist/extension.js';
import {GLTFAsset,PBRModel} from '../../gltf-pro/dist/index.js';
import {LODSystem,Imposter,octEncode,octDecode,frameDirection,frameBasis,frameMatrix,bakeShader} from '../dist/index.js';
import {optionalGPU} from '../../../tests/support/optional-gpu.js';

const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2],cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const clip=(m,p)=>[0,1,2,3].map(r=>m[r]*p[0]+m[4+r]*p[1]+m[8+r]*p[2]+m[12+r]);
async function plain(capacity=64){
  const store=await TransformStore.create(capacity),renderer={backend:'webgpu',gpu:null,live:new Set,add(g){this.live.add(g);},remove(g){this.live.delete(g);},render(){},dispose(){}};
  return new Engine({width:400,height:200,clientWidth:400,clientHeight:200},store,renderer,{position:[0,0,0.001],target:[0,0,-1],far:5000},null);
}
async function gpu(capacity=64){
  const h=optionalGPU(),device=h.engine.gpu,store=await TransformStore.create(capacity),counts={submits:0,copies:0,draws:[],passes:0},uploads=[],destroyed=[];
  device.limits.maxTextureDimension2D=8192;
  const create=device.createTexture;device.createTexture=d=>{const t=create(d);t.createView=(v={})=>({texture:t,...v});const destroy=t.destroy;t.destroy=()=>{destroyed.push(t);destroy.call(t);};return t;};
  const pass={setPipeline(){},setBindGroup(){},setVertexBuffer(){},setIndexBuffer(){},setBlendConstant(){},drawIndexed(){},draw(vertices,instances){counts.draws.push([vertices,instances]);},end(){}};
  device.createCommandEncoder=()=>({beginRenderPass(){counts.passes++;return pass;},copyTextureToTexture(){counts.copies++;},copyTextureToBuffer(source,target){new Uint8Array(target.buffer.data).fill(source.texture.format==='rgba16float'?2:1);},finish(){return {};}});
  device.queue.submit=()=>{counts.submits++;};device.queue.writeTexture=(destination,data)=>uploads.push({destination,data});
  const renderer={backend:'webgpu',gpu:device,add(){},remove(){},render(){},dispose(){}};
  const engine=new Engine({width:128,height:96,clientWidth:128,clientHeight:96},store,renderer,{position:[0,0,10],target:[0,0,0],far:5000},null);
  const context={...h.context,camera:engine.camera,encoder:device.createCommandEncoder()},frame=()=>{counts.draws.length=0;engine.render();engine.frameGraph.execute(context);return counts.draws.filter(d=>d[0]===4);};
  return {h,device,engine,renderer,counts,uploads,destroyed,frame,close(){engine.dispose();h.cleanup();}};
}

test('octahedral atlas maths: round trip, grid poles and folded edges, right-handed bases, view matrices', () => {
  for(let k=0;k<500;k++){const d=octDecode(Math.random()*2-1,Math.random()*2-1),e=octEncode(d),back=octDecode(...e);assert.ok(Math.hypot(...d.map((v,i)=>v-back[i]))<1e-9);}
  assert.deepEqual(frameDirection(2,2,5).map(v=>Math.round(v*1e9)/1e9),[0,1,0],'grid centre looks down from +y');
  for(const [i,j] of [[0,0],[4,0],[0,4],[4,4]])assert.ok(Math.abs(frameDirection(i,j,5)[1]+1)<1e-12,'corners look up from -y');
  assert.ok(Math.hypot(...frameDirection(4,1,5).map((v,i)=>v-frameDirection(4,3,5)[i]))<1e-12,'the outer edge folds onto itself');
  for(let j=0;j<12;j++)for(let i=0;i<12;i++){
    const d=frameDirection(i,j,12),[r,u]=frameBasis(d);
    assert.ok(Math.abs(dot(r,r)-1)<1e-9&&Math.abs(dot(u,u)-1)<1e-9&&Math.abs(dot(r,u))<1e-9&&Math.abs(dot(r,d))<1e-9,`orthonormal ${i},${j}`);
    assert.ok(Math.hypot(...cross(r,u).map((v,k)=>v-d[k]))<1e-9,'right x up = view: no mirrored frames');
    const c=[1,-2,3],m=frameMatrix(d,c,2);assert.ok(Math.hypot(...clip(m,c).map((v,k)=>v-[0,0,0.5,1][k]))<1e-6);
    const front=clip(m,c.map((v,k)=>v+2*d[k])),side=clip(m,c.map((v,k)=>v+2*r[k]));assert.ok(Math.abs(front[2]-1)<1e-6&&Math.abs(side[0]-1)<1e-6&&Math.abs(clip(m,c.map((v,k)=>v+2*u[k]))[1]-1)<1e-6);
  }
  assert.ok(Math.abs(frameDirection(0,6,13)[0]+1)<1e-12,'left edge centre looks from -x');
});

test('selection: distance levels with three.js hysteresis toggle Mesh and model-root visibility only on change', async () => {
  const e=await plain(),lods=new LODSystem({hysteresis:0.2});e.use(lods);
  const anchor=e.createMesh(),high=e.createMesh(anchor).setGeometry(box()),low=e.createMesh(anchor).setGeometry(box()),model={root:e.createMesh(anchor)};
  anchor.setPosition([0,0,-10]);const lod=lods.add(anchor,[{object:high},{object:low,distance:20},{object:model,distance:50},{object:null,distance:100}]);
  assert.equal(lod.level,-1);assert.ok(!high.visible&&!low.visible&&!model.root.visible,'levels start hidden');
  const at=z=>{e.camera.position=[0,0,z];lods.update();return lod.level;};
  assert.equal(at(0),0);assert.ok(high.visible&&!low.visible);
  assert.equal(at(10.5),1,'20.5 away: past 20');assert.ok(!high.visible&&low.visible);
  assert.equal(at(8),1,'18 away stays coarse: 20 * (1 - 0.2) = 16');assert.equal(at(5),0,'15 away returns');
  assert.equal(at(50),2);assert.ok(model.root.visible&&!low.visible);assert.equal(at(95),3);assert.ok(!model.root.visible,'null level hides everything');
  let writes=0;const show=lods.show;lods.show=function(...args){writes++;return show.apply(this,args);};
  at(0);for(let k=0;k<20;k++)at(k%2?1:2);assert.equal(writes,1,'no writes while the level holds');
  lods.bias=2;assert.equal(at(1),1,'bias 2 doubles distances');lods.bias=1;
  assert.throws(()=>lods.add(anchor,[{object:high},{object:low,distance:5},{object:null,distance:4}]),/increasing/);
  assert.throws(()=>lods.add(anchor,[{object:{}}]),/Invalid LOD level/);assert.throws(()=>new LODSystem().add(anchor,[{object:null}]),/engine first/);
  lod.remove();assert.equal(lod.level,-1);assert.equal(lods.size,0);e.dispose();
});

test('geometry levels swap the anchor geometry; hidden keeper meshes keep every batch alive', async () => {
  const e=await plain(),lods=new LODSystem();e.use(lods);const a=box(1,1,1),b=box(0.5,0.5,0.5),anchors=[];
  for(let i=0;i<4;i++){const m=e.createMesh().setPosition([i*30,0,-5]);anchors.push(m);lods.add(m,[{object:a},{object:b,distance:30},{object:null,distance:80}]);}
  const keepers=[...e.meshes.values()].filter(m=>!anchors.includes(m));assert.equal(keepers.length,2);assert.ok(keepers.every(m=>!m.visible&&m.geometry));
  lods.update();assert.deepEqual(anchors.map(m=>m.geometry),[a,b,b,null]);
  e.camera.position=[90,0,0.001];e.camera.target=[90,0,-1];lods.update();assert.deepEqual(anchors.map(m=>m.geometry),[null,b,b,a]);
  assert.ok(e.renderer.live.has(a)&&e.renderer.live.has(b),'GPU batches survive with no visible user');
  e.render({culling:false});assert.equal(e.stats.visible,3);lods.dispose();assert.equal(e.meshes.size,4,'dispose removes keepers');e.dispose();
});

test('screen-size levels follow the bounding radius and world scale', async () => {
  const e=await plain(),lods=new LODSystem({hysteresis:0});e.use(lods);const m=e.createMesh().setPosition([0,0,-10]),g=box(2,2,2);
  const lod=lods.add(m,[{object:g},{object:null,screen:0.25}]),r=g.bounds[3],t=Math.tan(Math.PI/6);
  // screen = r / (d tan(fov/2)): the switch is at d = r / (0.25 t).
  const d=r/(0.25*t);m.setPosition([0,0,-(d*0.99)]);e.store.tick(false);lods.update();assert.equal(lod.level,0);
  m.setPosition([0,0,-(d*1.01)]);e.store.tick(false);lods.update();assert.equal(lod.level,1);
  m.setScale([2,2,2]);e.store.tick(false);lods.update();assert.equal(lod.level,0,'twice the size shows detail again');
  assert.throws(()=>lods.add(m,[{object:g},{object:null,screen:0.5,distance:3}]),/screen/);e.dispose();
});

test('per-frame selection allocates nothing, including level switches, for 3,000 objects', async () => {
  v8.setFlagsFromString('--expose-gc');const gc=vm.runInNewContext('gc');
  const e=await plain(8192),lods=new LODSystem();e.use(lods);const a=box(),b=box(0.5,0.5,0.5),imposterLike=null;
  for(let i=0;i<3000;i++){const anchor=e.createMesh().setPosition([(i%60)*4,0,-Math.floor(i/60)*4]),child=e.createMesh(anchor).setGeometry(a);lods.add(anchor,[{object:child},{object:b,distance:40},{object:imposterLike,distance:120}]);}
  const near=[0,0,0.001],far=[60,0,-60],run=frames=>{for(let f=0;f<frames;f++){e.camera.position=f%2?near:far;lods.update();}};
  run(4000);gc();const before=v8.getHeapStatistics().used_heap_size;run(1000);const grown=v8.getHeapStatistics().used_heap_size-before;
  assert.ok(grown<64*1024,`selection allocated ${grown} bytes over 1000 frames with switches`);
  e.camera.position=[60,0,-60];lods.update();const levels=new Set(lods.handles.map(l=>l.level));assert.deepEqual([...levels].sort(),[0,1,2],'all levels in use');
  e.dispose();
});

test('bakeShader adds an early return to the gltf-pro beauty fragment only', () => {
  const code='@fragment fn fragment(i:Out,@builtin(front_facing) front:bool)->@location(0) vec4f {\n  let s=surface(i,front); return x;}\n@fragment fn gbuffer(i:Out,@builtin(front_facing) front:bool)->@location(0) vec4f {\n  let s=surface(i,front);}';
  const out=bakeShader(code,2);assert.match(out,/@group\(2\) @binding\(96\) var<uniform> lod_bake/);assert.equal(out.match(/return lod_bake_out/g).length,1);
  assert.throws(()=>bakeShader('fn x(){}',2),/gltf-pro PBR shader/);
});

test('mock GPU: bake renders every view through gltf-pro, restores the source, draws imposters in one instanced call per atlas', async () => {
  const s=await gpu(),{engine,device,counts}=s;
  try {
    const before=engine.meshes.size,imposter=Imposter.bake(engine,box(2,2,2),{frames:4,frameSize:32,material:new PbrMaterial({color:'#ff0000'})});
    assert.equal(counts.submits,16+1,'one submit per view plus mipmaps');assert.equal(counts.copies,32,'albedo and normal per view');
    assert.equal(engine.meshes.size,before,'temporary core model disposed');assert.equal(imposter.shading,'core');
    assert.ok(Math.abs(imposter.radius-Math.sqrt(3)*1.01)<1e-6&&imposter.center.every(v=>Math.abs(v)<1e-9));
    const baked=s.h.pipelines.filter(p=>p.vertex?.module?.code?.includes('lod_bake_out'));assert.deepEqual([...new Set(baked.map(p=>p.fragment.targets[0].format))].sort(),['rgba16float','rgba8unorm-srgb']);
    assert.equal(imposter.color.width,128);assert.equal(imposter.color.mipLevelCount,3);assert.equal(imposter.normal.format,'rgba16float');

    // A gltf-pro source is baked in its root's space and left exactly as it was.
    const doc={asset:{version:'2.0'},nodes:[{mesh:0,translation:[1,0,0]}],meshes:[{primitives:[{material:0}]}],materials:[{}]};
    const v=new Float32Array(60);for(const [k,p] of [[0,[0,0,0]],[1,[1,0,0]],[2,[0,1,0]]]){v.set(p,k*20);v[k*20+3]=1;v[k*20+6]=1;v.fill(1,k*20+16,k*20+20);}
    const model=new PBRModel(engine,new GLTFAsset(doc,[]),[],[[{vertices:v,indices:new Uint32Array([0,1,2])}]]);engine.use(model);
    const parent=engine.createMesh();model.root.setParent(parent).setPosition([5,6,7]);model.root.visible=false;
    const fromModel=Imposter.bake(engine,model,{frames:4,frameSize:16});assert.equal(fromModel.shading,'gltf');
    assert.ok(Math.abs(fromModel.center[0]-1.5)<1e-6,'root-space bounds include the node translation, not the root position');
    assert.deepEqual([model.root.position.x,model.root.position.y,model.root.position.z],[5,6,7]);assert.equal(model.root.visible,false);assert.equal(engine.store.parents[model.root.id],parent.id);

    const lods=new LODSystem();engine.use(lods);const anchors=[[0,0,-100],[3,0,-100],[0,0,500]].map(p=>engine.createMesh().setPosition(p));
    for(const a of anchors)lods.add(a,[{object:box()},{object:imposter,distance:50}]);
    s.frame();assert.deepEqual(counts.draws,[[4,2]],'one strip draw, behind-camera instance culled');
    anchors[0].visible=false;assert.deepEqual(s.frame(),[[4,1]],'a hidden anchor hides its imposter');anchors[0].visible=true;
    engine.camera.position=[0,0,-95];s.frame();assert.deepEqual(counts.draws,[[4,1]]);
    lods.add(engine.createMesh().setPosition([0,0,300]),[{object:null},{object:fromModel,distance:1}]);s.frame();assert.equal(counts.draws.length,2,'one draw per atlas');

    const data=await imposter.export();assert.equal(data.color.length,128*128*4);assert.equal(data.normal.length,128*128*4);assert.equal(data.color[0],1);assert.equal(data.normal[0],0x0202);
    const restored=Imposter.fromData(engine,data);assert.ok(s.uploads.some(u=>u.data===data.color)&&s.uploads.some(u=>u.data===data.normal));assert.equal(restored.radius,imposter.radius);
    assert.throws(()=>Imposter.fromData(engine,{...data,color:new Uint8Array(4)}),/Invalid imposter data/);
    assert.throws(()=>Imposter.bake(engine,box(),{frames:3}),RangeError);

    // Device restore: the atlas rebuilds on the next frame on the new device.
    const old=imposter.color,next=optionalGPU().engine.gpu;Object.assign(next,{limits:device.limits,createTexture:device.createTexture,createCommandEncoder:device.createCommandEncoder,queue:device.queue});
    s.renderer.gpu=next;lods.onDeviceRestored(engine);const drawn=s.frame();
    assert.ok(s.destroyed.includes(old)&&imposter.color!==old&&imposter.device===next,'re-baked on the restored device');assert.deepEqual(drawn,[[4,1],[4,1]]);
    model.destroy();s.renderer.gpu=device;lods.onDeviceRestored(engine);assert.equal(s.frame().length,1,'source gone: that atlas skips, others draw');

    lods.dispose();imposter.dispose();assert.ok(s.destroyed.includes(imposter.color??old)||imposter.color===undefined);assert.equal(imposter.ready(),false);
  } finally {s.close();}
});

test('screen-size levels follow orthographic zoom, not camera distance', async () => {
  const {CameraProjection}=await import('../../cameras/dist/index.js');
  const e=await plain(),projection=new CameraProjection(),lods=new LODSystem({hysteresis:0});e.use(projection);e.use(lods);
  const m=e.createMesh().setPosition([0,0,-10]),g=box(2,2,2),lod=lods.add(m,[{object:g},{object:null,screen:0.25}]),r=g.bounds[3];
  // Orthographic: screen = r / (height / 2), independent of distance. The switch is at height = 2r / 0.25.
  const switchHeight=2*r/0.25;
  projection.height=switchHeight*0.99;e.render();lods.update();assert.equal(lod.level,0,'zoomed in shows detail');
  projection.height=switchHeight*1.01;e.render();lods.update();assert.equal(lod.level,1,'zoomed out switches');
  m.setPosition([0,0,-1000]);projection.height=switchHeight*0.99;e.render();lods.update();assert.equal(lod.level,0,'distance does not matter in orthographic');
  e.dispose();
});
