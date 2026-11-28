import {FloatingOrigin} from '@margoengine/cameras/origin';
import {GlobeControls} from '@margoengine/controls/globe';
import {GeospatialControls} from '@margoengine/controls/geospatial';
import {connectSurface,readMap} from './surface.js';
import {radToDeg} from '@margoengine/math/geo';
import {anchors,detailMask,eyeAsView,frames,fromWorld,globeRadii,makeEarth,terrainHeight,views} from './geo.js';

const data={
  earth:new URL('./imagery/earth-detail.webp',import.meta.url),
  island:{
    metres:new URL('./imagery/hawaii-metres.bin',import.meta.url),
    surface:new URL('./imagery/hawaii-relief.webp',import.meta.url),
    contours:new URL('./imagery/hawaii-contours.webp',import.meta.url)
  },
  summit:{
    metres:new URL('./imagery/summit-metres.bin',import.meta.url),
    surface:new URL('./imagery/summit-relief.webp',import.meta.url),
    contours:new URL('./imagery/summit-contours.webp',import.meta.url)
  }
};
const element=id=>document.getElementById(id);
const format=(degrees,positive,negative)=>Math.abs(degrees).toFixed(3)+'° '+(degrees<0?negative:positive);
const firstInput='margo-first-input-rendered';
const stages={orbit:'ORBIT',island:'ISLAND SURVEY',summit:'SUMMIT APPROACH'};

async function readHeights(name,signal){
  const response=await fetch(data[name].metres,{signal});
  if(!response.ok)throw Error('Hawaiʻi elevation could not be opened.');
  const bytes=await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  signal.throwIfAborted();
  if(bytes.byteLength!==frames[name].samples**2*2)throw Error('The elevation grid has an unexpected size.');
  return new Int16Array(bytes);
}

