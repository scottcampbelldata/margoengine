'use client';
import {forwardRef,useEffect,useImperativeHandle,useRef,useState,type ReactNode,type Ref,type RefObject} from 'react';
import type {EngineKernel,FrameCallback,Mesh as MeshHandle} from '@margoengine/core';
import type {Geometry,Mesh as EngineMesh} from '@margoengine/core/extension';
import type {PointerLockControls as PointerControls,TransformControls as GizmoControls,TransformControlsOptions,ControlEvent} from '@margoengine/controls';
import type {Sky as SkyPlugin,SkyOptions} from '@margoengine/sky';
import type {Text as TextBlock,TextOptions,TextRenderer,Font} from '@margoengine/text';
import {Mesh,PbrMaterial,type PbrMaterialProps,type MeshProps,type MeshRef} from './components.js';
import {useScene,useMesh,useCommit,live,setGeometry,zero,type Scene,type Registry} from './internal.js';
import {ContactGround,type ContactGroundOptions} from './kit-contact.js';
import {optionalPeer} from './optional.js';

interface ErrorProps {onError?:(error:unknown)=>void}
function report(scene:Scene,error:unknown,onError?:ErrorProps['onError']):void {try{onError?.(error);}finally{scene.engine.onError(error);}}

type GeometryApi=typeof import('@margoengine/geometry');
type ShapeKind='boxGeometry'|'sphereGeometry'|'planeGeometry';
function ShapeGeometry({kind,args,onError}:{kind:ShapeKind;args:readonly number[];onError?:ErrorProps['onError']}) {
  const scene=useScene(),registry=useMesh(),error=useRef(onError);error.current=onError;
  const key=JSON.stringify(args);
  useEffect(()=>{
    let active=true,geometry:Geometry|undefined;
    const attach=(mesh:EngineMesh)=>{if(geometry)setGeometry(registry,mesh,geometry);};
    optionalPeer('@margoengine/geometry',()=>import('@margoengine/geometry')).then(api=>{
      if(!active||scene.engine.disposed)return;
      const create=api[kind] as (...args:number[])=>ReturnType<GeometryApi[ShapeKind]>;
      geometry=api.toGeometry(create(...args));registry.attachments.add(attach);
      try{const mesh=live(registry);if(mesh)attach(mesh);}catch(error){registry.attachments.delete(attach);throw error;}
    }).catch(cause=>{if(active&&!scene.engine.disposed)report(scene,cause,error.current);});
    return()=>{active=false;registry.attachments.delete(attach);const mesh=live(registry);if(mesh&&registry.geometry===geometry)setGeometry(registry,mesh,null);};
  },[scene.engine,registry,kind,key]);return null;
}
interface ShapeProps extends MeshProps,ErrorProps,PbrMaterialProps {castShadow?:boolean}
function ShapeCaster({enabled,onError}:{enabled:boolean;onError?:ErrorProps['onError']}) {
  const scene=useScene(),registry=useMesh(),error=useRef(onError);error.current=onError;
  useEffect(()=>{if(enabled)return scene.requestShadows();},[scene.requestShadows,enabled]);
  useEffect(()=>{
    if(!enabled||!scene.shadows)return;
    let remove:(()=>void)|undefined;
    const attach=(mesh:EngineMesh)=>{remove?.();remove=undefined;try{remove=scene.shadows!.add(mesh as unknown as MeshHandle);}catch(cause){report(scene,cause,error.current);}};
    registry.attachments.add(attach);const mesh=live(registry);if(mesh)attach(mesh);
    return()=>{registry.attachments.delete(attach);remove?.();};
  },[registry,scene.shadows,enabled]);return null;
}
export interface BoxProps extends ShapeProps {args?:Parameters<GeometryApi['boxGeometry']>}
export interface SphereProps extends ShapeProps {args?:Parameters<GeometryApi['sphereGeometry']>}
export interface PlaneProps extends ShapeProps {args?:Parameters<GeometryApi['planeGeometry']>}
export const Box=forwardRef<MeshRef,BoxProps>(function Box({args=[],castShadow=false,onError,color,roughness,metalness,children,...props},ref){return <Mesh {...props} ref={ref}><ShapeGeometry kind="boxGeometry" args={args as number[]} onError={onError}/><PbrMaterial color={color} roughness={roughness} metalness={metalness}/><ShapeCaster enabled={castShadow} onError={onError}/>{children}</Mesh>;});
export const Sphere=forwardRef<MeshRef,SphereProps>(function Sphere({args=[],castShadow=false,onError,color,roughness,metalness,children,...props},ref){return <Mesh {...props} ref={ref}><ShapeGeometry kind="sphereGeometry" args={args as number[]} onError={onError}/><PbrMaterial color={color} roughness={roughness} metalness={metalness}/><ShapeCaster enabled={castShadow} onError={onError}/>{children}</Mesh>;});
export const Plane=forwardRef<MeshRef,PlaneProps>(function Plane({args=[],castShadow=false,onError,color,roughness,metalness,children,...props},ref){return <Mesh {...props} ref={ref}><ShapeGeometry kind="planeGeometry" args={args as number[]} onError={onError}/><PbrMaterial color={color} roughness={roughness} metalness={metalness}/><ShapeCaster enabled={castShadow} onError={onError}/>{children}</Mesh>;});

