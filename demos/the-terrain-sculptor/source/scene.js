import {Terrain} from '@margoengine/terrain';
import {TerrainSculpt} from '@margoengine/terrain/sculpt';
import {TerrainHoles} from '@margoengine/terrain/holes';
import {TerrainQuery} from '@margoengine/terrain/query';
import {cave,caveBoundary,columns,extent,origin,spacing} from './ground-data.js';
import {makeMaterials} from './surface.js';
import {geology} from './art.js';

const levels=7, resolution=64, cacheSize=256, cacheLevels=5;
const nextFrame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
const names={raise:'Raise ground',lower:'Lower ground',smooth:'Smooth ground',paint:'Paint ochre'};
const normalized=v=>{const length=Math.hypot(...v);return v.map(n=>n/length);};
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const clamp=(v,min,max)=>Math.min(max,Math.max(min,v));

function groundRay(camera,x,y,aspect){
  const forward=normalized(camera.target.map((n,i)=>n-camera.position[i]));
  const across=normalized(cross(forward,camera.up)),up=cross(across,forward);
  const focal=Math.tan(camera.fov*Math.PI/360),sx=(x*2-1)*focal*aspect,sy=(1-y*2)*focal;
  return normalized(forward.map((n,i)=>n+across[i]*sx+up[i]*sy));
}

function createTerrain(engine,data,holes,maps,settings){
  return Terrain.attach(engine,{
    ...settings,resolution,levels,cellSize:3,clipmapAnchor:'camera',roughness:.87,
    layers:[.082,.092,.072,.108].map((scale,index)=>({
      height:[-300,400],slope:[0,1],scale,macro:index===0?.26:.18,
    })),
    textures(device){
      const usage=GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.COPY_SRC|GPUTextureUsage.STORAGE_BINDING;
      const heightmap=device.createTexture({size:[columns,columns],format:'r32float',usage});
      const weights=device.createTexture({size:[columns,columns],format:'rgba8unorm',usage});
      device.queue.writeTexture({texture:heightmap},data.heights,{bytesPerRow:columns*4},[columns,columns]);
      device.queue.writeTexture({texture:weights},data.weights,{bytesPerRow:columns*4},[columns,columns]);
      return {heightmap,layers:maps.layers(device),weights:[weights,weights],holes:holes.texture(device)};
    },
  });
}

