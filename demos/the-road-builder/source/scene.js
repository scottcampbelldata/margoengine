import {gallery} from './art.js';
import {bounds,crossing,defaultSpur,naturalHeight,clip} from './terrain-art.js';

function gpuFence(engine,gl,signal){
  if(engine.gpu)return engine.gpu.queue.onSubmittedWorkDone();
  const fence=gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0),limit=performance.now()+1600;
  gl.flush();
  return new Promise((resolve,reject)=>{
    function poll(){
      const state=gl.clientWaitSync(fence,0,0);
      if(state===gl.TIMEOUT_EXPIRED&&!signal.aborted&&performance.now()<limit){setTimeout(poll,4);return;}
      gl.deleteSync(fence);
      if(state===gl.WAIT_FAILED||state===gl.TIMEOUT_EXPIRED)reject(Error('The road frame did not finish.'));
      else resolve();
    }
    poll();
  });
}
export async function connect(engine,canvas,signal,original,build,fail){
  engine.scene.background='#a8afa0';
  engine.lighting.direction.set([-63,74,45,1.82]);
  engine.lighting.radiance.set([1,.92,.77,.68]);
  engine.lighting.ambient.set([.79,.88,.94]);
  const art=gallery(engine),controls=document.querySelector('#controls'),state=document.body.dataset;
  const overlay=document.querySelector('#sketch'),guide=overlay.getContext('2d');
  const add=document.querySelector('#add'),draw=document.querySelector('#draw'),plan=document.querySelector('#plan');
  const bank=document.querySelector('#bank'),bankLabel=document.querySelector('#bank-value'),status=document.querySelector('#status');
  const distance=document.querySelector('#distance');
  let shown=original,gl,frame=0,building=false,disposed=false,desired=0,actual=0,revision=0,bankTimer=0;
  let desiredSpur=null,displaySpur=null,editor=false,path=[],pointer=null,wantedCause='';
  const remove=engine.scene.frameGraph.add({name:'capture render fence',order:5,execute(context){
    if(context.backend==='webgl2')gl=context.gl;
  }});
  function fit(){
    const dpr=Math.min(devicePixelRatio,2),width=Math.round(canvas.clientWidth*dpr),height=Math.round(canvas.clientHeight*dpr);
    if(canvas.width!==width){canvas.width=width;overlay.width=width;}
    if(canvas.height!==height){canvas.height=height;overlay.height=height;}
    const narrow=width/height<1.32;
    if(plan.checked){
      engine.camera.position=[0,narrow?233:204,0];engine.camera.up=[0,0,-1];engine.camera.target=[0,0,0];engine.camera.fov=47;
    }else{
      engine.camera.position=narrow?[90,147,180]:[83,117,154];
      engine.camera.up=[0,1,0];engine.camera.target=[0,1,19];engine.camera.fov=50;
    }
  }
  function render(){fit();engine.render({delta:0});}
  function requestView(){
    if(frame||signal.aborted)return;
    frame=requestAnimationFrame(()=>{
      frame=0;
      try{render();}
      catch(error){fail(error);}
    });
  }
  function reflect(){
    const meters=Math.round(shown.total);
    distance.textContent=meters+' m of road · '+(displaySpur?'T junction':'Main route');
    bankLabel.value=bank.value+'°';
    add.textContent=desiredSpur?'Remove spur':'Add hillside spur';
    state.revision=String(revision);state.bank=bank.value;
    state.spur=displaySpur?'true':'false';state.points=String(displaySpur?.length??0);
    state.area=String(Math.round(shown.junctionArea));state.distance=String(meters);
    state.view=plan.checked?'plan':'oblique';
  }
  async function refresh(){
    if(building||disposed||signal.aborted)return;
    building=true;
    const target=desired,cause=wantedCause,route=desiredSpur;
    status.textContent='Rebuilding the road and fitted ground…';
    try{
      const network=await build({bank:Number(bank.value),spur:route});
      if(signal.aborted)return;
      if(target===desired){
        art.reload(network);shown=network;displaySpur=route;
        render();await gpuFence(engine,gl,signal);
        if(signal.aborted)return;
        revision++;reflect();
        status.textContent=route?'The branch and main road share one stitched junction.':'Add a spur or sketch a branch from the crossing.';
        if(cause&&!performance.getEntriesByName('roads-control-applied').length)performance.mark('roads-control-applied');
      }
    }catch(error){
      if(!signal.aborted&&target===desired){
        desiredSpur=displaySpur;reflect();
        status.textContent='The road needs a wider curve. Try a gentler line from the marked crossing.';
        if(!state.ready)fail(error);
      }
    }finally{
      building=false;actual=target;
      if(desired!==actual&&!disposed)void refresh();
    }
  }
  function request(cause){wantedCause=cause;desired++;void refresh();}
  function sketch(on){
    editor=on;path=[];pointer=null;guide.clearRect(0,0,overlay.width,overlay.height);
    draw.setAttribute('aria-pressed',String(editor));canvas.dataset.drawing=String(editor);
    art.draft(editor);
    if(editor){
      plan.checked=true;
      status.textContent='Drag a line north from the brass crossing marker.';
    }else status.textContent=displaySpur?'The branch shares the crossing.':'Add a spur to see the terrain and junction rebuild.';
    state.view=plan.checked?'plan':'oblique';
    requestView();
  }
  function sample(event){
    const box=canvas.getBoundingClientRect(),x=event.clientX-box.left,y=event.clientY-box.top;
    const u=x/box.width*2-1,v=y/box.height*2-1;
    const centerHeight=engine.camera.position[1],lens=Math.tan(engine.camera.fov*Math.PI/360);
    let wx=u*box.width/box.height*lens*centerHeight,wz=v*lens*centerHeight;
    for(let k=0;k<5;k++){
      const hit=naturalHeight(wx,wz);
      wx=u*box.width/box.height*lens*(centerHeight-hit);wz=v*lens*(centerHeight-hit);
    }
    return {x:x*overlay.width/box.width,y:y*overlay.height/box.height,world:[clip(wx,-87,87),clip(wz,-69,67)]};
  }
  function redrawGuide(){
    guide.clearRect(0,0,overlay.width,overlay.height);
    if(path.length<2)return;
    guide.lineWidth=Math.max(3,overlay.width*.005);
    guide.lineCap='round';guide.lineJoin='round';guide.strokeStyle='#f5d179';
    guide.setLineDash([guide.lineWidth*1.9,guide.lineWidth*1.2]);
    guide.beginPath();
    for(const [index,p] of path.entries())if(index)guide.lineTo(p.x,p.y);else guide.moveTo(p.x,p.y);
    guide.stroke();
  }
  function accept(event){
    if(event.pointerId!==pointer)return;
    const last=sample(event),raw=[...path,last];sketch(false);
    const points=[defaultSpur[0],defaultSpur[1]];
    for(const {world:p} of raw){
      const last=points.at(-1);
      if(p[1]>last[1]-4||Math.hypot(p[0]-last[0],p[1]-last[1])<10)continue;
      points.push(p);
      if(points.length===11)break;
    }
    if(points.length<3){status.textContent='Draw farther uphill to add a branch.';return;}
    desiredSpur=points;request('sketch');
  }
  art.reload(original);render();
  await gpuFence(engine,gl,signal);
  state.renderer=gl?'webgl2':'webgpu';reflect();
  const options={signal};
  function activate(button,action){
    // A touch drag can leave Chrome suppressing the next synthesized click.
    // Activate at touch release while keeping keyboard and mouse click semantics.
    button.addEventListener('pointerup',event=>{
      if(event.pointerType!=='touch'||!event.isPrimary)return;
      const rect=button.getBoundingClientRect();
      if(event.clientX>=rect.left&&event.clientX<=rect.right&&event.clientY>=rect.top&&event.clientY<=rect.bottom)action();
    },options);
    button.addEventListener('click',event=>{
      if(event.pointerType!=='touch'&&!event.sourceCapabilities?.firesTouchEvents)action();
    },options);
  }
  activate(add,()=>{if(editor)sketch(false);desiredSpur=desiredSpur?null:defaultSpur;request('spur');});
  activate(draw,()=>sketch(!editor));
  plan.addEventListener('input',()=>{
    if(!plan.checked&&editor)sketch(false);
    state.view=plan.checked?'plan':'oblique';requestView();
  },options);
  bank.addEventListener('input',()=>{
    bankLabel.value=bank.value+'°';clearTimeout(bankTimer);bankTimer=setTimeout(()=>request('bank'),70);
  },options);
  canvas.addEventListener('pointerdown',event=>{
    if(!editor||pointer!==null)return;
    const p=sample(event);
    if(Math.hypot(p.world[0]-crossing[0],p.world[1]-crossing[1])>23){
      status.textContent='Start near the marked crossing, then drag north.';return;
    }
    pointer=event.pointerId;path=[p];canvas.setPointerCapture(pointer);redrawGuide();
  },options);
  canvas.addEventListener('pointermove',event=>{
    if(event.pointerId!==pointer)return;
    const p=sample(event),previous=path.at(-1);
    if(Math.hypot(p.x-previous.x,p.y-previous.y)>6){path.push(p);redrawGuide();}
  },options);
  canvas.addEventListener('pointerup',accept,options);
  canvas.addEventListener('pointercancel',event=>{
    if(event.pointerId===pointer){pointer=null;path=[];redrawGuide();}
  },options);
  const observer=new ResizeObserver(requestView);observer.observe(canvas);
  document.querySelector('#loading').hidden=true;controls.disabled=false;
  state.ready='true';
  performance.mark('margo-first-usable-frame');
  return {dispose(){disposed=true;observer.disconnect();cancelAnimationFrame(frame);clearTimeout(bankTimer);remove();art.dispose();}};
}
