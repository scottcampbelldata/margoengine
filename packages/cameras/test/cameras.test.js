import test from 'node:test';
import assert from 'node:assert/strict';
import {Camera,CADCameraControls} from '../../core/dist/index.js';
import {Engine,TransformStore,box} from '../../core/dist/extension.js';
import {viewMatrix} from '../../shared/view.js';
import {jitterProjection} from '../../taa/dist/index.js';
import {fitCascades,cascadeSplits} from '../../shadows/dist/index.js';
import {OrbitControls} from '../../controls/dist/index.js';
import {Raycaster} from '../../bvh/dist/index.js';
import {PointsPlugin,PointCloud} from '../../points/dist/index.js';
import {lookAtView} from '../../labels/dist/index.js';
import {optionalGPU} from '../../../tests/support/optional-gpu.js';
import {CameraProjection} from '../dist/index.js';

const clip=(m,p)=>[0,1,2,3].map(r=>m[r]*p[0]+m[4+r]*p[1]+m[8+r]*p[2]+m[12+r]);
const ndc=(m,p)=>{const c=clip(m,p);return c.map(v=>v/c[3]);};
const near=(a,b,eps=1e-5)=>a.every((v,i)=>Math.abs(v-b[i])<=eps*Math.max(1,Math.abs(b[i])));
const ortho=(options,camera=new Camera({position:[0,0,10],target:[0,0,0],fov:60}))=>{const p=new CameraProjection(options);p.attach(camera);return {camera,p};};
const element=()=>({clientWidth:400,clientHeight:200,style:{touchAction:''},addEventListener(){},removeEventListener(){},setPointerCapture(){},hasPointerCapture(){return false;},releasePointerCapture(){},getBoundingClientRect(){return {left:0,top:0,width:400,height:200};}});

test('orthographic projection matches three.js OrthographicCamera, including zoom and an off-centre frustum', () => {
  const {camera,p}=ortho({left:-4,right:2,top:3,bottom:-1,near:1,far:21,zoom:2});
  camera.update(1.5,true);const m=camera.matrix;
  assert.ok(!m[3]&&!m[7]&&!m[11]&&m[15]===1,'w row is constant');
  // three.js: dx=(r-l)/(2 zoom), cx=(r+l)/2 → visible x in [cx-dx,cx+dx] = [-2.5,0.5], y in [0,2]; aspect ignored.
  assert.ok(near(ndc(m,[-2.5,0,0]).slice(0,2),[-1,-1])&&near(ndc(m,[0.5,2,5]).slice(0,2),[1,1]));
  p.zoom=1;camera.update(0.3,true);assert.ok(near(ndc(camera.matrix,[2,3,-7]).slice(0,2),[1,1]),'explicit bounds keep three.js semantics on resize');
});

test('reversed-Z depth: near maps to 1 and far to 0 on WebGPU, -1..1 on WebGL', () => {
  const {camera}=ortho({height:4,near:-5,far:20});
  camera.update(1,true);assert.ok(Math.abs(ndc(camera.matrix,[0,0,15])[2]-1)<1e-6&&Math.abs(ndc(camera.matrix,[0,0,-10])[2])<1e-6);
  assert.ok(Math.abs(ndc(camera.matrix,[0,0,5])[2]-0.6)<1e-6,'linear in depth');
  camera.update(1,false);assert.ok(Math.abs(ndc(camera.matrix,[0,0,15])[2]+1)<1e-6&&Math.abs(ndc(camera.matrix,[0,0,-10])[2]-1)<1e-6);
  // Default range: camera.far deep, centred on the target, so a model is never cut by the eye when zoomed in.
  const d=ortho({});d.camera.far=100;d.camera.update(1,true);
  assert.ok(Math.abs(ndc(d.camera.matrix,[0,0,50])[2]-1)<1e-6&&Math.abs(ndc(d.camera.matrix,[0,0,-50])[2])<1e-6);
});

