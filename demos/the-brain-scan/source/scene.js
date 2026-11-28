import { metadata, fullMRI, boneCT, readMRI, readScan } from './scan-data.js';
import { openingSlices } from './opening.js';
import { demoStatus } from 'margo-demo-status';
import { buildRig } from './rig.js';

let canvas=document.querySelector('#viewer');
const warning=document.querySelector('#error');
const message=document.querySelector('#message');
const help=document.querySelector('#help');
const loadLabel=document.querySelector('#status');
const busy=document.querySelector('#busy');
const gesture=document.querySelector('#gesture');
const mri=document.querySelector('#mri');
const bone=document.querySelector('#bone');
const outline=document.querySelector('#modality');
const mriPanel=document.querySelector('#mri-controls');
const ctPanel=document.querySelector('#ct-controls');
const threshold=document.querySelector('#threshold');
const thresholdLabel=document.querySelector('#threshold-value');
const count=document.querySelector('#count');
const cut=document.querySelector('#cut');
const reset=document.querySelector('#reset');
const basis=document.querySelector('#basis');
const ordering={sagittal:['x',0],coronal:['y',1],axial:['z',2]};
const defaults={sagittal:.50,coronal:.54,axial:.64};
const slices=Object.fromEntries(Object.keys(ordering).map(key=>[key,{
  input:document.querySelector('#'+key), value:document.querySelector('#'+key+'-value'),
  focus:document.querySelector('[data-inspect="'+key+'"]'),
}]));
const all=[mri,bone,threshold,cut,reset,...Object.values(slices).flatMap(({input,focus})=>[input,focus])];
const bounds=metadata.extentMM.flatMap(n=>[-n/2,n/2]);
const half=metadata.extentMM.map(n=>n*.0005);
const position={...defaults};
const number=new Intl.NumberFormat('en-US');
const angles={yaw:1.23,pitch:.335};
const stageAngles={...angles};
let status,lifetime,resize,stop,detailTimer;
let engine, figure, volume, preview, iso, anchors, resizeObserver, frame, rendering=false;
let mode='mri', request='mri', inspect='', clipping=true, extraction, thresholdBusy=false;
let currentLevel=460, pendingLevel=460, captureTouch=false, touchMarkPending=false;
let compatibility=false, driver='', failedBone=false;

function placeCamera(target) {
  const ratio=canvas.width/canvas.height;
  const distance=Math.max(1,1.06/ratio);
  const range=(inspect ? .344 : .381)*distance;
  const fov=inspect ? 41 : 42;
  const targetY=inspect ? 0 : -.014;
  target.camera.fov=fov;
  if(inspect==='axial'){
    target.camera.position=[0,range,0];
    target.camera.target=[0,0,0];
    target.camera.up=[0,0,1];
  }else if(inspect){
    target.camera.position=inspect==='sagittal'?[range,0,0]:[0,0,-range];
    target.camera.target=[0,0,0];
    target.camera.up=[0,1,0];
  }else{
    const horizontal=range*Math.cos(angles.pitch);
    target.camera.position=[horizontal*Math.sin(angles.yaw),Math.sin(angles.pitch)*range+targetY,-horizontal*Math.cos(angles.yaw)];
    target.camera.target=[0,targetY,0];
    target.camera.up=[0,1,0];
  }
}

function numberText(mm) {
  const sign=mm<-.049?'−':mm>.049?'+':'';
  return sign+Math.abs(mm).toFixed(1)+' mm';
}

function labels() {
  for(const [key,[axis,index]] of Object.entries(ordering)){
    const control=slices[key];
    const mm=(position[key]-.5)*metadata.extentMM[index];
    control.value.value=numberText(mm);
    control.input.setAttribute('aria-valuetext',mm.toFixed(1)+' millimeters from scan center');
    control.focus.setAttribute('aria-pressed',String(inspect===key));
    control.focus.textContent=inspect===key?'Show all':'View '+key;
  }
  mri.setAttribute('aria-pressed',String(mode==='mri'));
  bone.setAttribute('aria-pressed',String(mode==='ct'));
  bone.disabled=!figure||failedBone||Boolean(extraction);
  mriPanel.hidden=mode!=='mri';
  ctPanel.hidden=mode!=='ct';
  cut.hidden=mode!=='mri';
  cut.setAttribute('aria-pressed',String(clipping));
  cut.disabled=!volume||Boolean(inspect);
  gesture.hidden=Boolean(inspect);
  basis.textContent=mode==='mri'?'Coordinates from scan center':driver+' marching cubes';
  thresholdLabel.value=pendingLevel+' HU';
  threshold.setAttribute('aria-valuetext',pendingLevel+' Hounsfield units');
  count.value=iso?number.format(iso.triangles):'—';
  outline.replaceChildren(document.createTextNode(mode==='mri'?'MRI · T1-weighted':'CT · Bone reconstruction'));
  Object.assign(canvas.dataset,{
    detail:volume?'full':'opening', mode, inspect:inspect||'all', cut:String(clipping),
    axial:position.axial.toFixed(8), coronal:position.coronal.toFixed(8), sagittal:position.sagittal.toFixed(8),
    threshold:currentLevel, triangles:iso?.triangles??0,
  });
}

