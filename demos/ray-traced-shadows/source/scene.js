
import {box,PbrMaterial} from '@margoengine/core';
import {MeshBVH} from '@margoengine/bvh';
import {Shadows} from '@margoengine/shadows';
import {rayTracedFilter} from '@margoengine/shadows/rt';
import {slab,hoops,reeds,feet,latticePosition,latticeBase} from './geometry.js';

const degrees=Math.PI/180;
const elevation=.638;
const horizontal=Math.sqrt(1-elevation*elevation);
const bounds={min:[-2.05,-.05,-1.55],max:[1.96,1.28,1.52]};
const methodText={
  map:'A depth map stores occluders on a grid. Its resolution changes how much of the grille survives in the shadow.',
  trace:'One ray per lit pixel tests the actual grille triangles. Look for the fine gaps that survive at the shadow’s edge.',
};
function material(color,roughness,metalness=0){
  return new PbrMaterial({color,roughness,metalness});
}

export function prepareStudy(){
  const ring=hoops(), lattice=reeds(), legs=feet();
  const blockers=[latticeBase(),ring.brass,ring.seam,lattice.dark,lattice.bright,legs.steel,legs.trim];
  const vertices=new Float32Array(blockers.reduce((size,g)=>size+g.vertices.length/2,0));
  const indices=new Uint32Array(blockers.reduce((size,g)=>size+g.indices.length,0));
  let nextVertex=0,nextIndex=0;
  for(const mesh of blockers){
    const base=nextVertex/3;
    for(let i=0;i<mesh.vertices.length;i+=6){
      vertices[nextVertex++]=mesh.vertices[i];
      vertices[nextVertex++]=mesh.vertices[i+1];
      vertices[nextVertex++]=mesh.vertices[i+2];
    }
    for(const index of mesh.indices)indices[nextIndex++]=base+index;
  }
  const bvh=MeshBVH.build({positions:vertices,indices});
  return {blockers,bvh,triangles:indices.length/3};
}

function assemble(engine,blockers){
  const warm=material('#bb8851',.26,1), amber=material('#d4a969',.31,1);
  const teal=material('#4f6570',.46), gray=material('#47585e',.6), black=material('#30373b',.52);
  const paving=material('#e0ccaf',.91), shell=material('#8c786a',.79), brassPaint=material('#9a7759',.7);
  const indigo=material('#484d62',.85), stands=material('#4b5d62',.48);
  function part(name,geometry,finish,position=[0,0,0]){
    const mesh=engine.createMesh().setGeometry(geometry).setMaterial(finish).setPosition(position);
    mesh.name=name;
    mesh.receiveShadow=false;
    return mesh;
  }

  part('Studio floor',box(140,.08,140),material('#55656e',.91),[0,-.23,0]);
  part('Exhibition support',slab(3.71,2.48,.290,.155,.021),indigo,[0,-.056,0]);
  part('Bronze seam of support',slab(3.70,2.46,.027,.152,.010),brassPaint,[0,.095,0]);
  part('Foundation of fossil-limestone surface',slab(3.65,2.42,.073,.141,.016),shell,[0,.123,0]);
  const receiver=part('Warm honed limestone receiver',slab(3.60,2.37,.048,.128,.012),paving,[0,.168,0]);
  receiver.receiveShadow=true;
  for(const side of [-1,1]){
    part('Recessed instrument side strip',box(.013,.003,1.70),gray,[side*1.68,.194,.026]);
    part('Bronze index plate',slab(.282,.093,.029,.024,.005),black,[side*1.48,.198,1.006]);
    part('Index inlay',box(.137,.004,.011),brassPaint,[side*1.48,.216,1.006]);
  }
  const tickGeometry=box(.021,.004,.010);
  for(let i=0;i<13;i++){
    const x=.21+i*.105;
    part('Fine measurement notch',tickGeometry,i%4===0?gray:brassPaint,[x,.194,1.052]);
  }

  part('Foot face incised edge',box(.80,.009,.012),stands,latticePosition(0,.230,.115)).setRotation([0,-.22,0]);
  const roles=[
    ['Dark blue steel rail foot',teal],['Outer bronze and inner return hoops',warm],
    ['Fine brass lip on the front rim',amber],['Dark curved blades',black],['Woven bronze spine',amber],
    ['Two curved uprights',stands],['Low support wires',warm],
  ];
  const casters=roles.map(([name,finish],i)=>part(name,blockers[i],finish));
  return {receiver,casters};
}

