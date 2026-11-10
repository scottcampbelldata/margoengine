/// <reference lib="esnext.disposable" preserve="true" />
import {Geometry,PbrMaterial,type EngineKernel,type Mesh,type PbrMaterialOptions} from '@margoengine/core';
import type {StudioLight} from '@margoengine/environment/studio';
import type {EnvironmentLighting,EnvironmentLoadOptions} from '@margoengine/environment';
import {rangeError,typeError} from '../../shared/errors.js';

/** The four photographic staging rigs, for a subject facing a camera on +Z. */
export type StagingPreset='portrait'|'rembrandt'|'upfront'|'soft';
/** Quarter-circle cyclorama dimensions, in world units. */
export interface BackdropShape {
  /** Horizontal width, 0.001..1e4. Default 8. */
  width?:number;
  /** Front-to-back depth, 0.001..1e4. Default 5. */
  depth?:number;
  /** Wall height, 0.001..1e4. Default 4. */
  height?:number;
  /** Bend radius, positive and smaller than depth and height. Default 1. */
  radius?:number;
  /** Quarter-circle subdivisions, integer 2..256. Default 32. */
  segments?:number;
}
/** A backdrop mesh's initial shape and surface. */
export interface BackdropOptions extends BackdropShape {
  /** Core material values; default matte grey (#b8b8b8, roughness 1, metalness 0). */
  material?:PbrMaterialOptions;
}

/** Build a smooth floor-to-wall sweep with exact analytic unit normals and outward winding. */
export function backdropGeometry(options:BackdropShape={}):Geometry{
  if(!options||typeof options!=='object'||Array.isArray(options))throw typeError('Invalid backdrop shape; pass an options object','arguments');
  const width=options.width??8,depth=options.depth??5,height=options.height??4,radius=options.radius??1,segments=options.segments??32;
  if(![width,depth,height].every(v=>Number.isFinite(v)&&v>=.001&&v<=1e4)||!Number.isFinite(radius)||radius<=0||radius>=Math.min(depth,height)||!Number.isInteger(segments)||segments<2||segments>256)
    throw rangeError('Invalid backdrop dimensions; use finite width/depth/height .001..1e4, positive radius below depth/height and 2..256 integer segments','arguments');
  const positions:number[]=[],normals:number[]=[],indices:number[]=[];
  let previousY=NaN,previousZ=NaN;
  const row=(y:number,z:number,ny:number,nz:number)=>{
    const fy=Math.fround(y),fz=Math.fround(z);
    if(fy===previousY&&fz===previousZ)throw rangeError('Backdrop bend collapses at float32 precision; increase radius or reduce segments/depth','arguments');
    previousY=fy;previousZ=fz;positions.push(-width/2,y,z,width/2,y,z);normals.push(0,ny,nz,0,ny,nz);
  };
  row(0,depth/2,1,0);
  for(let i=0;i<=segments;i++){
    const angle=i/segments*Math.PI/2,s=Math.sin(angle),c=Math.cos(angle);
    row(radius*(1-c),-depth/2+radius-radius*s,c,s);
  }
  row(height,-depth/2,0,1);
  for(let i=0;i<segments+2;i++){const a=i*2;indices.push(a,a+1,a+3,a,a+3,a+2);}
  return new Geometry(positions,normals,indices);
}

/** A real mesh cyclorama, with the ordinary core mesh transform/material API. */
export class Backdrop {
  /** Borrowed mesh handle; translate/rotate/scale it with normal mesh setters. */
  readonly mesh:Mesh;
  private disposed=false;
  private constructor(engine:EngineKernel,options:BackdropOptions){
    const geometry=backdropGeometry(options),material=new PbrMaterial({color:'#b8b8b8',roughness:1,metalness:0,...options.material});
    this.mesh=engine.createMesh().setGeometry(geometry).setMaterial(material);
  }
  /** Create a cyclorama in the default scene. Mesh disposal remains owned by the engine too. */
  static attach(engine:EngineKernel,options:BackdropOptions={}):Backdrop{return new Backdrop(engine,options);}
  /** Release the mesh. Repeated calls and using cleanup are safe. */
  dispose():void{if(this.disposed)return;this.disposed=true;this.mesh.dispose();}
  [Symbol.dispose]():void{this.dispose();}
}

// Original photographic directions/ratios and softbox angular extents; no rival preset data.
const rigs:Record<StagingPreset,readonly StudioLight[]>={
 portrait:[{direction:[-1,1.1,1.2],width:.8,height:1.1,intensity:7},{direction:[1,.3,1],width:.9,height:.9,intensity:2.5},{direction:[.5,1,-1],width:.35,height:1,intensity:4}],
 rembrandt:[{direction:[-1,1.4,1],width:.55,height:.8,intensity:9},{direction:[1,.4,1],width:.7,height:.8,intensity:.8},{direction:[.7,.8,-1],width:.3,height:1,intensity:3}],
 upfront:[{direction:[0,.6,1],width:1.1,height:1.1,intensity:7},{direction:[-1,.4,.7],width:.7,height:.8,intensity:1.5},{direction:[1,.4,.7],width:.7,height:.8,intensity:1.5}],
 soft:[{direction:[-.6,1,1],width:1.7,height:1.4,intensity:4},{direction:[1,.6,.6],width:1.5,height:1.3,intensity:3},{direction:[0,1,-.5],width:1.4,height:1.1,intensity:2}],
};

/** Fresh softbox descriptors for the named rig, ready for environment/studio. Default rembrandt. */
export function stagingLights(preset:StagingPreset='rembrandt'):StudioLight[]{
  if(!Object.hasOwn(rigs,preset))throw rangeError('Unknown staging preset; choose portrait, rembrandt, upfront or soft','arguments');
  return structuredClone(rigs[preset]) as StudioLight[];
}
/** Environment preparation settings, with an optional procedural image width. */
export interface StagingLightingOptions extends EnvironmentLoadOptions {
  /** Equirect image width, a power of two 16..4096. Default 256. */
  width?:number;
}
/** Lazily create a named studio environment and its lighting; dispose the returned lighting to detach both. */
export async function stagingLighting(engine:EngineKernel,preset:StagingPreset='rembrandt',options:StagingLightingOptions={}):Promise<EnvironmentLighting>{
  options.signal?.throwIfAborted();const lights=stagingLights(preset),{width=256,...settings}=options;
  const [{studio},{EnvironmentLighting}]=await Promise.all([import('@margoengine/environment/studio'),import('@margoengine/environment')]);
  options.signal?.throwIfAborted();return EnvironmentLighting.load(engine,studio({width,lights}),settings);
}
