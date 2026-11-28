import {buildGallery} from './gallery.js';

const nextFrame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
const start=16;
export async function show({engine,clustered,canvas,notice,status,signal,size,fail}){
  const query=id=>document.querySelector('#'+id);
  const wallInput=query('wall'),compare=query('occluder'),data=canvas.dataset;
  const compatibility=engine.gpu.adapterInfo?.vendor==='margo-webgl2';
  const {statue,total}=clustered;
  if(compatibility)statue.culling='frustum';
  engine.use(statue);
  const hall=buildGallery(engine);
  let useWall=!compatibility;
  if(useWall)statue.addOccluder(hall.moving);
  let shadows,shadowLoad;

  engine.scene.background='#677583';
  engine.lighting.direction.set([-3.8,7.6,4.8,3.2]);
  engine.lighting.radiance.set([1.0,.92,.82,.54]);
  engine.lighting.ambient.set([.88,.93,1.0]);
  query('route').textContent=compatibility?'Margo WebGL2':'Margo WebGPU';
  query('method').textContent=compatibility?'Frustum + normal cones':'Frustum + normal cones + Hi-Z';
  if(compatibility)query('support').textContent='WebGL2 reports frustum and normal-cone culling.';
  const format=new Intl.NumberFormat('en-US');
  data.renderer=compatibility?'compatibility':'webgpu';
  data.total=String(total);
  data.clusters=String(statue.meshlets.count);
  query('total').textContent=format.format(total);
  query('meshlets').textContent=format.format(statue.meshlets.count);

  function setFrame(position,use){
    const x=-4.37+.0585*position;
    hall.wall.setPosition([x,0,hall.railZ]);
    if(useWall!==use){
      if(use)statue.addOccluder(hall.moving);
      else statue.removeOccluder(hall.moving);
      useWall=use;
    }
    const aspect=canvas.width/canvas.height;
    engine.camera.fov=2*Math.atan(Math.tan(Math.PI*.1)*Math.max(1,1.19/aspect))*180/Math.PI;
  }
  function record(position,use,count){
    if(!(count>0&&count<=total))throw new Error('Margo meshlet triangle readback did not match the sculpture.');
    data.position=String(position);
    data.drawn=String(count);
    data.occluder=String(use);
    query('drawn').textContent=format.format(count);
    query('wall-value').value=position+'%';
  }
  setFrame(start,useWall);
  engine.render(0);
  const firstCount=await statue.readTriangles();
  signal.throwIfAborted();
  record(start,useWall,firstCount);
  status.ready(engine);
  notice.hidden=true;
  wallInput.disabled=false;
  compare.checked=useWall;
  compare.disabled=compatibility;
  data.ready='true';
  performance.mark('statue-ready');

  let queued=null,running=false,first=true;
  function finishLighting(){
    if(shadowLoad||signal.aborted)return;
    shadowLoad=import('@margoengine/shadows').then(({Shadows})=>{
      if(signal.aborted)return;
      shadows=Shadows.attach(engine,{filter:'pcf',resolution:1024,cascades:1,distance:19,jitter:false,depthBias:3});
      for(const caster of hall.shadows)shadows.add(caster,{static:true});
      shadows.add(hall.wall);
      shadows.add(statue,{static:true});
      request();
    }).catch(fail);
  }
  async function draw(){
    if(running)return;
    running=true;
    try{
      while(queued&&!signal.aborted){
        const {position,use,trusted}=queued;
        queued=null;
        const shaded=Boolean(shadows);
        setFrame(position,use);
        engine.render(0);
        const count=await statue.readTriangles();
        await engine.gpu.queue.onSubmittedWorkDone();
        await nextFrame();
        if(signal.aborted)return;
        record(position,use,count);
        if(shaded)data.shadows='live';
        if(trusted){
          performance.mark('statue-input-rendered');
          if(first){
            first=false;
            performance.mark('statue-first-input');
            clearTimeout(lightingTimer);
            finishLighting();
          }
        }
      }
    }catch(reason){if(!signal.aborted)fail(reason);}
    finally{running=false;}
  }
  function request(event){
    queued={position:Number(wallInput.value),use:!compatibility&&compare.checked,trusted:event?.isTrusted??false};
    draw();
  }
  const lightingTimer=setTimeout(finishLighting,920);
  signal.addEventListener('abort',()=>clearTimeout(lightingTimer),{once:true});
  wallInput.addEventListener('input',request,{signal});
  compare.addEventListener('change',request,{signal});
  const observer=new ResizeObserver(()=>{if(!signal.aborted&&size())request();});
  observer.observe(canvas);
  signal.addEventListener('abort',()=>observer.disconnect(),{once:true});
}