export interface SkyProps extends SkyOptions,ErrorProps {}
export const Sky=forwardRef<SkyPlugin,SkyProps>(function Sky({onError,...options},ref){
  const scene=useScene(),latest=useRef({options,onError}),[sky,setSky]=useState<SkyPlugin|null>(null);latest.current={options,onError};
  useEffect(()=>{
    let active=true,current:SkyPlugin|undefined;
    optionalPeer('@margoengine/sky',()=>import('@margoengine/sky')).then(({Sky})=>{
      if(!active||scene.engine.disposed)return;
      current=new Sky({...latest.current.options});scene.engine.use(current);setSky(current);
    }).catch(error=>{if(active&&!scene.engine.disposed)report(scene,error,latest.current.onError);});
    return()=>{active=false;if(current){scene.engine.removePlugin(current.name);current.dispose();}};
  },[scene.engine]);
  useCommit(()=>{if(!sky)return;for(const key of Object.keys(sky.options))delete (sky.options as Record<string,unknown>)[key];Object.assign(sky.options,options);});
  useImperativeHandle(ref,()=>sky!,[sky]);return null;
});

export interface ContactShadowsProps extends MeshProps,ErrorProps,ContactGroundOptions {}
function ContactBinding({onError,...options}:ContactGroundOptions&ErrorProps) {
  const scene=useScene(),registry=useMesh(),latest=useRef({options,onError});latest.current={options,onError};
  useEffect(()=>scene.requestShadows(),[scene.requestShadows]);
  useEffect(()=>{
    if(!scene.shadows)return;
    const ground=new ContactGround(registry,scene.shadows,()=>latest.current.options);
    try{scene.engine.use(ground);}catch(error){report(scene,error,latest.current.onError);return;}
    return()=>{scene.engine.removePlugin(ground.name);ground.dispose();};
  },[scene.engine,registry,scene.shadows]);return null;
}
/** A transparent ground that draws only the existing shadow map's occlusion. */
export const ContactShadows=forwardRef<MeshRef,ContactShadowsProps>(function ContactShadows({width=10,height=10,opacity=0.5,color=[0,0,0],onError,children,...props},ref){return <Mesh {...props} ref={ref}><ContactBinding width={width} height={height} opacity={opacity} color={color} onError={onError}/>{children}</Mesh>;});

