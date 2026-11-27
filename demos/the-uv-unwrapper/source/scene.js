import {Geometry,PbrMaterial,box} from '@margoengine/core';
import {unwrapMesh,meshLightmapUVs} from '@margoengine/mesh-edit/modeling';
import {autoEngine} from '@margoengine/webgl2-compat/auto';
import {applyQualityTier} from '@margoengine/quality';
import {demoStatus} from 'margo-demo-status';
import {fixture,cutStyles} from './fixture.mjs';
import {inspectSurface} from './inspection.js';

const id=name=>document.getElementById(name);
const canvas=id('view'),atlas=id('atlas'),cuts=id('cuts'),unwrap=id('unwrap'),lightmap=id('lightmap');
const loading=id('status'),message=demoStatus(document.body,loading,id('error'));
const state=document.body.dataset;
const controller=new AbortController(),{signal}=controller;
const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
const draft=fixture.faces.map(face=>face.uv);
const textureLayout={resolution:1024,padding:4},bakeLayout={resolution:256,padding:3};
const layouts=new Map();
const material=(color,roughness,metalness)=>new PbrMaterial({color,roughness,metalness});
const edgeKey=(a,b)=>Math.min(a,b)+':'+Math.max(a,b);
const accents=['#99c8c9','#e2ab76','#d7d2a2','#9ec1a1','#a2accc','#d4a1aa','#accfdd'];
let engine,renderer,resize,frame,drag;
let yaw=.57,pitch=.37,layout=cutStyles[0],kind='draft',revision=0;
const atlasPadding=31;

function makeStage(target){
  const shell=material('#3c4849',.53,.51);
  const steel=material('#728582',.43,.59);
  const green=material('#4b5a55',.51,.52);
  const black=material('#222a2b',.54,.33);
  const floor=material('#343e3f',.77,.14);
  const mark=material('#dcb781',.48,.42);
  function mount(geometry,surface,position){
    return target.createMesh().setGeometry(geometry).setMaterial(surface).setPosition(position);
  }
  function lathe(profile,sides=60){
    const points=[],normals=[],triangles=[];
    for(let i=0;i<profile.length;i++){
      const [r,y]=profile[i], a=profile[Math.max(0,i-1)], b=profile[Math.min(profile.length-1,i+1)];
      const dr=b[0]-a[0],dy=b[1]-a[1],length=Math.hypot(dr,dy);
      for(let j=0;j<=sides;j++){
        const angle=2*Math.PI*j/sides,c=Math.cos(angle),s=Math.sin(angle);
        points.push(c*r,y,s*r);
        normals.push(c*dy/length,-dr/length,s*dy/length);
        if(i&&j){
          const d=i*(sides+1)+j,a=d-sides-2;
          triangles.push(a,d,a+1,a,d-1,d);
        }
      }
    }
    return new Geometry(points,normals,triangles);
  }
  mount(box(80,.07,80),floor,[0,-.225,0]);
  mount(lathe([[0,-.17],[1.045,-.17],[1.14,-.14],[1.18,-.10],[1.18,-.045],[1.14,-.02],[0,-.02]]),shell,[-1.46,0,0]);
  mount(lathe([[0,-.025],[.92,-.025],[.97,-.012],[.988,.014],[.988,.055],[.972,.068],[0,.068]]),steel,[-1.46,0,0]);
  mount(lathe([[0,.065],[.802,.065],[.827,.087],[.827,.132],[.806,.154],[0,.154]]),green,[-1.46,0,0]);
  mount(lathe([[0,.154],[.647,.154],[.669,.176],[.669,.222],[.651,.252],[0,.252]]),black,[-1.46,0,0]);
  for(let i=0;i<12;i++){
    const a=(i+.5)*Math.PI/6, x=Math.sin(a), z=Math.cos(a);
    mount(box(i%3===0?.025:.012,.005,.058),i%3===0?mark:steel,[-1.46+x*.751,.157,z*.751]).setQuaternion([0,Math.sin(a/2),0,Math.cos(a/2)]);
  }
  const screw=lathe([[0,.001],[.051,.001],[.060,.009],[.060,.020],[.054,.025],[0,.025]],6);
  for(const [x,z] of [[-.61,0],[.61,0],[0,.61],[0,-.61]]){
    mount(screw,steel,[-1.46+x,.233,z]);
    mount(box(.044,.003,.009),black,[-1.46+x,.260,z]);
  }
  const panel=mount(box(.52,.008,.142),black,[-1.46,.072,.885]);
  panel.setQuaternion([0,Math.sin(-.08),0,Math.cos(-.08)]);
  for(let k=0;k<6;k++)mount(box(k%2?.025:.012,.008,.055),mark,[-1.65+k*.063,.078,.897-k*.011]);
}