test('resize keeps the height and widens with the aspect; the default height follows distance so dolly is zoom', () => {
  const {camera,p}=ortho({height:4});
  for(const aspect of [0.5,1,2.5]){camera.update(aspect,true);assert.ok(near(ndc(camera.matrix,[2*aspect,2,0]).slice(0,2),[1,1]));}
  p.height=undefined;camera.update(1,true);const h=10*Math.tan(Math.PI/6);
  assert.ok(near(ndc(camera.matrix,[h,h,0]).slice(0,2),[1,1]),'matches perspective framing at the target');
  camera.position=[0,0,5];camera.update(1,true);assert.ok(near(ndc(camera.matrix,[h/2,h/2,0]).slice(0,2),[1,1]),'half the distance, twice the zoom');
  camera.fitToBoundingBox([-3,-1,-1],[3,1,1],{aspect:2,duration:0});camera.update(2,true);
  for(const corner of [[-3,-1,-1],[3,1,1],[3,-1,1]]){const v=ndc(camera.matrix,corner);assert.ok(v.every(x=>x>=-1&&x<=1),`fit keeps ${corner} visible`);}
});

test('exactly vertical views: core throws, the projection renders north-up and keeps position readers working', () => {
  assert.throws(()=>new Camera({position:[0,10,0],target:[0,0,0]}).update(1,true),/Vertical camera/);
  for(const mode of ['orthographic','perspective']){
    const {camera}=ortho({mode,height:4});camera.position=[1,10,2];camera.target=[1,0,2];camera.update(2,true);
    const centre=ndc(camera.matrix,[1,0,2]),east=ndc(camera.matrix,[1.5,0,2]),north=ndc(camera.matrix,[1,0,1.5]);
    assert.ok(near(centre.slice(0,2),[0,0],1e-6)&&east[0]>0&&Math.abs(east[1])<1e-6&&north[1]>0&&Math.abs(north[0])<1e-6,`${mode}: +x right, -z up`);
    assert.deepEqual(camera.position,[1,10,2],'position is left exactly vertical');assert.deepEqual(camera.up,[0,0,-1]);
    const view=viewMatrix(new Float32Array(16),camera),eye=[0,1,2].map(r=>view[r]*1.5+view[8+r]*2+view[12+r]);
    assert.ok(near(eye,[0.5,0,-10],1e-6),'shared viewMatrix (shadows, ssao, gltf-pro) uses camera.up: +x right, -z up');
    camera.update(2,true);assert.ok(near(ndc(camera.matrix,[1.5,0,2]),east,1e-6),'stable');
  }
  const below=ortho({mode:'perspective',up:[1,0,0]});below.camera.position=[0,-10,0];below.camera.update(1,true);
  const p=ndc(below.camera.matrix,[1,0,0]);assert.ok(p[1]>0&&Math.abs(p[0])<1e-6,'custom up looking up');
  const bad=ortho({up:[0,1,0]});bad.camera.position=[0,10,0];assert.throws(()=>bad.camera.update(1,true),/vertical up/);
});

test('perspective mode leaves non-vertical views to core exactly; dispose restores core project and up', () => {
  const reference=new Camera({position:[3,4,5],target:[0,1,0]});reference.update(1.3,true);
  const {camera,p}=ortho({mode:'perspective'},new Camera({position:[3,4,5],target:[0,1,0]}));camera.update(1.3,true);
  assert.deepEqual([...camera.matrix],[...reference.matrix]);assert.deepEqual([...camera.planes],[...reference.planes]);
  p.mode='orthographic';camera.update(1.3,true);assert.notDeepEqual([...camera.matrix],[...reference.matrix]);
  assert.deepEqual(camera.up,[0,1,0],'non-vertical views keep world up');camera.up=[0,1,0];
  p.dispose();camera.update(1.3,true);assert.deepEqual([...camera.matrix],[...reference.matrix]);
  assert.equal(camera.project,undefined);assert.ok(Object.getOwnPropertyDescriptor(camera,'up').writable,'up is a plain field again');
  camera.position=[0,9,0];assert.throws(()=>camera.update(1.3,true),/Vertical camera/,'core behaviour after dispose');
  assert.throws(()=>{const q=new CameraProjection();q.attach(camera);q.attach(camera);},/attached/);
  assert.throws(()=>new CameraProjection().attach(camera),/already set/);
});

