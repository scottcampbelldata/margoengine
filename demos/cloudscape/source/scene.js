import {profile,stations,fly} from './coast-field.mjs';

const id=name=>document.getElementById(name);
const canvas=id('view'),scale=id('altitude'),coverage=id('cover');
const presetButtons=[...document.querySelectorAll('[data-altitude]')];
const signalOwner=new AbortController(),{signal}=signalOwner;
const force=new URLSearchParams(location.search).get('backend')==='webgl2';
const current=document.body.dataset;
const sunlight=[.46,.22,-.86];
const clamp=(v,l,u)=>Math.min(u,Math.max(l,v));
const units=new Intl.NumberFormat('en-US');
let view,resize,drag,request,rendering=false;
let height=stations[0],heading=0,tilt=0,revision=0,painted=-1;
let active,animationFrame,lastFlightRender,cloudTime=0;

function label(){
  const region=height<profile.base?'Below cloud base':height>profile.top?'Above cloud tops':'Inside the cloud deck';
  id('metres').value=units.format(Math.round(height))+' m';
  id('region').textContent=region;
  for(const button of presetButtons)button.setAttribute('aria-pressed',String(Number(button.dataset.altitude)===height));
  id('altitude').setAttribute('aria-valuetext',units.format(Math.round(height))+' meters, '+region.toLowerCase());
  id('amount').value=coverage.value+'%';
  current.altitude=String(Math.round(height));
  current.region=region;
  current.coverage=coverage.value;
  current.shafts=String(id('shafts').checked);
  current.shadows=String(id('shadows').checked);
}
function paint(delta=0){
  const w=canvas.clientWidth,h=canvas.clientHeight,dpr=Math.min(1.36,Math.max(1,devicePixelRatio||1));
  const width=Math.max(1,Math.round(w*dpr)),tall=Math.max(1,Math.round(h*dpr));
  if(canvas.width!==width)canvas.width=width;
  if(canvas.height!==tall)canvas.height=tall;
  const {eye,look}=fly(height,heading,tilt);
  current.eye=eye.map(n=>n.toFixed(1)).join(',');
  current.yaw=heading.toFixed(1);
  current.pitch=tilt.toFixed(1);
  label();
  cloudTime+=delta;
  view.draw({eye,look,sun:sunlight,cover:coverage.valueAsNumber/100,
    shadows:id('shadows').checked,shafts:id('shafts').checked,time:cloudTime,delta});
}
function update(){
  if(request||rendering||signal.aborted)return;
  request=requestAnimationFrame(async()=>{
    request=undefined;rendering=true;
    try{
      const next=revision;
      const now=performance.now();
      const delta=active&&lastFlightRender?Math.min(.15,(now-lastFlightRender)/1000):0;
      lastFlightRender=active?now:undefined;
      paint(delta);
      await view.finish();
      if(signal.aborted)return;
      painted=next;current.revision=String(painted);
      if(!performance.getEntriesByName('cloudscape-first-flight').length&&height!==stations[0])
        performance.mark('cloudscape-first-flight');
    }catch(error){fail(error);}
    finally{rendering=false;}
    if(painted!==revision)update();
  });
}
function change(){revision++;update();}
function altitude(next){
  height=clamp(Math.round(next),profile.min,profile.max);
  scale.value=String(height);
  change();
}
function setAnimation(running){
  id('autopilot').textContent=running?'Pause flight':'Fly route';
  id('autopilot').setAttribute('aria-pressed',String(running));
  current.autopilot=String(running);
}
function stopFlight(){
  if(!active)return;
  active=null;cancelAnimationFrame(animationFrame);
  setAnimation(false);
}
function startFlight(){
  if(active){stopFlight();return;}
  const start=height>=stations[2]?stations[0]:height;
  const route={begin:performance.now(),start,finish:stations[2]};
  active=route;setAnimation(true);
  const flyFrame=(now)=>{
    if(active!==route)return;
    const p=clamp((now-route.begin)/15500,0,1),soft=p*p*(3-2*p);
    altitude(route.start+(route.finish-route.start)*soft);
    if(p>=1){stopFlight();return;}
    animationFrame=requestAnimationFrame(flyFrame);
  };
  animationFrame=requestAnimationFrame(flyFrame);
}
function look(yaw,pitch){
  heading=clamp(yaw,-80,80);tilt=clamp(pitch,-38,38);change();
}
function connect(){
  for(const button of presetButtons)button.addEventListener('click',()=>{stopFlight();altitude(+button.dataset.altitude);},{signal});
  scale.addEventListener('input',()=>{stopFlight();altitude(scale.valueAsNumber);},{signal});
  for(const name of ['cover','shadows','shafts'])id(name).addEventListener('input',change,{signal});
  id('center').addEventListener('click',()=>look(0,0),{signal});
  id('autopilot').addEventListener('click',startFlight,{signal});
  canvas.addEventListener('pointerdown',event=>{
    if(drag)return;
    drag={pointer:event.pointerId,x:event.clientX,y:event.clientY,heading,tilt};
    canvas.setPointerCapture(event.pointerId);
  },{signal});
  canvas.addEventListener('pointermove',event=>{
    if(drag?.pointer!==event.pointerId)return;
    look(drag.heading+(drag.x-event.clientX)*.18,drag.tilt+(event.clientY-drag.y)*.18);
  },{signal});
  for(const kind of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(kind,event=>{
    if(drag?.pointer===event.pointerId)drag=undefined;
  },{signal});
  canvas.addEventListener('keydown',event=>{
    const step={ArrowLeft:[-6,0],ArrowRight:[6,0],ArrowUp:[0,6],ArrowDown:[0,-6]}[event.key];
    if(!step)return;
    event.preventDefault();look(heading+step[0],tilt+step[1]);
  },{signal});
  resize=new ResizeObserver(change);resize.observe(canvas);
}
async function start(){
  const params={sun:sunlight,signal,fail};
  if(!force&&navigator.gpu){
    const {openNative}=await import('./native.js');
    try{view=await openNative(canvas,params);}
    catch(error){if(!['unsupported','no-adapter'].includes(error?.code))throw error;}
  }
  if(!view){
    // The same packages on the WebGL2 layer: clouds, sky, light shafts and cloud shadows.
    await (await import('@margoengine/webgl2-compat')).install({force:true,signal});
    const {openNative}=await import('./native.js');
    view=await openNative(canvas,{...params,compatibility:true});
  }
  signal.throwIfAborted();
  performance.mark('cloudscape-model');
  paint();
  performance.mark('cloudscape-submitted');
  await view.finish();
  signal.throwIfAborted();
  current.renderer=view.renderer;
  current.ready='true';
  id('tools').disabled=id('effects').disabled=false;
  id('status').hidden=true;
  connect();
  performance.mark('margo-first-usable-frame');
  if(view.prepareLighting)lightingFrame=setTimeout(waitLighting,1450);
  else readyEffects();
}
let lightingTask,lightingFrame;
function readyEffects(){
  for(const name of ['shafts','shadows'])id(name).disabled=false;
  id('effects-status').hidden=true;current.lighting='true';
  performance.mark('cloudscape-lighting');
}
function waitLighting(){
  if(lightingTask||signal.aborted)return;
  lightingTask=view.prepareLighting().then(async()=>{
    signal.throwIfAborted();
    paint();
    await view.finish();
    if(!signal.aborted)readyEffects();
  }).catch(fail);
}

function fail(error){
  if(signal.aborted)return;
  id('status').hidden=true;id('error').hidden=false;id('error').textContent=error.message;
  delete current.ready;current.error=error.message;console.error(error);stopFlight();signalOwner.abort();
}
addEventListener('pagehide',event=>{
  if(event.persisted)return;
  stopFlight();signalOwner.abort();clearTimeout(lightingFrame);cancelAnimationFrame(request);resize?.disconnect();view?.dispose();
});
start().catch(fail);
