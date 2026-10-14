import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine,TransformStore} from '../../core/dist/extension.js';
import {boxGeometry,planeGeometry} from '../../geometry/dist/index.js';
import {Texture,Material,createMesh,loadTexture,packGeometry,materialShader} from '../dist/index.js';
import {optionalGPU} from '../../../tests/support/optional-gpu.js';

async function scene(){
  const h=optionalGPU(),device=h.engine.gpu,store=await TransformStore.create(64),uploads=[];
  device.limits.maxTextureDimension2D=8192;
  const create=device.createTexture;device.createTexture=d=>{const t=create(d);t.createView=(v={})=>({texture:t,...v});return t;};
  device.queue.copyExternalImageToTexture=(info,destination,size)=>uploads.push({source:info.source,flipY:info.flipY,destination,size});
  device.queue.writeTexture=(destination,data,layout,size)=>{if(size[0]*size[1]>1)uploads.push({destination,data,size});};
  device.queue.submit=()=>{h.counts.submits=(h.counts.submits??0)+1;};
  device.createCommandEncoder=()=>({beginRenderPass(){h.counts.mips=(h.counts.mips??0)+1;return {setPipeline(){},setBindGroup(){},draw(){},end(){}};},finish(){return {};}});
  const engine=new Engine({width:128,height:96,clientWidth:128,clientHeight:96},store,{backend:'webgpu',gpu:device,add(){},remove(){},render(){},dispose(){}},{position:[0,0,4],target:[0,0,0]},null);
  engine.camera.update(128/96,true);
  const context={...h.context,camera:engine.camera},frame=()=>{store.tick(false);engine.frameGraph.execute(context);};
  const lighting=()=>h.groups.filter(g=>g.entries.some(e=>e.binding===32));
  return {h,device,engine,frame,uploads,lighting,close(){engine.dispose();h.cleanup();}};
}
const triangle={positions:[0,0,0,1,0,0,0,1,0],normals:[0,0,2,0,0,1,0,0,1],uvs:[0,0,1,0,0,1]};

test('packGeometry writes the gltf-pro 80-byte vertex once per geometry object',()=>{
  const g={...triangle,tangents:[2,0,0,-0.5,1,0,0,1,1,0,0,0],colors:new Uint8Array([255,0,0,0,255,0,0,0,255])},p=packGeometry(g);
  assert.equal(p.vertices.length,60);assert.deepEqual([...p.indices],[0,1,2]);assert.equal(packGeometry(g),p);
  assert.deepEqual([...p.vertices.slice(0,20)],[0,0,0,1,0,0,1,0,1,0,0,-1,0,0,0,0,1,0,0,1]);
  assert.deepEqual([...p.vertices.slice(52,56)],[0,1,0,1]);
  const box=packGeometry(boxGeometry(1,1,1));assert.equal(box.vertices.length/20,24);assert.equal(box.indices.length,36);
  assert.throws(()=>packGeometry({positions:[0,0,0],normals:[0,0,1]}),RangeError);
  assert.throws(()=>packGeometry({...triangle,uvs:[0,0]}),RangeError);
  assert.throws(()=>packGeometry({...triangle,normals:[0,0,0,0,0,1,0,0,1]}),/non-zero/);
});

test('Material converts colors, validates options and keeps live gltf-pro arrays in sync',()=>{
  const m=new Material({color:'#ff8000',opacity:0.5,roughness:0.25,metalness:1,emissive:[0.1,0.2,0.3],alphaTest:0.4,doubleSided:true});
  assert.equal(m.color[0],1);assert.ok(Math.abs(m.color[1]-0.2158605)<1e-6);assert.equal(m.color[3],0.5);
  assert.deepEqual(m.factors,[0.25,1,1,1]);assert.deepEqual(m.settings,[1,0.4,1,0]);
  m.transparent=true;assert.equal(m.settings[0],2);m.transparent=false;m.alphaTest=0;assert.equal(m.settings[0],0);
  m.roughness=0.5;m.normalScale=-2;m.opacity=1;m.doubleSided=false;assert.deepEqual(m.factors,[0.5,1,-2,1]);assert.equal(m.color[3],1);assert.equal(m.settings[2],0);
  assert.throws(()=>new Material({roughness:2}),RangeError);assert.throws(()=>new Material({color:'red'}),TypeError);
  assert.throws(()=>new Material({map:{}}),TypeError);assert.throws(()=>new Material({shading:'phong'}),TypeError);
  assert.throws(()=>{m.metalness=-1;},RangeError);
  assert.equal(new Material().customState,false);assert.equal(new Material({blending:'additive'}).customState,true);assert.equal(new Material({depthWrite:false}).customState,true);
});

