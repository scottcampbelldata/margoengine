import { autoEngine } from '@margoengine/webgl2-compat/auto';
import { applyQualityTier } from '@margoengine/quality';
import { PointsPlugin } from '@margoengine/points';
import { DepthVideoCloud } from '@margoengine/points/depth-video';
import { demoStatus } from 'margo-demo-status';
import clip from './assets/frames.json';

const {width,height,grid,frames,chunks,frameCount,rate}=clip;
const assets=import.meta.glob('./assets/clip-*.*',{eager:true,query:'?url',import:'default'});
const byFrame=frames.map((_,index)=>chunks.findLastIndex(packet=>packet.first<=index));
const id=name=>document.getElementById(name);
const canvas=id('view'), play=id('play'), scrub=id('frame'), modes=id('modes'), reset=id('reset');
const position=id('position'), time=id('time'), buffer=id('buffer'), pointsLabel=id('points');
const loading=id('status'), viewStatus=demoStatus(document.body,loading,id('error'));
const {dataset}=document.body;
const lifetime=new AbortController(),{signal}=lifetime;
const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
const depths=new Map(), colours=new Map();
const depth={width,height,data:new Uint8Array(width*height*4)};
const colour={width,height,data:new Uint8Array(width*height*4)};
const shown=new Intl.NumberFormat();
const stops=[[0,255,222,159],[.24,250,171,128],[.45,225,129,137],[.69,153,139,205],[1,92,167,209]];
const palette=new Uint8Array(5701*3);
for(let mm=0;mm<=5700;mm++){
  const range=Math.max(0,Math.min(1,(mm-500)/1200));
  const j=stops.findIndex(stop=>stop[0]>=range);
  const a=stops[Math.max(0,j-1)],b=stops[j];
  const t=a===b?0:(range-a[0])/(b[0]-a[0]);
  for(let c=0;c<3;c++)palette[mm*3+c]=a[c+1]+(b[c+1]-a[c+1])*t;
}

let engine, cloud, plugin, resize, raf, drag;
let frameIndex=0, requested=0, playing=false, mode='range', requestedMode='range';
let due=0, viewDirty=true, firstPlayback=false;
let yaw=.17, pitch=.09, drawnIndex=-1, drawnMode, generation=0;

function fetchPacket(index, rgb=false) {
  const table=rgb?colours:depths;
  let entry=table.get(index);
  if(entry)return entry.pending;
  const packet=chunks[index], file=rgb?packet.colorKey:packet.key;
  entry={};
  table.set(index,entry);
  entry.pending=(async()=>{
    const response=await fetch(assets['./assets/'+file],{signal});
    if(!response.ok)throw new Error('The recorded frame packet could not be loaded.');
    if(rgb){
      const bitmap=await createImageBitmap(await response.blob());
      try{
        if(bitmap.width!==width||bitmap.height!==height*packet.count)throw new Error('The recorded colour packet is incomplete.');
        const surface=document.createElement('canvas');
        surface.width=bitmap.width;
        surface.height=bitmap.height;
        const context=surface.getContext('2d');
        context.drawImage(bitmap,0,0);
        entry.data=context.getImageData(0,0,bitmap.width,bitmap.height).data;
        return entry.data;
      }finally{bitmap.close();}
    }
    const stream=response.body.pipeThrough(new DecompressionStream('gzip'));
    const bytes=await new Response(stream).arrayBuffer();
    if(bytes.byteLength!==packet.count*grid)throw new Error('The recorded frame packet is incomplete.');
    entry.data=new DataView(bytes);
    return entry.data;
  })();
  entry.pending.catch(fail);
  return entry.pending;
}

