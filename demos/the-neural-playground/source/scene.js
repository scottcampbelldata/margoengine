
import { Geometry, PbrMaterial } from '@margoengine/core';
import { domain, resolution, maxSamples, makeSamples } from './data.js';

const cold=['#566da9','#4a5a93','#414d82','#394270','#343a62','#303256','#2d2b4d','#2c2948'];
const warm=['#ba715e','#ad6658','#9b5a52','#8d514c','#7d4849','#694047','#573844','#483242'];
const plotColors=[...cold,'#382d45',...warm.reverse()];
const cell=2*domain/resolution;
const span=resolution+1;
const fieldEdge=[-domain,domain];
const colorBin=value=>Math.max(0,Math.min(16,8+Math.round(8*Math.tanh(value*.32))));
const cuts=Array.from({length:16},(_,i)=>Math.atanh((i+.5-8)/8)/.32);
const quartile=Math.log(3);

function sheet(){return {points:[],indices:[]};}
function polygon(shape,vertices,depth){
  const first=shape.points.length/3;
  for(const [x,y] of vertices)shape.points.push(x,y,depth);
  for(let i=1;i<vertices.length-1;i++)shape.indices.push(first,first+i,first+i+1);
}
function tile(shape,x0,x1,y0,y1,depth){
  polygon(shape,[[x0,y0],[x1,y0],[x1,y1],[x0,y1]],depth);
}
function line(shape,x0,y0,x1,y1,width,depth){
  const length=Math.hypot(x1-x0,y1-y0);
  if(length<1e-7)return;
  const px=(y1-y0)*width/(2*length),py=(x0-x1)*width/(2*length);
  polygon(shape,[[x0+px,y0+py],[x1+px,y1+py],[x1-px,y1-py],[x0-px,y0-py]],depth);
}
function draw(mesh,shape){
  if(!shape.indices.length){
    mesh.setGeometry(null);
    return;
  }
  const normals=new Float32Array(shape.points.length);
  for(let i=2;i<normals.length;i+=3)normals[i]=1;
  mesh.setGeometry(new Geometry(shape.points,normals,shape.indices));
}
function marker(shape,x,y,radius,label,depth){
  const sides=label===1?4:14;
  const edges=Array.from({length:sides},(_,i)=>{
    const turn=i*2*Math.PI/sides;
    return [x+radius*Math.cos(turn),y+radius*Math.sin(turn)];
  });
  polygon(shape,edges,depth);
}
function between(a,b,level){
  const fraction=(level-a[2])/(b[2]-a[2]);
  return [a[0]+(b[0]-a[0])*fraction,a[1]+(b[1]-a[1])*fraction,level];
}
function crossing(mesh,triangle,level,width,depth){
  const edges=[];
  for(let i=0;i<triangle.length;i++){
    const a=triangle[i],b=triangle[(i+1)%triangle.length];
    if((a[2]>=level)!==(b[2]>=level))edges.push(between(a,b,level));
  }
  if(edges.length===2)line(mesh,edges[0][0],edges[0][1],edges[1][0],edges[1][1],width,depth);
}
function clip(vertices,level,keepAbove){
  const surviving=[];
  for(let i=0;i<vertices.length;i++){
    const a=vertices[i],b=vertices[(i+1)%vertices.length];
    const here=keepAbove?a[2]>=level:a[2]<=level;
    const there=keepAbove?b[2]>=level:b[2]<=level;
    if(here)surviving.push(a);
    if(here!==there)surviving.push(between(a,b,level));
  }
  return surviving;
}
function diagrams(margin){
  const bands=plotColors.map(sheet),boundary=sheet(),confidence=sheet();
  for(let y=0;y<resolution;y++){
    const y0=-domain+y*cell,y1=y0+cell;
    let from=0, last=-1;
    for(let x=0;x<resolution;x++){
      const i=y*span+x;
      const a=margin[i],b=margin[i+1],c=margin[i+span+1],d=margin[i+span];
      const lo=Math.min(a,b,c,d), hi=Math.max(a,b,c,d);
      const first=colorBin(lo), final=colorBin(hi), bin=first===final?first:-1;
      if(bin!==last){
        if(last>=0)tile(bands[last],-domain+from*cell,-domain+x*cell,y0,y1,0);
        from=x;
        last=bin;
      }
      const equal=lo<=0&&hi>=0;
      const lower=lo<=-quartile&&hi>=-quartile,upper=lo<=quartile&&hi>=quartile;
      if(bin>=0&&!equal&&!lower&&!upper)continue;
      const x0=-domain+x*cell,x1=x0+cell;
      for(const triangle of [
        [[x0,y0,a],[x1,y0,b],[x1,y1,c]],
        [[x0,y0,a],[x1,y1,c],[x0,y1,d]],
      ]){
        if(bin<0){
          for(let band=first;band<=final;band++){
            let strip=clip(triangle,cuts[band-1]??-Infinity,true);
            strip=clip(strip,cuts[band]??Infinity,false);
            if(strip.length>=3)polygon(bands[band],strip,0);
          }
        }
        if(equal)crossing(boundary,triangle,0,.010,.012);
        if(lower)crossing(confidence,triangle,-quartile,.004,.007);
        if(upper)crossing(confidence,triangle,quartile,.004,.007);
      }
    }
    if(last>=0)tile(bands[last],-domain+from*cell,domain,y0,y1,0);
  }
  return {bands,boundary,confidence};
}