export async function show({engine,data,canvas,notice,status,size,signal,fail}){
  const brushes=[...document.querySelectorAll('[name="brush"]')];
  const caveButton=document.querySelector('#cave'),inspectCave=document.querySelector('#inspect'), radius=document.querySelector('#radius');
  const survey=document.querySelector('#survey'), material=document.querySelector('#material');
  const undo=document.querySelector('#undo'),redo=document.querySelector('#redo'),guide=document.querySelector('#guide');
  const metres=document.querySelector('#metres'), angle=document.querySelector('#angle');
  const stats=document.querySelector('#statistics'),cursor=document.querySelector('#cursor');
  const settings={size:[extent,extent],origin,heightScale:1};
  const holes=new TerrainHoles(settings,1024),outline=caveBoundary();
  const maps=makeMaterials(data.maps),state=canvas.dataset;
  const compat=engine.gpu.adapterInfo?.vendor==='margo-webgl2';
  const mobile=matchMedia('(max-width:650px)');
  state.renderer=compat?'compatibility':'webgpu';
  document.querySelector('#renderer').textContent=compat?'Margo WebGL2':'Margo WebGPU';
  Object.assign(state,{clipmap:String(levels),span:String(extent),brush:'raise',cave:'closed',surface:'direct',
    confirmed:'0',draws:'0',cacheBaked:'0'});
  let pointer=null,stroke=null,lastHit=null,pending=false,scheduled=0,dirty=false,input=false,first=true;
  let tally=0,confirmed=0,switching=false,aperture=false,shaftView=false,mode='direct',tool='raise';
  let rvt,pbr,previousPoint;
  let undoCount=0, redoCount=0,boardOps=Promise.resolve(),aim=[.51,.58];

  engine.scene.background='#8f9899';
  engine.lighting.direction.set([-.69,.46,.52,3.31]);
  engine.lighting.radiance.set([1,.816,.639,.53]);
  engine.lighting.ambient.set([.61,.783,1.08]);
  engine.use(geology(data.art,()=>aperture));
  const terrain=createTerrain(engine,data,holes,maps,settings);
  function setCamera(){
    const theta=(16+Number(survey.value))*Math.PI/180;
    if(shaftView){
      engine.camera.position=[cave.x+Math.sin(theta)*42,72,cave.z+Math.cos(theta)*42];
      engine.camera.target=[cave.x+1,-8,cave.z-1.2];
      engine.camera.fov=mobile.matches?50:45;
      return;
    }
    const radius=mobile.matches?175:181;
    engine.camera.position=[Math.sin(theta)*radius+4,79.0,-58+Math.cos(theta)*radius];
    engine.camera.target=[4,23,-66];
    engine.camera.fov=mobile.matches?56:49;
  }
  setCamera();
  const sculpting=TerrainSculpt.attach(engine,terrain,{radius:36,strength:.66,undoLimit:20,signal});
  const initialDraw=Promise.resolve().then(()=>{
    engine.render(0);
    performance.mark('terrain-sculpt-submitted');
  });
  const [sculpt]=await Promise.all([sculpting,initialDraw]);
  const ground=new TerrainQuery(sculpt.heights,sculpt.columns,sculpt.rows,{...settings,holes});
  performance.mark('terrain-sculpt-brush-ready');

  function controlLabels(){
    metres.value=radius.value+' m';
    angle.value=survey.value+'°';
    undo.disabled=switching||undoCount===0;
    redo.disabled=switching||redoCount===0;
    caveButton.textContent=aperture?'Fill cave':'Cut cave';
    caveButton.setAttribute('aria-pressed',String(aperture));
    inspectCave.hidden=!aperture;
    inspectCave.textContent=shaftView?'Basin view':'Inspect shaft';
    state.view=shaftView?'shaft':'basin';
    state.brush=tool;
    state.cave=aperture?'open':'closed';
    state.surface=mode;
  }
  function inspect(){
    const dataCount=rvt?.baked??0;
    state.cacheBaked=String(dataCount);
    state.draws=String(++tally);
    const tag='2,048 m × 2,048 m · '+levels+' geometry clipmap levels';
    if(rvt){
      const scope=cacheSize+'² × '+cacheLevels+' cache';
      stats.textContent=tag+' · '+scope+' · '+dataCount.toLocaleString('en')+' texels baked';
    }else stats.textContent=tag;
  }
  function drive(){
    engine.render(0);
    inspect();
  }
  function request(){
    if(scheduled||pending||signal.aborted)return;
    scheduled=requestAnimationFrame(render);
  }
  async function render(){
    scheduled=0;
    if(pending||signal.aborted)return;
    pending=true;dirty=false;
    const accepted=input;
    input=false;
    try{
      drive();
      await engine.gpu.queue.onSubmittedWorkDone();
      if(signal.aborted)return;
      if(accepted){
        await nextFrame();
        if(signal.aborted)return;
        performance.mark('terrain-sculpt-input-rendered');
        if(first){first=false;performance.mark('terrain-sculpt-first-input');}
      }
      performance.mark('terrain-sculpt-view-rendered');
    }catch(reason){
      fail(reason);
    }finally{
      pending=false;
      if(dirty)request();
    }
  }
  function refresh(trusted=false){
    dirty=true;
    input||=trusted;
    request();
  }
  const stopChanges=sculpt.onChange(change=>{
    if(change.weights===undefined)ground.refresh(change.u,change.v,change.width,change.depth);
    state.rectangle=[change.u,change.v,change.width,change.depth].join(',');
  });

  function position(event){
    const rect=canvas.getBoundingClientRect();
    return [(event.clientX-rect.left)/rect.width,(event.clientY-rect.top)/rect.height];
  }
  function hit(x,y){
    const direction=groundRay(engine.camera,x,y,canvas.width/canvas.height);
    return ground.raycast(engine.camera.position,direction,1100)?.position;
  }
  function weightAt(x,z){
    const col=clamp(Math.floor((x-origin[0])*columns/extent),0,columns-1);
    const row=clamp(Math.floor((z-origin[1])*columns/extent),0,columns-1);
    return sculpt.weights[0].data[(row*columns+col)*4+2];
  }
  function sample(point,brush){
    const [x,,z]=point;
    return brush==='paint'?weightAt(x,z):ground.height(x,z);
  }
  function grow(x,z){
    const width=Number(radius.value);
    sculpt.dab(x,z);
    rvt?.invalidate(x-width-6,z-width-6,x+width+6,z+width+6);

  }
  function continueTo(point,trusted){
    if(!point){previousPoint=undefined;return;}
    const [x,,z]=point;
    const span=Number(radius.value)*.37;
    if(previousPoint){
      const [px,,pz]=previousPoint,distance=Math.hypot(x-px,z-pz);
      if(distance<span)return;
      const pieces=Math.min(6,Math.max(1,Math.ceil(distance/span)));
      for(let i=1;i<=pieces;i++)grow(px+(x-px)*i/pieces,pz+(z-pz)*i/pieces);
    }else grow(x,z);
    previousPoint=point;
    refresh(trusted);
  }
  function startAt(point,trusted){
    const width=Number(radius.value),options={
      brush:tool,layer:2,radius:width,strength:tool==='paint'?.94:.73,amount:width*.76,
    };
    previousPoint=undefined;
    lastHit={point,tool,before:sample(point,tool)};
    stroke=sculpt.stroke(options);
    guide.textContent=tool==='paint'?'Iron ochre is replacing the local surface weights.':
      names[tool]+' with the live height brush.';
    continueTo(point,trusted);
  }
  function stopStroke(){
    if(!stroke)return;
    const inspectHit=lastHit;
    stroke.end();
    stroke=null;pointer=null;previousPoint=undefined;
    undoCount=Math.min(undoCount+1,20);redoCount=0;
    controlLabels();
    boardOps=boardOps.then(async()=>{
      await sculpt.flush();
      if(signal.aborted)return;
      const after=sample(inspectHit.point,inspectHit.tool),before=inspectHit.before;
      state.editKind=inspectHit.tool;
      state.world=inspectHit.point.map(value=>value.toFixed(2)).join(',');
      if(Number.isFinite(before)&&Number.isFinite(after)){
        state.before=before.toFixed(4);state.after=after.toFixed(4);
      }
      state.confirmed=String(++confirmed);
      performance.mark('terrain-sculpt-edit-confirmed');
    });
    boardOps.catch(fail);
  }
  function transact(task){
    stopStroke();
    switching=true;
    controlLabels();
    boardOps=boardOps.then(task).catch(fail).finally(()=>{
      switching=false;
      if(!signal.aborted)controlLabels();
    });
  }

  canvas.addEventListener('pointerdown',event=>{
    if(!state.ready||switching||pointer!==null||event.button!==0)return;
    event.preventDefault();
    cursor.hidden=true;
    const point=hit(...position(event));
    if(!point){guide.textContent='Aim at terrain rather than the sky or the exposed opening.';return;}
    pointer=event.pointerId;
    canvas.setPointerCapture(pointer);
    try{startAt(point,event.isTrusted);}catch(reason){fail(reason);}
  },{signal});
  canvas.addEventListener('pointermove',event=>{
    if(event.pointerId!==pointer||!stroke)return;
    try{
      const coalesced=event.getCoalescedEvents?.();
      const samples=coalesced?.length?coalesced:[event];
      for(const point of samples)continueTo(hit(...position(point)),event.isTrusted);
    }catch(reason){fail(reason);}
  },{signal});
  for(const type of ['pointerup','pointercancel','lostpointercapture']){
    canvas.addEventListener(type,event=>{if(event.pointerId===pointer)stopStroke();},{signal});
  }
  canvas.addEventListener('keydown',event=>{
    if(!state.ready||switching||stroke)return;
    const arrows={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};
    if(!arrows[event.key]&&event.key!==' ')return;
    event.preventDefault();
    if(arrows[event.key]){
      const [u,v]=arrows[event.key],stride=event.shiftKey?.045:.016;
      aim=[clamp(aim[0]+u*stride,.04,.96),clamp(aim[1]+v*stride,.04,.96)];
    }else{
      const point=hit(...aim);
      if(point){try{startAt(point,event.isTrusted);stopStroke();}catch(reason){fail(reason);}}
    }
    cursor.hidden=false;cursor.style.left=aim[0]*100+'%';cursor.style.top=aim[1]*100+'%';
  },{signal});
  canvas.addEventListener('blur',()=>{cursor.hidden=true;},{signal});
  for(const button of brushes)button.addEventListener('change',()=>{
    if(!button.checked)return;
    stopStroke();
    tool=button.value;
    guide.textContent=names[tool]+'. Drag on the terrain to apply.';
    controlLabels();
  },{signal});
  radius.addEventListener('input',controlLabels,{signal});
  survey.addEventListener('input',event=>{
    stopStroke();
    setCamera();
    controlLabels();
    refresh(event.isTrusted);
  },{signal});
  caveButton.addEventListener('click',event=>{
    if(switching)return;
    stopStroke();
    aperture=!aperture;
    if(!aperture&&shaftView){shaftView=false;setCamera();}
    holes.polygon(outline,aperture).upload(terrain);
    rvt?.invalidate(cave.x-43,cave.z-43,cave.x+43,cave.z+43);
    state.caveHeight=String(ground.height(cave.x,cave.z)??'hole');
    state.caveCells=String(holes.mask.reduce((n,value)=>n+(value===0),0));
    guide.textContent=aperture?'The cut exposes the rock shaft and its survey lights.':'The original surface covers the shaft again.';
    controlLabels();
    refresh(event.isTrusted);
  },{signal});
  inspectCave.addEventListener('click',event=>{
    if(!aperture||switching)return;
    stopStroke();
    shaftView=!shaftView;
    guide.textContent=shaftView?'Look down the lined shaft to the lower ledge and cold pool.':
      'The cut exposes the rock shaft and its survey lights.';
    setCamera();
    controlLabels();
    refresh(event.isTrusted);
  },{signal});

  for(const [button,step] of [[undo,'undo'],[redo,'redo']]){
    button.addEventListener('click',event=>transact(async()=>{
      await sculpt.flush();
      if(signal.aborted)return;
      const changed=await sculpt[step]();
      if(!changed)return;
      undoCount+=step==='undo'?-1:1;
      redoCount+=step==='undo'?1:-1;
      if(rvt)rvt.invalidate();
      state.history=step;
      refresh(event.isTrusted);
    }),{signal});
  }

  async function changeSurface(next){
    if(next===mode)return;
    let Materials,VirtualTexture;
    if(next==='pbr')({TerrainMaterials:Materials}=await import('@margoengine/terrain/layers-pbr'));
    if(next==='cache')({TerrainVirtualTexture:VirtualTexture}=await import('@margoengine/terrain/rvt'));
    signal.throwIfAborted();
    pbr?.dispose();pbr=undefined;
    rvt?.dispose();rvt=undefined;
    if(Materials)pbr=Materials.attach(engine,terrain,{textures:maps.pbr,heightBlend:.56,
      layers:[{normal:1.18,roughness:.97},{normal:.84},{normal:1.27},{normal:.83}]});
    if(VirtualTexture)rvt=VirtualTexture.attach(engine,terrain,{size:cacheSize,levels:cacheLevels,texel:.78,steep:.55});
    state.pbrLayers=String(pbr?.surface?.depthOrArrayLayers??0);
    mode=next;
    state.surface=mode;
    guide.textContent=mode==='cache'?'Survey around the basin to shift the virtual-texture windows.':
      mode==='pbr'?'Normal, roughness, ambient occlusion and height maps light the same edited ground.':
      'The four terrain layers are sampled directly.';
  }
  material.addEventListener('change',event=>{
    material.disabled=true;
    transact(async()=>{
      try{
        await changeSurface(material.value);
        refresh(event.isTrusted);
      }finally{
        if(!signal.aborted)material.disabled=false;
      }
    });
  },{signal});

  const resize=new ResizeObserver(()=>{
    if(!size())return;
    stopStroke();setCamera();refresh();
  });
  resize.observe(canvas);
  signal.addEventListener('abort',()=>{resize.disconnect();stopChanges();cancelAnimationFrame(scheduled);},{once:true});
  await engine.gpu.queue.onSubmittedWorkDone();
  signal.throwIfAborted();
  inspect();
  state.caveHeight=String(ground.height(cave.x,cave.z));
  await nextFrame();
  if(status.ready()){
    notice.hidden=true;
    for(const control of [caveButton,radius,survey,material,...brushes])control.disabled=false;
    guide.textContent='Drag on the terrain. On a keyboard, use the arrows to aim and Space to brush.';
    controlLabels();
    performance.mark('terrain-sculpt-ready');
  }
}