const opening=fetchPacket(0);
opening.then(()=>fetchPacket(1)).catch(fail);
function warmBuffer(index,rgb){
  for(let next=index;next<Math.min(chunks.length,index+3);next++){
    fetchPacket(next);
    if(rgb)fetchPacket(next,true);
  }
}
function tell(message){
  if(buffer.textContent!==message)buffer.textContent=message;
}
function setPlaying(state){
  playing=state;
  play.setAttribute('aria-pressed',String(state));
  play.textContent=state?'Pause':frameIndex===frameCount-1?'Replay clip':'Play clip';
}
function updatePosition(index, nextMode){
  const group=byFrame[index];
  const z=depths.get(group)?.data;
  const image=nextMode==='rgb'?colours.get(group)?.data:null;
  if(!z||(nextMode==='rgb'&&!image))return false;
  const offset=(index-chunks[group].first)*grid;
  const d=depth.data, c=colour.data;
  if(image)c.set(image.subarray(offset*2,offset*2+grid*2));
  for(let i=0;i<grid/2;i++){
    const k=i*4;
    const mm=z.getUint16(offset+i*2,true);
    d[k]=mm>>>8; d[k+1]=mm&255;
    if(!image){
      const colourAt=Math.min(mm,5700)*3;
      c[k]=palette[colourAt]; c[k+1]=palette[colourAt+1]; c[k+2]=palette[colourAt+2];
    }
    c[k+3]=d[k+3]=255;
  }
  const count=cloud.update(colour,depth);
  if(count!==clip.counts[index])throw new Error('The recorded depth frame did not reconstruct correctly.');
  frameIndex=index;
  mode=nextMode;
  drawnIndex=index;
  drawnMode=nextMode;
  dataset.frame=String(index);
  dataset.points=String(count);
  dataset.mode=mode;
  pointsLabel.value=shown.format(count)+' points';
  scrub.value=String(index);
  position.value=(index+1)+' / '+frameCount;
  time.value=(frames[index].time-frames[0].time).toFixed(2)+' s';
  if(!playing)setPlaying(false);
  for(const button of modes.querySelectorAll('button'))button.setAttribute('aria-pressed',String(mode===button.dataset.mode));
  document.querySelector('.scale').hidden=mode==='rgb';
  viewDirty=true;
  return true;
}

function camera(){
  const dpr=Math.min(1.7,devicePixelRatio||1);
  const w=Math.max(1,Math.round(canvas.clientWidth*dpr)), h=Math.max(1,Math.round(canvas.clientHeight*dpr));
  if(canvas.width!==w)canvas.width=w;
  if(canvas.height!==h)canvas.height=h;
  const focus=-1.75, radius=(w/h<1.55?2.46:2.26), horizontal=radius*Math.cos(pitch);
  engine.camera.position=[Math.sin(yaw)*horizontal,Math.sin(pitch)*radius,focus+Math.cos(yaw)*horizontal];
  engine.camera.target=[0,-.10,focus];
  dataset.orbit=yaw.toFixed(3)+','+pitch.toFixed(3);
}

function paint(){
  if(!viewDirty)return false;
  camera();
  engine.render();
  viewDirty=false;
  return true;
}
function schedule(){
  if(!raf&&!signal.aborted)raf=requestAnimationFrame(tick);
}
function tick(now){
  raf=undefined;
  try{
    const demand=playing&&now>=due;
    if(demand&&requested===frameIndex)requested=Math.min(frameIndex+1,frameCount-1);
    const change=requested!==drawnIndex||requestedMode!==drawnMode;
    if(change){
      const group=byFrame[requested];
      warmBuffer(group,requestedMode==='rgb');
      if(updatePosition(requested,requestedMode)){
        tell('');
        if(demand){
          const interval=1000/rate;
          due=Math.max(due+interval,now+interval*.73);
        }
      }else{
        tell('Buffering recorded frame '+(requested+1)+'…');
      }
    }
    const rendered=paint();
    if(rendered&&playing&&firstPlayback&&frameIndex!==0){
      firstPlayback=false;
      const submittedFrame=frameIndex;
      engine.gpu.queue.onSubmittedWorkDone().then(()=>{
        if(!signal.aborted){
          dataset.playbackFrame=String(submittedFrame);
          performance.mark('depth-first-frame-applied');
        }
      }).catch(fail);
    }
    if(playing&&frameIndex===frameCount-1&&requested===drawnIndex){
      setPlaying(false);
      dataset.completed='true';
    }
    if(playing||requested!==drawnIndex||requestedMode!==drawnMode)schedule();
  }catch(error){fail(error);}
}