test('Texture validates sources and options',()=>{
  assert.throws(()=>new Texture({data:new Uint8Array(4),width:2,height:1}),RangeError);
  assert.throws(()=>new Texture({width:1,height:1},{wrapS:'tile'}),TypeError);
  assert.throws(()=>new Texture({width:1,height:1},{anisotropy:32}),TypeError);
  const t=new Texture({data:new Uint8ClampedArray(16),width:2,height:2});assert.equal(t.width,2);assert.equal(t.isVideo,false);
  assert.equal(new Texture({videoWidth:0,videoHeight:0,readyState:0}).isVideo,true);
});

test('createMesh draws through gltf-pro with patched shader and default bindings',async()=>{
  const s=await scene();
  try {
    const model=createMesh(s.engine,boxGeometry(1,1,1),new Material({color:[0.5,0.25,1]}));
    assert.equal(model.primitives.length,1);assert.ok(s.engine.hasPlugin(model.name));
    s.frame();
    const pipeline=s.h.pipelines.find(p=>p.fragment?.entryPoint==='fragment'),code=pipeline.vertex.module.code;
    for(let b=32;b<42;b++)assert.ok(code.includes(`@binding(${b})`));
    assert.ok(code.includes('textureSample(mat_baseMap,mat_baseMapS,')&&code.includes('*textureSample(baseMap,baseSampler,'));
    assert.ok(!code.includes('mat_out')&&!code.includes('@binding(42)'));
    const group=s.lighting().at(-1);assert.deepEqual(group.entries.map(e=>e.binding),[32,33,34,35,36,37,38,39,40,41]);
    assert.equal(group.entries[0].resource,group.entries[2].resource,'missing maps share the white default');
    assert.notEqual(group.entries[4].resource,group.entries[0].resource,'normal slot uses the flat normal default');
    const uniform=s.h.resources.find(r=>r.size===880);// gltf-pro's per-draw Frame uniformassert.deepEqual([...new Float32Array(uniform.data,76*4,4)],[0.5,0.25,1,1]);
  } finally {s.close();}
});

test('shading modes add early returns and matcap binds its own slot',()=>{
  const source='@group(1) @binding(0) var baseMap:texture_2d<f32>;\nfn surface(i:Out,front:bool)->Surface {\n  s.base=textureSample(baseMap,baseSampler,uv(i,f.coordsA.x))*f.base*i.color;\n  let mr=textureSample(mrMap,mrSampler,uv(i,f.coordsA.y));\n  let sampledNormal=textureSample(normalMap,normalSampler,uv(i,f.coordsA.z)).xyz*2-1;\n  s.occlusion=mix(1.0,textureSample(aoMap,aoSampler,uv(i,f.coordsA.w)).r,f.factors.w);\n  s.emissive=textureSample(emissiveMap,emissiveSampler,uv(i,f.coordsB.x)).rgb*f.emissive.xyz;\n}\n@fragment fn fragment(i:Out,@builtin(front_facing) front:bool)->@location(0) vec4f {\n  let s=surface(i,front); let v=1;\n}';
  const basic=materialShader(source,2,'basic');assert.ok(basic.includes('fn mat_out'));assert.ok(/let s=surface\(i,front\);\n  let alpha=.*\n  if\(f\.coordsB\.w<0\.5\)\{return vec4f\(mat_out\(s\.base\.rgb\+s\.emissive\),alpha\);\}/.test(basic));
  assert.equal(materialShader(source,2,'basic'),basic,'patches are cached per source');
  const matcap=materialShader(source,3,'matcap');assert.ok(matcap.includes('@group(3) @binding(42) var mat_matcap:texture_2d<f32>;'));assert.ok(matcap.includes('textureSample(mat_matcap,mat_matcapS,'));
  assert.ok(materialShader(source,2,'normal').includes('normalize((f.view*vec4f(s.n,0)).xyz)*0.5+0.5'));
  assert.ok(materialShader(source,2,'standard').includes('+0*textureSample(normalMap,normalSampler,uv(i,f.coordsA.z)).xyz'));
  assert.throws(()=>materialShader('fn other(){}',2,'standard'),/standard gltf-pro PBR shader/);
});

