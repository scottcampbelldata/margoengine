import {DOF} from '@margoengine/dof';
import {DOFLens} from '@margoengine/dof/lens';
import {Autofocus} from '@margoengine/dof/autofocus';
import {prepareRoom,mountRoom,targets} from './room.js';

export {prepareRoom};

const stops=[1,1.4,2,2.8,4,5.6,8];
const lensProfiles={
  round:{},
  hex:{blades:6,bladeRotation:Math.PI/6},
  cat:{catEye:1.22},
};
const radians=Math.PI/180, focalLength=.095;
const nextFrame=()=>new Promise(resolve=>requestAnimationFrame(resolve));

function project(camera,shift){
  camera.project=(out,aspect,webgpu)=>{
    const scale=1/Math.tan(camera.fov*radians/2), depth=camera.near-camera.far;
    out[0]=scale/aspect;
    out[5]=scale;
    const filmHeight=2000*focalLength/scale;
    out[9]=-2*shift()/filmHeight;
    out[10]=webgpu?-camera.near/depth:(camera.far+camera.near)/depth;
    out[11]=-1;
    out[14]=(webgpu?-1:2)*camera.far*camera.near/depth;
  };
}

function targetDistance(camera,target){
  const direction=camera.target.map((coordinate,axis)=>coordinate-camera.position[axis]);
  const length=Math.hypot(...direction);
  return direction.reduce((sum,delta,axis)=>sum+delta*(target[axis]-camera.position[axis]),0)/length;
}

