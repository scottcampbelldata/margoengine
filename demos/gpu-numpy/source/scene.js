import {demoStatus} from 'margo-demo-status';
import {openCompute,run} from './compute.js';
import {examples} from './fixtures.mjs';
import {parseExpression} from './expression.mjs';

const by=id=>document.getElementById(id);
const state=document.body.dataset;
const form=by('compute-form'), controls=by('controls'), code=by('expression');
const runButton=by('run'), plot=by('plot'), dial=by('inspect'), error=by('run-error');
const buttons=[...form.querySelectorAll('[data-example]')];
const status=demoStatus(document.body,by('status-text'),by('fatal'));
const lifetime=new AbortController(),{signal}=lifetime;
let gpu,result,previousCell,running=false;

const displayBackend={webgpu:'WebGPU',webgl2:'WebGL2 compatibility',cpu:'CPU compatibility'};
const zero=[30,34,49],cold=[115,166,255],warm=[255,176,112];

function format(value){
  if(!Number.isFinite(value))return String(value);
  const size=Math.abs(value);
  if(size>=10000||size!==0&&size<.001)return value.toExponential(3);
  return Number(value.toFixed(5)).toString();
}

function heat(value,scale,weighted=false){
  if(!Number.isFinite(value))return '#69546a';
  const weight=Math.pow(Math.min(1,Math.abs(value)/scale),weighted?.73:.91);
  const destination=value<0?cold:warm;
  return 'rgb('+zero.map((channel,i)=>Math.round(channel+(destination[i]-channel)*weight)).join(' ')+')';
}

function describeIndex(index){
  const {shape,data,complex}=result;
  let position;
  if(shape.length===2)position='['+Math.floor(index/shape[1])+', '+index%shape[1]+']';
  else position=shape.length?'['+index+']':'Scalar';
  if(complex){
    const {re,im}=complex;
    const add=im[index]<0?' − ':' + ';
    return position+' '+format(re[index])+add+format(Math.abs(im[index]))+'i';
  }
  return position+' '+format(data[index]);
}

function inspect(index){
  if(!result)return;
  previousCell?.classList.remove('selected');
  previousCell=plot.children[index];
  previousCell?.classList.add('selected');
  dial.value=String(index);
  by('value').textContent=describeIndex(index);
  dial.setAttribute('aria-valuetext',describeIndex(index));
}

function plotResult(next) {
  const {shape,data,complex}=next;
  let min=Infinity,max=-Infinity;
  for(const number of data)if(Number.isFinite(number)){
    min=Math.min(min,number);
    max=Math.max(max,number);
  }
  const scale=Number.isFinite(min)?Math.max(Math.abs(min),Math.abs(max),1e-10):1;
  const colorScale=by('color-scale');
  colorScale.hidden=!shape.length;
  colorScale.classList.toggle('sequential',Boolean(complex));
  by('lo').textContent=format(complex?0:-scale);
  by('hi').textContent=format(scale);
  result=next;
  previousCell=undefined;
  plot.replaceChildren();
  const kind=shape.length===2?'matrix':shape.length===1?'vector':'scalar';
  plot.className='plot '+kind;
  by('plotstage').setAttribute('aria-label',complex?'Complex array magnitude':kind+' output');
  const axis=by('plot-axis');
  axis.hidden=kind!=='vector';
  axis.textContent=(complex?'Frequency bins ':'Indices ')+'0–'+(data.length-1);
  const cells=document.createDocumentFragment();
  if(kind==='matrix'){
    const [rows,columns]=shape;
    plot.style.setProperty('--columns',columns);
    plot.style.setProperty('--rows',rows);
    for(const [index,value] of data.entries()){
      const cell=document.createElement('span');
      cell.dataset.index=index;
      cell.style.background=heat(value,scale);
      cells.append(cell);
    }
  }else if(kind==='vector'){
    const maximum=complex?scale:Math.max(0,max), minimum=complex?0:Math.min(0,min);
    const valid=Number.isFinite(maximum)&&Number.isFinite(minimum);
    const width=valid?Math.max(maximum-minimum,1e-10):1;
    const baseline=valid?100*(maximum/width):50;
    plot.style.setProperty('--axis',baseline+'%');
    plot.style.setProperty('--columns',data.length);
    for(const [index,value] of data.entries()){
      const cell=document.createElement('span');
      const bar=document.createElement('i');
      const y=Number.isFinite(value)&&valid?100*(maximum-value)/width:baseline;
      cell.dataset.index=index;
      bar.style.setProperty('--begin',Math.min(y,baseline)+'%');
      bar.style.setProperty('--size',Math.max(.8,Math.abs(y-baseline))+'%');
      bar.style.background=heat(value,scale,true);
      cell.append(bar);
      cells.append(cell);
    }
  }else{
    const number=document.createElement('strong');
    number.textContent=format(data[0]);
    cells.append(number);
  }
  plot.append(cells);
  dial.max=String(Math.max(0,data.length-1));
  dial.disabled=data.length<2;
  inspect(kind==='matrix'?(Math.floor(shape[0]/2)*shape[1]+Math.floor(shape[1]/2)):0);
}

