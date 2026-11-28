import {Engine} from '@margoengine/core';
import {SpriteLayer} from '@margoengine/sprites';
import {demoStatus} from 'margo-demo-status';
import {placement,maskSize,dropScale,renderTile,maxCutouts,release} from './layout.js';
import {buildAtlas,tiles,dropTile,paintCutout,paintOutline,atlasSize} from './art.js';
import {cutoutEditor,dies} from './cutouts.js';
import {kernelResponse} from './transport.js';

const by=id=>document.getElementById(id);
const canvas=by('scene'),viewport=by('viewport'),loading=by('loading'),error=by('error');
const status=demoStatus(viewport,loading,error);
const life=new AbortController(),{signal}=life;
const allControls=['drop','outline','draw','erase','undo','blank',...Object.keys(dies),'clear'];
const camera={x:0,y:0,zoom:1};
const media=matchMedia('(max-width:720px)');
const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
const waitFrame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
const brush=7.8;
const cursor=[maskSize*.5,maskSize*.5];
const renderedDrops=[];
let engine,press,layer,texture,atlas,atlasDevice;
let plate,chamber,grid,preview,previewTrace,lamp,pointerMark;
let plan=placement(media.matches),mode='draw',showOutline=true,pointer=null,queued,capture;
let started=false,alive=false,dirty=true,inspect=true,raf=0,previous=0,mouseEdited=false,firstDraw=false,firstDrop=false,painting=false,needReadout=true;
let flash=0,lastHit=0,focus=false;
const editor=cutoutEditor(()=>{inspect=true;invalidate();});