export async function show({engine,room,canvas,notice,status,size,signal,fail}){
  const form=document.querySelector('.optics');
  const focusButtons=[...document.querySelectorAll('[data-focus]')];
  const aperture=document.querySelector('#iris'), tilt=document.querySelector('#tilt'),shift=document.querySelector('#shift');
  const fstop=document.querySelector('#iris-value'), tiltValue=document.querySelector('#tilt-value');
  const shiftValue=document.querySelector('#shift-value'), distance=document.querySelector('#distance');
  const guide=document.querySelector('#guide');
  const controls=[...focusButtons,...form.querySelectorAll('input')];
  const isCompatibility=engine.gpu.adapterInfo?.vendor==='margo-webgl2';
  const phone=matchMedia('(max-width:650px)');
  let dof, lens, autofocus, scheduled=false, drawing=false, dirty=false, firstInput=false, loadingShape=false;
  let active={type:'projector',target:targets.projector.position};
  let shape='round', tiltAngle=0, rise=0;
  let autofocusFrames=0, queuedInput=false;

  mountRoom(engine,room);
  function frameCamera(){
    engine.camera.fov=phone.matches?41:36;
    project(engine.camera,()=>rise);
  }
  frameCamera();

  function updateLabel(){
    const label=targets[active.type]?.label??'Surface';
    const depth=dof.options.focalDistance;
    distance.value=depth.toFixed(2)+' m';
    distance.setAttribute('aria-label',label+' focus distance');
    canvas.dataset.focus=active.type;
    canvas.dataset.distance=depth.toFixed(4);
    canvas.dataset.shape=shape;
    canvas.dataset.aperture=String(stops[+aperture.value]);
    canvas.dataset.tilt=String(tiltAngle);
    canvas.dataset.shift=String(rise);
    for(const button of focusButtons)button.setAttribute('aria-pressed',String(button.dataset.focus===active.type));
  }

  async function installShape(next){
    const focusDistance=dof?.options.focalDistance??targetDistance(engine.camera,active.target);
    autofocus?.dispose();
    dof?.dispose();
    shape=next;
    lens=new DOFLens({...lensProfiles[shape],tilt:tiltAngle*radians,tiltDirection:[0,1]});
    dof=DOF.attach(engine,{focalLength,focalDistance:focusDistance,aperture:stops[+aperture.value],maxRadius:32,lens});
    autofocus=Autofocus.attach(engine,dof,{smoothing:0,...(active.target?{target:active.target}:{point:active.point})});
    performance.mark('cine-attached');
    await dof.ready;
    signal.throwIfAborted();
  }

  function draw(){
    engine.render(0);
    updateLabel();
  }


  function queueDraw(trusted=false){
    queuedInput||=trusted;
    dirty=true;
    if(scheduled||drawing||loadingShape||signal.aborted)return;
    scheduled=true;
    requestAnimationFrame(async()=>{
      scheduled=false;
      if(signal.aborted||loadingShape)return;
      drawing=true;
      dirty=false;
      const trustedFrame=queuedInput;
      queuedInput=false;
      try{
        draw();
        if(autofocusFrames>0){
          autofocusFrames--;
          dirty||=autofocusFrames>0;
        }
        if(trustedFrame||autofocusFrames>0)await engine.gpu.queue.onSubmittedWorkDone();
        if(trustedFrame){
          if(dirty||loadingShape){
            queuedInput=true;
          }else{
            await nextFrame();
            if(!signal.aborted){
              performance.mark('cine-input-rendered');
              if(!firstInput){
                firstInput=true;
                performance.mark('cine-first-input-rendered');
              }
            }
          }
        }
      }catch(error){
        fail(error);
      }finally{
        drawing=false;
        if(dirty)queueDraw();
      }
    });
  }

  function focus(type,event,point){
    const target=targets[type]?.position;
    active={type,target,point};
    autofocus.options.target=target;
    autofocus.options.point=point;
    if(target)dof.options.focalDistance=targetDistance(engine.camera,target);
    autofocusFrames=target?0:4;
    guide.textContent=target?
      'Focused on the '+targets[type].label.toLowerCase()+'. Try a different depth or adjust the iris.':
      'Surface autofocus uses the depth beneath your tap. Empty space keeps the previous distance.';
    queueDraw(event.isTrusted);
  }
  focusButtons.forEach(button=>button.addEventListener('click',event=>focus(button.dataset.focus,event),{signal}));
  canvas.addEventListener('click',event=>{
    if(!canvas.dataset.ready||loadingShape)return;
    const rect=canvas.getBoundingClientRect();
    focus('surface',event,[event.clientX-rect.left,event.clientY-rect.top]);
  },{signal});
  aperture.addEventListener('input',event=>{
    dof.options.aperture=stops[+aperture.value];
    fstop.value='f/'+dof.options.aperture.toFixed(dof.options.aperture<2?1:0);
    queueDraw(event.isTrusted);
  },{signal});
  tilt.addEventListener('input',event=>{
    tiltAngle=+tilt.value;
    lens.tilt=tiltAngle*radians;
    tiltValue.value=tiltAngle+'°';
    guide.textContent='Tilt rotates the plane of focus. Compare the top and bottom of the image.';
    queueDraw(event.isTrusted);
  },{signal});
  shift.addEventListener('input',event=>{
    rise=+shift.value;
    shiftValue.value=rise+' mm';
    guide.textContent='Shift moves the framing without turning the camera.';
    queueDraw(event.isTrusted);
  },{signal});
  form.addEventListener('change',async event=>{
    if(event.target.name!=='shape'||shape===event.target.value)return;
    loadingShape=true;
    controls.forEach(control=>control.disabled=true);
    try{
      await installShape(event.target.value);
      guide.textContent=shape==='cat'?'The barrel clips blur discs toward the frame edges.':
        'Bright points take the shape of the selected iris.';
    }catch(error){
      fail(error);
      return;
    }finally{
      loadingShape=false;
    }
    controls.forEach(control=>control.disabled=false);
    queueDraw(event.isTrusted);
  },{signal});
  const changes=new ResizeObserver(()=>{
    if(!size())return;
    frameCamera();
    queueDraw();
  });
  changes.observe(canvas);
  signal.addEventListener('abort',()=>changes.disconnect(),{once:true});

  canvas.dataset.renderer=isCompatibility?'compatibility':'webgpu';
  document.querySelector('#route').textContent=isCompatibility?'Margo WebGL2':'Margo WebGPU';
  await installShape(shape);
  performance.mark('cine-package-ready');
  draw();
  performance.mark('cine-first-submitted');
  await engine.gpu.queue.onSubmittedWorkDone();
  signal.throwIfAborted();
  await nextFrame();
  if(status.ready()){
    controls.forEach(control=>control.disabled=false);
    notice.hidden=true;
    performance.mark('cine-ready');
  }
}