function camera(){
  const dpr=Math.min(devicePixelRatio||1,1.7);
  const w=Math.max(1,Math.round(canvas.clientWidth*dpr)),h=Math.max(1,Math.round(canvas.clientHeight*dpr));
  if(canvas.width!==w)canvas.width=w;
  if(canvas.height!==h)canvas.height=h;
  const radius=w/h<1.37?6.7:5.76;
  const center=[-.72,1.32,0];
  const dx=radius*Math.cos(pitch);
  engine.camera.position=[center[0]+Math.sin(yaw)*dx,center[1]+Math.sin(pitch)*radius,Math.cos(yaw)*dx];
  engine.camera.target=center;
  state.orbit=yaw.toFixed(3)+','+pitch.toFixed(3);
}
function render(){
  camera();
  engine.render({delta:0});
}
function requestRender(){
  if(frame||signal.aborted)return;
  frame=requestAnimationFrame(()=>{
    frame=undefined;
    try{render();}catch(error){fail(error);}
  });
}
function hex(rgb){
  return '#'+rgb.map(n=>Math.round(n*255).toString(16).padStart(2,'0')).join('');
}
function paintAtlas(uv,seams,charts,mode){
  const size=Math.max(300,Math.round(atlas.clientWidth*Math.min(2,devicePixelRatio||1)));
  atlas.width=atlas.height=size;
  const g=atlas.getContext('2d'), inset=atlasPadding*size/680, space=size-2*inset;
  const toPoint=([u,v])=>[inset+u*space,inset+v*space];
  g.fillStyle='#202a30';
  g.fillRect(0,0,size,size);
  g.strokeStyle='#798786';g.lineWidth=1;
  g.strokeRect(inset-.5,inset-.5,space+1,space+1);
  g.setLineDash([3,4]);
  g.strokeStyle='#566563';
  for(let i=1;i<8;i++){
    const a=inset+i*space/8;
    g.beginPath();g.moveTo(a,inset);g.lineTo(a,size-inset);g.moveTo(inset,a);g.lineTo(size-inset,a);g.stroke();
  }
  g.setLineDash([]);
  const clip=new Path2D();
  for(const polygon of uv){
    clip.moveTo(...toPoint(polygon[0]));
    for(const point of polygon.slice(1))clip.lineTo(...toPoint(point));
    clip.closePath();
  }
  g.save();
  g.clip(clip);
  const cells=mode==='draft'?12:19, cell=space/cells;
  const palette=[hex([.192,.271,.274]),mode==='light'?hex([.67,.80,.79]):hex([.85,.73,.48])];
  for(let i=0;i<cells;i++)for(let j=0;j<cells;j++){
    g.fillStyle=palette[(i+j)%2];
    g.fillRect(inset+i*cell,inset+j*cell,cell+.4,cell+.4);
  }
  g.restore();
  const cutEdges=new Set(seams);
  const chartIndex=new Map(charts.flatMap((c,i)=>c.faces.map(f=>[f,i])));
  for(let i=0;i<uv.length;i++){
    const face=fixture.faces[i];
    g.strokeStyle=accents[(chartIndex.get(face.id)??0)%accents.length];
    g.lineWidth=Math.max(1.2,size/320);
    if(mode==='draft')continue;
    for(let j=0;j<face.vertices.length;j++){
      const next=(j+1)%face.vertices.length;
      if(!cutEdges.has(edgeKey(face.vertices[j],face.vertices[next])))continue;
      g.beginPath();g.moveTo(...toPoint(uv[i][j]));g.lineTo(...toPoint(uv[i][next]));g.stroke();
    }
  }
  g.fillStyle='#bcceca';g.font=(Math.max(9,size/42))+'px ui-monospace, monospace';
  g.textBaseline='middle';g.textAlign='left';
  g.fillText('0',inset,inset*.46);g.fillText('0',inset*.23,inset);
  g.textAlign='right';
  g.fillText('U  1',size-inset,inset*.46);
  g.textAlign='center';
  g.fillText('V',inset*.43,size*.50);g.fillText('1',inset*.43,size-inset);
}
function answer(next){
  const key=layout.id+':'+next;
  if(layouts.has(key))return layouts.get(key);
  const options={angle:layout.angle,seams:layout.seams,signal,...(next==='light'?bakeLayout:textureLayout)};
  let result;
  if(next==='light')result=meshLightmapUVs(fixture,options);
  else {
    const unwrap=unwrapMesh(fixture,options);
    result={...unwrap,uv:unwrap.mesh.faces.map(face=>face.uv),resolution:textureLayout.resolution};
  }
  layouts.set(key,result);
  return result;
}
function statistics(result){
  const names={draft:'Draft UVs',texture:'Texture UVs',light:'Lightmap UVs'};
  id('view-label').textContent=names[kind];
  id('atlasSize').value=kind==='draft'?'Draft':result.resolution+' × '+result.resolution;
  id('islands').value=kind==='draft'?'—':String(result.charts.length);
  id('seams').value=kind==='draft'?'—':String(result.seams.length);
  const stretch=Math.max(0,...result.charts.map(c=>c.stretch));
  id('stretch').value=stretch?stretch.toFixed(2)+'×':'—';
  state.mode=kind;
  state.layout=layout.id;
  state.charts=String(result.charts.length);
  state.seams=String(result.seams.length);
  state.stretch=stretch.toFixed(5);
  state.resolution=String(result.resolution??0);
  lightmap.setAttribute('aria-pressed',String(kind==='light'));
  for(const button of cuts.querySelectorAll('button'))button.setAttribute('aria-pressed',String(button.dataset.cut===layout.id));
}
const draftResult={uv:draft,seams:[],charts:[]};
let selected=draftResult;
function apply(mode){
  kind=mode;
  selected=kind==='draft'?draftResult:answer(kind);
  renderer.show(selected.uv,selected.seams,kind);
  paintAtlas(selected.uv,selected.seams,selected.charts,kind);
  statistics(selected);
  render();
  const id=++revision;
  engine.gpu.queue.onSubmittedWorkDone().then(()=>{
    if(signal.aborted)return;
    state.revision=String(id);
    if(mode!=='draft'&&!performance.getEntriesByName('uv-unwrap-rendered').length)performance.mark('uv-unwrap-rendered');
  }).catch(fail);
}
function guarded(work){
  return event=>{
    try{work(event);}catch(error){fail(error);}
  };
}
function connect(){
  unwrap.addEventListener('click',guarded(()=>apply('texture')),{signal});
  lightmap.addEventListener('click',guarded(()=>apply(kind==='light'?'texture':'light')),{signal});
  cuts.addEventListener('click',guarded(event=>{
    const next=cutStyles.find(cut=>cut.id===event.target.closest('button')?.dataset.cut);
    if(!next||next===layout)return;
    layout=next;
    apply(kind==='light'?'light':'texture');
  }),{signal});
  canvas.addEventListener('pointerdown',event=>{
    if(drag)return;
    drag={id:event.pointerId,x:event.clientX,y:event.clientY,yaw,pitch};
    canvas.setPointerCapture(event.pointerId);
  },{signal});
  canvas.addEventListener('pointermove',event=>{
    if(drag?.id!==event.pointerId)return;
    yaw=drag.yaw-(event.clientX-drag.x)*.009;
    pitch=Math.min(1.03,Math.max(-.065,drag.pitch+(event.clientY-drag.y)*.008));
    requestRender();
  },{signal});
  canvas.addEventListener('lostpointercapture',()=>{drag=undefined;},{signal});
  resize=new ResizeObserver(()=>{
    paintAtlas(selected.uv,selected.seams,selected.charts,kind);
    requestRender();
  });
  resize.observe(canvas);
  resize.observe(atlas.parentElement);
}

