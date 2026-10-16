import React,{StrictMode,Suspense,useEffect,createRef} from 'react';
import {createRoot,type Root} from 'react-dom/client';
// Let Vite prepare the test's optional dependencies before any scene mounts.
// Discovering these after a lazy component loads would reload the running page.
import 'react-dom';
import '@dimforge/rapier3d-compat';
import {Engine,engineRuntime,type Mesh as RuntimeMesh} from '@margoengine/core/extension';
import {Canvas,Stage,Mesh,PbrMaterial,useFrame,useMargo,type MeshRef,type MargoContextValue} from '@margoengine/react';
import {Box,Sphere,Plane,Html,Text,Sky,Environment,ContactShadows,Center,TransformControls,PointerLock,Gltf,Fbx} from '@margoengine/react/kit';
import {Physics,RigidBody,CuboidCollider,BallCollider,type PhysicsBody} from '@margoengine/react/physics';
import {EffectComposer,Bloom,SSAO,DepthOfField,Tonemap,TAA} from '@margoengine/react/post';
import {XR,Controller,useXR,type XRContextValue} from '@margoengine/react/xr';
import {simulatedXR} from './scene-xr-fixture.js';

type Mode='kit'|'environment'|'physics'|'bloom'|'ssao'|'dof'|'xr'|'xr-simulated';
const app=document.querySelector('#app')!,errors:string[]=[],gpuErrors:string[]=[],pending:Promise<void>[]=[],engines:Engine[]=[];
const box=createRef<MeshRef>(),sphere=createRef<MeshRef>(),plane=createRef<MeshRef>(),ground=createRef<MeshRef>(),text=createRef<any>(),sky=createRef<any>(),gizmo=createRef<any>(),pointer=createRef<any>();
let root:Root|undefined,current:Engine|undefined,context:MargoContextValue|undefined,mode:Mode='kit',frames=0,renders=0,clicks=0,gltf:MeshRef|undefined,fbx:MeshRef|undefined,body:PhysicsBody|undefined,world:any,postReady=0,xrReady=false,xrError:string|undefined;
let xrContext:XRContextValue|undefined,xrFixture:ReturnType<typeof simulatedXR>|undefined,controllerFrames=0;
let fbxAutoBody:PhysicsBody|undefined,fbxExplicitBody:PhysicsBody|undefined,ballBody:PhysicsBody|undefined,autoFbxRoot:MeshRef|undefined,explicitFbxRoot:MeshRef|undefined;
const report=(error:unknown)=>errors.push(String(error));
const originalCreate=Engine.create;
Engine.create=async function(...args:Parameters<typeof Engine.create>){
  const engine=await originalCreate.apply(this,args),device=engine.gpu!;engines.push(engine);
  device.addEventListener('uncapturederror',(event:GPUUncapturedErrorEvent)=>gpuErrors.push(event.error.message));
  const bind=device.createBindGroup.bind(device);device.createBindGroup=descriptor=>{device.pushErrorScope('validation');const stack=new Error('Bind group creation').stack;try{return bind(descriptor);}finally{pending.push(device.popErrorScope().then(error=>{if(error)gpuErrors.push(error.message+'\n'+stack);}));}};
  const render=engine.render.bind(engine);engine.render=(options={})=>{
    device.pushErrorScope('validation');try{renders++;render(options);}finally{pending.push(device.popErrorScope().then(error=>{if(error)gpuErrors.push(error.message);}));}
  };
  return engine;
};
function Probe(){const value=useMargo();useEffect(()=>{context=value;return()=>{if(context===value)context=undefined;};},[value]);useFrame(()=>frames++);return null;}
const fixture='/packages/exporters/tests/fixtures/Box.glb',fbxFixture='/packages/fbx/test/fixtures/blender-rig.fbx';
function Models(){return <Suspense fallback={<span data-loading="models">Loading native assets</span>}><Gltf src={fixture} position={[1.5,0.65,0]} scale={[0.65,0.65,0.65]} onLoad={mesh=>{gltf=mesh;}}/><Fbx src={fbxFixture} position={[-2,0,-1]} scale={[0.45,0.45,0.45]} onLoad={mesh=>{fbx=mesh;}}/></Suspense>;}
function Kit(){return <>
  <Sky ref={sky} model="preetham" hours={10} timeScale={0}/>
  <Box ref={box} position={[-0.9,0.7,0]} args={[1,1,1]} castShadow onClick={()=>clicks++}><PbrMaterial color="#eb7c46"/></Box>
  <Sphere ref={sphere} position={[0.7,0.6,0.25]} args={[0.5,20,12]} castShadow><PbrMaterial color="#84d6bd"/></Sphere>
  <Plane ref={plane} args={[1.5,1.5]} position={[2.5,0.02,-1]} rotation={[-Math.PI/2,0,0]}><PbrMaterial color="#4b6287"/></Plane>
  <ContactShadows ref={ground} width={12} height={12} opacity={0.9} position={[0,-0.015,0]}/>
  <Center position={[0,1.9,-1]}><Box args={[0.25,0.25,0.25]} position={[2,0,0]}><PbrMaterial color="#f1cc44"/></Box></Center>
  <TransformControls ref={gizmo} position={[0,0.4,-2]} size={0.6}><Box args={[0.35,0.35,0.35]}/></TransformControls>
  <PointerLock ref={pointer} lockOnClick={false}/>
  <Text ref={text} text="Margo React" position={[-1.5,2.2,0]} fontSize={0.25} color="#ffffff"/>
  <Html position={[0,2.55,0]} occlude={false}><span data-overlay="ready" style={{background:'#182831',padding:'4px 8px'}}>React DOM overlay</span></Html>
  <Models/>
</>;}
function Post({kind}:{kind:Mode}){return <><Box ref={box} position={[-0.65,0.6,0]}><PbrMaterial color="#ef744c"/></Box><Sphere ref={sphere} position={[0.7,0.6,0]} args={[0.5,20,12]}/><Plane ref={plane} args={[7,7]} rotation={[-Math.PI/2,0,0]}/><Suspense fallback={<span data-loading="model"/>}><Gltf src={fixture} position={[0,0.6,-1.8]} onLoad={mesh=>{gltf=mesh;}}/></Suspense><EffectComposer onError={report}>
  {kind==='bloom'?<Bloom strength={0.8} threshold={0.6} onReady={()=>postReady++}/>:kind==='ssao'?<><SSAO samples={8} onReady={()=>postReady++}/><TAA onReady={()=>postReady++}/></>:<><DepthOfField focalDistance={8} maxRadius={4} onReady={()=>postReady++}/><Tonemap curve="agx" onReady={()=>postReady++}/><TAA onReady={()=>postReady++}/></>}
</EffectComposer></>;}
function PhysicsScene(){return <Physics onReady={value=>{world=value;}}>
  <RigidBody position={[0,3,0]} onReady={value=>{body=value;}}><Box ref={box}><PbrMaterial color="#84d6bd"/></Box></RigidBody>
  <RigidBody type="fixed" position={[0,-0.5,0]} colliders={{shape:'box',halfExtents:[5,0.5,5]}}><Box args={[10,1,10]}/></RigidBody>
  <RigidBody type="fixed" colliders="cuboid" position={[-2,0,0]} onReady={value=>{fbxAutoBody=value;}}><Suspense fallback={<span data-loading="fbx-auto"/>}><Fbx src={fbxFixture} scale={[0.45,0.45,0.45]} onLoad={mesh=>{autoFbxRoot=mesh;}}/></Suspense></RigidBody>
  <RigidBody type="fixed" colliders={false} position={[2,0,0]} onReady={value=>{fbxExplicitBody=value;}}><CuboidCollider args={[0.5,0.75,0.25]}/><Suspense fallback={<span data-loading="fbx-explicit"/>}><Fbx src={fbxFixture} scale={[0.45,0.45,0.45]} onLoad={mesh=>{explicitFbxRoot=mesh;}}/></Suspense></RigidBody>
  <RigidBody type="fixed" colliders={false} position={[3.5,0.5,0]} onReady={value=>{ballBody=value;}}><BallCollider args={[0.4]}/><Sphere args={[0.4,16,10]}/></RigidBody>
</Physics>;}
function EnvironmentScene(){return <><Box ref={box} position={[-1,0.6,0]}/><Suspense fallback={<span data-loading="environment"/>}><Environment src="/packages/environment/tests/fixtures/spot1Lux.hdr"/><Gltf src={fixture} position={[1,0.6,0]} onLoad={mesh=>{gltf=mesh;}}/></Suspense></>;}
function XRProbe(){const value=useXR();useEffect(()=>{xrContext=value;return()=>{if(xrContext===value)xrContext=undefined;};},[value]);return <button data-enter-xr style={{position:'absolute',top:8,left:8,zIndex:5}} disabled={!value.ready} onClick={()=>{void value.enter('immersive-vr').catch(report);}}>Enter simulated XR</button>;}
function XRScene(){return <XR onReady={()=>{xrReady=true;}} onError={error=>{xrError=String(error);}}><XRProbe/><Box ref={box} args={[0.8,0.8,0.8]} position={[0,0.5,0]}><PbrMaterial color="#ef5c35"/></Box><Controller handedness="right" onFrame={()=>controllerFrames++}><Box args={[0.2,0.2,0.4]}/></Controller></XR>;}
function Scene({features=true}:{features?:boolean}){return <StrictMode><Canvas key={mode} backend="webgpu" frameloop="demand" style={{width:768,height:512}} camera={{position:[5,4,7],target:[0,0.7,0],near:0.1,far:40}} onCreated={stage=>{current=engineRuntime(stage.engine);}} onError={error=>{if(mode==='xr'&&/WebXR is unavailable/.test(String(error)))xrError=String(error);else report(error);}}><Stage><Probe/>{features?(mode==='kit'?<Kit/>:mode==='environment'?<EnvironmentScene/>:mode==='physics'?<PhysicsScene/>:mode==='xr'||mode==='xr-simulated'?<XRScene/>:<Post kind={mode}/>):<Box args={[0.5,0.5,0.5]}/>}</Stage></Canvas></StrictMode>;}
async function settle(){await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));await Promise.all(pending.splice(0));}
async function until(test:()=>boolean,label:string){const end=performance.now()+45_000;while(!test()){if(errors.length||gpuErrors.length)throw new Error([...errors,...gpuErrors].join('\n'));if(performance.now()>end)throw new Error('Timed out: '+label);await settle();}}
function ready(){if(!current||!context?.ready)return false;if(mode==='kit')return !!(box.current?.geometry&&sphere.current?.geometry&&plane.current?.geometry&&sky.current&&text.current&&gizmo.current&&pointer.current&&gltf&&fbx&&document.querySelector('[data-overlay="ready"]')&&current.hasPlugin('shadows'));if(mode==='environment')return !!(box.current?.geometry&&gltf&&current.hasPlugin('environment')&&current.hasPlugin('environment:background'));if(mode==='physics')return !!(world&&body?.valid&&box.current?.geometry&&fbxAutoBody&&fbxExplicitBody&&ballBody&&autoFbxRoot&&explicitFbxRoot);if(mode==='xr'||mode==='xr-simulated')return xrReady||!!xrError;return !!(box.current?.geometry&&sphere.current?.geometry&&plane.current?.geometry&&gltf&&postReady===({bloom:1,ssao:2,dof:3} as any)[mode]);}
async function draw(count=1){for(let index=0;index<count;index++){context!.invalidate();await current!.gpu!.queue.onSubmittedWorkDone();await settle();}if(errors.length||gpuErrors.length)throw new Error([...errors,...gpuErrors].join('\n'));}
function snapshot(){return {mode,backend:current?.backend,frames,renders,meshes:current?.meshes.size,stats:{...current?.stats},gltf:!!gltf,fbx:!!fbx,postReady,physicsBodies:world?.isDisposed?0:world?.bodyCount,physicsY:body?.valid?body.position[1]:null,xrReady,xrError,clock:context?.clock,clicks,xrRequests:xrFixture?.requests,xrFrames:xrFixture?.frames,controllerFrames,errors:[...errors],gpuErrors:[...gpuErrors]};}
async function unmount(){root?.unmount();root=undefined;await settle();await settle();xrFixture?.restore();xrFixture=undefined;for(const engine of engines)if(!engine.disposed||engine.meshes.size)throw new Error('Canvas did not dispose its engine/meshes');if(document.querySelector('[data-overlay="ready"]'))throw new Error('Html overlay leaked after unmount');return {disposed:engines.length};}
async function mount(next:Mode){if(root)await unmount();mode=next;current=undefined;context=undefined;gltf=fbx=undefined;body=fbxAutoBody=fbxExplicitBody=ballBody=undefined;autoFbxRoot=explicitFbxRoot=undefined;world=undefined;postReady=0;frames=renders=0;xrReady=false;xrError=undefined;controllerFrames=0;if(mode==='xr-simulated')xrFixture=simulatedXR(gpuErrors);root=createRoot(app);root.render(<Scene/>);await until(ready,next+' scene ready');await settle();return snapshot();}
async function singleFrame(){const before={frames,renders};await draw();if(frames!==before.frames+1||renders!==before.renders+1)throw new Error('Demand invalidate must advance exactly one callback and render');return snapshot();}
async function removeFeatures(){root!.render(<Scene features={false}/>);await settle();await settle();for(const name of ['sky','html','environment','environment:background','physics','bloom','ssao','dof','tonemap','taa','margoengine-react:text'])if(current?.hasPlugin(name))throw new Error('Unmounted feature plugin remains: '+name);if(mode==='physics'&&(!world.isDisposed||[body,fbxAutoBody,fbxExplicitBody,ballBody].some(value=>value?.valid)))throw new Error('RigidBody collider removal leaked a live Rapier body/world');await draw();return snapshot();}
async function verifyPhysics(){const before=body!.position[1];for(let index=0;index<12;index++){current!.render({delta:1/60});await settle();}await Promise.all(pending.splice(0));if(!(body!.position[1]<before))throw new Error('Physics did not advance through engine rendering');let fbxCoreGeometries=0;const autoRootId=(autoFbxRoot as unknown as RuntimeMesh).id;for(const mesh of current!.meshes.values()){if(!mesh.geometry)continue;for(let id=mesh.id;id!==-1;id=current!.store.parents[id])if(id===autoRootId)fbxCoreGeometries++;}return {before,after:body!.position[1],colliders:body!.colliders.length,bodyCount:world.bodyCount,fbxCoreGeometries,fbxAutoColliders:fbxAutoBody!.colliders.length,fbxExplicitColliders:fbxExplicitBody!.colliders.length,ballColliders:ballBody!.colliders.length};}
(window as any).reactScene={mount,draw,singleFrame,snapshot,removeFeatures,unmount,async verifyXR(){await until(()=>!!xrFixture&&xrFixture.frames>=4,'stereo XR frames');const pixels=await xrFixture!.pixels();await xrContext!.exit();await settle();const before=renders;await settle();if(renders!==before)throw new Error('XR exit resumed demand Canvas loop');return {...snapshot(),...pixels,ends:xrFixture!.ends};},clickPoint(){const m=(box.current as RuntimeMesh).matrix,c=current!.camera.matrix,x=m[12],y=m[13],z=m[14],w=c[3]*x+c[7]*y+c[11]*z+c[15],bounds=current!.canvas.getBoundingClientRect();return {x:bounds.left+(c[0]*x+c[4]*y+c[8]*z+c[12])/w*bounds.width/2+bounds.width/2,y:bounds.top-(c[1]*x+c[5]*y+c[9]*z+c[13])/w*bounds.height/2+bounds.height/2};},async shadow(enabled:boolean){if(!ground.current)throw new Error('Contact ground unavailable');(ground.current as RuntimeMesh).visible=enabled;await draw();},physics:verifyPhysics,get errors(){return errors;},get gpuErrors(){return gpuErrors;}};
