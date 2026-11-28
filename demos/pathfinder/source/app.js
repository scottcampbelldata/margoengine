import { demoStatus } from 'margo-demo-status';

const get=id=>document.getElementById(id);
const exhibit=get('exhibit'),canvas=get('canvas'),label=get('readout'),distance=get('distance');
const links=get('links'),mesh=get('mesh'),pause=get('pause'),reset=get('reset');
const controls=[links,mesh,pause,reset],status=demoStatus(exhibit,get('status'));
const aborter=new AbortController(),{signal}=aborter;
const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
let scene,failed=false,pointer=null;

function write(node,value){if(node.textContent!==value)node.textContent=value;}
function fail(error){
  if(failed||signal.aborted)return;
  failed=true;
  for(const control of controls)control.disabled=true;
  status.error(error);
  aborter.abort();
}
function show(result){
  const route=result.route?.points??[];
  const metres=route.reduce((sum,point,i)=>i===0?0:sum+Math.hypot(point[0]-route[i-1][0],point[2]-route[i-1][2]),0);
  Object.assign(exhibit.dataset,{
    renderer:result.compatibility?'compatibility':'webgpu',goal:result.goal.map(n=>n.toFixed(4)).join(','),
    goalScreen:result.goalScreen.map(n=>n.toFixed(5)).join(','),revision:result.revision,routeRevision:result.routeRevision,
    lead:result.lead.map(n=>n.toFixed(4)).join(','),leadState:result.leadState,
    elapsed:result.elapsed.toFixed(3),linkCount:result.linkCount,routeJumps:result.route?.offMesh.length??0,
    points:route.length,airborne:result.airborne,height:result.airborneHeight.toFixed(4),
    leadJumps:result.leadJumps,leadHeight:result.leadHeight.toFixed(4),totalJumps:result.totalJumps,corrections:result.avoidance,
    minGap:(result.minimumGap??0).toFixed(5),mesh:result.grid,paused:result.paused,
  });
  const phases={moving:'Lead cart en route',offmesh:'Lead cart jumping',arrived:'Lead cart arrived',
    idle:'Lead cart waiting',unreachable:'Goal unavailable'};
  write(label,result.paused?'Traffic paused':phases[result.leadState]);
  write(distance,route.length?metres.toFixed(1)+' m':'—');
  mesh.setAttribute('aria-pressed',String(result.grid));
  links.setAttribute('aria-pressed',String(result.links));
  write(mesh,result.grid?'Hide mesh':'Show mesh');
  write(links,result.links?'Jump links on':'Bridge only');
  write(pause,result.paused?'Resume':'Pause');
}
function position(event){
  const rect=canvas.getBoundingClientRect();
  scene?.drag((event.clientX-rect.left)/rect.width,(event.clientY-rect.top)/rect.height,event.isTrusted);
}
canvas.addEventListener('pointerdown',event=>{
  if(!scene||pointer!==null||event.button!==0)return;
  canvas.setPointerCapture(event.pointerId);
  pointer=event.pointerId;
  position(event);
},{signal});
canvas.addEventListener('pointermove',event=>{
  if(event.pointerId===pointer)position(event);
},{signal});
canvas.addEventListener('pointerup',event=>{
  if(event.pointerId===pointer){position(event);pointer=null;}
},{signal});
for(const type of ['pointercancel','lostpointercapture'])canvas.addEventListener(type,event=>{
  if(event.pointerId===pointer)pointer=null;
},{signal});
const keys={ArrowUp:[0,-.42],ArrowDown:[0,.42],ArrowLeft:[-.42,0],ArrowRight:[.42,0]};
canvas.addEventListener('keydown',event=>{
  if(!scene||!keys[event.key])return;
  event.preventDefault();
  scene.nudge(...keys[event.key],event.isTrusted);
},{signal});
links.addEventListener('click',()=>scene?.toggleLinks(),{signal});
mesh.addEventListener('click',()=>scene?.toggleGrid(),{signal});
pause.addEventListener('click',()=>scene?.pause(),{signal});
reset.addEventListener('click',()=>scene?.reset(),{signal});
window.addEventListener('pagehide',event=>{if(!event.persisted)aborter.abort();},{signal});

async function open(){
  const launch=import('./scene.js');
  const native=!forced&&navigator.gpu&&await navigator.gpu.requestAdapter().catch(()=>null);
  const compatibility=!native;
  if(compatibility)await (await import('./compatibility.js')).enableCompatibility();
  signal.throwIfAborted();
  const {connect}=await launch;
  scene=await connect(canvas,{compatibility,signal,report:show,fail,
    inputRendered:()=>performance.mark('margo-first-input-rendered')});
  if(signal.aborted)return;
  for(const control of controls)control.disabled=false;
  performance.mark('margo-first-usable-frame');
  status.ready('');
}
open().catch(fail);