function sceneState(target) {
  preview?.update(position,inspect,mode==='mri'&&!volume);
  if(volume){
    volume.visible=mode==='mri'&&!inspect;
    volume.clip=clipping ? [{normal:[-1,0,0],offset:position.sagittal}] : [];
    for(const [key,control] of Object.entries(slices)){
      control.layer.visible=mode==='mri'&&(!inspect||inspect===key);
      control.layer.position=position[key];
    }
  }
  if(iso)iso.visible=mode==='ct';
  anchors.update(position,mode,inspect);
  placeCamera(target);
}

function draw() {
  frame=undefined;
  if(lifetime.signal.aborted)return;
  try{
    sceneState(engine);
    rendering=true;
    engine.render({delta:0});
    rendering=false;
    labels();
    if(captureTouch&&!touchMarkPending&&!performance.getEntriesByName('brain-slice-applied').length){
      touchMarkPending=true;
      engine.gpu.queue.onSubmittedWorkDone().then(()=>{
        if(!lifetime.signal.aborted)performance.mark('brain-slice-applied');
      }).catch(fail);
    }
  }catch(reason){rendering=false;fail(reason);}
}
function schedule(){if(frame===undefined)frame=requestAnimationFrame(draw);}

async function openBone() {
  request='ct';
  inspect='';
  if(iso){mode='ct';schedule();return;}
  if(extraction || failedBone)return;
  busy.textContent='Extracting a surface from CT…';
  busy.hidden=false;
  bone.disabled=true;
  extraction=(async()=>{
    const dims=metadata.ct.dims;
    const bytes=await readScan(boneCT,dims,2,lifetime.signal);
    const field=Float32Array.from(new Int16Array(bytes),v=>v*metadata.ct.huPerUnit);
    if(compatibility){
      const {marchingCubes}=await import('@margoengine/sciviz/fallback');
      figure.renderer.cpuIsosurface=marchingCubes;
    }
    driver=compatibility?'CPU':'GPU';
    iso=await figure.isosurface(field,currentLevel,{dims,bounds,color:'#efd3ab',signal:lifetime.signal});
    if(request==='ct')mode='ct';
    threshold.disabled=false;
  })();
  try{await extraction;}
  catch(reason){
    if(lifetime.signal.aborted)return;
    failedBone=true;
    request='mri';
    if(reason?.code!=='unsupported')console.error(reason);
    busy.textContent=reason?.message??'The CT surface could not be opened.';
  }finally{
    extraction=undefined;
    if(!lifetime.signal.aborted){
      if(!failedBone)busy.hidden=true;
      schedule();
    }
  }
}

async function setSurface() {
  if(thresholdBusy)return;
  thresholdBusy=true;
  try{
    while(currentLevel!==pendingLevel && !lifetime.signal.aborted){
      const level=pendingLevel;
      busy.textContent='Updating CT surface…';
      busy.hidden=false;
      await iso.update(level,{signal:lifetime.signal});
      currentLevel=level;
      schedule();
    }
    busy.hidden=true;
  }catch(reason){
    if(!lifetime.signal.aborted)fail(reason);
  }finally{thresholdBusy=false;}
}

function gestures(options) {
  let drag;
  canvas.addEventListener('pointerdown',event=>{
    if(inspect||event.button!==0)return;
    drag={id:event.pointerId,x:event.clientX,y:event.clientY};
    canvas.setPointerCapture(event.pointerId);
  },options);
  canvas.addEventListener('pointermove',event=>{
    if(!drag||drag.id!==event.pointerId||inspect)return;
    angles.yaw+=(event.clientX-drag.x)*.009;
    angles.pitch=Math.max(-.69,Math.min(.84,angles.pitch+(event.clientY-drag.y)*.007));
    drag.x=event.clientX;drag.y=event.clientY;
    schedule();
  },options);
  for(const type of ['pointerup','pointercancel','lostpointercapture']){
    canvas.addEventListener(type,()=>{drag=undefined;},options);
  }
  canvas.addEventListener('keydown',event=>{
    if(inspect)return;
    const direction={ArrowLeft:[-.14,0],ArrowRight:[.14,0],ArrowUp:[0,-.11],ArrowDown:[0,.11]}[event.key];
    if(!direction)return;
    event.preventDefault();
    angles.yaw+=direction[0];
    angles.pitch=Math.max(-.69,Math.min(.84,angles.pitch+direction[1]));
    schedule();
  },options);
}

