import {colors,height,width,size as sampleSize,sample} from './patterns.js';
import {wovenView} from './view.js';

const nextFrame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
const clamp=(x,min,max)=>Math.min(max,Math.max(min,x));
const signature=values=>{
  let key=2166136261;
  for(const value of values)key=Math.imul(key^value,16777619);
  return (key>>>0).toString(16).padStart(8,'0');
};
function indexOf(x,y){return y*sampleSize+x;}
function pointOf(index){return [index%sampleSize,Math.floor(index/sampleSize)];}
function trace(a,b,visit){
  let [x,y]=pointOf(a);
  const [tx,ty]=pointOf(b),dx=Math.abs(tx-x),dy=-Math.abs(ty-y);
  const sx=x<tx?1:-1,sy=y<ty?1:-1;
  let error=dx+dy;
  for(;;){
    visit(indexOf(x,y));
    if(x===tx&&y===ty)return;
    const e=2*error;
    if(e>=dy){error+=dy;x+=sx;}
    if(e<=dx){error+=dx;y+=sy;}
  }
}

export async function show({engine,opening,seed,solve,canvas,notice,status,size,signal,fail}){
  const grid=document.querySelector('#sample'), palette=document.querySelector('#palette');
  const preset=document.querySelector('#preset'),seedInput=document.querySelector('#seed');
  const next=document.querySelector('#next'),detail=document.querySelector('#detail');
  const routes=document.querySelector('#route'),state=canvas.dataset;
  const compat=engine.gpu.adapterInfo?.vendor==='margo-webgl2';
  const view=wovenView(opening.cells);
  let contents=seed,ink=2,focus=0,pointer=null,last=null,edited=false;
  let pending=null,working=false,first=true,rendering=0,count=0;
  const pixels=[],swatches=[];
  const drawn=document.createElement('option');
  drawn.value='drawn';
  drawn.textContent='Drawn sample';
  drawn.disabled=true;
  drawn.hidden=true;
  preset.append(drawn);
  routes.textContent=compat?'Margo WebGL2':'Margo WebGPU';
  state.renderer=compat?'compatibility':'webgpu';

  function colorAt(index){
    const pixel=pixels[index],col=colors[contents[index]],[x,y]=pointOf(index);
    pixel.style.setProperty('--ink',col.color);
    pixel.dataset.color=String(contents[index]);
    pixel.setAttribute('aria-label','Row '+(y+1)+', column '+(x+1)+', '+col.name);
  }
  for(let y=0;y<sampleSize;y++){
    const row=document.createElement('div');
    row.className='sample-row';
    row.role='row';
    for(let x=0;x<sampleSize;x++){
      const index=indexOf(x,y),pixel=document.createElement('button');
      pixel.type='button';
      pixel.role='gridcell';
      pixel.className='pixel';
      pixel.tabIndex=index===0?0:-1;
      pixel.dataset.index=String(index);
      pixel.disabled=true;
      pixels.push(pixel);
      colorAt(index);
      row.append(pixel);
    }
    grid.append(row);
  }
  colors.forEach(({name,color},index)=>{
    const label=document.createElement('label'),radio=document.createElement('input');
    radio.name='ink';radio.type='radio';radio.checked=index===ink;radio.disabled=true;
    radio.style.setProperty('--ink',color);
    radio.setAttribute('aria-label',name);
    label.title=name;
    label.append(radio);
    palette.append(label);
    swatches.push(radio);
    radio.addEventListener('change',()=>{if(radio.checked)ink=index;},{signal});
  });

  engine.use(view);
  function paint(index){
    if(contents[index]===ink)return;
    contents[index]=ink;
    colorAt(index);
    edited=true;
  }
  function record(data,source){
    state.seed=String(data.seed);
    state.patterns=String(data.patterns);
    state.backtracks=String(data.backtracks);
    state.result=signature(data.cells);
    state.sample=signature(source);
    state.woven=String(width)+'x'+height;
    state.generation=String(++count);
    delete state.contradiction;
    detail.textContent=width+' × '+height+' cells · '+data.patterns+' neighbourhoods · seed '+data.seed;
  }
  function solveValue(){
    const seed=clamp(Math.trunc(Number(seedInput.value)||1),1,999999999);
    seedInput.value=String(seed);
    return seed;
  }
  async function run(){
    if(working||!pending||signal.aborted)return;
    working=true;
    try{
      while(pending&&!signal.aborted){
        const job=pending;
        pending=null;
        detail.textContent='Growing the field from seed '+job.seed+'…';
        const result=await solve(job.data,job.seed);
        if(signal.aborted)return;
        if(pending)continue;
        if(result.error){
          state.contradiction='true';
          detail.textContent='This sample hit the search limit. Try another seed or change the swatch.';
          continue;
        }
        view.set(result.cells);
        engine.render(0);
        await engine.gpu.queue.onSubmittedWorkDone();
        if(signal.aborted)return;
        record(result,job.data);
        if(job.trusted){
          await nextFrame();
          if(signal.aborted)return;
          performance.mark('pattern-input-rendered');
          if(first){first=false;performance.mark('pattern-first-input');}
        }
      }
    }catch(reason){
      fail(reason);
    }finally{
      working=false;
    }
  }
  function request(trusted){
    pending={data:contents.slice(),seed:solveValue(),trusted};
    run();
  }

  function finish(event){
    pointer=null;
    last=null;
    if(!edited)return;
    edited=false;
    drawn.hidden=false;
    preset.value='drawn';
    request(event.isTrusted);
  }
  function cell(event){
    const bounds=grid.getBoundingClientRect();
    const x=Math.floor((event.clientX-bounds.left)/bounds.width*sampleSize);
    const y=Math.floor((event.clientY-bounds.top)/bounds.height*sampleSize);
    if(x<0||y<0||x>=sampleSize||y>=sampleSize)return null;
    return indexOf(x,y);
  }
  function setFocus(index,focusHere){
    pixels[focus].tabIndex=-1;
    pixels[index].tabIndex=0;
    focus=index;
    if(focusHere)pixels[index].focus({preventScroll:true});
  }
  grid.addEventListener('pointerdown',event=>{
    if(!state.ready||event.button!==0||pointer!==null)return;
    const index=cell(event);
    if(index===null)return;
    event.preventDefault();
    pointer=event.pointerId;
    last=index;
    setFocus(index,false);
    grid.setPointerCapture(pointer);
    paint(index);
  },{signal});
  grid.addEventListener('pointermove',event=>{
    if(event.pointerId!==pointer)return;
    const index=cell(event);
    if(index===null){last=null;return;}
    if(last===null)paint(index);
    else trace(last,index,paint);
    last=index;
  },{signal});
  for(const type of ['pointerup','pointercancel','lostpointercapture']){
    grid.addEventListener(type,event=>{if(event.pointerId===pointer)finish(event);},{signal});
  }
  grid.addEventListener('click',event=>{
    if(!state.ready||pointer!==null||event.detail!==0||!event.target.matches('.pixel'))return;
    paint(Number(event.target.dataset.index));
    finish(event);
  },{signal});
  grid.addEventListener('keydown',event=>{
    if(!state.ready||pointer!==null||!event.target.matches('.pixel'))return;
    const shifts={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};
    const move=shifts[event.key];
    if(!move)return;
    event.preventDefault();
    const [x,y]=pointOf(Number(event.target.dataset.index));
    setFocus(indexOf(clamp(x+move[0],0,sampleSize-1),clamp(y+move[1],0,sampleSize-1)),true);
  },{signal});
  preset.addEventListener('change',event=>{
    if(preset.value==='drawn')return;
    contents=sample(preset.value);
    drawn.hidden=true;
    for(let i=0;i<pixels.length;i++)colorAt(i);
    request(event.isTrusted);
  },{signal});
  next.addEventListener('click',event=>{
    seedInput.value=String(solveValue()%999999999+1);
    request(event.isTrusted);
  },{signal});
  seedInput.addEventListener('change',event=>request(event.isTrusted),{signal});
  seedInput.addEventListener('keydown',event=>{
    if(event.key==='Enter'){event.preventDefault();seedInput.blur();}
  },{signal});
  const observer=new ResizeObserver(()=>{
    if(!size()||rendering)return;
    rendering=requestAnimationFrame(()=>{
      rendering=0;
      if(!signal.aborted)engine.render(0);
    });
  });
  observer.observe(canvas);
  signal.addEventListener('abort',()=>{observer.disconnect();cancelAnimationFrame(rendering);},{once:true});

  engine.render(0);
  await engine.gpu.queue.onSubmittedWorkDone();
  signal.throwIfAborted();
  record(opening,contents);
  await nextFrame();
  if(status.ready()){
    notice.hidden=true;
    for(const control of [preset,seedInput,next,...pixels,...swatches])control.disabled=false;
    performance.mark('pattern-ready');
  }
}