export async function open({engine,trainer,canvas,notice,status,signal,fail,size}) {
  const stepButton=document.querySelector('#step'), runButton=document.querySelector('#run'), resetButton=document.querySelector('#reset');
  const patternButtons=[...document.querySelectorAll('[data-pattern]')];
  const classButtons=[...document.querySelectorAll('[data-class]')];
  const stepsLabel=document.querySelector('#steps'), lossLabel=document.querySelector('#loss');
  const accuracyLabel=document.querySelector('#correct'), sampleLabel=document.querySelector('#sample-count');
  const route=document.querySelector('#backend');
  let pattern='crescents', examples=makeSamples(pattern), selected=0, steps=0, ready=false, running=false;
  let queued=0, pending=Promise.resolve(), timer=0, runGeneration=0, firstStep=false;
  const cursor=[0,0];
  const compat=engine.gpu.adapterInfo?.vendor==='margo-webgl2';
  engine.scene.background='#382d45';
  engine.lighting.direction[3]=0;
  engine.lighting.radiance[3]=1;
  engine.camera.project=(out,_,gpu)=>{
    const [left,right]=fieldEdge,{near,far}=engine.camera,depth=far-near;
    out[0]=2/(right-left);out[5]=out[0];out[10]=(gpu?1:2)/depth;
    out[14]=(gpu?far:far+near)/depth;out[15]=1;
  };
  let clock=0;
  const render=()=>engine.render(clock++);
  const mesh=(name,color)=>{
    const item=engine.createMesh().setMaterial(new PbrMaterial({color,roughness:1}));
    item.name=name;
    return item;
  };
  const fields=plotColors.map((color,i)=>mesh('Probability band '+(i+1),color));
  const tinyGrid=mesh('Coordinate ticks','#806e85');
  const grid=sheet();
  for(let x=-1;x<=1;x+=.2){
    for(let y=-1;y<=1;y+=.2){
      if(Math.abs(x)<.01||Math.abs(y)<.01)
        line(grid,x-.012,y,x+.012,y,.004,.005);
      else marker(grid,x,y,.0065,1,.005);
    }
  }
  draw(tinyGrid,grid);
  const edge=mesh('Equal probability at 50 percent','#f7dfb5');
  const iso=mesh('25 percent and 75 percent contours','#9b8295');
  const trim=mesh('Sample outlines','#1a1624');
  const classA=mesh('Class A, circles','#c4d4ff'), classB=mesh('Class B, diamonds','#ffb18e');
  const keyboardMarker=mesh('Keyboard point marker','#fcf1d4');
  engine.onError=fail;
  canvas.dataset.renderer=compat?'compatibility':'webgpu';
  route.textContent=compat?'Margo Compute · WebGL2':'Margo Compute · WebGPU';

  function paintPoints(){
    const outlines=sheet(), a=sheet(), b=sheet();
    for(const [x,y,label] of examples){
      marker(outlines,x,y,label?.033:.027,label,.018);
      marker(label?b:a,x,y,label?.025:.019,label,.021);
    }
    draw(trim,outlines);
    draw(classA,a);
    draw(classB,b);
  }
  function paintCursor(show){
    const s=sheet(),[x,y]=cursor;
    if(show){
      line(s,x-.040,y,x+.040,y,.009,.029);
      line(s,x,y-.040,x,y+.040,.009,.029);
    }
    draw(keyboardMarker,s);
  }
  function sync(){
    for(const button of patternButtons)button.setAttribute('aria-pressed',String(button.dataset.pattern===pattern));
    for(const button of classButtons)button.setAttribute('aria-pressed',String(+button.dataset.class===selected));
    runButton.textContent=running?'Pause':'Train';
    stepButton.disabled=running||queued>0;
  }
  function halt(){
    running=false;
    runGeneration++;
    clearTimeout(timer);
    sync();
  }
  async function repaint(points=false){
    const output=await trainer.sample();
    signal.throwIfAborted();
    const {bands,boundary,confidence}=diagrams(output.margin);
    for(let i=0;i<fields.length;i++)draw(fields[i],bands[i]);
    draw(edge,boundary);
    draw(iso,confidence);
    if(points)paintPoints();
    render();
    await engine.gpu.queue.onSubmittedWorkDone();
    signal.throwIfAborted();
    // Publish measurements after the corresponding probability surface was rendered.
    stepsLabel.value=String(steps);
    lossLabel.value=output.loss.toFixed(3);
    accuracyLabel.value=output.correct+' / '+examples.length;
    sampleLabel.textContent=examples.length+' labeled points';
    Object.assign(canvas.dataset,{steps:String(steps),loss:output.loss.toFixed(6),
      correct:String(output.correct),samples:String(examples.length),pattern});
    if(compat&&engine.gpu.dispatches){
      const {fragment,scatter,cpu}=engine.gpu.dispatches;
      canvas.dataset.computeDispatches=[fragment,scatter,cpu].join(',');
    }
  }
  function apply(operation){
    if(!ready||signal.aborted)return Promise.resolve();
    queued++;
    sync();
    pending=pending.then(async()=>{
      signal.throwIfAborted();
      await operation();
    }).catch(fail).finally(()=>{
      queued--;
      if(!signal.aborted)sync();
    });
    return pending;
  }
  async function train(count){
    await apply(async()=>{
      trainer.step(count);
      steps+=count;
      await repaint();
      if(!firstStep){
        firstStep=true;
        await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));
        if(!signal.aborted)performance.mark('neural-step-applied');
      }
    });
  }
  function nextBatch(generation){
    if(!running||signal.aborted||runGeneration!==generation)return;
    train(5).finally(()=>{
      if(running&&!signal.aborted&&runGeneration===generation)
        timer=setTimeout(()=>nextBatch(generation),72);
    });
  }
  function restart(nextPattern){
    halt();
    return apply(async()=>{
      pattern=nextPattern;
      examples=makeSamples(pattern);
      steps=0;
      trainer.reset(examples);
      await repaint(true);
    });
  }
  function plant(x,y){
    const label=selected;
    halt();
    return apply(async()=>{
      if(examples.length>=maxSamples)return;
      examples=[...examples,[x,y,label]];
      trainer.edit(examples);
      await repaint(true);
    });
  }

  runButton.addEventListener('click',()=>{
    if(!ready)return;
    if(running){halt();return;}
    running=true;
    sync();
    nextBatch(++runGeneration);
  },{signal});
  stepButton.addEventListener('click',()=>train(1),{signal});
  resetButton.addEventListener('click',()=>restart(pattern),{signal});
  for(const button of patternButtons)button.addEventListener('click',()=>restart(button.dataset.pattern),{signal});
  for(const button of classButtons)button.addEventListener('click',()=>{
    selected=+button.dataset.class;
    sync();
  },{signal});
  canvas.addEventListener('click',event=>{
    const area=canvas.getBoundingClientRect();
    plant(domain*(2*(event.clientX-area.left)/area.width-1),domain*(1-2*(event.clientY-area.top)/area.height));
  },{signal});
  canvas.addEventListener('keydown',event=>{
    const moves={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,1],ArrowDown:[0,-1]};
    const change=moves[event.key];
    if(change){
      event.preventDefault();
      for(let i=0;i<2;i++)cursor[i]=Math.max(-domain+.05,Math.min(domain-.05,cursor[i]+change[i]*.11));
      paintCursor(true);
      render();
    }else if(event.key==='Enter'||event.key===' '){
      event.preventDefault();
      plant(...cursor);
    }
  },{signal});
  canvas.addEventListener('focus',()=>{
    if(canvas.matches(':focus-visible')){paintCursor(true);if(ready)render();}
  },{signal});
  canvas.addEventListener('blur',()=>{paintCursor(false);if(ready)render();},{signal});
  signal.addEventListener('abort',()=>{clearTimeout(timer);trainer.dispose();},{once:true});
  const watch=new ResizeObserver(()=>{
    if(size()&&ready)render();
  });
  watch.observe(canvas);
  signal.addEventListener('abort',()=>watch.disconnect(),{once:true});

  trainer.reset(examples);
  await repaint(true);
  ready=status.ready();
  if(!ready)return;
  notice.hidden=true;
  for(const button of document.querySelectorAll('button'))button.disabled=false;
  performance.mark('neural-frame-ready');
}
