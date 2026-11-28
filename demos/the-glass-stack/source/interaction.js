const get=id=>document.getElementById(id),control=get('controls'),slider=get('angle'),state=document.body.dataset;
const modes=[...document.querySelectorAll('[data-mode]')];
const note={
  weighted:'Weighted blending accumulates transparent color and coverage without sorting the panes.',
  moments:'Moment blending estimates how much light is blocked in front of each layer.',
  exact:'Exact compositing keeps the depth order of each pixel’s transparent layers.'
};
export async function runGlass(engine,canvas,signal,fail,adapter){
  const {room}=adapter;
  let frame,observer,drag,busy;
let mode='weighted',angle=16,smoke=true,reverse=false,revision=0,shown=0,needsUpdate=false;
let installed;

function allocation(){
  const scale=Math.min(1.75,Math.max(1,devicePixelRatio||1));
  return [Math.round(canvas.clientWidth*scale),Math.round(canvas.clientHeight*scale)];
}
function chooseMode(){
  if(installed===mode&&!needsUpdate)return;
  state.submitted=String(adapter.select({mode,smoke,reverse}));
  installed=mode;
}
function draw(){
  const [width,height]=allocation();
  if(canvas.width!==width)canvas.width=width;
  if(canvas.height!==height)canvas.height=height;
  const phone=canvas.clientWidth<630;
  engine.camera.position=phone?[3.31,2.62,5.19]:[3.37,2.68,5.29];
  engine.camera.target=[0,1.39,0];
  engine.camera.fov=phone?41:37;
  chooseMode();
  const heading=angle*Math.PI/180;
  room.fixture.setRotation([0,heading,0]);
  for(const button of modes)button.setAttribute('aria-pressed',String(button.dataset.mode===mode));
  slider.value=String(Math.round(angle));get('angle-value').value=Math.round(angle)+'°';
  get('method').textContent=mode==='exact'?note.exact+' '+state.exactMethod+'.':note[mode];
  state.mode=mode;state.angle=String(Math.round(angle));state.smoke=String(smoke);state.reversed=String(reverse);
  needsUpdate=false;
  engine.render({delta:0});
}
function schedule(){
  if(frame||busy||signal.aborted)return;
  frame=requestAnimationFrame(async ()=>{
    frame=undefined;busy=true;const captured=revision;
    try{
      draw();await adapter.wait();
      if(signal.aborted)return;
      shown=captured;state.revision=String(shown);
      if(captured&&!performance.getEntriesByName('glass-first-rendered').length)performance.mark('glass-first-rendered');
    }catch(error){fail(error);}
    finally{busy=false;}
    if(revision!==shown)schedule();
  });
}
function update(){revision++;schedule();}
function setAngle(value){angle=Math.max(-105,Math.min(105,value));update();}
function inputs(){
  for(const button of modes)button.addEventListener('click',()=>{
    if(mode!==button.dataset.mode){mode=button.dataset.mode;update();}
  },{signal});
  slider.addEventListener('input',()=>setAngle(+slider.value),{signal});
  get('smoke').addEventListener('change',event=>{smoke=event.target.checked;needsUpdate=true;update();},{signal});
  get('reverse').addEventListener('change',event=>{reverse=event.target.checked;needsUpdate=true;update();},{signal});
  canvas.addEventListener('pointerdown',event=>{
    if(drag)return;drag={pointer:event.pointerId,x:event.clientX,angle};canvas.setPointerCapture(event.pointerId);
  },{signal});
  canvas.addEventListener('pointermove',event=>{
    if(drag?.pointer===event.pointerId)setAngle(drag.angle+(event.clientX-drag.x)*.45);
  },{signal});
  for(const type of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(type,event=>{
    if(drag?.pointer===event.pointerId)drag=undefined;
  },{signal});
  canvas.addEventListener('keydown',event=>{
    if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();setAngle(angle+(event.key==='ArrowLeft'?-5:5));}
  },{signal});
  observer=new ResizeObserver(()=>{
    const [width,height]=allocation();
    if(canvas.width===width&&canvas.height===height)return;
    update();
  });
  observer.observe(canvas);
}
  state.renderer=adapter.renderer;
  state.exactMethod=adapter.exact;
    engine.lighting.direction.set([-2.8,3.8,4.5,1.75]);
    engine.lighting.radiance.set([.98,.88,.80,.73]);
    engine.lighting.ambient.set([.54,.72,.85]);
    engine.scene.background='#2c3540';
  performance.mark('glass-model');
  draw();
  performance.mark('glass-submit');
  await adapter.wait();
  return {
    connect(){state.ready='true';state.revision='0';control.disabled=false;get('loading').hidden=true;inputs();},
    dispose(){cancelAnimationFrame(frame);observer?.disconnect();adapter.dispose();}
  };
}