export async function connect(engine,canvas,opening,signal,fail){
  const discovered=document.body.dataset;
  const button=element('fly'),contours=element('contours'),footnote=element('footnote'),target=element('reticle');
  const stationButtons=[...document.querySelectorAll('[data-stop]')];
  const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
  const heights={},meshes={},contourMaps={},memo={},pending=new Map();
  const worker=new Worker(new URL('./terrain-worker.js',import.meta.url),{type:'module'});
  let showContour=false,flight=0,previous=0,frame=0,detailTimer,detailRequested=false,resize;
  worker.addEventListener('message',({data:message})=>{
    const job=pending.get(message.name);
    if(!job)return;
    pending.delete(message.name);
    if(message.error)job.reject(Error(message.error));
    else job.resolve(message.geometry);
  },{signal});
  worker.addEventListener('error',event=>{
    for(const job of pending.values())job.reject(Error(event.message));
    pending.clear();
  },{signal});
  let markInput=false,counter=0,disposed=false,alreadyInteracted=false,tracking='orbit',mode='orbit';

  engine.scene.background='#020613';
  const origin=FloatingOrigin.attach(engine,{ratio:18});
  const surface=connectSurface(engine,origin);
  const earth=surface.mesh(makeEarth(),[0,0,0],opening,{globe:true});
  const getHeight=(lon,lat)=>terrainHeight(heights.summit,frames.summit,lon,lat)??terrainHeight(heights.island,frames.island,lon,lat);
  const geospatial=new GeospatialControls(engine.camera,canvas,{
    view:views.orbit,origin,scene:false,geoid:null,minRange:1450,maxRange:25e6,clearance:260,
    heightAt:getHeight,reducedMotion:reduce
  });
  const globe=new GlobeControls(engine.camera,canvas,{radii:globeRadii,origin,minAltitude:320000,maxAltitude:22e6});
  geospatial.enabled=false;
  function makeMesh(name,grid){
    return new Promise((resolve,reject)=>{
      signal.throwIfAborted();
      pending.set(name,{resolve,reject});
      worker.postMessage({name,heights:grid});
    });
  }
  function loadTerrain(name){
    memo[name]??=(async()=>{
      const tile=data[name];
      const [geometry,bitmap]=await Promise.all([
        readHeights(name,signal).then(grid=>{
          heights[name]=grid;
          return makeMesh(name,grid);
        }),
        readMap(tile.surface,signal)
      ]);
      if(signal.aborted){bitmap.close();signal.throwIfAborted();}
      const mesh=surface.mesh(geometry,anchors[name],bitmap);
      meshes[name]=mesh;
      if(showContour){
        contourMaps[name]??=readMap(tile.contours,signal).then(image=>{
          if(signal.aborted){image.close();signal.throwIfAborted();}
          mesh.supply('contours',image);
          mesh.show(showContour?'contours':'surface');
          schedule();
        });
        contourMaps[name].catch(error=>{if(!signal.aborted)fail(error);});
      }
      discovered[name==='island'?'terrainSamples':'summitSamples']=String(heights[name].length);
      schedule();
      return mesh;
    })();
    return memo[name];
  }
  const terrain=loadTerrain('island');
  terrain.catch(error=>{
    if(signal.aborted)return;
    footnote.textContent=error.message;
    for(const control of [button,...stationButtons.slice(1)])control.disabled=true;
  });
  function refreshOrbitalMap(){
    if(detailRequested||signal.aborted)return;
    detailRequested=true;
    void readMap(data.earth,signal).then(bitmap=>{
      if(signal.aborted){bitmap.close();return;}
      earth.supply('surface',bitmap);
      discovered.orbitImage='2304';
      schedule();
    }).catch(error=>{if(!signal.aborted)console.warn(error.message);});
  }
  const fence=()=>engine.gpu.queue.onSubmittedWorkDone();
  function fit(){
    const width=Math.round(canvas.clientWidth*Math.min(devicePixelRatio,2));
    const height=Math.round(canvas.clientHeight*Math.min(devicePixelRatio,2));
    if(canvas.width!==width)canvas.width=width;
    if(canvas.height!==height)canvas.height=height;
  }
  function currentEye(){return fromWorld(origin.toWorld(engine.camera.position));}
  function report(){
    const eye=currentEye(),v=geospatial.view;
    const km=Math.max(0,eye.height)/1000;
    element('altitude').value=(km>100?Math.round(km).toLocaleString('en-US'):km.toFixed(1))+' km';
    element('coordinates').textContent=format(radToDeg(eye.latitude),'N','S')+' · '+format(radToDeg(eye.longitude),'E','W');
    element('dataset').textContent=km>350?'NASA Blue Marble':'USGS 3DEP · Hawaiʻi';
    element('mode').textContent=flight?'IN FLIGHT':stages[mode];
    for(const control of stationButtons){
      if(control.dataset.stop===mode&&!flight)control.setAttribute('aria-current','true');
      else control.removeAttribute('aria-current');
    }
    const summit=views.summit;
    target.hidden=!(mode==='summit'&&!flight&&Math.abs(summit.latitude-v.latitude)<.000008&&Math.abs(summit.longitude-v.longitude)<.000008);
    contours.disabled=!meshes.island||km>350;
    discovered.state=mode;
    discovered.flight=flight?'running':'idle';
    discovered.geospatial=String(geospatial.enabled);
    discovered.altitude=eye.height.toFixed(2);
    discovered.latitude=radToDeg(eye.latitude).toFixed(6);
    discovered.longitude=radToDeg(eye.longitude).toFixed(6);
    discovered.range=(geospatial.enabled?v.range:globe.altitude).toFixed(2);
    discovered.rebases=String(origin.rebases);
    discovered.contours=String(showContour);
  }
  function render(delta){
    fit();
    if(geospatial.enabled)geospatial.update(delta);
    else globe.update();
    const altitude=currentEye().height;
    const haze=Math.min(1,Math.max(0,(altitude-350000)/650000));
    surface.atmosphere(haze);
    const inRange=altitude<630000;
    const useDetail=!!meshes.summit&&altitude<150000;
    meshes.island?.visible(inRange);
    meshes.island?.hole(useDetail?detailMask:null);
    meshes.summit?.visible(useDetail);
    engine.render({delta});
    report();
  }
  async function tick(now){
    frame=0;
    if(disposed||signal.aborted)return;
    const delta=previous?Math.min(.074,(now-previous)/1000):1/60;
    const shouldMark=markInput&&!performance.getEntriesByName(firstInput).length;
    markInput=false;
    try{
      render(delta);
      if(shouldMark){
        await fence();
        if(!signal.aborted&&!performance.getEntriesByName(firstInput).length)performance.mark(firstInput);
      }
      if(flight||canvas.matches(':active')){previous=now;schedule();}
      else previous=0;
    }catch(error){fail(error);}
  }
  function schedule(input=false){
    markInput||=input;
    if(!frame&&!disposed&&!signal.aborted)frame=requestAnimationFrame(tick);
  }
  function beginInput(event){
    if(!event.isTrusted)return false;
    if(!alreadyInteracted){alreadyInteracted=true;clearTimeout(detailTimer);}
    return true;
  }
  function updateControls(){
    const isOrbit=mode==='orbit'&&!flight;
    geospatial.enabled=!isOrbit;
    globe.enabled=isOrbit;
  }
  function fromGlobe(){
    if(!globe.enabled)return;
    const hit=globe.pick(canvas.clientWidth/2,canvas.clientHeight/2);
    if(hit)geospatial.setView(eyeAsView(origin.toWorld(hit),origin.toWorld(engine.camera.position)));
  }
  function flyTo(view,duration){
    return geospatial.flyTo(view,{duration:reduce?0:duration,arc:false,signal,easing:t=>t*t*(3-2*t)});
  }
  async function go(destination,trusted){
    const token=++counter;
    clearTimeout(detailTimer);
    fromGlobe();
    flight=token;
    updateControls();
    const isCurrent=()=>token===counter&&!signal.aborted;
    const finish=arrived=>{
      if(!isCurrent())return;
      flight=0;
      if(arrived){mode=destination;tracking=destination;}
      else {
        tracking='free';
        const distance=currentEye().height;
        mode=distance>350000?'orbit':distance>26000?'island':'summit';
      }
      updateControls();
      if(arrived&&mode==='orbit')refreshOrbitalMap();
      button.firstChild.textContent=mode==='summit'?'Replay descent ':'Fly to Mauna Kea ';
      footnote.textContent=arrived&&mode==='summit'?'Drag to orbit the summit. Scroll or pinch to change range.':'Drag to turn the map. Scroll or pinch to zoom.';
      schedule();
    };
    try{
      const detail=destination==='summit'?terrain.then(()=>loadTerrain('summit')):null;
      detail?.catch(()=>{});
      if(reduce&&destination!=='orbit'){
        await (detail??terrain);
        if(!isCurrent())return;
      }
      if(destination==='summit'&&tracking==='summit'){
        geospatial.setView(views.orbit);
        tracking='orbit';
      }
      if(destination==='summit'&&tracking==='orbit'){
        const route=flyTo(views.island,4.1);
        schedule(trusted);
        if(!await route){finish(false);return;}
        await detail;
        if(!isCurrent())return;
        const approach=flyTo({...views.summit,height:getHeight(views.summit.longitude,views.summit.latitude)},3);
        schedule();
        finish(await approach);
        return;
      }
      if(destination!=='orbit'){
        const intermediate=flyTo(views.island,destination==='island'?2.2:1.2);
        schedule(trusted);
        if(!await intermediate){finish(false);return;}
        await (detail??terrain);
      }
      if(!isCurrent())return;
      if(destination==='island'){finish(true);return;}
      const station=views[destination];
      const landed=flyTo(destination==='summit'?{...station,height:getHeight(station.longitude,station.latitude)}:station,2.3);
      schedule(trusted&&destination==='orbit');
      finish(await landed);
    }catch(error){
      finish(false);
      if(!signal.aborted)fail(error);
    }
  }
  button.addEventListener('click',event=>void go('summit',beginInput(event)),{signal});
  for(const control of stationButtons)control.addEventListener('click',event=>void go(control.dataset.stop,beginInput(event)),{signal});
  contours.addEventListener('change',async event=>{
    const trusted=beginInput(event);
    try{
      const entries=Object.entries(meshes);
      if(contours.checked)await Promise.all(entries.map(([name,mesh])=>{
        contourMaps[name]??=readMap(data[name].contours,signal).then(bitmap=>{
          if(signal.aborted){bitmap.close();signal.throwIfAborted();}
          mesh.supply('contours',bitmap);
        });
        return contourMaps[name];
      }));
      if(signal.aborted)return;
      showContour=contours.checked;
      for(const [,mesh] of entries)mesh.show(showContour?'contours':'surface');
      schedule(trusted);
    }catch(error){if(!signal.aborted)fail(error);}
  },{signal});
  for(const control of [globe,geospatial]){
    control.addEventListener('change',()=>schedule());
  }
  for(const event of ['pointermove','wheel']){
    canvas.addEventListener(event,e=>{
      if(e.type==='wheel'||e.buttons)if(beginInput(e))schedule(true);
    },{signal,passive:true});
  }
  canvas.addEventListener('keydown',event=>{
    const key=event.key;
    if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home'].includes(key))return;
    event.preventDefault();
    const trusted=beginInput(event);
    if(key==='Home'){void go('orbit',trusted);return;}
    if(globe.enabled){
      const x=canvas.clientWidth/2,y=canvas.clientHeight/2,point=globe.pick(x,y);
      if(point)globe.grab(point,x+({ArrowLeft:23,ArrowRight:-23}[key]??0),y+({ArrowUp:23,ArrowDown:-23}[key]??0));
    }else{
      geospatial.cancel();
      const v=geospatial.view;
      geospatial.setView({heading:v.heading+({ArrowLeft:-.11,ArrowRight:.11}[key]??0),pitch:v.pitch+({ArrowUp:.068,ArrowDown:-.068}[key]??0)});
    }
    schedule(trusted);
  },{signal});
  resize=new ResizeObserver(()=>schedule());
  resize.observe(canvas);
  render(0);
  await fence();
  signal.throwIfAborted();
  discovered.renderer=engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu';
  discovered.ready='true';
  performance.mark('margo-first-usable-frame');
  element('loading').hidden=true;
  element('controls').disabled=false;
  discovered.orbitImage='768';
  detailTimer=setTimeout(refreshOrbitalMap,2200);
  return {dispose(){
    disposed=true;
    clearTimeout(detailTimer);
    cancelAnimationFrame(frame);
    resize.disconnect();
    worker.terminate();
    for(const job of pending.values())job.reject(signal.reason);
    pending.clear();
    globe.dispose();
    geospatial.dispose();
  }};
}