function dispose() {
  if(lifetime.signal.aborted)return;
  clearTimeout(detailTimer);
  if(frame!==undefined)cancelAnimationFrame(frame);
  resizeObserver?.disconnect();
  figure?.dispose();
  stop();
}
function fail(reason) {
  if(lifetime.signal.aborted)return;
  canvas=engine?.canvas??document.querySelector('#viewer');
  status=demoStatus(canvas,loadLabel,message);
  status.error(reason);
  loadLabel.hidden=true;
  warning.hidden=false;
  help.hidden=reason?.code!=='unsupported';
  for(const control of all)control.disabled=true;
  if(reason?.code!=='unsupported')console.error(reason);
  if(rendering)queueMicrotask(dispose);else dispose();
}

function loadDetail() {
  detailTimer = setTimeout(async()=>{
    try {
      const [{ createDetail }, values] = await Promise.all([
        import('./detail.js'),
        readMRI(fullMRI,metadata.mri.dims,lifetime.signal),
      ]);
      if(lifetime.signal.aborted)return;
      const detail = createDetail(engine,values,metadata.mri.dims,bounds,half,position);
      ({ figure, volume } = detail);
      for(const [key,layer] of Object.entries(detail.slices))slices[key].layer=layer;
      engine.scene.removePlugin(preview.name);
      preview = undefined;
      schedule();
    } catch (error) {
      if(!lifetime.signal.aborted) {
        busy.textContent = error.message;
        busy.hidden = false;
      }
    }
  },950);
}

export async function open(boot) {
  ({target:engine, controller:lifetime, fit:resize, status, stop} = boot);
  canvas = engine.canvas;
  engine.onError = fail;
  engine.scene.background = '#18262d';
  engine.lighting.direction.set([-.42,1.44,-.38,3.65]);
  engine.lighting.radiance.set([.91,.98,1,.49]);
  engine.lighting.ambient.set([.79,.93,1]);
  compatibility = engine.gpu.adapterInfo?.vendor === 'margo-webgl2';
  for(const [key,[,axis]] of Object.entries(ordering)){
    const control = slices[key];
    const max = metadata.mri.dims[axis]-1;
    control.input.max = max;
    control.input.value = Math.round(defaults[key]*max);
    position[key] = Number(control.input.value)/max;
  }
  preview = openingSlices(boot.values,metadata.initial.dims,half);
  engine.scene.use(preview);
  anchors = buildRig(engine,[half[0],half[2],half[1]]);
  sceneState(engine);
  performance.mark('brain-mri-mounted');
  rendering = true;
  try{
    engine.render({delta:0});
  }finally{rendering=false;}
  await engine.gpu.queue.onSubmittedWorkDone();
  if(lifetime.signal.aborted)return;
  const options={signal:lifetime.signal};
  for(const [name,control] of Object.entries(slices)){
    control.input.addEventListener('input',()=>{
      position[name]=Number(control.input.value)/Number(control.input.max);
      captureTouch=true;
      schedule();
    },options);
    control.focus.addEventListener('click',()=>{inspect=inspect===name?'':name;schedule();},options);
  }
  mri.addEventListener('click',()=>{request='mri';mode='mri';inspect='';schedule();},options);
  bone.addEventListener('click',openBone,options);
  cut.addEventListener('click',()=>{clipping=!clipping;schedule();},options);
  reset.addEventListener('click',()=>{
    Object.assign(angles,stageAngles);inspect='';
    for(const [name,control] of Object.entries(slices)){
      control.input.value=Math.round(defaults[name]*Number(control.input.max));
      position[name]=Number(control.input.value)/Number(control.input.max);
    }
    schedule();
  },options);
  threshold.addEventListener('input',()=>{pendingLevel=Number(threshold.value);labels();},options);
  threshold.addEventListener('change',setSurface,options);
  gestures(options);
  lifetime.signal.addEventListener('abort',()=>{
    clearTimeout(detailTimer);
    resizeObserver?.disconnect();
    if(frame!==undefined)cancelAnimationFrame(frame);
  },{once:true});
  resizeObserver=new ResizeObserver(()=>{if(resize())schedule();});
  resizeObserver.observe(canvas);
  for(const control of all)control.disabled=control===threshold;
  Object.assign(canvas.dataset,{detail:'opening',renderer:compatibility?'compatibility':'webgpu',pair:metadata.sample});
  labels();
  if(status.ready())loadLabel.hidden=true;
  performance.mark('margo-first-usable-frame');
  loadDetail();
}