function seek(index){
  requested=index;
  schedule();
}
function connect(){
  play.addEventListener('click',()=>{
    if(playing){
      setPlaying(false);
      requested=frameIndex;
      tell('');
      return;
    }
    if(frameIndex===frameCount-1){
      requested=0;
      delete dataset.completed;
    }
    if(!dataset.playbackFrame)firstPlayback=true;
    warmBuffer(byFrame[requested],requestedMode==='rgb');
    setPlaying(true);
    due=performance.now();
    schedule();
  },{signal});
  scrub.addEventListener('input',()=>{
    setPlaying(false);
    delete dataset.completed;
    seek(Number(scrub.value));
  },{signal});
  modes.addEventListener('click',event=>{
    const value=event.target.closest('button')?.dataset.mode;
    if(!value||value===requestedMode)return;
    const revision=++generation;
    requestedMode=value;
    if(value==='range'){
      schedule();
      return;
    }
    const group=byFrame[requested];
    setPlaying(false);
    tell('Loading the camera colour…');
    warmBuffer(group,true);
    fetchPacket(group,true).then(()=>{
      if(generation===revision&&!signal.aborted)schedule();
    }).catch(fail);
  },{signal});
  reset.addEventListener('click',()=>{
    yaw=.17;
    pitch=.09;
    viewDirty=true;
    schedule();
  },{signal});
  canvas.addEventListener('pointerdown',event=>{
    if(drag)return;
    drag={id:event.pointerId,x:event.clientX,y:event.clientY,yaw,pitch};
    canvas.setPointerCapture(event.pointerId);
  },{signal});
  canvas.addEventListener('pointermove',event=>{
    if(drag?.id!==event.pointerId)return;
    yaw=Math.max(-1.13,Math.min(1.13,drag.yaw-(event.clientX-drag.x)*.006));
    pitch=Math.max(-.50,Math.min(.60,drag.pitch+(event.clientY-drag.y)*.006));
    viewDirty=true;
    schedule();
  },{signal});
  canvas.addEventListener('lostpointercapture',()=>{drag=undefined;},{signal});
  resize=new ResizeObserver(()=>{viewDirty=true;schedule();});
  resize.observe(canvas);
}

async function setup(target){
  if(!target.gpu)throw new Error('This exhibit needs WebGPU or WebGL2.');
  engine=target;
  engine.onError=fail;
  engine.scene.background='#18263e';
  await opening;
  signal.throwIfAborted();
  plugin=PointsPlugin.attach(engine,{pointBudget:width*height});
  cloud=new DepthVideoCloud({
    width,height,layout:'separate',encoding:'millimeters',near:.43,far:5.7,maxJump:.09,
    intrinsics:{fx:525*width/640,fy:525*height/480,cx:width*.5,cy:height*.5},
    cloud:{material:{size:.026,minPixelSize:1.65,maxPixelSize:14,shape:'round'}},
  });
  plugin.add(cloud.cloud);
  updatePosition(0,'range');
}
async function compatibility(){
  const {install}=await import('@margoengine/webgl2-compat');
  return {install:()=>install({force:true,signal})};
}
async function start(){
  applyQualityTier();
  const options={signal,exactSize:true,antialias:false,camera:{near:.03,far:20,fov:48},startupTimeout:4700};
  if(forced||!navigator.gpu){
    await (await compatibility()).install();
    await autoEngine(canvas,setup,{...options,backend:'webgpu'});
  }else await autoEngine(canvas,setup,{...options,loadCompat:compatibility});
  for(let attempt=0;attempt<5&&!plugin.stats.pointsDrawn;attempt++){
    viewDirty=true;
    paint();
    await engine.gpu.queue.onSubmittedWorkDone();
    if(!plugin.stats.pointsDrawn)await new Promise(requestAnimationFrame);
  }
  signal.throwIfAborted();
  if(!plugin.stats.pointsDrawn)throw new Error('The graphics device did not draw the depth points.');
  dataset.renderer=engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu';
  scrub.max=String(frameCount-1);
  play.disabled=reset.disabled=scrub.disabled=modes.disabled=false;
  loading.hidden=true;
  viewStatus.ready();
  performance.mark('margo-first-usable-frame');
  connect();
  warmBuffer(0,false);
}
function dispose(){
  lifetime.abort();
  cancelAnimationFrame(raf);
  resize?.disconnect();
  cloud?.[Symbol.dispose]();
  engine?.dispose();
}
function fail(error){
  if(signal.aborted)return;
  viewStatus.error(error);
  loading.hidden=true;
  id('error').hidden=false;
  console.error(error);
  dispose();
}
addEventListener('pagehide',event=>{if(!event.persisted)dispose();});
start().catch(fail);
