import React,{StrictMode,Suspense,createRef,useEffect} from 'react';
import {createRoot,type Root} from 'react-dom/client';
// Application components all come from the public root. Native types below
// support inspection only; the test never imperatively installs a scene feature.
import {Canvas,Gltf,Animation,Box,PbrMaterial,MeshTransmissionMaterial,useMargo,type MeshRef,type MargoContextValue} from '@margoengine/react';
import type {Engine,Mesh as RuntimeMesh,EnginePlugin} from '@margoengine/core/extension';
import type {PBRModel} from '@margoengine/gltf-pro';
import type {Animation as ClipAnimation} from '@margoengine/animation';
import type {Animator} from '@margoengine/animator';

type Mode='lit'|'pbr'|'transmission-zero'|'transmission-on'|'skinned';
interface Resource {resource:GPUBuffer|GPUTexture;destroyed:boolean}
interface Record {engine:Engine;plugins:EnginePlugin[];resources:Resource[]}
const host=document.querySelector('#app')!,front=createRef<MeshRef>(),records:Record[]=[],errors:string[]=[],gpuErrors:string[]=[],pending:Promise<unknown>[]=[];
let root:Root|undefined,current:Record|undefined,context:MargoContextValue|undefined,mode:Mode='lit',features=true,clip='Walk',playing=true;
let assetSrc='',holdAsset=false,releaseAsset:(()=>void)|undefined,assetRequests=0,assetAborts=0,fallbackMounts=0,modelRoot:MeshRef|undefined,clicks=0,lastObject=-1,lastNativeHit=-1,pendingPicks=0,renders=0;
const report=(error:unknown)=>errors.push(String(error));
const originalFetch=window.fetch.bind(window);
window.fetch=async(input,init)=>{
  const src=typeof input==='string'?input:input instanceof URL?input.href:input.url;
  if(src===assetSrc){
    assetRequests++;
    if(holdAsset)await new Promise<void>((resolve,reject)=>{
      const signal=init?.signal??(input instanceof Request?input.signal:null);
      const abort=()=>{assetAborts++;releaseAsset=undefined;reject(new DOMException('Aborted test asset','AbortError'));};
      if(signal?.aborted){abort();return;}
      signal?.addEventListener('abort',abort,{once:true});
      releaseAsset=()=>{holdAsset=false;signal?.removeEventListener('abort',abort);releaseAsset=undefined;resolve();};
    });
  }
  return originalFetch(input,init);
};
function created(engine:Engine){
  const record:Record={engine,plugins:[],resources:[]};records.push(record);current=record;
  const device=engine.gpu!;
  device.addEventListener('uncapturederror',(event:GPUUncapturedErrorEvent)=>gpuErrors.push(event.error.message));
  const own=<T extends GPUBuffer|GPUTexture>(resource:T):T=>{
    const entry:Resource={resource,destroyed:false},destroy=resource.destroy.bind(resource);record.resources.push(entry);
    resource.destroy=()=>{entry.destroyed=true;destroy();};return resource;
  };
  const buffer=device.createBuffer.bind(device),texture=device.createTexture.bind(device),shader=device.createShaderModule.bind(device);
  device.createBuffer=descriptor=>own(buffer(descriptor));device.createTexture=descriptor=>own(texture(descriptor));
  device.createShaderModule=descriptor=>{const module=shader(descriptor);pending.push(module.getCompilationInfo().then(info=>{for(const message of info.messages)if(message.type==='error')gpuErrors.push(message.message);}));return module;};
  const use=engine.use.bind(engine);engine.use=plugin=>{const result=use(plugin);record.plugins.push(plugin);return result;};
  const render=engine.render.bind(engine);engine.render=options=>{device.pushErrorScope('validation');try{renders++;render(options);}finally{pending.push(device.popErrorScope().then(error=>{if(error)gpuErrors.push(error.message);}));}};
  const pick=engine.pick.bind(engine);engine.pick=async(x,y)=>{pendingPicks++;device.pushErrorScope('validation');try{const hit=await pick(x,y);lastNativeHit=hit?.id??-1;return hit;}finally{pendingPicks--;pending.push(device.popErrorScope().then(error=>{if(error)gpuErrors.push(error.message);}));}};
  engine.lighting.direction.set([0,0,1,3]);engine.lighting.radiance.set([1,1,1,.15]);
}
function Probe(){const value=useMargo();useEffect(()=>{context=value;return()=>{if(context===value)context=undefined;};},[value]);return null;}
function Loading(){useEffect(()=>{fallbackMounts++;},[]);return <span data-loading="skin">Loading skinned asset</span>;}
function MaterialScene(){return <>
  <Box position={[-.9,0,-1.6]} args={[1.7,2.5,.35]} color="#278ed1" roughness={.6}/>
  <Box position={[.9,0,-1.6]} args={[1.7,2.5,.35]} color="#51c675" roughness={.6}/>
  <Box ref={front} args={[1.7,1.7,.65]} color="#ed623e" roughness={.35} metalness={0}>
    {mode==='pbr'?<PbrMaterial color="#ed623e" roughness={.35} metalness={0}/>:mode==='transmission-zero'||mode==='transmission-on'?<MeshTransmissionMaterial color="#ed623e" roughness={.35} metalness={0} factor={mode==='transmission-zero'?0:.85} ior={1.45} onError={report}/>:null}
  </Box>
</>;}
function SkinnedScene(){return <Suspense fallback={<Loading/>}><Gltf src={assetSrc} onLoad={mesh=>{modelRoot=mesh;}} onError={report} onClick={event=>{clicks++;lastObject=(event.object as RuntimeMesh).id;}}><Animation clip={clip} playing={playing} loop={false} blend={.5} onError={report}/></Gltf></Suspense>;}
function Scene(){return <StrictMode><Canvas backend="webgpu" frameloop="demand" style={{width:640,height:480}} camera={{position:[mode==='skinned'?1:0,0,6],target:[mode==='skinned'?1:0,0,0],fov:45,near:.1,far:30}} onCreated={stage=>created(stage.engine as unknown as Engine)} onError={report}><Probe/>{features?(mode==='skinned'?<SkinnedScene/>:<MaterialScene/>):<Box color="#628db7" args={[.25,.25,.25]}/>}</Canvas></StrictMode>;}
function active(prefix:string){return current?.plugins.filter(plugin=>plugin.name.startsWith(prefix)&&current!.engine.hasPlugin(plugin.name))??[];}
function model(){return active('gltf-pro:').find(plugin=>(plugin as PBRModel).root===modelRoot) as PBRModel|undefined;}
function animation(){return active('animation:')[0] as ClipAnimation|undefined;}
function animator(){return active('animator:')[0] as Animator|undefined;}
function assertClean(){if(errors.length||gpuErrors.length)throw new Error([...errors,...gpuErrors].join('\n'));}
async function settle(){await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));await Promise.all(pending.splice(0));assertClean();}
async function until(test:()=>boolean,label:string){const end=performance.now()+45_000;while(!test()){assertClean();if(performance.now()>end)throw new Error('Timed out: '+label);await settle();}}
async function draw(delta=0){const engine=current!.engine;engine.render({delta,culling:false});await engine.gpu!.queue.onSubmittedWorkDone();await settle();return snapshot();}
function snapshot(){const instance=model(),mixer=animator();return {mode,backend:current?.engine.backend,renders,clicks,lastObject,lastNativeHit,assetRequests,assetAborts,fallbackMounts,pendingPicks,models:active('gltf-pro:').length,animations:active('animation:').length,animators:active('animator:').length,clip:mixer?.state,jointX:instance?.nodes[1].position.x,primitiveId:instance?.primitives[0].node.id,opaqueCapture:current?.engine.hasPlugin('materials:opaque-color')??false,picking:current?.engine.hasPlugin('picking')??false,materialInstallations:active('materials:').filter(plugin=>plugin.name!=='materials:opaque-color').length,stats:{...current?.engine.stats},errors:[...errors],gpuErrors:[...gpuErrors]};}
function ready(){return !!current&&!!context?.ready&&(mode==='skinned'?!!model()&&active('animation:').length===1&&active('animator:').length===1:mode==='transmission-on'?current.engine.hasPlugin('materials:opaque-color')&&active('materials:').length>1:!!front.current?.geometry);}
async function unmount(){root?.unmount();root=undefined;await settle();await settle();for(const record of records){if(!record.engine.disposed||record.engine.meshes.size)throw new Error('Unmount leaked a Canvas engine/mesh');if(record.resources.some(entry=>!entry.destroyed))throw new Error('Unmount leaked '+record.resources.filter(entry=>!entry.destroyed).length+' owned GPU resources');}return {engines:records.length,resources:records.reduce((sum,record)=>sum+record.resources.length,0),assetAborts};}
async function mount(next:Mode,src=assetSrc,defer=false){if(root)await unmount();mode=next;assetSrc=src;holdAsset=defer;features=true;clip='Walk';playing=true;current=undefined;context=undefined;modelRoot=undefined;assetRequests=assetAborts=fallbackMounts=clicks=renders=0;lastObject=lastNativeHit=-1;root=createRoot(host);root.render(<Scene/>);if(defer){await until(()=>!!document.querySelector('[data-loading="skin"]'),'Suspense fallback');await settle();}else{await until(ready,'scene ready');await settle();}return snapshot();}
async function release(){releaseAsset?.();await until(ready,'loaded animation scene');await settle();return snapshot();}
async function material(next:Mode){if(next==='skinned')throw new Error('Use mount for the skinned fixture');mode=next;root!.render(<Scene/>);await until(ready,'material update');await settle();await draw();return snapshot();}
async function playback(next:string,play=true){clip=next;playing=play;root!.render(<Scene/>);await settle();await until(()=>animator()?.state===next,'clip transition');return snapshot();}
async function positions(){const instance=model();if(!instance)throw new Error('No loaded model');const geometry=await instance.readPickingGeometry();return Array.from({length:geometry[0].vertices.length/20},(_,index)=>[...geometry[0].vertices.subarray(index*20,index*20+3)]);}
function point(x=1,y=-.2,z=0){const engine=current!.engine;engine.camera.update(engine.canvas.width/engine.canvas.height,true);const m=engine.camera.matrix,w=m[3]*x+m[7]*y+m[11]*z+m[15],bounds=engine.canvas.getBoundingClientRect();return {x:bounds.left+(m[0]*x+m[4]*y+m[8]*z+m[12])/w*bounds.width/2+bounds.width/2,y:bounds.top-(m[1]*x+m[5]*y+m[9]*z+m[13])/w*bounds.height/2+bounds.height/2};}
async function remove(){features=false;root!.render(<Scene/>);await settle();await settle();if(active('animation:').length||active('animator:').length||active('gltf-pro:').length||active('materials:').length)throw new Error('Removing scene features leaked an optional plugin');await draw();return snapshot();}
(window as any).afterScene={mount,release,material,playback,draw,positions,point,snapshot,remove,unmount,async drain(){await settle();await until(()=>pendingPicks===0,'pending pointer pick');await settle();return snapshot();},get errors(){return errors;},get gpuErrors(){return gpuErrors;}};
