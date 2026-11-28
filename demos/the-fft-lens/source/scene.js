import {createCompute} from '@margoengine/compute';
import {fft2,ifft2} from '@margoengine/compute/fft';
import {filter,upload,download,power,analysis,size,channels} from './model.mjs';

const id=name=>document.getElementById(name);
const tools=id('tools'),cutoff=id('cutoff'),wipe=id('wipe'),message=id('state');
const buttons=[...tools.querySelectorAll('[data-mode]')];
const rendered=id('image').getContext('2d',{alpha:false}),
  spectrum=id('spectrum').getContext('2d',{alpha:false}),scope=document.querySelector('.compare');
const readout=document.body.dataset,abort=new AbortController(),{signal}=abort;
const modeLabels={
  low:['Low pass','Low pass preserves broad glow and smooths fine detail.'],
  high:['High pass','High pass shows changes around neutral gray, revealing edges and fine detail.'],
  band:['Band pass','Band pass isolates an intermediate scale. Gray is a zero response.'],
  none:['Full spectrum','The inverse transform uses all frequencies and rebuilds the source.'],
};
const force=new URLSearchParams(location.search).get('backend')==='webgl2';
let engine,coefficients,energy,mode='low',requested=0,active=false;

function presentLabels(){
  id('frequency').value=cutoff.value+' cycles / frame';
  id('filter-label').textContent=modeLabels[mode][0];
  id('meaning').textContent=modeLabels[mode][1];
  cutoff.disabled=mode==='none';
  for(const button of buttons)button.setAttribute('aria-pressed',String(button.dataset.mode===mode));
}
function cutoffGuide(kind,frequency){
  if(kind==='none')return;
  const rings=kind==='band'?[frequency*.5,frequency*2]:[frequency];
  spectrum.lineWidth=.65;
  spectrum.strokeStyle='rgba(255,230,196,.68)';
  spectrum.setLineDash([2,3]);
  for(const radius of rings){
    spectrum.beginPath();
    spectrum.arc(size/2,size/2,radius,0,Math.PI*2);
    spectrum.stroke();
  }
  spectrum.setLineDash([]);
}
function presentWipe(){
  scope.style.setProperty('--split',wipe.value+'%');
  id('split').value=wipe.value+'%';
  wipe.setAttribute('aria-valuetext',wipe.value+' percent original');
}
async function imageData(){
  const image=scope.querySelector('img');
  await image.decode();
  if(image.naturalWidth!==size||image.naturalHeight!==size)throw Error('Unexpected sample size.');
  const source=document.createElement('canvas');
  source.width=source.height=size;
  const context=source.getContext('2d',{alpha:false,willReadFrequently:true});
  context.drawImage(image,0,0);
  return upload(context.getImageData(0,0,size,size).data);
}
async function openingCompute(){
  const compatibility=force||!navigator.gpu;
  if(compatibility){
    const {install}=await import('@margoengine/webgl2-compat');
    await install({force:true,signal});
  }
  return createCompute({signal});
}
async function computeMask(kind,frequency){
  const weights=filter(kind,frequency);
  const m=engine.array(weights,{shape:[size,size]});
  const real=coefficients.re.mul(m);
  const imaginary=coefficients.im.mul(m);
  const reconstructed=ifft2({re:real,im:imaginary});
  try{
    const rgba=download(await reconstructed.re.read({signal}),kind);
    return {rgba,plot:analysis(energy,weights)};
  }finally{
    reconstructed.re.dispose();
    reconstructed.im.dispose();
    m.dispose();
  }
}
async function paint(){
  if(active)return;
  active=true;
  try{
    while(!signal.aborted){
      const sequence=requested,kind=mode,frequency=cutoff.valueAsNumber;
      const result=await computeMask(kind,frequency);
      signal.throwIfAborted();
      if(sequence!==requested)continue;
      rendered.putImageData(new ImageData(result.rgba,size,size),0,0);
      spectrum.putImageData(new ImageData(result.plot.rgba,size,size),0,0);
      cutoffGuide(kind,frequency);
      id('energy').value=result.plot.kept.toLocaleString('en-US',{maximumFractionDigits:2})+'%';
      readout.mode=kind;readout.cutoff=String(frequency);readout.energy=result.plot.kept.toFixed(7);
      readout.revision=String(sequence);
      if(sequence>0&&!performance.getEntriesByName('fft-first-mask').length)performance.mark('fft-first-mask');
      if(!readout.ready)performance.mark('fft-first-frame');
      break;
    }
  }finally{active=false;}
}
function change(){
  requested++;
  presentLabels();
  paint().catch(fail);
}
function connect(){
  for(const button of buttons)button.addEventListener('click',()=>{
    if(mode===button.dataset.mode)return;
    mode=button.dataset.mode;
    change();
  },{signal});
  cutoff.addEventListener('input',change,{signal});
  wipe.addEventListener('input',presentWipe,{signal});
}
async function start(){
  const pixels=imageData();
  pixels.catch(()=>{});
  engine=await openingCompute();
  performance.mark('fft-device');
  readout.renderer=engine.backend==='cpu'?'cpu':force||engine.device?.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu';
  const original=engine.array(await pixels,{shape:[channels,size,size]});
  try{coefficients=fft2(original);}finally{original.dispose();}
  const [real,imaginary]=await Promise.all([coefficients.re.read({signal}),coefficients.im.read({signal})]);
  energy=power(real,imaginary);
  performance.mark('fft-forward');
  await paint();
  connect();presentLabels();presentWipe();
  tools.disabled=false;
  readout.ready='true';
  readout.samples=String(size*size);
  const backend={webgpu:'WebGPU',webgl2:'WebGL2 compatibility',cpu:'CPU fallback'}[readout.renderer];
  message.textContent='256 × 256 image · RGB transform · '+backend;
}
function fail(error){
  if(signal.aborted)return;
  message.textContent='The transform could not be computed on this device.';
  readout.error=error.message;
  console.error(error);
}
addEventListener('pagehide',event=>{
  if(event.persisted)return;
  abort.abort();
  coefficients?.re.dispose();coefficients?.im.dispose();engine?.dispose();
});
start().catch(fail);
