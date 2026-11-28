import {createTerrainGrass} from '@margoengine/creative/grass-terrain';
import {Sky,sunDirectionFromAngles} from '@margoengine/sky/base';
import {preetham} from '@margoengine/sky/preetham';
import {area,bounds,fieldCenter,cameraAt,groundY,trail,footRadius,recoverSeconds,candidateClumps,clamp,mix} from './meadow-data.js';

const by=id=>document.getElementById(id);
const deg=Math.PI/180;
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const sub=(a,b)=>a.map((v,i)=>v-b[i]);
const unit=a=>{const l=Math.hypot(...a);return a.map(v=>v/l);};
const limit=14.5;
const wind=[.92,.37,.68,7.4];

function createTextures(engine,{width,height,y,density}){
  let made,land,cover;
  function make(){
    if(made===engine.gpu)return;
    land?.destroy();
    cover?.destroy();
    made=engine.gpu;
    const details={size:[width,height],usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST};
    land=made.createTexture({...details,format:'r32float',label:'meadow rooted heights'});
    cover=made.createTexture({...details,format:'r8unorm',label:'meadow density'});
    made.queue.writeTexture({texture:land},y,{bytesPerRow:width*4,rowsPerImage:height},[width,height]);
    made.queue.writeTexture({texture:cover},density,{bytesPerRow:width,rowsPerImage:height},[width,height]);
  }
  return {heightmap(){make();return land;},densityMap(){make();return cover;},dispose(){land?.destroy();cover?.destroy();}};
}
function sightPoint(cam,w,h,nx,ny){
  const eye=cam.position,forward=unit(sub(cam.target,eye));
  const right=unit(cross(forward,[0,1,0])),up=cross(right,forward);
  const tan=Math.tan(cam.fov*.5*deg);
  const direction=unit(forward.map((v,i)=>v+right[i]*nx*tan*w/h+up[i]*ny*tan));
  const at=t=>eye.map((v,i)=>v+t*direction[i]);
  const above=p=>p[1]-groundY(p[0],p[2]);
  if(direction[1]>.1)return;
  let previous=.4;
  for(let step=.75;step<29;step+=.53){
    const p=at(step);
    if(above(p)>0){previous=step;continue;}
    let a=previous,b=step;
    for(let i=0;i<13;i++){
      const t=(a+b)*.5;
      if(above(at(t))>0)a=t;else b=t;
    }
    const hit=at((a+b)*.5);
    if(hit[0]<bounds[0]+1||hit[2]<bounds[1]+1||hit[0]>bounds[2]-1||hit[2]>bounds[3]-1)return;
    hit[1]=groundY(hit[0],hit[2])+.035;
    return hit;
  }
}
export function mount({opening,interaction,landscape,terrain,blade,viewport,canvas,movement,weather,loading,page,signal,fail,resize}){
  const walk=by('walk'),press=by('press'),reset=by('reset'),sun=by('sun'),sunValue=by('sun-value'),distanceOutput=by('distance');
  const reduceMotion=matchMedia('(prefers-reduced-motion: reduce)').matches;
  let engine,grass,sky,textures,observer,frameId=0,clock=0,path=0,lastStep=-1,walking=false,pending=false,working=false;
  let markedPress,stampCount=0,requested,latestInput='',transient=0,sunAngle=Number(sun.value),position;
  let cloudTimer,cloudFeature,requestingClouds=false,cloudActive=false,recoveryRemaining=0;
  let lastWalking=false,lastSunApplied;

  function camera(){
    const state=cameraAt(path,canvas.width/canvas.height<1.06);
    engine.camera.position=state.position;
    engine.camera.target=state.target;
    engine.camera.fov=state.fov;
    return state;
  }
  function lighting(elevation){
    lastSunApplied=elevation;
    const t=clamp((elevation-6)/44),d=sunDirectionFromAngles(199,elevation);
    sky.options.sunDirection=Array.from(d);
    sky.options.turbidity=mix(3.4,2.45,t);
    sky.options.exposure=mix(.19,-.15,t);
    if(sky.options.clouds)sky.options.clouds.coverage=mix(.36,.51,t);
    engine.lighting.direction.set([d[0],d[1],d[2],mix(2.27,2.75,t)]);
    engine.lighting.radiance.set([.98,mix(.73,.94,t),mix(.46,.82,t),mix(.58,.70,t)]);
    engine.lighting.ambient.set([mix(.93,1,t),.98,mix(1.06,1.12,t)]);
    grass.color=[mix(.365,.34,t),mix(.435,.481,t),mix(.132,.165,t)];
  }
  function createSky(feature){
    const options={model:'preetham',hours:16.9,timeScale:0,exposure:.14,turbidity:3.1};
    if(feature)options.clouds={coverage:.39,speed:reduceMotion?0:6.2,height:820};
    return Sky.attach(engine,options,{preetham,...(feature?{clouds:feature}:{})});
  }
  function requestClouds(){
    if(requestingClouds||page.failed||signal.aborted)return;
    requestingClouds=true;
    clearTimeout(cloudTimer);
    import('./sky-layer.js').then(api=>{
      if(signal.aborted||page.failed)return;
      cloudFeature=api.cloudFeature;
      schedule();
    }).catch(fail);
  }
  function foot(s,n){
    const p=trail(Math.min(16.8,s+2.24)),q=trail(Math.min(16.8,s+2.46)),dir=unit([q[0]-p[0],0,q[2]-p[2]]);
    const offset=(n%2===0?-1:1)*.18;
    const x=p[0]-dir[2]*offset,z=p[2]+dir[0]*offset;
    return [x,groundY(x,z)+.041,z];
  }
  function status(){
    viewport.dataset.distance=path.toFixed(3);
    viewport.dataset.walking=String(walking);
    viewport.dataset.stamps=String(stampCount);
    viewport.dataset.sun=String(sunAngle);
    if(position)viewport.dataset.stampPosition=position.map(n=>n.toFixed(3)).join(',');
    walk.textContent=walking?'Pause walk':'Walk forward';
    walk.setAttribute('aria-pressed',String(walking));
    distanceOutput.value=path.toFixed(1)+' m';
    sunValue.value=sunAngle+'°';
  }
  function schedule(){
    if(!frameId&&!working&&!signal.aborted&&!page.failed)frameId=requestAnimationFrame(draw);
  }
  function act(name,source){
    latestInput=name;
    if(source)requested=source;
    pending=true;
    schedule();
  }
  async function draw(time){
    frameId=0;
    if(signal.aborted||page.failed)return;
    working=true;
    try{
      const delta=clock?Math.min(.076,Math.max(.004,(time-clock)/1000)):1/60;
      clock=time;
      const action=latestInput;latestInput='';
      const needsPaint=pending;pending=false;
      if(action==='return'){
        walking=false;path=0;lastStep=-1;grass.resetTime();transient=0;recoveryRemaining=0;
        requested=undefined;markedPress=undefined;position=undefined;
        delete viewport.dataset.stampPosition;
      }
      if(walking){
        path=Math.min(limit,path+1.29*delta);
        if(path>=limit)walking=false;
        const index=Math.floor(path/.49);
        if(index!==lastStep){lastStep=index;requested=foot(path,index);}
      }
      resize();
      const view=camera();
      if(requested){
        position=typeof requested==='function'?requested(view):requested;
        if(position){
          markedPress={position,radius:footRadius,strength:1};
          transient=.145;
          recoveryRemaining=recoverSeconds*2.38+.145;
          stampCount++;
        }
        requested=undefined;
      }
      transient=Math.max(0,transient-delta);
      recoveryRemaining=Math.max(0,recoveryRemaining-delta);
      grass.setInteractors(transient&&markedPress?[markedPress]:[]);
      const addClouds=cloudFeature&&!cloudActive&&!walking&&!needsPaint;
      if(addClouds){
        sky.dispose();
        sky=createSky(cloudFeature);
        cloudActive=true;
      }
      if(lastSunApplied!==sunAngle||addClouds)lighting(sunAngle);
      engine.render({delta});
      if(needsPaint){
        await engine.gpu.queue.onSubmittedWorkDone();
        await new Promise(resolve=>requestAnimationFrame(resolve));
        signal.throwIfAborted();
        if(action){
          performance.mark(action+'-frame');
          if(!performance.getEntriesByName('first-control-frame').length){
            performance.mark('first-control-frame');
            clearTimeout(cloudTimer);
            cloudTimer=setTimeout(requestClouds,360);
          }
          viewport.dataset.lastAction=action;
        }
      }
      if(addClouds){
        await engine.gpu.queue.onSubmittedWorkDone();
        signal.throwIfAborted();
        viewport.dataset.clouds='true';
        performance.mark('cloud-frame');
      }
      const recovering=String(recoveryRemaining>0);
      if(viewport.dataset.recovering!==recovering)viewport.dataset.recovering=recovering;
      if(needsPaint||walking||lastWalking!==walking){
        lastWalking=walking;
        status();
      }
    }catch(reason){fail(reason);}
    finally{
      working=false;
      if(!reduceMotion||walking||pending||recoveryRemaining>0||(cloudFeature&&!cloudActive))schedule();
    }
  }
  async function run(){
    const [result,{TrampledScatter}]=await Promise.all([opening,interaction]);
    engine=result;
    signal.throwIfAborted();
    engine.scene.background='#9dada3';
    for(const {name,geometry,material} of landscape){
      engine.createMesh().setGeometry(geometry).setMaterial(material).name='SM_Meadow_'+name;
    }
    textures=createTextures(engine,terrain);
    sky=createSky();
    grass=await createTerrainGrass(engine,{
      geometry:blade,area,center:fieldCenter,bounds,count:candidateClumps,seed:12917,
      density:.96,densityMap:textures.densityMap,heightmap:textures.heightmap,maxSlope:54,alignToGround:.12,sink:.018,
      scale:[.38,1.06],lod:[8.3,16.5,38.4],edgeShrink:5,wind:reduceMotion?undefined:wind,
      blades:{rootShade:.38,widen:.36},colorMap:{data:terrain.tint,width:terrain.width,height:terrain.height,bounds},
      interaction:{size:21,resolution:112,recover:recoverSeconds,bend:1.53},signal,
    });
    if(!(grass instanceof TrampledScatter))throw new Error('The meadow needs terrain grass with a persistent interaction field.');
    signal.throwIfAborted();
    lighting(sunAngle);camera();
    engine.render({delta:1/60});
    await grass.ready;
    await engine.gpu.queue.onSubmittedWorkDone();
    await new Promise(resolve=>requestAnimationFrame(resolve));
    signal.throwIfAborted();
    performance.mark('meadow-frame');status();
    walk.addEventListener('click',()=>{
      if(path>=limit){path=0;lastStep=-1;}
      walking=!walking;
      act('walk');
    },{signal});
    press.addEventListener('click',()=>act('press',view=>sightPoint(view,canvas.width,canvas.height,0,-.61)),{signal});
    reset.addEventListener('click',()=>act('return'),{signal});
    sun.addEventListener('input',()=>{
      sunAngle=Number(sun.value);
      act('sun');
    },{signal});
    canvas.addEventListener('click',event=>{
      const r=canvas.getBoundingClientRect();
      const nx=(event.clientX-r.left)/r.width*2-1,ny=1-(event.clientY-r.top)/r.height*2;
      const hit=sightPoint(camera(),canvas.width,canvas.height,nx,ny);
      if(hit)act('press',hit);
    },{signal});
    observer=new ResizeObserver(()=>{
      if(resize()){pending=true;schedule();}
    });
    observer.observe(canvas);
    if(page.ready()){
      movement.disabled=false;
      weather.disabled=false;
      loading.hidden=true;
      cloudTimer=setTimeout(requestClouds,Math.max(300,3400-performance.now()));
      if(!reduceMotion)schedule();
    }
  }
  run().catch(fail);
  return ()=>{
    clearTimeout(cloudTimer);
    observer?.disconnect();
    if(frameId)cancelAnimationFrame(frameId);
    textures?.dispose();
  };
}