async function compatibility(){
  const {install}=await import('@margoengine/webgl2-compat');
  return {install:()=>install({force:true,signal})};
}
async function open(target){
  if(!target.gpu)throw new Error('This exhibit needs full WebGPU or the WebGL2 compatibility renderer.');
  engine=target;
  target.scene.background='#1a2928';
  target.lighting.direction.set([-.44,.8,.53,2.3]);
  target.lighting.radiance.set([1,.94,.79,.52]);
  target.lighting.ambient.set([.84,.91,.97]);
  makeStage(target);
  renderer=inspectSurface(target);
  apply('draft');
  await target.gpu.queue.onSubmittedWorkDone();
}
async function start(){
  applyQualityTier();
  const known=forced||!navigator.gpu;
  if(known)await (await compatibility()).install();
  await autoEngine(canvas,open,{
    signal,exactSize:true,antialias:false,loadCompat:compatibility,backend:known?'webgpu':undefined,
    camera:{near:.05,far:36,fov:40},startupTimeout:4500,
  });
  signal.throwIfAborted();
  engine.onError=fail;
  state.renderer=engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu';
  cuts.disabled=unwrap.disabled=lightmap.disabled=false;
  loading.hidden=true;
  connect();
  message.ready();
  performance.mark('margo-first-usable-frame');
}
function dispose(){
  controller.abort();
  cancelAnimationFrame(frame);
  resize?.disconnect();
  renderer?.dispose();
  engine?.dispose();
}
function fail(error){
  if(signal.aborted)return;
  message.error(error);
  loading.hidden=true;
  id('error').hidden=false;
  console.error(error);
  dispose();
}
addEventListener('pagehide',event=>{if(!event.persisted)dispose();});
start().catch(fail);