test('culling planes enclose exactly the orthographic box', () => {
  const {camera}=ortho({height:4,near:-5,far:20});camera.update(2,true);
  for(let i=0;i<2000;i++){
    const p=[(Math.random()-0.5)*12,(Math.random()-0.5)*6,(Math.random()-0.5)*40],v=ndc(camera.matrix,p),inside=v.every(x=>x>=-1&&x<=1)&&v[2]>=0;
    const planes=[0,1,2,3,4,5].map(k=>camera.planes[k*4]*p[0]+camera.planes[k*4+1]*p[1]+camera.planes[k*4+2]*p[2]+camera.planes[k*4+3]);
    if(Math.min(...planes.map(Math.abs))>1e-4)assert.equal(planes.every(d=>d>=0),inside,`${p}`);
  }
});

async function engine(projection){
  const store=await TransformStore.create(16),seen=[];
  const renderer={backend:'webgpu',gpu:null,add(){},remove(){},dispose(){},render(camera){seen.push(camera.matrix.slice());},async pick(camera){seen.push(camera.matrix.slice());return null;}};
  const e=new Engine({width:400,height:200,clientWidth:400,clientHeight:200},store,renderer,{position:[0,0,10],target:[0,0,0],near:1,far:100},null);
  if(projection)e.use(projection);return {e,seen};
}

test('engine culling, render and pick use the orthographic frustum without disabling culling', async () => {
  const geometry=box(0.2,0.2,0.2);
  for(const projection of [undefined,new CameraProjection({height:4})]){
    const {e,seen}=await engine(projection),edge=e.createMesh().setGeometry(geometry),outside=e.createMesh().setGeometry(geometry);
    edge.position.set(3.8,1.8,8.5);outside.position.set(4.5,0,0);
    e.render();
    // Near the eye the perspective frustum is narrow, at the target it is wide: each view culls what the other shows.
    assert.equal(e.store.visible[edge.id],projection?1:0);assert.equal(e.store.visible[outside.id],projection?0:1);
    if(projection){assert.deepEqual([...seen[0]],[...e.camera.matrix]);assert.ok(!seen[0][11]);
      globalThis.devicePixelRatio=1;await e.pick(100,50);assert.ok(!seen[1][11],'pick updates through the projection');}
    e.dispose();
  }
});

test('picking: the core pick matrix and bvh rays agree with the orthographic projection', () => {
  const {camera}=ortho({height:4});camera.position=[2,6,8];camera.target=[0,0,0];camera.update(2,true);
  const W=400,H=200,world=[1.2,-0.4,0.7],c=ndc(camera.matrix,world),x=Math.floor((c[0]+1)/2*W),y=Math.floor((1-c[1])/2*H);
  // renderer.pick and selection: shift the clicked pixel's centre to the 1x1 target origin.
  const m=camera.matrix.slice(),nx=2*(x+0.5)/W-1,ny=1-2*(y+0.5)/H;for(let k=0;k<4;k++){m[k*4]=(camera.matrix[k*4]-nx*camera.matrix[k*4+3])*W;m[k*4+1]=(camera.matrix[k*4+1]-ny*camera.matrix[k*4+3])*H;}
  const pixel=ndc(m,world);assert.ok(Math.abs(pixel[0])<=1&&Math.abs(pixel[1])<=1,'the world point lands in the picked pixel');
  const ray=new Raycaster().setFromCamera([c[0],c[1]],camera),to=world.map((v,i)=>v-ray.origin[i]),along=to.reduce((s,v,i)=>s+v*ray.direction[i],0);
  assert.ok(Math.hypot(...to.map((v,i)=>v-along*ray.direction[i]))<1e-4,'ray passes through the point');
  const forward=[0,0,0].map((_,i)=>camera.target[i]-camera.position[i]),length=Math.hypot(...forward);assert.ok(near([...ray.direction],forward.map(v=>v/length),1e-5),'rays are parallel to the view');
});