function descendant(scene:Scene,mesh:EngineMesh,root:EngineMesh):boolean {
  for(let id=mesh.id,depth=0;id>=0&&depth<64;id=scene.engine.store.parents[id],depth++)if(id===root.id)return true;
  return false;
}
// The frozen stage keeps worldBounds private. Use its vertex/world-matrix
// calculation here, with PBRModel.bounds for geometry owned by loader plugins.
export function sceneWorldBounds(scene:Scene,root:EngineMesh,output=new Float32Array(6)):Float32Array|null {
  scene.engine.store.tick(false);output.fill(Infinity,0,3);output.fill(-Infinity,3);
  for(const mesh of scene.engine.meshes.values()){
    if(!mesh.geometry||!descendant(scene,mesh,root))continue;
    const vertices=mesh.geometry.vertices,m=mesh.matrix;
    for(let i=0;i<vertices.length;i+=6)for(let axis=0;axis<3;axis++){
      const value=m[axis]*vertices[i]+m[axis+4]*vertices[i+1]+m[axis+8]*vertices[i+2]+m[axis+12];
      output[axis]=Math.min(output[axis],value);output[axis+3]=Math.max(output[axis+3],value);
    }
  }
  for(const model of scene.resources.models)if(!model.disposed&&descendant(scene,model.root,root)){
    const bounds=model.bounds;
    for(let axis=0;axis<3;axis++){output[axis]=Math.min(output[axis],bounds[axis]);output[axis+3]=Math.max(output[axis+3],bounds[axis+3]);}
  }
  return Number.isFinite(output[0])?output:null;
}
export interface CenterProps extends MeshProps {disableX?:boolean;disableY?:boolean;disableZ?:boolean}
function CenterBinding({disableX=false,disableY=false,disableZ=false}:Pick<CenterProps,'disableX'|'disableY'|'disableZ'>) {
  const scene=useScene(),registry=useMesh(),flags=useRef([disableX,disableY,disableZ]);flags.current=[disableX,disableY,disableZ];
  useEffect(()=>{
    const bounds=new Float32Array(6);
    const center=()=>{
      const root=live(registry);if(!root||!sceneWorldBounds(scene,root,bounds))return;
      const parent=scene.engine.meshes.get(scene.engine.store.parents[root.id]),m=parent?.matrix;
      const dx=(m?.[12]??0)-(bounds[0]+bounds[3])/2,dy=(m?.[13]??0)-(bounds[1]+bounds[4])/2,dz=(m?.[14]??0)-(bounds[2]+bounds[5])/2;
      let delta=[dx,dy,dz];
      if(m){
        const a=m[0],b=m[4],c=m[8],d=m[1],e=m[5],f=m[9],g=m[2],h=m[6],i=m[10];
        const determinant=a*(e*i-f*h)-b*(d*i-f*g)+c*(d*h-e*g);if(!determinant)return;
        delta=[((e*i-f*h)*dx+(c*h-b*i)*dy+(b*f-c*e)*dz)/determinant,((f*g-d*i)*dx+(a*i-c*g)*dy+(c*d-a*f)*dz)/determinant,((d*h-e*g)*dx+(b*g-a*h)*dy+(a*e-b*d)*dz)/determinant];
      }
      const position=[root.position.x,root.position.y,root.position.z];let changed=false;
      for(let axis=0;axis<3;axis++)if(!flags.current[axis]&&Math.abs(delta[axis])>1e-5){position[axis]+=delta[axis];changed=true;}
      if(changed)root.setPosition(position as [number,number,number]);
    };
    const frame:FrameCallback=()=>center();scene.frames.callbacks.add(frame);queueMicrotask(()=>{if(scene.frames.callbacks.has(frame)&&!scene.engine.disposed)center();});
    return()=>{scene.frames.callbacks.delete(frame);};
  },[scene.engine,scene.frames,scene.resources,registry]);return null;
}
/** Recenter descendants while retaining the outer group's declared transform. */
export const Center=forwardRef<MeshRef,CenterProps>(function Center({disableX,disableY,disableZ,children,...props},ref){return <Mesh {...props} ref={ref}><Mesh><CenterBinding disableX={disableX} disableY={disableY} disableZ={disableZ}/>{children}</Mesh></Mesh>;});

export interface PointerLockProps extends ErrorProps {
  enabled?:boolean;pointerSpeed?:number;movementSpeed?:number;requireLock?:boolean;minPolarAngle?:number;maxPolarAngle?:number;
  lockOnClick?:boolean;onLock?:(event:ControlEvent)=>void;onUnlock?:(event:ControlEvent)=>void;onChange?:(event:ControlEvent)=>void;
}
export const PointerLock=forwardRef<PointerControls,PointerLockProps>(function PointerLock(props,ref){
  const scene=useScene(),latest=useRef(props),[controls,setControls]=useState<PointerControls|null>(null);latest.current=props;
  useEffect(()=>{
    let active=true,current:PointerControls|undefined,release=()=>{};
    optionalPeer('@margoengine/controls',()=>import('@margoengine/controls')).then(({PointerLockControls})=>{
      if(!active||scene.engine.disposed)return;
      current=new PointerLockControls(scene.engine as unknown as EngineKernel,scene.engine.canvas);
      const control=current,frame:FrameCallback=(_,delta)=>{control.update(delta);};
      const click=()=>{if(latest.current.lockOnClick!==false&&control.enabled)control.lock();};
      const lock=(event:ControlEvent)=>latest.current.onLock?.(event),unlock=(event:ControlEvent)=>latest.current.onUnlock?.(event),change=(event:ControlEvent)=>latest.current.onChange?.(event);
      const error=(event:ControlEvent)=>report(scene,event,latest.current.onError);
      control.addEventListener('lock',lock);control.addEventListener('unlock',unlock);control.addEventListener('change',change);control.addEventListener('error',error);
      scene.engine.canvas.addEventListener('click',click);scene.frames.callbacks.add(frame);
      release=()=>{scene.engine.canvas.removeEventListener('click',click);scene.frames.callbacks.delete(frame);control.removeEventListener('lock',lock);control.removeEventListener('unlock',unlock);control.removeEventListener('change',change);control.removeEventListener('error',error);if(control.isLocked)control.unlock();control.dispose();};
      setControls(control);
    }).catch(error=>{current?.dispose();if(active&&!scene.engine.disposed)report(scene,error,latest.current.onError);});
    return()=>{active=false;release();};
  },[scene.engine,scene.frames]);
  useCommit(()=>{
    if(!controls)return;
    const {enabled=true,pointerSpeed=1,movementSpeed=1,requireLock=true,minPolarAngle=0,maxPolarAngle=Math.PI}=props;
    if(![pointerSpeed,movementSpeed,minPolarAngle,maxPolarAngle].every(Number.isFinite)||pointerSpeed<0||movementSpeed<0||minPolarAngle<0||maxPolarAngle>Math.PI||minPolarAngle>maxPolarAngle)throw new RangeError('Invalid pointer lock options');
    Object.assign(controls,{enabled,pointerSpeed,movementSpeed,requireLock,minPolarAngle,maxPolarAngle});
  },[controls,props.enabled,props.pointerSpeed,props.movementSpeed,props.requireLock,props.minPolarAngle,props.maxPolarAngle]);
  useImperativeHandle(ref,()=>controls!,[controls]);return null;
});

