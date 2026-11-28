import {ContactShadows} from '@margoengine/studio';
import {cameraFor,plantArt} from './art.js';
import {generate,maxGeneration,specimens} from './grammar.js';

const by=id=>document.getElementById(id);
const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
const samePoint=(a,b)=>a.every((v,i)=>v===b[i]);
const sameOrgan=(a,b)=>a.index===b.index&&a.symbol===b.symbol&&samePoint(a.at,b.at)&&
  samePoint(a.direction,b.direction)&&samePoint(a.up,b.up);

export function mount({opening,canvas,viewport,loading,status,controls,signal,fail,size,first,room,initial}){
  const preset=by('preset'),axiom=by('axiom'),rules=by('rules'),angle=by('angle'),generation=by('generation'),grow=by('grow');
  const title=by('specimen-name'),inputStatus=by('rule-status'),angleValue=by('angle-value'),genValue=by('generation-value');
  const stems=by('stem-count'),organs=by('organ-count'),symbols=by('symbol-count');
  let engine,observer,plant,live=first,pieces=[],pending,raf=0,timer=0,tracking,working=false,layoutDirty=false;
  let ready=false,version=0,orbit=0,firstChange=false;
  function camera(){
    const pose=cameraFor(canvas.width,canvas.height,plant?.bounds,orbit);
    engine.camera.position=pose.position;
    engine.camera.target=pose.target;
    engine.camera.fov=pose.fov;
  }
  function add(piece){
    const mesh=engine.createMesh().setGeometry(piece.geometry).setMaterial(piece.material);
    if(piece.position)mesh.setPosition(piece.position);
    mesh.name='SM_Glasshouse_'+piece.name;
    return mesh;
  }
  function replace(next,spec){
    const prior=plant?.organs??[];
    const extendsPrevious=spec.kind===live.kind&&prior.length>0&&next.organs.length>prior.length&&
      prior.every((organ,i)=>sameOrgan(organ,next.organs[i]));
    const addition=extendsPrevious?{...next,organs:next.organs.slice(prior.length)}:next;
    const grown=plantArt(addition,spec.kind).map(piece=>({mesh:add(piece),role:piece.role}));
    const keep=[];
    for(const item of pieces){
      if(extendsPrevious&&item.role!=='stem')keep.push(item);
      else item.mesh.dispose();
    }
    pieces=[...keep,...grown];
    plant=next;
    live=spec;
    version++;
  }
  function published(){
    title.textContent=live.name;
    genValue.value=String(live.generation);
    stems.value=String(plant.stems);
    organs.value=plant.leaves+' leaves · '+plant.blooms+' blooms';
    symbols.value=String(plant.symbols);
    grow.disabled=Number(generation.value)>=maxGeneration;
    Object.assign(viewport.dataset,{version:String(version),generation:String(live.generation),stems:String(plant.stems),
      leaves:String(plant.leaves),blooms:String(plant.blooms),modules:String(plant.symbols),angle:String(live.angle),
      preset:preset.value,orbit:orbit.toFixed(3)});
  }
  function captureSpec(){
    return {...specimens[preset.value],axiom:axiom.value,rules:rules.value,angle:Number(angle.value),generation:Number(generation.value)};
  }
  function markError(reason){
    inputStatus.textContent=reason.message;
    inputStatus.dataset.invalid='true';
    viewport.dataset.grammar='invalid';
  }
  function markValid(){
    inputStatus.textContent='';
    inputStatus.dataset.invalid='false';
    viewport.dataset.grammar='valid';
  }
  function request(action,wait=0){
    if(!ready||signal.aborted)return;
    clearTimeout(timer);
    const next={spec:captureSpec(),action};
    if(wait){
      timer=setTimeout(()=>{pending=next;schedule();},wait);
    }else{
      pending=next;
      schedule();
    }
  }
  function schedule(){
    if(working||raf||signal.aborted||!engine)return;
    raf=requestAnimationFrame(draw);
  }
  async function draw(){
    raf=0;
    if(signal.aborted||status.failed)return;
    working=true;
    try{
      const request=pending;
      pending=undefined;
      let next;
      if(request){
        try{next=generate(request.spec);}
        catch(reason){markError(reason);}
        if(next){replace(next,request.spec);markValid();}
      }
      if(next||layoutDirty){
        layoutDirty=false;
        camera();
        engine.render({delta:0});
        await engine.gpu.queue.onSubmittedWorkDone();
        await frame();
        signal.throwIfAborted();
        published();
        if(next){
          performance.mark('plant-geometry-frame');
          if(request.action==='growth'&&!firstChange){
            firstChange=true;
            performance.mark('first-control-frame');
          }
        }
      }
    }catch(reason){fail(reason);}
    finally{
      working=false;
      if(pending||layoutDirty)schedule();
    }
  }
  function choose(name){
    const spec=specimens[name];
    preset.value=name;
    axiom.value=spec.axiom;
    rules.value=spec.rules;
    angle.value=String(spec.angle);
    generation.value='4';
    angleValue.value=spec.angle+'°';
    grow.disabled=false;
  }

  async function run(){
    choose('lantern');
    engine=await opening;
    signal.throwIfAborted();
    engine.scene.background='#554754';
    engine.lighting.direction.set([-.49,.68,.67,3.7]);
    engine.lighting.radiance.set([1,.909,.752,.58]);
    engine.lighting.ambient.set([.84,.96,1.08]);
    const bed=[];
    for(const piece of room){
      const mesh=add(piece);
      if(['plinth','edge','glaze','glazeA','glazeB','bare'].includes(piece.name))bed.push(mesh);
    }
    const shadows=ContactShadows.attach(engine,{
      position:[0,.004,0],size:[1.34,1.25],height:.36,opacity:.78,blur:.022,resolution:256,static:true,
      color:[.014,.009,.012],toneMapped:true,
    });
    for(const mesh of bed)shadows.add(mesh);
    replace(initial,first);
    camera();
    engine.render({delta:0});
    await engine.gpu.queue.onSubmittedWorkDone();
    await frame();
    signal.throwIfAborted();
    performance.mark('glasshouse-frame');
    published();markValid();
    grow.addEventListener('click',()=>{
      generation.value=String(clamp(Number(generation.value)+1,0,maxGeneration));
      performance.mark('grow-input');
      request('growth');
    },{signal});
    generation.addEventListener('input',()=>request('growth'),{signal});
    angle.addEventListener('input',()=>{
      angleValue.value=angle.value+'°';
      request('angle');
    },{signal});
    axiom.addEventListener('input',()=>request('rule',110),{signal});
    rules.addEventListener('input',()=>request('rule',110),{signal});
    preset.addEventListener('change',()=>{
      choose(preset.value);
      request('preset');
    },{signal});
    by('reset').addEventListener('click',()=>{
      orbit=0;
      choose(preset.value);
      request('reset');
    },{signal});
    canvas.addEventListener('pointerdown',event=>{
      if(event.button!==0)return;
      tracking={id:event.pointerId,x:event.clientX};
      canvas.setPointerCapture(event.pointerId);
    },{signal});
    canvas.addEventListener('pointermove',event=>{
      if(tracking?.id!==event.pointerId)return;
      orbit+=clamp((event.clientX-tracking.x)*.008,-.40,.40);
      tracking.x=event.clientX;
      layoutDirty=true;schedule();
    },{signal});
    for(const event of ['pointerup','pointercancel','lostpointercapture']){
      canvas.addEventListener(event,()=>{tracking=undefined;},{signal});
    }
    observer=new ResizeObserver(()=>{
      if(size()){layoutDirty=true;schedule();}
    });
    observer.observe(canvas);
    if(status.ready()){
      ready=true;
      for(const control of controls)by(control).disabled=false;
      loading.hidden=true;
    }
  }
  run().catch(fail);
  return ()=>{
    observer?.disconnect();
    clearTimeout(timer);
    if(raf)cancelAnimationFrame(raf);
  };
}
