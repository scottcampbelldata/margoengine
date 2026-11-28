import {SkinnedCrowd, poseBone} from '@margoengine/animation/instanced-skin';
import {Texture, UnlitMaterial, createInstancedMesh} from '@margoengine/materials';
import {clipBake,walkSpeed} from './caribou.js';
import {elevation,makeLandscape} from './landscape.js';
const total=2048, sizes=[384,768,1280,2048], TAU=Math.PI*2;
const overview={eye:[29,43,91],look:[-4,13,-30],fov:49};
const tint=[
  [[104,76,62],[129,95,70],[185,148,108],[203,177,140],[112,87,72],[55,48,41],[160,143,123],[116,102,85]],
  [[83,66,60],[116,86,74],[155,124,102],[187,164,139],[100,78,67],[54,46,43],[158,141,122],[102,96,82]],
  [[110,78,58],[151,112,79],[191,153,113],[224,195,153],[121,90,73],[58,49,43],[174,152,127],[121,98,80]],
  [[82,61,58],[109,79,68],[144,114,96],[190,164,133],[98,72,62],[52,42,37],[140,121,105],[110,82,72]],
];
const el=id=>document.getElementById(id);
const nextFrame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
const clamp=(n,a,b)=>Math.min(b,Math.max(a,n));
const mix=(a,b,t)=>a+(b-a)*t;
function rng(seed){
  return ()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
}
function texture(){
  const rgba=new Uint8Array(tint.flatMap(row=>row.flatMap(color=>[...color,255])));
  return new Texture({data:rgba,width:8,height:4},{minFilter:'linear',magFilter:'linear',mipmaps:false});
}
function createHerd(){
  const random=rng(559182), width=237, lanes=32, perLane=64;
  const agents=Array.from({length:total},(_,i)=>{
    const band=i%lanes, order=Math.floor(i/lanes);
    const shift=(band*(width/perLane)*.618)%(width/perLane);
    const x=-width*.5+(order+.2+random()*.55)*(width/perLane)+shift;
    const z=(band-17)*3.21+(random()-.5)*1.64;
    const size=.78+random()*.30, speed=.87+random()*.31, offset=random()*1.28;
    return {x,z,size,speed,offset,swirl:random()*TAU,palette:i%4,matrix:new Float32Array(16)};
  });
  for(let i=agents.length-1;i>0;i--){
    const j=Math.floor(random()*(i+1));
    [agents[i],agents[j]]=[agents[j],agents[i]];
  }
  Object.assign(agents[0],{x:2.2,z:3.15,size:1.18,palette:2,speed:1,swirl:0});
  return agents;
}
function worldMatrix(actor,time){
  const x=((actor.x+118.5+walkSpeed*actor.speed*time)%237+237)%237-118.5;
  const drift=1.13*Math.sin(x*.065+actor.swirl)+.61*Math.sin(x*.122+actor.z*.21);
  const z=actor.z+drift,y=elevation(x,z);
  const yaw=-Math.atan(.07345*Math.cos(x*.065+actor.swirl)+.07442*Math.cos(x*.122+actor.z*.21));
  const c=Math.cos(yaw)*actor.size,s=Math.sin(yaw)*actor.size;
  const m=actor.matrix;
  m[0]=c;m[2]=-s;m[5]=actor.size;m[8]=s;m[10]=c;
  m[12]=x;m[13]=y;m[14]=z;m[15]=1;
  return m;
}

function contactShadows(engine){
  const p=[0,0,0],n=[0,1,0],c=[1,1,1,.57],indices=[];
  const sides=10;
  for(const scale of [.57,1]){
    for(let i=0;i<sides;i++){
      const a=i*TAU/sides;
      p.push(Math.cos(a)*scale,0,Math.sin(a)*scale);
      n.push(0,1,0);
      c.push(1,1,1,scale===1?0:.27);
    }
  }
  for(let i=0;i<sides;i++){
    const a=1+i,b=1+(i+1)%sides;
    indices.push(0,b,a,a,b,a+sides,b,b+sides,a+sides);
  }
  const material=new UnlitMaterial({color:'#272724',opacity:.72,transparent:true,depthWrite:false});
  const mesh=createInstancedMesh(engine,{positions:p,normals:n,colors:c,indices},material,total);
  return mesh.instances;
}

