import { demoStatus } from 'margo-demo-status';

const get=id=>document.getElementById(id);
const exhibit=get('exhibit'),canvas=get('canvas'),lensButton=get('slide'),wire=get('wire'),normals=get('normals');
const capture=get('capture'),frame=get('frame'),passList=get('pass-list'),detail=get('pass-detail');
const controls=[lensButton,wire,normals,capture],status=demoStatus(exhibit,get('status'));
const aborter=new AbortController(),{signal}=aborter;
const forced=new URLSearchParams(location.search).get('backend')==='webgl2';
let scene,failed=false,captures=0;

function write(element,text){if(element.textContent!==text)element.textContent=text;}
function fail(error){
  if(failed||signal.aborted)return;
  failed=true;
  for(const button of controls)button.disabled=true;
  status.error(error);
  aborter.abort();
}
function report(result){
  Object.assign(exhibit.dataset,{renderer:result.compatibility?'compatibility':'webgpu',
    lens:result.position.toFixed(4),selection:result.selection,history:result.history,wireframe:result.wireframe,
    normals:result.normals,draws:result.draws,frameTime:result.frameTime.toFixed(3),samples:result.samples});
  const mm=Math.round(result.offset*1000);
  write(get('offset'),mm===0?'Lens seated':'Lens '+(mm>0?'+':'')+mm+' mm');
  write(lensButton,result.extended?'Seat lens':'Slide lens out');
  lensButton.setAttribute('aria-pressed',String(result.extended));
  wire.setAttribute('aria-pressed',String(result.wireframe));
  normals.setAttribute('aria-pressed',String(result.normals));
}
function make(tag,text){
  const element=document.createElement(tag);
  if(text)element.textContent=text;
  return element;
}
const timing=ms=>Number.isFinite(ms)?ms.toFixed(3)+' ms':null;
const quantity=(count,name,plural=name+'s')=>count+' '+(count===1?name:plural);
function commandInfo(command){
  if(command.workgroups)return command.kind+' · '+command.workgroups.join(' × ');
  if(command.indexCount!==undefined&&command.indexCount!==null)
    return command.kind+' · '+command.indexCount+' indices · '+(command.instanceCount??'—')+' instances';
  if(command.vertexCount!==undefined&&command.vertexCount!==null)
    return command.kind+' · '+command.vertexCount+' vertices · '+(command.instanceCount??'—')+' instances';
  return command.kind;
}
function showPass(pass,buttons,index){
  for(const [i,button] of buttons.entries())button.setAttribute('aria-pressed',String(i===index));
  const commands=pass.passes.flatMap(item=>item.commands);
  const count=commands.filter(command=>command.kind.startsWith('draw')).length;
  const gpuTime=timing(pass.gpuMilliseconds);
  detail.replaceChildren(make('h3',pass.name),make('p',[
    pass.owner,quantity(pass.passes.length,'GPU pass','GPU passes'),quantity(count,'draw'),
    'CPU '+(timing(pass.cpuMilliseconds)??'—'),gpuTime?'GPU '+gpuTime:'GPU timing unavailable'
  ].join(' · ')));
  if(commands.length){
    const disclosure=make('details'),list=make('ul');
    disclosure.append(make('summary',quantity(commands.length,'recorded command')));
    for(const command of commands)list.append(make('li',commandInfo(command)));
    disclosure.append(list);
    detail.append(disclosure);
  }
  exhibit.dataset.activePass=pass.name;
}
function frameReport(result){
  captures++;
  const {totals,graph}=result;
  exhibit.dataset.captureCount=String(captures);
  exhibit.dataset.captureDraws=String(totals.draws);
  exhibit.dataset.capturePasses=String(graph.length);
  exhibit.dataset.captureTiming=result.timing;
  delete exhibit.dataset.captureError;
  frame.hidden=false;
  write(get('frame-totals'),[
    quantity(totals.draws,'draw'),quantity(totals.renderPasses+totals.computePasses,'GPU pass','GPU passes'),
    'CPU '+(timing(result.cpuMilliseconds)??'—')
  ].join(' · '));
  const buttons=graph.map(pass=>{
    const button=make('button',pass.name);
    button.type='button';
    return button;
  });
  for(const [i,button] of buttons.entries())
    button.addEventListener('click',()=>showPass(graph[i],buttons,i));
  passList.replaceChildren(...buttons);
  if(graph.length){
    const selected=Math.max(0,graph.findIndex(pass=>pass.owner==='core'&&pass.passes.length>0));
    showPass(graph[selected],buttons,selected);
  }else detail.replaceChildren(make('p','The captured frame contained no graph passes.'));
  capture.disabled=false;
  write(capture,'Capture frame');
}
function frameError(error){
  frame.hidden=false;
  exhibit.dataset.captureError='true';
  passList.replaceChildren();
  detail.replaceChildren(make('p',error instanceof Error?error.message:String(error)));
  write(get('frame-totals'),'Capture interrupted');
  capture.disabled=false;
  write(capture,'Capture frame');
}

lensButton.addEventListener('click',event=>scene?.slide(event.isTrusted),{signal});
wire.addEventListener('click',()=>scene?.toggle('wireframe'),{signal});
normals.addEventListener('click',()=>scene?.toggle('normals'),{signal});
capture.addEventListener('click',()=>{
  if(!scene)return;
  capture.disabled=true;
  write(capture,'Capturing…');
  void scene.capture();
},{signal});
window.addEventListener('pagehide',event=>{if(!event.persisted)aborter.abort();},{signal});

async function open(){
  const launch=import('./scene.js');
  const native=!forced&&navigator.gpu&&await navigator.gpu.requestAdapter().catch(()=>null);
  const compatibility=!native;
  if(compatibility)await (await import('./compatibility.js')).enableCompatibility();
  signal.throwIfAborted();
  const {openBench}=await launch;
  scene=await openBench(canvas,{tree:get('tree-host'),statsHost:get('stats-host'),compatibility,
    timestamps:Boolean(native?.features?.has('timestamp-query')),signal,fail,report,frameReport,frameError,
    inputRendered:()=>performance.mark('margo-first-input-rendered')});
  signal.throwIfAborted();
  for(const button of controls)button.disabled=false;
  performance.mark('margo-first-usable-frame');
  status.ready('');
}
open().catch(fail);
