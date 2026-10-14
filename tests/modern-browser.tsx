import React,{StrictMode,Suspense,useRef} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {Engine,box,PbrMaterial, type Mesh as CoreMesh} from '@margoengine/core/extension';
import {Canvas,Mesh,BoxGeometry,PbrMaterial as ReactMaterial,useFrame} from '@margoengine/react';
import {GPUParticles,PostProcessing,ToonShading} from '@margoengine/creative';
import {SectionPlanes,EngineeringAnnotations,PartInstancer} from '@margoengine/machinery';
import {webglRenderer} from '@margoengine/webgl';
const state:{core?:Engine;react?:Engine;root?:Root;host?:HTMLDivElement;parent:CoreMesh|null;child:CoreMesh|null;renders:number;errors:string[];frames:number}={parent:null,child:null,renders:0,errors:[],frames:0};
function Cube({position=1}:{position?:number}){
  state.renders++;const mesh=useRef<CoreMesh>(null);
  useFrame((_,delta)=>{state.frames++;if(mesh.current)mesh.current.rotation.y+=delta;});
  return <Mesh ref={node=>{state.parent=node as unknown as CoreMesh;mesh.current=node as unknown as CoreMesh;}} position={[position,0,0]}><BoxGeometry/><ReactMaterial color="#e45630"/><Mesh ref={node=>{state.child=node as unknown as CoreMesh;}} position={[0.5,0,0]}><BoxGeometry/><ReactMaterial color="#84d6bd"/></Mesh></Mesh>;
}
const pending=new Promise<never>(()=>{});
function Suspended():never{throw pending;}
function App({position=1,show=true,suspend=false}:{position?:number;show?:boolean;suspend?:boolean}){
  return <StrictMode><Canvas backend="webgl2" fallback={webglRenderer} capacity={8} onCreated={stage=>{state.react=stage.engine as unknown as Engine;}} onError={error=>state.errors.push(String(error))}>{show&&(suspend?<Suspense fallback={null}><Cube position={position}/><Suspended/></Suspense>:<Cube position={position}/>)}</Canvas></StrictMode>;
}
const harness={
  state,
  async core(backend:'webgpu'|'webgl2'|'auto'){
    state.core?.dispose();document.querySelector('[data-core]')?.remove();const canvas=document.createElement('canvas');canvas.dataset.core=backend;canvas.style.cssText='width:320px;height:240px;display:block';document.body.append(canvas);
    const engine=await Engine.create(canvas,{backend,fallback:webglRenderer,capacity:16,camera:{position:[0,0,4]}});state.core=engine;
    const geometry=box(),mesh=engine.createMesh().setGeometry(geometry).setMaterial(new PbrMaterial({color:'#e45630',roughness:0.6}));
    engine.createMesh().setGeometry(geometry).setPosition([100,0,0]);engine.render();
    return {backend:engine.backend,fallbackReason:engine.fallbackReason,stats:{...engine.stats},mesh:mesh.id};
  },
  mount(options:{position?:number;show?:boolean;suspend?:boolean}={}){
    if(!state.root){const host=document.createElement('div');host.style.cssText='width:320px;height:240px';document.body.append(host);state.host=host;state.root=createRoot(host);}state.root.render(<App {...options}/>);
  },
  unmount(){state.root?.unmount();state.host?.remove();state.root=undefined;state.host=undefined;},
  async particles(count=100_000){const engine=state.core!;engine.stop();const particles=new GPUParticles({count});engine.use(particles);engine.render({delta:0.1});await engine.gpu!.queue.onSubmittedWorkDone();return particles;},
  async machinery(){const e=state.core!,mesh=[...e.meshes.values()][0],plane=[0,0,-1,0];e.use(new PartInstancer());e.use(new SectionPlanes({planes:[plane],color:'#00ff00',hatch:0}));e.use(new EngineeringAnnotations({dimensions:[{a:{node:mesh,point:[-0.5,0,0]},b:{node:mesh,point:[0.5,0,0]}}],callouts:[{anchor:{node:mesh,point:[0,0,0]},label:'Section cap'}]}));e.render();await e.gpu!.queue.onSubmittedWorkDone();return plane;},
  creative(options:any){const e=state.core!,post=new PostProcessing(options);e.use(post);e.render();return post;},
  toon(){state.core!.use(new ToonShading());state.core!.render();},
  sorted(){const e=state.core!,p=new GPUParticles({count:257,sort:true,gravity:[0,0,0],wind:[0,0,0],curl:0.3,obstacles:[{kind:'sphere',center:[0,0,0],radius:0.5},{kind:'box',center:[1,0,0],halfSize:[0.3,0.3,0.3]}]});e.use(p);e.render({delta:0});return p;}
};
(window as any).modern=harness;