export async function show(engine,canvas,loading,signal,fail,followControl){
  engine.scene.background='#8d9ea1';
  engine.lighting.direction.set([-.42,.78,.33,0]);
  engine.lighting.radiance.set([1.97,1.60,1.24,1]);
  engine.lighting.ambient.set([.33,.40,.43]);
  makeLandscape(engine);
  performance.mark('herd-landscape');
  let shadows;
  const shadowRows=new Float32Array(total*16);
  const atlas=texture();
  signal.addEventListener('abort',()=>atlas.dispose(),{once:true});
  const nearBake=clipBake('near'),farBake=clipBake('far');
  const coat={map:atlas,roughness:.91};
  const near=SkinnedCrowd.attach(engine,nearBake,coat),far=SkinnedCrowd.attach(engine,farBake,coat);
  const agents=createHerd(),data=canvas.dataset;
  const view={eye:overview.eye.slice(),look:overview.look.slice(),fov:overview.fov};
  const nearActors=[],farActors=[];
  let count=total,adaptive=true,paused=false,following=false,mouseTarget=0,travel=0;
  let last=0, frame=0, lodTime=-2, lastStep=-1, firstAction=false, wanted=false, ready=false;
  const number=new Intl.NumberFormat('en-US');

  function size(){
    const ratio=Math.min(devicePixelRatio,1.55);
    const w=Math.max(320,Math.round(canvas.clientWidth*ratio)),h=Math.max(220,Math.round(canvas.clientHeight*ratio));
    if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;return true;}
    return false;
  }
  function setCamera(t){
    const hero=agents[0].matrix;
    const focal=[hero[12]+.7,hero[13]+1.61,hero[14]-.24];
    const close=[hero[12]+4.45,hero[13]+3.29,hero[14]+8.75];
    for(let i=0;i<3;i++){
      view.eye[i]=mix(overview.eye[i],close[i],t);
      view.look[i]=mix(overview.look[i],focal[i],t);
    }
    view.fov=mix(overview.fov,36,t);
    engine.camera.position=view.eye;
    engine.camera.target=view.look;
    engine.camera.fov=view.fov*Math.max(1,(1.58/(canvas.width/canvas.height))**.28);
    engine.camera.near=.42;
    engine.camera.far=665;
  }
  function add(crowd,actor){
    crowd.add({matrix:actor.matrix,speed:actor.speed,offset:actor.offset,
      uvTransform:{offset:[0,actor.palette/4],scale:[1,.25]}});
  }
  function partition(){
    nearActors.length=0;farActors.length=0;
    near.truncate(0);far.truncate(0);
    const x=view.eye[0],z=view.eye[2], distance=mix(82,24,mouseTarget);
    for(let i=0;i<count;i++){
      const a=agents[i],m=a.matrix;
      const nearMode=adaptive&&Math.hypot(m[12]-x,m[14]-z)<distance&&nearActors.length<158;
      if(nearMode){nearActors.push(a);add(near,a);}
      else{farActors.push(a);add(far,a);}
    }
    data.near=String(near.count);
    data.far=String(far.count);
    data.draws=String(Number(near.count>0)+Number(far.count>0));
    data.triangles=String((near.count*nearBake.indices.length+far.count*farBake.indices.length)/3);
    data.count=String(count);
    el('near').textContent=number.format(near.count);
    el('far').textContent=number.format(far.count);
    el('draws').textContent=data.draws;
    el('population').textContent=number.format(count);
  }
  function select(trusted){
    wanted ||= trusted;
    lodTime=-2;
    el('pause').textContent=paused?'Resume herd':'Pause herd';
    el('pause').setAttribute('aria-pressed',String(paused));
    el('lod').setAttribute('aria-pressed',String(adaptive));
    el('mode').textContent=adaptive?'Near animals use a finer mesh and more sampled poses.':'The whole herd uses one mesh, one palette and one draw.';
    el('shot').textContent=following?'River tracking shot':'Ridge overlook';
    el('follow').firstChild.textContent=following?'Return to overlook ':'Follow the herd ';
  }
  followControl((next,trusted)=>{following=next;select(trusted);});
  el('pause').addEventListener('click',ev=>{paused=!paused;select(ev.isTrusted);},{signal});
  el('lod').addEventListener('click',ev=>{adaptive=!adaptive;select(ev.isTrusted);},{signal});
  el('herd').addEventListener('input',ev=>{count=sizes[+ev.target.value];select(ev.isTrusted);},{signal});

  function updateShadows(){
    shadows.count=count;
    for(let i=0;i<count;i++){
      const a=agents[i],m=a.matrix,o=i*16;
      shadowRows[o]=m[0]*.91;
      shadowRows[o+2]=m[2]*.91;
      shadowRows[o+5]=1;
      shadowRows[o+8]=m[8]*.38;
      shadowRows[o+10]=m[10]*.38;
      shadowRows[o+12]=m[12]+.28;
      shadowRows[o+13]=Math.max(-.098,m[13]+.033);
      shadowRows[o+14]=m[14]-.16;
      shadowRows[o+15]=1;
    }
    shadows.setMatrices(0,shadowRows.subarray(0,count*16));
  }
  async function animate(stamp){
    if(signal.aborted)return;
    try{
      const dt=last?clamp((stamp-last)/1000,.001,.073):1/60;
      last=stamp;
      if(!paused)travel+=dt;
      const target=Number(following);
      mouseTarget=Math.abs(mouseTarget-target)<.001?target:mix(mouseTarget,target,Math.min(1,dt*5.6));
      const resized=size();
      if(lastStep!==travel||resized){
        for(let i=0;i<count;i++)worldMatrix(agents[i],travel);
        lastStep=travel;
      }
      if(lodTime<0)for(let i=0;i<count;i++)worldMatrix(agents[i],travel);
      setCamera(mouseTarget);
      if(lodTime<0||stamp-lodTime>1000){
        partition();
        lodTime=stamp;
      }else if(!paused){
        for(let i=0;i<farActors.length;i++)far.set(i,{matrix:farActors[i].matrix});
        for(let i=0;i<nearActors.length;i++)near.set(i,{matrix:nearActors[i].matrix});
      }
      if(shadows&&(!paused||lodTime===stamp))updateShadows();
      far.time=near.time=travel;
      engine.render({delta:0});
      if(!ready)performance.mark('herd-first-submitted');
      const didChange=wanted;
      wanted=false;
      if(!ready||(didChange&&!firstAction)){
        await engine.gpu.queue.onSubmittedWorkDone();
        await nextFrame();
        signal.throwIfAborted();
      }
      data.frame=String(++frame);
      data.time=travel.toFixed(4);
      data.blend=mouseTarget.toFixed(5);
      data.paused=String(paused);
      data.adaptive=String(adaptive);
      data.heroX=agents[0].matrix[12].toFixed(4);
      data.hoof=poseBone(nearBake,{offset:agents[0].offset},4,travel)[7].toFixed(5);
      data.camera=view.eye.map(v=>v.toFixed(4)).join(',');
      data.sceneDraws=String(engine.stats.drawCalls);
      if(!ready){
        ready=true;
        loading.hidden=true;
        for(const id of ['pause','lod','herd'])el(id).disabled=false;
        data.ready='true';
        performance.mark('margo-first-usable-frame');
      }
      if(didChange&&!firstAction){
        firstAction=true;
        performance.mark('margo-first-input-rendered');
      }
      if(ready&&frame>1&&!shadows){
        shadows=contactShadows(engine);
        updateShadows();
      }
      requestAnimationFrame(animate);
    }catch(error){fail(error);}
  }
  requestAnimationFrame(animate);
}