// Keep both visibility methods in the same receiver program. In map mode its
// ray contribution is one. In trace mode there are no depth-map casters.
function compareFilter(rays){
  let modeBuffer;
  const mode=new Uint32Array(4);
  const effect={
    call:'vec3f(shadowFxExactVisibility(position,normal))',
    wgsl(group,binding){
      return rays.wgsl(group,binding)+`
@group(${group}) @binding(${binding+6}) var<uniform> shadowFxExactMode:vec4u;
fn shadowFxExactVisibility(position:vec3f,normal:vec3f)->f32 {
  if(shadowFxExactMode.x==0u){return 1.0;}
  let depth=-(shadowFrame.view*vec4f(position,1)).z;
  if(depth>shadowReach()){return 1.0;}
  let place=shadowPlace(0u,position,normal);
  if(any(place.xy<vec2f(0))||any(place.xy>vec2f(1))||place.z<=0||place.z>=1){return 1.0;}
  ${rays.body}
}`;
    },
    setup(device, map){
      modeBuffer?.destroy();
      rays.setup(device,map);
      modeBuffer=device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    },
    resources(){
      return [...rays.resources(),{buffer:modeBuffer}];
    },
    update(frame){
      frame.context.device.queue.writeBuffer(modeBuffer,0,mode);
      if(mode[0])rays.update(frame);
    },
    dispose(){
      modeBuffer?.destroy();
      modeBuffer=undefined;
      rays.dispose();
    },
  };
  return {effect,setMode(value){mode[0]=value==='trace'?1:0;}};
}

export async function show({engine,canvas,status,notice,size,signal,fail,prepared}){
  const buttons=[...document.querySelectorAll('[data-mode]')];
  const angle=document.querySelector('#angle'),bearing=document.querySelector('#bearing'),res=document.querySelector('#resolution');
  const explanation=document.querySelector('#explanation'), current=document.querySelector('#current'), renderer=document.querySelector('#renderer');
  engine.scene.background='#4c5c67';
  engine.lighting.radiance.set([1,.84,.63,.37]);
  engine.lighting.ambient.set([.67,.75,.83]);
  const {receiver,casters}=assemble(engine,prepared.blockers);
  const ray=rayTracedFilter(engine,prepared.bvh,{rays:1,lightSize:0,far:12,bias:.0018});
  const compare=typeof ray==='string'?null:compareFilter(ray);
  const canTrace=compare!==null;
  let mode='map', azimuth=0, resolution=+res.value, revision=0, shownMode, first=false, pending=0;
  let detachCasters=[];
  const shadow=Shadows.attach(engine,{filter:'pcf',resolution,cascades:1,jitter:false,bounds,
    effects:compare?[compare.effect]:[]});
  shadow.add(receiver,{castShadow:false});
  canvas.dataset.renderer=engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'compatibility':'webgpu';
  canvas.dataset.traceSupported=String(canTrace);
  canvas.dataset.casterTriangles=String(prepared.triangles);
  renderer.textContent=canvas.dataset.renderer==='compatibility'?'Margo WebGL2':'Margo WebGPU';

  function changeMethod(){
    if(mode==='map'){
      detachCasters=casters.map(caster=>shadow.add(caster,{static:true}));
    }else{
      for(const detach of detachCasters)detach();
      detachCasters=[];
    }
    compare?.setMode(mode);
    shownMode=mode;
  }

  function draw(){
    const narrow=canvas.clientWidth<760;
    engine.camera.position=[1.59,2.61,3.66];
    engine.camera.target=[.045,.098,0];
    engine.camera.fov=narrow?47:35;
    const a=(-117+azimuth)*degrees;
    engine.lighting.direction.set([horizontal*Math.cos(a),elevation,horizontal*Math.sin(a),1.98]);
    if(shownMode!==mode)changeMethod();
    shadow.options.resolution=mode==='map'?resolution:128;
    engine.render(0);
  }

  async function update(mark){
    const serial=++revision;
    draw();
    await engine.gpu.queue.onSubmittedWorkDone();
    if(signal.aborted||serial!==revision)return;
    for(const button of buttons)button.setAttribute('aria-pressed',String(button.dataset.mode===mode));
    res.disabled=mode==='trace';
    bearing.value=(azimuth<0?'−':'')+Math.abs(azimuth)+'°';
    explanation.textContent=methodText[mode];
    current.textContent=mode==='trace'?'Triangle BVH · 1 ray per pixel':resolution+' × '+resolution+' depth map';
    if(!canTrace)current.textContent+=' · Ray tracing unavailable on this device';
    Object.assign(canvas.dataset,{mode,azimuth:String(azimuth),resolution:String(resolution),revision:String(serial)});
    if(mark&&!first){
      await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));
      if(!signal.aborted&&!first){
        first=true;
        performance.mark('ray-shadow-change-applied');
      }
    }
  }
  function request(){
    cancelAnimationFrame(pending);
    pending=requestAnimationFrame(()=>update(true).catch(fail));
  }
  for(const button of buttons)button.addEventListener('click',()=>{
    if(mode===button.dataset.mode)return;
    mode=button.dataset.mode;
    request();
  },{signal});
  angle.addEventListener('input',()=>{azimuth=+angle.value;request();},{signal});
  res.addEventListener('change',()=>{resolution=+res.value;request();},{signal});
  const observer=new ResizeObserver(()=>{
    if(!size())return;
    try{draw();}catch(reason){fail(reason);}
  });
  observer.observe(canvas);
  signal.addEventListener('abort',()=>{
    observer.disconnect();
    cancelAnimationFrame(pending);
  },{once:true});

  performance.mark('ray-study-built');
  await update(false);
  if(status.ready()){
    notice.hidden=true;
    angle.disabled=res.disabled=false;
    for(const control of buttons)control.disabled=control.dataset.mode==='trace'&&!canTrace;
    performance.mark('ray-study-ready');
  }
}