function fail(reason){
  if(signal.aborted||status.failed)return;
  alive=false;
  for(const id of allControls)by(id).disabled=true;
  loading.hidden=true;error.hidden=false;
  status.error(reason);
}
function invalidate(){
  dirty=true;
  if(alive&&!raf)raf=requestAnimationFrame(render);
}
function size(){
  const bounds=canvas.getBoundingClientRect();
  if(!bounds.width||!bounds.height)return false;
  const ratio=Math.min(devicePixelRatio||1,1.75,1550/bounds.width);
  const w=Math.round(bounds.width*ratio),h=Math.round(bounds.height*ratio);
  if(canvas.width===w&&canvas.height===h)return false;
  canvas.width=w;canvas.height=h;
  return true;
}
async function openRenderer(){
  const options={backend:'webgpu',exactSize:true,antialias:false,capacity:64,signal,startupWarning:3000,startupTimeout:8700};
  if(!forced&&navigator.gpu){
    try{
      const native=await Engine.create(canvas,options);
      viewport.dataset.renderer='webgpu';
      return native;
    }catch(error){
      signal.throwIfAborted();
      if(error?.code&&!['unsupported','adapter','device','timeout','startup'].includes(error.code))throw error;
    }
  }
  const {install}=await import('@margoengine/webgl2-compat');
  await install({force:true,minimumTier:'half-float',signal});
  const fallback=await Engine.create(canvas,options);
  viewport.dataset.renderer='webgl2';
  return fallback;
}
function allocateAtlas(device){
  atlasDevice=device;
  texture=device.createTexture({size:[atlasSize,atlasSize],format:'rgba8unorm',
    usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
  device.queue.writeTexture({texture},atlas.data,{bytesPerRow:atlasSize*4},[atlasSize,atlasSize]);
  return texture;
}
function setTile([x,y,w,h],data){
  const stride=w*4;
  for(let row=0;row<h;row++)atlas.data.set(data.subarray(row*stride,(row+1)*stride),((y+row)*atlasSize+x)*4);
  if(atlasDevice===engine.gpu)atlasDevice.queue.writeTexture({texture,origin:[x,y,0]},data,{bytesPerRow:w*4},[w,h]);
}
function fitSprite(sprite,rect,area){
  const [x,y,w,h]=area;
  sprite.x=x;sprite.y=y;sprite.scaleX=w/rect[2];sprite.scaleY=h/rect[3];
}
function layout(){
  plan=placement(media.matches);
  camera.zoom=canvas.width/plan.width;
  fitSprite(plate,tiles.plate,plan.plate);
  const [ox,oy]=plan.workplace,s=plan.scale;
  fitSprite(chamber,tiles.chamber,[ox,oy,tiles.chamber[2]*s,tiles.chamber[3]*s]);
  fitSprite(grid,tiles.grating,[...plan.drawing,plan.drawing[2]]);
  const [x,y,w]=plan.drawing,brushSize=(w-23)/maskSize;
  for(const sprite of [preview,previewTrace]){
    sprite.x=x+w/2;sprite.y=y+w/2;sprite.scaleX=brushSize;sprite.scaleY=brushSize;
  }
  lamp.x=ox+442*s;lamp.y=oy+43*s;lamp.scaleX=s*.62;lamp.scaleY=s*.62;
  if(pointerMark){
    const [x,y]=cursor;
    setCursor(x,y);
  }
  refreshDrops();
}
function setCursor(x,y){
  const [dx,dy,w]=plan.drawing,scale=(w-23)/maskSize;
  pointerMark.x=dx+w/2+(x-maskSize/2)*scale;
  pointerMark.y=dy+w/2+(y-maskSize/2)*scale;
  pointerMark.scaleX=.34;pointerMark.scaleY=.34;
}
function syncPreview(){
  capture=editor.capture();inspect=false;
  setTile(tiles.preview,paintCutout(capture,0,true));
  setTile(tiles.previewTrace,paintOutline(capture));
  needReadout=true;
}
function refreshDrops(){
  const [ox,oy]=plan.workplace,scale=plan.scale;
  for(const {item,shape,outline,shadow} of renderedDrops){
    const {x,y,rotation}=item.pose;
    const unit=scale*dropScale;
    for(const sprite of [shape,outline,shadow]){
      sprite.x=ox+x*scale;sprite.y=oy+y*scale;
      sprite.scaleX=unit;sprite.scaleY=unit;sprite.rotation=rotation;
    }
    shadow.x+=3.2*scale;shadow.y+=4.3*scale;
    outline.visible=showOutline;
  }
}
function addCutout(saved){
  const item=press.releasePaper(saved);
  if(!item)return;
  const rect=dropTile(item.index),trace=dropTile(item.index,true);
  setTile(rect,paintCutout(saved,item.index));
  setTile(trace,paintOutline(saved));
  const base={pivotX:.5,pivotY:.5};
  const z=item.index*4+5;
  const shadow=layer.add({...base,rect,z,tint:'#1a2626',alpha:.60});
  const shape=layer.add({...base,rect,z:z+1});
  const outline=layer.add({...base,rect:trace,z:z+2});
  renderedDrops.push({item,shape,outline,shadow});
  previous=performance.now();
  performance.mark('cutout-released');
  refreshDrops();invalidate();
}
function updateToggle(){
  by('outline').setAttribute('aria-pressed',String(showOutline));
  previewTrace.visible=showOutline;
  refreshDrops();
  invalidate();
}
function submitCutout(){
  if(queued){
    queued=undefined;
    by('drop').textContent='Drop cutout';
    loading.textContent='Preparing gravity…';
    invalidate();
    return;
  }
  const saved=editor.capture();
  if(!saved.shapes.length)return;
  if(!firstDrop)performance.mark('drop-input');
  if(press)addCutout(saved);
  else{
    queued=saved;
    by('drop').textContent='Cancel queued drop';
    loading.textContent='Cutout queued while gravity loads…';
    invalidate();
  }
}
function clearChamber(){
  press?.clear();
  for(const {shape,outline,shadow} of renderedDrops){
    layer.remove(shape);layer.remove(outline);layer.remove(shadow);
  }
  renderedDrops.length=0;
  lastHit=0;flash=0;invalidate();
}
function show(){
  const data=press?.data();
  const {outlines,shapes,solids,undo,hash}=capture;
  const vertices=outlines.reduce((sum,{outer,holes})=>sum+outer.length+holes.reduce((n,loop)=>n+loop.length,0),0);
  const holes=outlines.reduce((n,outline)=>n+outline.holes.length,0);
  const latest=data?.latest,body=latest?.body,pose=body?.position;
  by('vertices').value=String(vertices);by('holes').value=String(holes);
  by('pieces').value=String(shapes.length);
  by('contacts').value=String(data?.totalHits??0);
  by('drop').dataset.queued=String(!!queued);
  by('drop').disabled=(!shapes.length&&!queued)||(data?.count??0)>=maxCutouts;
  by('undo').disabled=undo===0;
  by('clear').disabled=!(data?.count);
  by('notice').textContent=(data?.count??0)>=maxCutouts?'Clear the chamber to make another drop.':
    !solids?'Draw on the ink plate to make a cutout.':
    !shapes.length?'Draw a larger solid area to trace.':
    data?.totalHits?'The lit indicator follows new collider contacts.':'';
  Object.assign(viewport.dataset,{vertices:String(vertices),holes:String(holes),pieces:String(shapes.length),
    hash,solids:String(solids),drops:String(data?.count??0),serial:String(latest?.id??0),bodyHash:latest?.hash??'',
    bodyY:pose?pose[1].toFixed(3):'',bodyX:pose?pose[0].toFixed(3):'',bodyAngle:body?body.rotation.toFixed(3):'',
    contacts:String(data?.totalHits??0),sleeping:String(data?.sleeping??0),mode,outline:String(showOutline),
    traceRevision:String(capture.rev),colliders:String(body?.colliders.length??0),mass:body?body.mass.toFixed(4):'',
    queued:String(!!queued)});
  needReadout=false;
}
async function afterPaint(){
  await engine.gpu.queue.onSubmittedWorkDone();await waitFrame();signal.throwIfAborted();
}
function render(now){
  raf=0;
  if(signal.aborted||status.failed||!ownerReady())return;
  try{
    const elapsed=previous?Math.min(.05,Math.max(0,(now-previous)/1000)):0;
    previous=now;
    if(inspect)syncPreview();
    const data=press?.data();
    const awake=data&&data.count>data.sleeping;
    if(awake){
      press.advance(elapsed);
      refreshDrops();
      const next=press.data();
      if(next.totalHits>lastHit){lastHit=next.totalHits;flash=1;}
      needReadout=true;dirty=true;
    }
    if(flash>0){
      flash=Math.max(0,flash-elapsed*2.5);lamp.alpha=.15+.80*flash;dirty=true;
    }
    if(dirty){engine.render({delta:0});dirty=false;}
    if(needReadout)show();
    const live=press?.data().latest;
    if(live&&!firstDrop&&!painting&&live.body.position[1]>live.initialY+2){
      painting=true;
      afterPaint().then(()=>{
        firstDrop=true;performance.mark('first-control-frame');
      }).catch(fail);
    }
    if(mouseEdited&&!firstDraw){
      firstDraw=true;
      afterPaint().then(()=>performance.mark('first-draw-frame')).catch(fail);
    }
    if(awake||flash>0)invalidate();
  }catch(reason){fail(reason);}
}
const ownerReady=()=>started&&engine&&layer;
function inputPoint(event){
  const bound=canvas.getBoundingClientRect();
  const x=(event.clientX-bound.left)/bound.width*plan.width;
  const y=(event.clientY-bound.top)/bound.height*plan.height;
  const [left,top,w]=plan.drawing,span=w-23;
  const u=(x-left-11.5)/span*maskSize,v=(y-top-11.5)/span*maskSize;
  return [u,v];
}
const constrain=point=>point.map(val=>Math.max(0,Math.min(maskSize-.1,val)));
function lineStamp(x,y){
  mouseEdited=true;
  editor.start(x,y,mode,brush);
  editor.end();
}
function chooseBrush(value){
  mode=value;
  by('draw').setAttribute('aria-pressed',String(value==='draw'));
  by('erase').setAttribute('aria-pressed',String(value==='erase'));
  needReadout=true;invalidate();
}
function onButton(id,action){
  const button=by(id);
  let contact,activated=-Infinity;
  button.addEventListener('pointerdown',event=>{
    if(event.pointerType==='touch'&&!button.disabled)contact=[event.pointerId,event.clientX,event.clientY];
  },{signal});
  button.addEventListener('pointercancel',()=>{contact=undefined;},{signal});
  button.addEventListener('pointerup',event=>{
    if(!contact||event.pointerId!==contact[0])return;
    const [,x,y]=contact;
    contact=undefined;
    const rect=button.getBoundingClientRect(),dx=event.clientX,dy=event.clientY;
    if(button.disabled||Math.hypot(dx-x,dy-y)>12||dx<rect.left||dx>rect.right||dy<rect.top||dy>rect.bottom)return;
    activated=performance.now();
    action();
  },{signal});
  button.addEventListener('click',event=>{
    const touch=event.pointerType==='touch'||event.sourceCapabilities?.firesTouchEvents||!event.pointerType;
    if(!button.disabled&&!(event.detail&&touch&&performance.now()-activated<650))action();
  },{signal});
}
function connect(){
  canvas.addEventListener('pointerdown',event=>{
    if(pointer!==null||event.button!==0)return;
    const p=inputPoint(event);
    if(p.some(v=>v<0||v>=maskSize))return;
    canvas.setPointerCapture(event.pointerId);pointer=event.pointerId;
    mouseEdited=true;editor.start(...p,mode,brush);
  },{signal});
  canvas.addEventListener('pointermove',event=>{
    if(pointer===event.pointerId)editor.drag(...constrain(inputPoint(event)),mode,brush);
  },{signal});
  const up=event=>{if(pointer===event.pointerId){pointer=null;editor.end();}};
  for(const kind of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(kind,up,{signal});
  canvas.addEventListener('focus',()=>{focus=canvas.matches(':focus-visible');pointerMark.visible=focus;invalidate();},{signal});
  canvas.addEventListener('blur',()=>{focus=false;pointerMark.visible=false;invalidate();},{signal});
  canvas.addEventListener('keydown',event=>{
    const step={ArrowLeft:[-3,0],ArrowRight:[3,0],ArrowUp:[0,-3],ArrowDown:[0,3]}[event.code];
    if(step){
      event.preventDefault();
      const next=constrain(cursor.map((v,i)=>v+step[i]));
      cursor.splice(0,2,...next);setCursor(...next);
      pointerMark.visible=focus;invalidate();
    }else if(event.code==='Space'){
      event.preventDefault();lineStamp(...cursor);
    }
  },{signal});
  onButton('drop',submitCutout);
  onButton('outline',()=>{showOutline=!showOutline;needReadout=true;updateToggle();});
  onButton('clear',()=>{clearChamber();needReadout=true;});
  for(const name of ['draw','erase'])onButton(name,()=>chooseBrush(name));
  for(const name of ['blank',...Object.keys(dies)])onButton(name,()=>editor.drawPreset(name));
  onButton('undo',()=>editor.undoStroke());
}

size();
const wasm=kernelResponse(signal);
const physics=import('./physics.js').then(({openPress})=>openPress(signal,wasm)).then(world=>{
  if(signal.aborted){world.dispose();signal.throwIfAborted();}
  press=world;performance.mark('rigid-kernel-ready');return world;
});
physics.catch(fail);
const artwork=Promise.resolve().then(buildAtlas);
let observer;
async function boot(){
  engine=await openRenderer();signal.throwIfAborted();
  engine.onError=fail;performance.mark('engine-ready');
  engine.scene.background='#282422';
  atlas=await artwork;
  layer=SpriteLayer.attach(engine,{atlas:allocateAtlas,filter:'nearest',camera,snap:false,capacity:64});
  plate=layer.add({rect:tiles.plate,z:0});chamber=layer.add({rect:tiles.chamber,z:0});
  grid=layer.add({rect:tiles.grating,z:1});
  preview=layer.add({rect:tiles.preview,pivotX:.5,pivotY:.5,z:2});
  previewTrace=layer.add({rect:tiles.previewTrace,pivotX:.5,pivotY:.5,z:3});
  lamp=layer.add({rect:tiles.lamp,pivotX:.5,pivotY:.5,z:100,alpha:.15});
  pointerMark=layer.add({rect:tiles.lamp,pivotX:.5,pivotY:.5,z:100,visible:false});
  layout();syncPreview();
  engine.render({delta:0});
  await afterPaint();performance.mark('ink-plate-frame');
  started=alive=true;
  connect();
  for(const id of allControls)by(id).disabled=false;
  show();
  observer=new ResizeObserver(()=>{if(size()){layout();invalidate();}});
  observer.observe(canvas);
  loading.textContent='Preparing gravity…';
  await physics;signal.throwIfAborted();
  if(queued){
    const saved=queued;
    queued=undefined;
    by('drop').textContent='Drop cutout';
    addCutout(saved);
  }
  loading.hidden=true;needReadout=true;
  if(status.ready())invalidate();
}
boot().catch(fail);
addEventListener('pagehide',event=>{
  if(event.persisted)return;
  life.abort();if(raf)cancelAnimationFrame(raf);
  observer?.disconnect();press?.dispose();engine?.dispose();
});
