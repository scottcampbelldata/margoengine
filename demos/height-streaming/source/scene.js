import {TerrainStream} from '@margoengine/terrain/stream';
import {FlyControls} from '@margoengine/controls/fly';
import {Sky} from '@margoengine/sky/base';
import {preetham} from '@margoengine/sky/preetham';
import {look} from '@margoengine/sky/look';
import {elevationBase,samples,surveySide,tileSize,windowSide} from './tiles.js';
import {home,horizon,layers,layerTexture,sun,terrainLook} from './art.js';

const by=id=>document.getElementById(id);
const side=tileSize*surveySide;
const clamp=(v,a,b)=>Math.max(a,Math.min(v,b));
const important=[];
for(let z=6;z<=8;z++)for(let x=6;x<=8;x++)important.push([x,z]);

export function mount({opening,source,canvas,viewport,loading,status,signal,fail,size,projection}){
  const button=by('flight'),reset=by('return'),left=by('left'),right=by('right'),map=by('tile-map');
  const residency=by('resident'),heading=by('heading'),altitude=by('altitude'),position=by('position'),traveled=by('travel');
  const cells=Array.from({length:windowSide**2},()=>{
    const cell=document.createElement('span');
    map.append(cell);
    return cell;
  });
  let engine,stream,fly,observer,unlisten,raf=0,time=0,dirty=true,working=false,changed=true,keyboardTurn;
  let ready=false,cruise=false,firstRequest=false,firstQueued=false,tracking=true,shifts=0,uploads=0,distance=0,frame=0;
  const unique=new Set();
  function showFlight(){
    button.textContent=cruise?'Pause survey':'Start survey';
    button.setAttribute('aria-pressed',String(cruise));
    fly.autoForward=cruise;
  }
  function buttonFlight(){
    cruise=!cruise;
    showFlight();
    tracking=cruise;
    dirty=true;
    if(cruise&&!firstQueued){
      firstRequest=true;
      performance.mark('survey-input');
    }
    schedule();
  }
  function setHome(){
    cruise=false;
    showFlight();
    engine.camera.position=[...home.position];
    engine.camera.target=[...home.target];
    distance=0;tracking=true;dirty=true;changed=true;
    schedule();
  }
  function setCamera(next){
    const before=engine.camera.position,d=engine.camera.target.map((v,i)=>v-before[i]);
    engine.camera.position=next;
    engine.camera.target=next.map((v,i)=>v+d[i]);
  }
  function move(delta){
    const previous=[...engine.camera.position];
    if(keyboardTurn){
      fly.moveState[keyboardTurn]=.84;
      const turn=keyboardTurn;
      keyboardTurn=undefined;
      const moved=fly.update(delta);
      fly.moveState[turn]=0;
      if(!moved)return false;
    }else if(!fly.update(delta)){return false;}
    const p=engine.camera.position;
    const next=[clamp(p[0],5200,side-5200),clamp(cruise?previous[1]:p[1],920,2840),clamp(p[2],5200,side-5200)];
    if(cruise&&(next[0]!==p[0]||next[2]!==p[2])){
      cruise=false;
      showFlight();
    }
    if(next.some((v,i)=>v!==p[i]))setCamera(next);
    distance+=Math.hypot(next[0]-previous[0],next[2]-previous[2]);
    return true;
  }
  function updateHUD(){
    const p=engine.camera.position,t=engine.camera.target;
    const x=Math.floor(p[0]/tileSize),z=Math.floor(p[2]/tileSize),[a,b]=stream.tile;
    const d=(Math.atan2(t[0]-p[0],p[2]-t[2])*180/Math.PI+360)%360;
    const h=Math.round(d)%360,letters=['N','NE','E','SE','S','SW','W','NW'];
    let count=0;
    for(let j=0;j<windowSide;j++)for(let i=0;i<windowSide;i++){
      const tx=a+i,tz=b+j,cell=cells[j*windowSide+i];
      const available=stream.resident(tx,tz);
      if(available){count++;unique.add(tx+','+tz);}
      cell.dataset.active=String(tx===x&&tz===z);
      cell.dataset.resident=String(available);
      cell.title='Tile '+tx+'E, '+tz+'S'+(available?' · resident':' · loading');
    }
    residency.value=count+' / '+cells.length;
    heading.value=String(h).padStart(3,'0')+'° '+letters[Math.round(d/45)%8];
    altitude.value=Math.round(elevationBase+p[1]).toLocaleString('en-US')+' m';
    traveled.value=(distance/1000).toFixed(2)+' km';
    position.value=String(x).padStart(2,'0')+' E · '+String(z).padStart(2,'0')+' S';
    Object.assign(viewport.dataset,{resident:String(count),unique:String(unique.size),origin:a+','+b,version:String(stream.version),
      shifts:String(shifts),x:p[0].toFixed(1),z:p[2].toFixed(1),heading:String(h),travel:distance.toFixed(1),uploads:String(uploads),
      decoded:String(source.opened),survey:String(cruise),rendered:String(++frame)});
    changed=false;
  }
  function schedule(){
    if(!engine||raf||working||signal.aborted)return;
    raf=requestAnimationFrame(draw);
  }
  async function draw(now){
    raf=0;
    if(signal.aborted||status.failed)return;
    working=true;
    try{
      const delta=time?clamp((now-time)/1000,.014,.085):1/60;
      time=now;
      const moved=ready&&move(delta),render=moved||dirty||changed||tracking;
      dirty=false;
      if(render){
        engine.render({delta});
        const opened=!ready&&important.every(([x,z])=>stream.resident(x,z));
        const movedByControl=firstRequest&&moved&&distance>0;
        if(opened||movedByControl){
          await engine.gpu.queue.onSubmittedWorkDone();
          await new Promise(resolve=>requestAnimationFrame(resolve));
          signal.throwIfAborted();
        }
        if(opened){
          ready=true;
          performance.mark('terrain-frame');
          if(status.ready()){
            for(const control of [button,reset,left,right])control.disabled=false;
            loading.hidden=true;
          }
        }
        if(movedByControl){
          firstRequest=false;
          firstQueued=true;
          performance.mark('first-control-frame');
        }
        updateHUD();
      }
      tracking=cruise||Number(viewport.dataset.resident)<cells.length;
    }catch(reason){fail(reason);}
    finally{
      working=false;
      if(tracking||dirty||changed||Object.values(fly.moveState).some(value=>value!==0))schedule();
    }
  }

  function bindTurn(control,key){
    const hold=ev=>{
      if(control.disabled)return;
      control.setPointerCapture(ev.pointerId);
      fly.moveState[key]=.54;
      dirty=true;schedule();
    };
    const release=()=>{fly.moveState[key]=0;dirty=true;schedule();};
    control.addEventListener('pointerdown',hold,{signal});
    control.addEventListener('pointerup',release,{signal});
    control.addEventListener('pointercancel',release,{signal});
    control.addEventListener('lostpointercapture',release,{signal});
    control.addEventListener('click',ev=>{
      if(ev.detail!==0)return;
      keyboardTurn=key;
      dirty=true;schedule();
    },{signal});
  }
  async function run(){
    engine=await opening;
    signal.throwIfAborted();
    engine.scene.background='#a8bac0';
    engine.lighting.direction.set([...sun,3.04]);
    engine.lighting.radiance.set([1,.896,.754,.43]);
    engine.lighting.ambient.set([.72,.82,.98]);
    Sky.attach(engine,{sunDirection:sun,timeScale:0,turbidity:2.55,exposure:0,look:{
      gradient:[{elevation:-90,color:horizon},{elevation:-6,color:horizon},{elevation:1,color:[.43,.53,.59]},
        {elevation:21,color:[.17,.32,.47]},{elevation:55,color:[.055,.17,.32]},{elevation:90,color:[.052,.145,.30]}],
      gradientStrength:1,gradientIntensity:1,sunDiscIntensity:0,
    }},{preetham,look});
    stream=TerrainStream.attach(engine,{tileSize,tileTexels:samples,window:windowSide,heightScale:1,
      layers,colors:layerTexture,load:async (x,z,tileSignal)=>{
        try{return await source.load(x,z,tileSignal);}
        catch(reason){if(!tileSignal.aborted)fail(reason);throw reason;}
      },weights:1,fill:-90,budget:32768,concurrency:36,signal,
      cellSize:12,resolution:80,levels:5,roughness:.94});
    stream.terrain.addLighting(terrainLook);
    unlisten=stream.onChange(change=>{
      if(change.shifted)shifts++;
      else uploads+=change.width*change.depth;
      changed=true;
    });
    stream.ready(signal).catch(fail);
    fly=new FlyControls(engine.camera,canvas);
    fly.dragToLook=true;
    fly.movementSpeed=520;
    fly.rollSpeed=.79;
    for(const type of ['pointerdown','pointermove','pointerup','pointercancel']){
      canvas.addEventListener(type,()=>{if(ready){dirty=true;schedule();}},{signal});
    }
    document.addEventListener('keydown',()=>{
      if(!ready)return;
      dirty=true;schedule();
    },{signal});
    addEventListener('blur',()=>{
      for(const input of Object.keys(fly.moveState))fly.moveState[input]=0;
    },{signal});
    observer=new ResizeObserver(()=>{
      if(!size())return;
      engine.camera.fov=projection();
      dirty=true;schedule();
    });
    observer.observe(canvas);
    button.addEventListener('click',buttonFlight,{signal});
    reset.addEventListener('click',setHome,{signal});
    bindTurn(left,'yawLeft');
    bindTurn(right,'yawRight');
    schedule();
  }
  run().catch(fail);
  return ()=>{
    observer?.disconnect();
    unlisten?.();
    fly?.dispose();
    if(raf)cancelAnimationFrame(raf);
  };
}
