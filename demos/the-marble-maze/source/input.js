import { Gyro } from '@margoengine/input/motion';

const radians=Math.PI/180;
const travel=Math.sin(17*radians);
const screenAngle=()=>screen.orientation?.angle??window.orientation??0;
const clamp=value=>Math.max(-1,Math.min(value,1));
const deadZone=value=>Math.sign(value)*Math.max(0,Math.abs(value)-.045)/.955;
const directions={up:[0,-1],right:[1,0],down:[0,1],left:[-1,0]};

export function wireTilt(canvas,buttons,phone,onInput,onMotionState,signal){
  const keys=new Set(),pointers=new Map();
  let drag=null,pulse=null,gyro=null,origin=null,sensor=null,inertial=[0,0],pending=false;
  let orientation=screenAngle(),lastState='',available=false;
  function report(text){
    if(text===lastState)return;
    lastState=text;
    onMotionState(text);
  }
  function absolute(event){
    const {beta,gamma}=event;
    if(!Number.isFinite(beta)||!Number.isFinite(gamma))return;
    const angle=screenAngle(),t=angle*radians,b=beta*radians,g=gamma*radians;
    const x=-Math.cos(b)*Math.sin(g),y=Math.sin(b);
    const gravity=[-Math.cos(t)*x+Math.sin(t)*y,Math.sin(t)*x+Math.cos(t)*y];
    if(!origin||angle!==orientation){origin=gravity;orientation=angle;}
    sensor=gravity.map((v,i)=>deadZone(clamp((v-origin[i])/travel)));
    available=true;
    report('Phone tilt active');
    onInput();
  }
  function stop(){
    gyro?.dispose();
    gyro=null;
    window.removeEventListener('deviceorientation',absolute);
    window.removeEventListener('devicemotion',onInput);
    origin=sensor=null;
    inertial=[0,0];
    available=false;
    phone.setAttribute('aria-pressed','false');
    phone.textContent='Tilt with phone';
  }
  async function enable(){
    if(pending)return;
    if(gyro){
      stop();
      report('');
      onInput();
      return;
    }
    pending=true;
    try{
      if(!await Gyro.requestPermission()){
        report('Motion access unavailable. Drag the board or use the arrows.');
        return;
      }
      if(signal.aborted||document.hidden)return;
      gyro=new Gyro({deadzone:1.2,screenAngle});
      window.addEventListener('deviceorientation',absolute,{signal});
      window.addEventListener('devicemotion',onInput,{signal});
      phone.setAttribute('aria-pressed','true');
      phone.textContent='Turn phone tilt off';
      report('Hold your phone steady, then tilt.');
    }catch{
      report('Motion access unavailable. Drag the board or use the arrows.');
    }finally{pending=false;}
  }
  phone.addEventListener('click',enable,{signal});
  function move(event){
    if(drag?.id!==event.pointerId)return;
    const scale=Math.min(canvas.clientWidth,canvas.clientHeight)*.20;
    drag.vector=[clamp((event.clientX-drag.x)/scale),clamp((event.clientY-drag.y)/scale)];
    onInput();
  }
  canvas.addEventListener('pointerdown',event=>{
    if(drag||event.button!==0)return;
    canvas.setPointerCapture(event.pointerId);
    drag={id:event.pointerId,x:event.clientX,y:event.clientY,vector:[0,0]};
    canvas.dataset.dragging='true';
  },{signal});
  canvas.addEventListener('pointermove',move,{signal});
  for(const type of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(type,event=>{
    if(event.pointerId!==drag?.id)return;
    drag=null;
    delete canvas.dataset.dragging;
  },{signal});
  for(const button of buttons){
    const vector=directions[button.dataset.direction];
    function press(){
      pulse={vector,until:null};
      onInput();
    }
    button.addEventListener('pointerdown',event=>{
      if(event.button!==0)return;
      button.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId,vector);
      press();
    },{signal});
    button.addEventListener('click',event=>{if(event.detail===0)press();},{signal});
    for(const type of ['pointerup','pointercancel','lostpointercapture']){
      button.addEventListener(type,event=>pointers.delete(event.pointerId),{signal});
    }
  }
  const keyDirection=event=>event.key.startsWith('Arrow')?directions[event.key.slice(5).toLowerCase()]:null;
  window.addEventListener('keydown',event=>{
    if(!keyDirection(event)||event.altKey||event.metaKey||event.ctrlKey)return;
    event.preventDefault();
    keys.add(event.key);
    onInput();
  },{signal});
  window.addEventListener('keyup',event=>keys.delete(event.key),{signal});
  function neutral(){
    keys.clear();
    pointers.clear();
    pulse=drag=null;
    delete canvas.dataset.dragging;
    gyro?.recenter();
    origin=sensor=null;
    inertial=[0,0];
  }
  window.addEventListener('blur',neutral,{signal});
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden){stop();neutral();report('');}
  },{signal});
  signal.addEventListener('abort',stop,{once:true});
  function sample(now){
    if(gyro){
      gyro.update();
      if(!sensor&&gyro.available){
        if(!available){available=true;report('Phone tilt active');}
        inertial=[clamp(inertial[0]-gyro.yaw/(17*radians)),clamp(inertial[1]+gyro.pitch/(17*radians))];
      }
    }
    const manual=[...pointers.values(),...[...keys].map(key=>keyDirection({key}))];
    if(drag)manual.push(drag.vector);
    if(pulse){
      pulse.until??=now+220;
      if(now>=pulse.until)pulse=null;
      else if(!manual.length)manual.push(pulse.vector);
    }
    if(manual.length)return manual.reduce(([x,z],[a,b])=>[x+a,z+b],[0,0]);
    return sensor??inertial.map(deadZone);
  }
  return {sample,neutral};
}