test('core CAD controls and orbit controls zoom and pan the orthographic view', () => {
  const {camera}=ortho({}),aspect=2,controls=new CADCameraControls(camera,element());camera.update(aspect,true);
  const before=ndc(camera.matrix,[1,1,0]);controls.pan(0.1,0);camera.update(aspect,true);
  // A 0.1 * clientHeight drag right moves content right by the same pixels: 0.1*200/400*2 NDC.
  assert.ok(Math.abs(ndc(camera.matrix,[1,1,0])[0]-before[0]-0.1)<1e-6,'pan tracks the cursor');
  const height=()=>{camera.update(aspect,true);return 2/Math.hypot(camera.matrix[1],camera.matrix[5],camera.matrix[9]);};
  const h0=height();camera.position=camera.position.map((v,i)=>camera.target[i]+(v-camera.target[i])*0.5);assert.ok(Math.abs(height()-h0/2)<1e-6,'wheel dolly halves the view height');
  controls.dispose();
  const orbit=new OrbitControls(camera),h1=height();orbit.dollyIn(0.5);orbit.update(0);assert.ok(Math.abs(height()-h1/2)<1e-6,'orbit dolly zooms');
  orbit.rotateUp(10);orbit.update(0);assert.doesNotThrow(()=>height(),'orbit clamps at the pole');orbit.dispose();
});

test('taa jitter and shadow cascades accept the orthographic and vertical camera', () => {
  const {camera}=ortho({height:4});camera.position=[0,10,0];camera.update(2,true);
  const jittered=jitterProjection(new Float32Array(16),camera.matrix,3,400,200),a=ndc(camera.matrix,[0.3,0,0.2]),b=ndc(jittered,[0.3,0,0.2]);
  assert.ok(Math.abs(b[0]-a[0])<=1/400&&Math.abs(b[1]-a[1])<=1/200&&(b[0]!==a[0]||b[1]!==a[1]),'sub-pixel constant offset');
  const splits=cascadeSplits(camera.near,50);assert.doesNotThrow(()=>fitCascades(camera,2,[0.3,-1,0.2],2048,splits));
});

test('an exact top-down view reaches shared viewMatrix, labels and points through camera.up', async () => {
  const h=optionalGPU(),store=await TransformStore.create(16);
  globalThis.GPUShaderStage??={VERTEX:1,FRAGMENT:2,COMPUTE:4};globalThis.GPUTextureUsage??={COPY_SRC:1,COPY_DST:2,TEXTURE_BINDING:4,STORAGE_BINDING:8,RENDER_ATTACHMENT:16};
  h.engine.gpu.createBindGroupLayout??=d=>({...d});h.engine.gpu.createPipelineLayout??=d=>({...d});
  const e=new Engine({width:400,height:200,clientWidth:400,clientHeight:200},store,{backend:'webgpu',gpu:h.engine.gpu,add(){},remove(){},render(){},dispose(){}},{position:[1,10,2],target:[1,0,2],near:1,far:100},null);
  try {
    e.use(new CameraProjection({height:4}));e.camera.update(2,true);
    const shared=viewMatrix(new Float32Array(16),e.camera);
    // Right is +x, up is -z, back is +y: north up looking straight down.
    assert.deepEqual([shared[0],shared[4],shared[8],shared[1],shared[5],shared[9],shared[2],shared[6],shared[10]].map(v=>Math.round(v)+0),[1,0,0,0,0,-1,0,1,0]);
    assert.ok(near([...lookAtView(e.camera.position,e.camera.target,undefined,e.camera.up)],[...shared]),'labels CSS camera');
    const points=new PointsPlugin();e.use(points);points.add(new PointCloud({positions:new Float32Array([1,0,2,1.5,0,2,1,0,1.5])}));
    e.frameGraph.execute({...h.context,camera:e.camera});
    const frame=h.resources.filter(r=>r.size===144&&r.data).map(r=>new Float32Array(r.data)).find(f=>f[16]);
    assert.ok(frame,'points wrote its frame uniform');
    assert.ok(near([...frame.subarray(24,36)],[shared[0],shared[4],shared[8],0,shared[1],shared[5],shared[9],0,shared[2],shared[6],shared[10],0]),'points camera basis');
  } finally {e.dispose();h.cleanup();}
});

test('labels lookAtView and shared viewMatrix match core for the default up', () => {
  for(let i=0;i<200;i++){
    const camera=new Camera({position:[Math.random()*20-10,Math.random()*20-10,Math.random()*20-10],target:[Math.random(),Math.random(),Math.random()]});
    const v=viewMatrix(new Float32Array(16),camera),l=lookAtView(camera.position,camera.target);
    assert.deepEqual([...v],[...Float32Array.from(l)]);
  }
});
