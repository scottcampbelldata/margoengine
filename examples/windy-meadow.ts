import {createStage} from 'margoengine';
import {GrassField} from '@margoengine/creative/grass';
import {OrbitControls} from '@margoengine/controls';
import {Bloom} from '@margoengine/post/bloom';
import {Sky} from '@margoengine/sky';
import {sceneSamples} from '../packages/shared/quality.js';

const error=document.querySelector<HTMLElement>('#error')!,status=document.querySelector<HTMLElement>('#status')!;
const abort=new AbortController();let dispose:(()=>void)|undefined;
try {
  const stage=await createStage('#viewport',{backend:'webgpu',controls:false,autoStart:false,
    label:'Wind-blown meadow with adjustable daylight, clouds and floating seeds',
    camera:{position:[18,4,22],target:[0,1.2,0],far:300},onError:value=>{error.textContent=String(value);}});
  dispose=()=>stage.dispose();
  const controls=new OrbitControls(stage.engine.camera,stage.canvas);
  controls.minDistance=3;controls.maxDistance=65;controls.maxPolarAngle=Math.PI/2-0.02;controls.saveState();
  stage.use({name:'meadow-controls',setup(){},dispose:()=>{controls.dispose();abort.abort();}});
  const post=Bloom.attach(stage.engine,{strength:0.15,threshold:1.2,exposure:0});
  const sky=Sky.attach(stage.engine,{model:'bruneton',hours:16,timeScale:0,turbidity:3,exposure:-0.35,
    clouds:{coverage:0.38,speed:8},lighting:{intensity:3,color:[1,0.97,0.9],sunset:[1,0.68,0.35],
      moon:{intensity:0.4,color:[0.25,0.45,0.75]},ambient:{day:[0.14,0.19,0.24],night:[0.02,0.04,0.09]}}});
  stage.box({size:[60,0.12,60],position:[0,-0.07,0],color:'#34451f',roughness:1});
  const speed=document.querySelector<HTMLInputElement>('#speed')!,strength=document.querySelector<HTMLInputElement>('#strength')!;
  const density=document.querySelector<HTMLSelectElement>('#density')!,seeds=document.querySelector<HTMLInputElement>('#seeds')!;
  const mobile=sceneSamples()===1;
  if(mobile)density.value='35000';
  document.querySelector<HTMLDetailsElement>('#settings')!.open=!matchMedia('(max-width:600px)').matches;
  document.querySelector<HTMLElement>('#quality')!.textContent=mobile?'Mobile · 1× MSAA · DPR capped at 2':'Desktop · 4× MSAA · DPR capped at 1';
  let meadow:GrassField;
  const render=()=>stage.engine.render({delta:0});
  const populate=()=>{
    const time=meadow?.windTime??0;meadow?.dispose();
    meadow=new GrassField(stage,{blades:Number(density.value),area:[60,60],bladeHeight:1.2,
      windSpeed:speed.valueAsNumber,windStrength:strength.valueAsNumber,drawDistance:90,spores:seeds.checked});
    meadow.windTime=time;
    status.textContent=`WebGPU · ${meadow.blades.toLocaleString('en-US')} blades${seeds.checked?' · 240 seeds':''}`;
    render();
  };
  populate();
  for(const input of [density,seeds])input.addEventListener('change',populate,{signal:abort.signal});
  for(const [id,change] of [
    ['speed',(value:number)=>{meadow.windSpeed=value;sky.options.clouds!.speed=value*8/1.2;}],
    ['strength',(value:number)=>{meadow.windStrength=value;}],
    ['hours',(value:number)=>{sky.options.hours=value;}],
    ['clouds',(value:number)=>{sky.options.clouds!.coverage=value;}],
    ['bloom',(value:number)=>{post.options.strength=value;}],
    ['exposure',(value:number)=>{post.options.exposure=value;}],
  ] as const){
    const input=document.querySelector<HTMLInputElement>('#'+id)!,output=document.querySelector<HTMLOutputElement>('#'+id+'-value')!;
    input.addEventListener('input',()=>{change(input.valueAsNumber);output.value=id==='hours'?`${Math.floor(input.valueAsNumber)}:${input.valueAsNumber%1?'30':'00'}`:input.value;render();},{signal:abort.signal});
  }
  const reduced=matchMedia('(prefers-reduced-motion: reduce)'),button=document.querySelector<HTMLButtonElement>('#pause')!;
  let paused=reduced.matches;
  const motion=()=>{button.textContent=paused?'Resume motion':'Pause motion';button.setAttribute('aria-pressed',String(paused));if(paused){stage.engine.stop();render();}else stage.engine.start();};
  button.addEventListener('click',()=>{paused=!paused;motion();},{signal:abort.signal});
  reduced.addEventListener('change',()=>{paused=reduced.matches;motion();},{signal:abort.signal});
  controls.addEventListener('change',()=>{if(paused)render();});
  document.querySelector<HTMLButtonElement>('#reset-view')!.addEventListener('click',()=>{controls.reset();render();},{signal:abort.signal});
  stage.canvas.addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','-'].includes(event.key))return;event.preventDefault();
    if(event.key==='+'||event.key==='-')stage.canvas.dispatchEvent(new WheelEvent('wheel',{deltaY:event.key==='+'?-100:100,cancelable:true}));
    else {controls.rotateLeft(event.key==='ArrowLeft'?0.1:event.key==='ArrowRight'?-0.1:0);controls.rotateUp(event.key==='ArrowUp'?0.1:event.key==='ArrowDown'?-0.1:0);controls.update();}
  },{signal:abort.signal});
  stage.canvas.tabIndex=0;stage.canvas.setAttribute('aria-describedby','navigation-help');
  motion();document.querySelector<HTMLElement>('#viewport')!.dataset.ready='true';
  window.addEventListener('pagehide',()=>stage.dispose(),{once:true,signal:abort.signal});
  if(import.meta.hot)import.meta.hot.dispose(()=>stage.dispose());
}catch(value){dispose?.();status.textContent='Unable to start the meadow';error.textContent=String(value);}
