import {buildStudio} from './art.js';
import {span,path} from './layout.js';
const el=id=>document.getElementById(id);
export async function connect(engine,canvas,signal,hardware,fail){
  const root=document.body.dataset,art=buildStudio(engine);
  const shape=el('shape'),yaw=el('yaw'),height=el('height'),normals=el('normals'),castButton=el('cast');
  const panel=el('hits'),status=el('status');
  let bench,queued=false,resize,sequence=0;
  let result={...path(1.07,0),hits:[]},config={shape:'sphere',height:1.07,yaw:0},selected=-1,ran=false;
  engine.scene.background='#332f40';
  engine.lighting.direction.set([-3.5,6,4.1,2.65]);
  engine.lighting.radiance.set([1,.93,.85,.97]);
  engine.lighting.ambient.set([.66,.82,.95]);
  engine.camera.project=(m,aspect,gpu)=>{
    const span=Math.max(3.4,(aspect<1.4?9.25:9.8)/aspect),{far,near}=engine.camera,d=far-near;
    m[0]=2/(span*aspect);m[5]=2/span;m[10]=gpu?1/d:-2/d;
    m[14]=gpu?far/d:-(far+near)/d;m[15]=1;
  };
  function paint(){
    signal.throwIfAborted();
    const scale=Math.min(devicePixelRatio,2),w=Math.round(canvas.clientWidth*scale),h=Math.round(canvas.clientHeight*scale);
    if(canvas.width!==w)canvas.width=w;
    if(canvas.height!==h)canvas.height=h;
    const mobile=canvas.clientWidth/canvas.clientHeight<1.4;
    engine.camera.position=mobile?[-5.2,5.25,6.6]:[-2.35,4.2,8.0];
    const travel=selected<0?(ran?span:0):result.hits[selected].distance;
    art.update(result,config.shape,travel,result.hits,normals.checked,ran);
    engine.render({delta:0});
    root.travel=travel.toFixed(4);
    root.active=String(selected);
    root.vectors=String(normals.checked);
  }
  async function fence(){
    if(engine.gpu)await engine.gpu.queue.onSubmittedWorkDone();
    else canvas.getContext('webgl2').finish();
  }
  function report(){
    root.contacts=String(result.hits.length);
    root.figures=result.hits.map(h=>h.id+':'+h.distance.toFixed(4)).join(',');
    root.castShape=config.shape;
    root.yaw=String(config.yaw);
    root.revision=String(sequence);
    panel.replaceChildren();
    if(!ran){
      el('summary').textContent='Ready to test';
      return;
    }
    for(const [index,hit] of result.hits.entries()){
      const line=document.createElement('li'),jump=document.createElement('button');
      const name=document.createElement('span'),distance=document.createElement('strong'),vector=document.createElement('small');
      name.textContent=hit.name;
      distance.textContent=hit.distance.toFixed(3)+' m';
      vector.textContent='Normal '+hit.normal.map(value=>value.toFixed(2)).join(', ');
      jump.type='button';
      jump.setAttribute('aria-pressed',String(selected===index));
      jump.append(name,distance,vector);
      line.append(jump);panel.append(line);
      jump.addEventListener('click',()=>{
        selected=index;
        for(const [i,li] of [...panel.children].entries())li.firstChild.setAttribute('aria-pressed',String(i===index));
        paint();
      },{signal});
    }
    const count=result.hits.length;
    el('summary').textContent=count+(count===1?' contact':' contacts');
    status.textContent=count?'Select a contact to move the probe to its measured position.':'The probe crossed the bench without touching a fitting.';
  }
  async function execute(trusted){
    try{
      result=bench.cast(config.shape,config.height,config.yaw);
      ran=true;sequence++;
      selected=result.hits.length?0:-1;
      report();paint();
      await fence();
      if(trusted&&!signal.aborted&&!performance.getEntriesByName('margo-first-input-rendered').length)
        performance.mark('margo-first-input-rendered');
    }catch(error){if(!signal.aborted)fail(error);}
  }
  const options={signal};
  castButton.addEventListener('click',event=>{
    if(bench){void execute(event.isTrusted);return;}
    queued=event.isTrusted;castButton.disabled=true;
    el('loading').textContent='Cast queued. Loading the query solver…';
  },options);
  for(const control of [shape,yaw,height]){
    control.addEventListener('input',()=>{
      config={shape:shape.value,height:Number(height.value),yaw:Number(yaw.value)};
      el('yaw-value').value=config.yaw+'°';
      el('height-value').value=config.height.toFixed(2)+' m';
      if(ran)void execute(false);
      else{result={...path(config.height,config.yaw),hits:[]};paint();}
    },options);
  }
  normals.addEventListener('change',()=>paint(),options);
  paint();
  root.renderer=engine.backend;root.castReady='true';castButton.disabled=false;
  root.contacts='0';
  const api=await hardware;
  signal.throwIfAborted();
  bench=api.queryBench();
  if(queued)await execute(true);
  else{paint();await fence();}
  signal.throwIfAborted();
  root.ready='true';
  performance.mark('margo-first-usable-frame');
  castButton.disabled=false;
  el('options').inert=false;
  el('loading').hidden=true;
  resize=new ResizeObserver(()=>{if(!signal.aborted)paint();});
  resize.observe(canvas);
  return {dispose(){resize.disconnect();bench.dispose();}};
}
