import {CameraBrain} from '@margoengine/cinematic/brain';
import {FramingComposer} from '@margoengine/cinematic/composer';
import {DollyTrack} from '@margoengine/cinematic/dolly';
import {GroupFraming} from '@margoengine/cinematic/group';
import {studio} from './geometry.js';
import {daylight} from './daylight.js';
import {landscape} from './landscape.js';
import {station} from './station.js';
import {rover} from './rover.js';
import {rail,vehiclePaths} from './paths.js';

const nextFrame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
const names={wide:'Station camera',dolly:'Dolly camera',group:'Group camera',dish:'Dish camera'};
const minimumMove=.17;

function mapToScreen(matrix,[x,y,z]){
  const w=matrix[3]*x+matrix[7]*y+matrix[11]*z+matrix[15];
  return [(.5+.5*(matrix[0]*x+matrix[4]*y+matrix[8]*z+matrix[12])/w),
    (.5-.5*(matrix[1]*x+matrix[5]*y+matrix[9]*z+matrix[13])/w)];
}
const fixed=(values,n=3)=>Array.from(values,v=>v.toFixed(n)).join(',');

export async function mount({engine,canvas,notice,signal,size,fail}){
  const data=canvas.dataset,get=id=>document.getElementById(id);
  const picks=[...document.querySelectorAll('[data-camera]')];
  const override=get('override'),pause=get('pause'),cut=get('cut'),controls=[...picks,override,pause,cut];
  engine.scene.background='#80a6b4';
  engine.lighting.direction.set([-.56,.69,.46,3.02]);
  engine.lighting.radiance.set([1,.92,.76,.48]);
  engine.lighting.ambient.set([.70,.79,.91]);
  const scene=studio(engine);
  daylight(scene);
  landscape(scene);
  const antenna=station(scene);
  const actors=[rover(scene,0),rover(scene,1)],paths=vehiclePaths();
  const targets=[()=>paths[0].target,()=>paths[1].target];
  const dolly=new DollyTrack(rail,{target:targets[0],lead:2.0,damping:4.2,position:12,window:15});
  const operator=new FramingComposer(targets[0],{
    screen:[.44,.62],deadZone:[.059,.072],softZone:[.63,.49],lookahead:.36,lookaheadVertical:false,damping:6,
  });
  const group=new GroupFraming(targets.map(target=>({target,radius:2.32})),{
    padding:.14,mode:'both',minDistance:9.0,maxDistance:39,minFov:31,maxFov:54,damping:5,
  });
  const baseBlend={duration:.86,style:'direct'};
  const dishIn={from:'*',to:'dish',duration:.63,style:'direct'};
  const dishOut={from:'dish',to:'*',duration:.86,style:'direct'};
  const brain=CameraBrain.attach(engine,{blend:baseBlend,rules:[dishIn,dishOut]});
  const cameras={
    wide:brain.add({name:'wide',priority:30,position:[-25,14,40],target:[-1,6.25,-7.8],fov:38}),
    dolly:brain.add({name:'dolly',priority:10,position:[-14,2.6,18],target:[-12,1.18,9.0],fov:28,stages:[dolly,operator]}),
    group:brain.add({name:'group',priority:12,position:[4,13,26],target:[0,1.18,4],fov:36,stages:[group]}),
    dish:brain.add({name:'dish',priority:0,position:[18.0,9.38,14.5],target:[-2.4,12.73,-16.4],fov:32}),
  };
  const base={wide:8,dolly:10,group:12,dish:0};
  data.renderer=engine.backend==='webgl2'?'compatibility':'webgpu';
  get('renderer').textContent=data.renderer==='webgpu'?'Margo WebGPU':'Margo WebGL2';
  performance.mark('camera-director-stage');
  let selected='wide',cued=false,paused=matchMedia('(prefers-reduced-motion: reduce)').matches,
    hard=paused,tick=0,previous=0,request=0,frame=0,activeNote='',cachedDetails='',lastChange=0,
    settled=0,pending,firstMarked=false,dirty=true;
  function actionClock(){
    for(const [name,item] of Object.entries(cameras))item.priority=name===selected?30:base[name];
    cameras.dish.priority=cued?60:base.dish;
    for(const pick of picks)pick.setAttribute('aria-pressed',String(pick.dataset.camera===selected));
    override.setAttribute('aria-pressed',String(cued));
    pause.setAttribute('aria-pressed',String(paused));
    pause.textContent=paused?'Resume motion':'Pause motion';
    cut.setAttribute('aria-pressed',String(hard));
    baseBlend.duration=hard?0:.86;
    dishIn.duration=hard?0:.63;
    dishOut.duration=hard?0:.86;
    dirty=true;
  }
  const offChange=brain.on('change',event=>{lastChange=event.duration;});
  const offBlend=brain.on('blended',()=>{settled++;});
  for(const pick of picks){
    pick.addEventListener('click',event=>{
      const name=pick.dataset.camera;
      if(name===selected)return;
      if(event.isTrusted&&!firstMarked&&!cued)
        pending={name,start:Array.from(engine.camera.position)};
      selected=name;
      actionClock();
    },{signal});
  }
  override.addEventListener('click',event=>{
    cued=!cued;
    if(event.isTrusted&&!firstMarked)pending={name:cued?'dish':selected,start:Array.from(engine.camera.position)};
    actionClock();
  },{signal});
  cut.addEventListener('click',()=>{hard=!hard;actionClock();},{signal});
  pause.addEventListener('click',()=>{paused=!paused;actionClock();},{signal});

  function pose(){
    for(const [i,actor] of actors.entries())actor.move(paths[i].sample(tick),tick);
    antenna.turn(tick);
  }
  function readout(){
    const live=brain.live.name,during=brain.blending;
    const status=(during?'Blending · ':'Priority ')+(during?lastChange.toFixed(2)+' s':brain.live.priority);
    const note=names[live]+status;
    if(activeNote!==note){
      activeNote=note;
      get('live').textContent=names[live];
      get('transition').textContent=status;
      get('announcement').textContent=names[live]+'. '+(during?'Blending in.':'On air.');
    }
    const details={
      wide:'The station camera establishes the antenna and both rovers.',
      dolly:'The rail is '+rail.length.toFixed(1)+' m long. The dolly is at '+dolly.position.toFixed(1)+' m and follows rover 1.',
      group:group.fits?'Group framing keeps both survey rovers inside the shot.':'The rovers have reached the framing limit.',
      dish:'Priority 60 takes over from '+names[selected].toLowerCase()+' at priority 30. Release the cue to return.',
    }[live];
    if(cachedDetails!==details){cachedDetails=details;get('shot-detail').textContent=details;}
    data.camera=live;
    data.requested=selected;
    data.priority=String(brain.live.priority);
    data.blending=String(during);
    data.duration=lastChange.toFixed(2);
    data.settled=String(settled);
    data.paused=String(paused);
    data.cart=dolly.position.toFixed(5);
    data.rail=rail.length.toFixed(5);
    data.cartWorld=fixed(rail.atDistance(dolly.position),5);
    data.fits=String(group.fits);
    data.groupCenter=fixed(group.center);
    data.groupSubjects=targets.map(target=>fixed(mapToScreen(engine.camera.matrix,target()),5)).join(';');
    data.cameraPosition=fixed(engine.camera.position,5);
    data.cameraTarget=fixed(engine.camera.target,5);
    data.fov=engine.camera.fov.toFixed(5);
    data.subjects=targets.map(target=>fixed(target(),5)).join(';');
    data.frame=String(++frame);
  }
  function draw(dt){
    pose();
    engine.render({delta:dt});
    readout();
    if(pending&&data.camera===pending.name&&
      Math.hypot(...Array.from(engine.camera.position,(v,i)=>v-pending.start[i]))>=minimumMove){
      firstMarked=true;
      pending=null;
      Promise.resolve(engine.gpu?.queue.onSubmittedWorkDone()).then(nextFrame).then(()=>{
        if(!signal.aborted)performance.mark('camera-director-first-input');
      }).catch(fail);
    }
  }
  function animate(now){
    if(signal.aborted)return;
    request=requestAnimationFrame(animate);
    const dt=Math.min(.06,Math.max(.001,(now-previous)/1000));
    previous=now;
    if(paused&&!dirty&&!brain.blending&&!pending)return;
    try{
      if(!paused)tick+=dt;
      dirty=false;
      draw(dt);
    }catch(reason){fail(reason);}
  }
  const resize=new ResizeObserver(()=>{if(!signal.aborted&&size())dirty=true;});
  signal.addEventListener('abort',()=>{
    cancelAnimationFrame(request);resize.disconnect();offChange();offBlend();brain.dispose();
  },{once:true});
  actionClock();
  draw(0);
  if(engine.gpu)await engine.gpu.queue.onSubmittedWorkDone();
  await nextFrame();
  signal.throwIfAborted();
  for(const control of controls)control.disabled=false;
  notice.hidden=true;
  data.ready='true';
  performance.mark('camera-director-ready');
  resize.observe(canvas);
  previous=performance.now();
  request=requestAnimationFrame(animate);
}