type ObjectTarget=MeshHandle|RefObject<MeshHandle|null>|null;
export interface TransformControlsProps extends Omit<TransformControlsOptions,'element'>,MeshProps,ErrorProps {
  object?:ObjectTarget;enabled?:boolean;visible?:boolean;onChange?:(event:ControlEvent)=>void;onObjectChange?:(event:ControlEvent)=>void;onDraggingChange?:(event:ControlEvent)=>void;
}
function target(value:ObjectTarget|undefined,registry:Registry|null):MeshHandle|null {return value===undefined?registry?.current as unknown as MeshHandle??null:value&&'current' in value?value.current:value;}
function TransformBinding({options,controlRef}:{options:TransformControlsProps;controlRef:Ref<GizmoControls>}) {
  const scene=useScene(),latest=useRef(options),[controls,setControls]=useState<GizmoControls|null>(null);latest.current=options;
  useEffect(()=>{
    let active=true,current:GizmoControls|undefined,release=()=>{};
    optionalPeer('@margoengine/gizmo',()=>import('@margoengine/gizmo')).then(({TransformControls})=>{
      if(!active||scene.engine.disposed)return;
      current=new TransformControls(scene.engine as unknown as EngineKernel,latest.current);
      const control=current,attach=()=>{const object=target(latest.current.object,scene.registry);if(object!==control.object){if(object)control.attach(object);else control.detach();}};
      const frame:FrameCallback=()=>attach(),change=(event:ControlEvent)=>latest.current.onChange?.(event),objectChange=(event:ControlEvent)=>latest.current.onObjectChange?.(event),dragging=(event:ControlEvent)=>latest.current.onDraggingChange?.(event);
      control.addEventListener('change',change);control.addEventListener('objectChange',objectChange);control.addEventListener('dragging-changed',dragging);scene.frames.callbacks.add(frame);
      release=()=>{scene.frames.callbacks.delete(frame);control.removeEventListener('change',change);control.removeEventListener('objectChange',objectChange);control.removeEventListener('dragging-changed',dragging);control.dispose();};
      attach();setControls(control);
    }).catch(error=>{release();current?.dispose();if(active&&!scene.engine.disposed)report(scene,error,latest.current.onError);});
    return()=>{active=false;release();};
  },[scene.engine,scene.frames,scene.registry,options.order]);
  useCommit(()=>{
    if(!controls)return;
    const {enabled=true,visible=true,mode='translate',space='world',size=1,translationSnap=null,rotationSnap=null,scaleSnap=null,showX=true,showY=true,showZ=true}=options;
    if(!['translate','rotate','scale'].includes(mode)||!['world','local'].includes(space)||!Number.isFinite(size)||size<=0||[translationSnap,rotationSnap,scaleSnap].some(value=>value!==null&&(!Number.isFinite(value)||value<=0)))throw new RangeError('Invalid transform controls options');
    controls.enabled=enabled;controls.visible=visible;controls.setMode(mode);controls.setSpace(space);controls.setSize(size);controls.setTranslationSnap(translationSnap);controls.setRotationSnap(rotationSnap);controls.setScaleSnap(scaleSnap);Object.assign(controls,{showX,showY,showZ});
    const object=target(options.object,scene.registry);if(object!==controls.object){if(object)controls.attach(object);else controls.detach();}
  });
  useImperativeHandle(controlRef,()=>controls!,[controls]);return null;
}
export const TransformControls=forwardRef<GizmoControls,TransformControlsProps>(function TransformControls({children,...options},ref){
  return children!==undefined?<Mesh position={options.position} rotation={options.rotation} scale={options.scale} onClick={options.onClick} onPointerOver={options.onPointerOver} onPointerOut={options.onPointerOut}><TransformBinding options={options} controlRef={ref}/>{children}</Mesh>:<TransformBinding options={options} controlRef={ref}/>;
});