test('textures upload once, are shared, honor color space and re-upload on update or new video frames',async()=>{
  const s=await scene();
  try {
    const image={width:256,height:128},map=new Texture(image,{wrapS:'repeat',anisotropy:8}),normalMap=new Texture({data:new Uint8Array(16).fill(200),width:2,height:2});
    const video={videoWidth:0,videoHeight:0,readyState:0,currentTime:0},screen=new Texture(video);
    const lit=new Material({map,normalMap}),a=createMesh(s.engine,planeGeometry(1,1),lit),b=createMesh(s.engine,boxGeometry(1,1,1),new Material({map,emissiveMap:screen,shading:'basic'}));
    s.frame();
    const images=s.uploads.filter(u=>u.source===image),data=s.uploads.filter(u=>u.data);
    assert.equal(images.length,1,'shared texture uploads once');assert.equal(images[0].flipY,true);assert.deepEqual(images[0].size,[256,128]);
    const texture=images[0].destination.texture;assert.equal(texture.format,'rgba8unorm-srgb');assert.equal(texture.mipLevelCount,9);assert.deepEqual(texture.viewFormats,['rgba8unorm']);
    assert.equal(s.h.counts.mips,9,'8 levels for the image, 1 for the 2x2 normal map');
    assert.equal(data.length,1);assert.equal(data[0].destination.texture.format,'rgba8unorm','normal maps default to linear');
    const groups=s.lighting(),first=groups.find(g=>g.entries[0].resource.texture===texture);assert.equal(first.entries[0].resource.format,'rgba8unorm-srgb');
    assert.ok(groups.every(g=>g.entries[8].resource.texture?.mipLevelCount!==1),'unready video binds the default');
    const before=s.uploads.length;s.frame();assert.equal(s.uploads.length,before,'no re-upload without changes');
    map.update();s.frame();assert.equal(s.uploads.filter(u=>u.source===image).length,2);
    Object.assign(video,{videoWidth:4,videoHeight:2,readyState:4,currentTime:1});s.frame();
    const frames=s.uploads.filter(u=>u.source===video);assert.equal(frames.length,1);assert.equal(frames[0].destination.texture.mipLevelCount,1,'video skips mipmaps');
    s.frame();assert.equal(s.uploads.filter(u=>u.source===video).length,1,'paused video does not re-upload');
    video.currentTime=1.04;s.frame();assert.equal(s.uploads.filter(u=>u.source===video).length,2);
    const pipeline=s.h.pipelines.filter(p=>p.fragment?.entryPoint==='fragment').map(p=>p.vertex.module.code);assert.ok(pipeline.some(code=>code.includes('fn mat_out')));
    assert.equal(a.primitives[0].material.factors,lit.factors);assert.equal(a.primitives[0].material.base,lit.color);
    const old=texture;map.dispose();assert.equal(old.destroyed,true);s.frame();assert.equal(s.uploads.filter(u=>u.source===image).length,3,'disposed textures upload again on use');
    a.destroy();b.destroy();
  } finally {s.close();}
});

test('materials draw opaque first, then transparent back to front, each by renderOrder, with render-state pipelines',async()=>{
  const s=await scene();
  try {
    const order=[],mesh=(name,material,position,options)=>{const m=createMesh(s.engine,planeGeometry(1,1),material,options);m.root.setPosition(position);const draw=m.draw.bind(m);m.draw=(c,...rest)=>{order.push(name);return draw(c,...rest);};return m;};
    const glass=new Material({transparent:true,opacity:0.5}),glow=new Material({blending:'additive',depthWrite:false,transparent:true}),solid=new Material();
    const near=mesh('near',glass,[0,0,2]),far=mesh('far',glass,[0,0,-6]),late=mesh('late',solid,[0,0,0],{renderOrder:1}),early=mesh('early',solid,[0,0,0],{renderOrder:-1}),add=mesh('add',glow,[0,0,-1]);
    s.frame();assert.deepEqual(order,['early','late','far','add','near']);
    order.length=0;near.root.setPosition([0,0,-20]);glass.transparent=false;s.frame();assert.deepEqual(order,['early','near','far','late','add']);
    const additive=s.h.pipelines.filter(p=>p.fragment?.targets[0].blend?.color.dstFactor==='one');assert.equal(additive.length,1);assert.equal(additive[0].depthStencil.depthWriteEnabled,false);
    assert.ok(s.h.pipelines.filter(p=>p.fragment?.entryPoint==='fragment'&&!p.fragment.targets[0].blend).every(p=>p.depthStencil.depthWriteEnabled));
    far.destroy();order.length=0;s.frame();assert.ok(!order.includes('far'));
    for(const m of [near,late,early,add])m.destroy();
  } finally {s.close();}
});

test('loadTexture fetches into an owned ImageBitmap and enforces protocol and size limits',async()=>{
  const fetchBefore=globalThis.fetch,bitmapBefore=globalThis.createImageBitmap,closed=[];let size=[4,4];
  globalThis.fetch=async()=>new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'image/png'}});
  globalThis.createImageBitmap=async blob=>{assert.equal(blob.type,'image/png');const b={width:size[0],height:size[1],close(){closed.push(b);}};return b;};
  try {
    const t=await loadTexture('https://assets.test/crate.png',{colorSpace:'linear'});assert.equal(t.width,4);assert.equal(t.options.colorSpace,'linear');assert.equal('signal' in t.options,false);
    t.dispose();assert.equal(closed.length,1);
    await assert.rejects(loadTexture('file:///crate.png'),/HTTP/);
    size=[8192,4096];await assert.rejects(loadTexture('https://assets.test/huge.png'),/size limit/);assert.equal(closed.length,2);
    new Texture({width:1,height:1}).dispose();assert.equal(closed.length,2,'caller-owned sources stay open');
  } finally {globalThis.fetch=fetchBefore;globalThis.createImageBitmap=bitmapBefore;}
});
