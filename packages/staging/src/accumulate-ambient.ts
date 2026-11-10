import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Vec3 } from '@margoengine/core/extension';
import { AccumulatedShadows, type AccumulatedShadowOptions } from './accumulate.js';
import { rangeError } from '../../shared/errors.js';

/** One disk light, parallel to the receiver, with normalized relative visibility weight. */
export interface AccumulatedLight {
  /** World centre above the caster slab. Required. */
  position: Vec3;
  /** World radius, 0..1e6. Default 2. */
  radius?: number;
  /** Relative nonnegative weight, at most 1e6. Default 1. */
  intensity?: number;
}
/** Several soft lights mixed with cosine-weighted sky occlusion. */
export interface AmbientShadowOptions extends AccumulatedShadowOptions {
  /** 0..64 disks. Default one disk from lightPosition/lightRadius; copied on construction. */
  lights?: readonly AccumulatedLight[];
  /** Sky share of total visibility, 0..1. Default 0.5. All-sky permits an empty lights array. */
  ambient?: number;
}

// Independent prime-base radical inverses decorrelate light selection, radius and azimuth.
function inverse(value: number, base: number): number {
  let sum=0, weight=1/base;
  while(value>0){sum+=(value%base)*weight;value=Math.floor(value/base);weight/=base;}
  return sum;
}

/** Progressive multi-light and hemispherical floor visibility; one projection per frame. */
export class AmbientShadows extends AccumulatedShadows {
  override readonly name = 'ambient-shadows';
  declare readonly options: AmbientShadowOptions;
  private readonly projected = new Float32Array(16);

  /** Copies disk positions; receiver and accumulation defaults are unchanged. */
  constructor(options: AmbientShadowOptions = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options))
      throw rangeError('Invalid ambient shadow options; pass an options object', 'arguments');
    super({...options, ...(Array.isArray(options?.lights) ? {lights:options.lights.map(l=>({...l,position:Array.isArray(l?.position)?[...l.position]:l?.position}))}: {})});
  }
  /** Attach to the default scene; a secondary scene can use new AmbientShadows(options). */
  static override attach(engine: EngineKernel, options: AmbientShadowOptions = {}): AmbientShadows {
    const shadow=new AmbientShadows(options);engineRuntime(engine).use(shadow);return shadow;
  }
  private disks(s: ReturnType<AmbientShadows['settings']>): readonly AccumulatedLight[] {
    return this.options.lights === undefined ? [{position:(this.options.lightPosition ?? s.normal.map(v=>8*v)) as Vec3,radius:this.options.lightRadius??2}] : this.options.lights;
  }
  protected override validateLighting(s: ReturnType<AmbientShadows['settings']>): void {
    const disks=this.disks(s), ambient=this.options.ambient??.5;
    const valid=Array.isArray(disks)&&disks.length<=64&&[...disks].every(l=>l&&Array.isArray(l.position)&&l.position.length===3&&
      [0,1,2].every(i=>Number.isFinite(l.position[i])&&Math.abs(l.position[i])<=1e6)&&
      Math.fround(s.normal.reduce((sum,v,i)=>sum+v*(l.position[i]-[s.x,s.ground,s.z][i]),0))>Math.fround(s.height)&&
      Number.isFinite(l.radius??2)&&(l.radius??2)>=0&&(l.radius??2)<=1e6&&
      Number.isFinite(l.intensity??1)&&(l.intensity??1)>=0&&(l.intensity??1)<=1e6);
    if(!Number.isFinite(ambient)||ambient<0||ambient>1||!valid||
      (ambient<1&&!disks.some(l=>(l.intensity??1)>0)))
      throw rangeError('Invalid ambient shadow lights; use ambient 0..1 and up to 64 finite nonnegative weighted disks above the caster slab, with a positive disk weight unless ambient is 1','arguments');
  }
  protected override lightingKey(s: ReturnType<AmbientShadows['settings']>): string {
    return [this.options.ambient??.5,...this.disks(s).flatMap(l=>[...l.position,l.radius??2,l.intensity??1])].join('|');
  }
  protected override projection(s: ReturnType<AmbientShadows['settings']>): Float32Array {
    const index=this.samples+1, ambient=this.options.ambient??.5, pick=inverse(index,2),
      r=Math.sqrt(inverse(index,3)), angle=2*Math.PI*inverse(index,5),
      center=[s.x,s.ground,s.z];
    let h:number,x:number,z:number,point:boolean;
    if(pick<ambient){
      // Cosine hemisphere: disk radius sqrt(u), height sqrt(1-u). No finite sky dome or horizon cutoff.
      h=Math.sqrt(1-r*r);x=r*Math.cos(angle);z=r*Math.sin(angle);point=false;
    }else{
      const disks=this.disks(s),total=disks.reduce((sum,l)=>sum+(l.intensity??1),0);
      let weight=(pick-ambient)/(1-ambient)*total, selected=disks[disks.length-1];
      for(const disk of disks){weight-=disk.intensity??1;if(weight<0){selected=disk;break;}}
      const local=(axis:readonly number[])=>axis.reduce((sum,v,i)=>sum+v*(selected.position[i]-center[i]),0);
      h=local(s.normal);x=local(s.u)+(selected.radius??2)*r*Math.cos(angle);z=local(s.v)+(selected.radius??2)*r*Math.sin(angle);point=true;
    }
    const m=this.projected;m.fill(0);
    for(let i=0;i<3;i++){
      m[i*4]=2*(h*s.u[i]-x*s.normal[i])/s.width;
      m[i*4+1]=2*(h*s.v[i]-z*s.normal[i])/s.depth;
      m[i*4+2]=(point?h-s.height:h)*s.normal[i]/s.height;
      m[i*4+3]=point?-s.normal[i]:0;
    }
    for(let row=0;row<4;row++)m[12+row]=(row===3?h:0)-center.reduce((sum,v,i)=>sum+v*m[i*4+row],0);
    return m;
  }
}