interface TextRendererLease {users:number;promise:Promise<{renderer:TextRenderer;api:typeof import('@margoengine/text')}>}
const renderers=new WeakMap<Scene['engine'],TextRendererLease>();
function acquireTextRenderer(scene:Scene):TextRendererLease {
  let entry=renderers.get(scene.engine);
  if(!entry){entry={users:0,promise:optionalPeer('@margoengine/text',()=>import('@margoengine/text')).then(api=>{if(scene.engine.disposed)throw new Error('Canvas disposed');const renderer=new api.TextRenderer({name:'margoengine-react:text'});scene.engine.use(renderer);return {renderer,api};})};renderers.set(scene.engine,entry);}
  entry.users++;return entry;
}
function releaseTextRenderer(scene:Scene,entry:TextRendererLease):void {
  if(--entry.users)return;
  queueMicrotask(()=>{if(entry.users||renderers.get(scene.engine)!==entry)return;renderers.delete(scene.engine);void entry.promise.then(({renderer})=>{scene.engine.removePlugin(renderer.name);renderer.dispose();},()=>{});});
}
export interface TextProps extends Omit<TextOptions,'mesh'|'text'>,ErrorProps {text?:string;children?:string|number}
const textDefaults={fontSize:1,lineHeight:1.2,letterSpacing:0,maxWidth:Infinity,textAlign:'left',anchorX:'left',anchorY:'top',direction:'auto',whiteSpace:'normal',overflowWrap:'break-word',color:0xffffff,opacity:1,outlineWidth:0,outlineColor:0,outlineOpacity:1,shadowColor:0,shadowOpacity:0,shadowBlur:0,billboard:false,onTop:false} as const;
export const Text=forwardRef<TextBlock,TextProps>(function Text(props,ref){
  const scene=useScene(),latest=useRef(props),[item,setItem]=useState<TextBlock|null>(null);latest.current=props;
  const font=useRef<{input:TextOptions['font'];value:Font}|null>(null),apply=useRef<(text:TextBlock)=>void>(()=>{});
  useEffect(()=>{
    let active=true,current:TextBlock|undefined,renderer:TextRenderer|undefined;
    const entry=acquireTextRenderer(scene),attach=(mesh:EngineMesh)=>current?.attach(mesh as unknown as MeshHandle);
    entry.promise.then(({renderer:loaded,api})=>{
      if(!active||scene.engine.disposed)return;
      renderer=loaded;
      apply.current=text=>{
        const {children,text:content=String(children??''),font:input,visible=true,position=zero,rotation=zero,scale=1,matrix,onError,...style}=latest.current;
        if(!font.current||font.current.input!==input)font.current={input,value:input instanceof api.Font?input:new api.Font(input)};
        text.set({...textDefaults,shadowOffset:[0.04*(style.fontSize??1),-0.04*(style.fontSize??1)],...style,text:content,font:font.current.value});text.visible=visible;
        if(matrix)text.setMatrix(matrix);else text.setTransform(position,rotation,scale);
        text.attach(scene.registry?.current as unknown as MeshHandle??null);
      };
      current=new api.Text();apply.current(current);renderer.add(current);scene.registry?.attachments.add(attach);setItem(current);
    }).catch(error=>{if(current)renderer?.remove(current);if(active&&!scene.engine.disposed)report(scene,error,latest.current.onError);});
    return()=>{active=false;scene.registry?.attachments.delete(attach);if(current)renderer?.remove(current);releaseTextRenderer(scene,entry);};
  },[scene.engine,scene.registry]);
  useCommit(()=>{if(item)apply.current(item);});useImperativeHandle(ref,()=>item!,[item]);return null;
});