function update(next,expression){
  plotResult(next);
  const {shape,complex,dispatches}=next, dimensions=shape.length?shape.join(' × '):'scalar';
  by('elapsed').textContent=next.elapsed.toFixed(next.elapsed<10?2:1)+' ms';
  by('shape').textContent=dimensions;
  by('result-expression').textContent=expression;
  by('result-title').textContent=complex?'Magnitude':shape.length===2?'Matrix result':shape.length===1?'Array result':'Scalar result';
  by('result-format').textContent=complex?'Complex · float32':'Float32';
  by('dispatches').hidden=!dispatches;
  if(dispatches){
    by('dispatch-count').textContent=dispatches.gpu+' GPU · '+dispatches.cpu+' CPU';
    state.gpuDispatches=String(dispatches.gpu);
    state.cpuDispatches=String(dispatches.cpu);
  }
  state.expression=expression;
  state.shape=shape.join('x');
  state.entries=String(next.data.length);
  state.elapsed=next.elapsed.toFixed(3);
  state.complex=String(Boolean(complex));
  state.sample=Array.from(next.data.subarray(0,6)).join(',');
}

function nextPaint(){
  return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
}

async function evaluate(expression,interactive){
  if(running||signal.aborted)return;
  running=true;
  runButton.disabled=true;
  for(const button of buttons)button.disabled=true;
  error.hidden=true;
  runButton.textContent='Running…';
  try{
    const tree=parseExpression(expression);
    const deadline=AbortSignal.any([signal,AbortSignal.timeout(8000)]);
    const next=await run(gpu,tree,deadline);
    if(signal.aborted)return;
    update(next,expression);
    await nextPaint();
    if(interactive&&!performance.getEntriesByName('first-control-frame').length)performance.mark('first-control-frame');
    if(interactive)performance.mark('expression-frame');
  }catch(reason){
    if(!interactive)throw reason;
    if(!signal.aborted){
      error.textContent=reason?.message??String(reason);
      error.hidden=false;
    }
  }finally{
    running=false;
    runButton.textContent='Run expression';
    runButton.disabled=false;
    for(const button of buttons)button.disabled=false;
  }
}

function bind(){
  form.addEventListener('submit',event=>{
    event.preventDefault();
    void evaluate(code.value,true);
  },{signal});
  for(const button of buttons)button.addEventListener('click',()=>{
    const example=examples[Number(button.dataset.example)];
    code.value=example.expression;
    void evaluate(code.value,true);
  },{signal});
  dial.addEventListener('input',()=>inspect(Number(dial.value)),{signal});
  plot.addEventListener('click',event=>{
    const cell=event.target.closest('[data-index]');
    if(cell)inspect(Number(cell.dataset.index));
  },{signal});
}

async function start(){
  const context=await openCompute(signal);
  gpu=context.gpu;
  if(signal.aborted){gpu.dispose();return;}
  state.renderer=context.backend;
  by('backend').textContent=displayBackend[context.backend];
  performance.mark('compute-ready');
  await evaluate(code.value,false);
  signal.throwIfAborted();
  bind();
  controls.disabled=false;
  if(status.ready())by('status').hidden=true;
  performance.mark('workbench-ready');
}

addEventListener('pagehide',event=>{
  if(event.persisted)return;
  lifetime.abort();
  gpu?.dispose();
});

start().catch(reason=>{
  if(signal.aborted)return;
  status.error(reason);
  by('status-text').textContent='Margo Compute could not open.';
});
