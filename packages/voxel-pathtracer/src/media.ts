import type { EngineKernel } from '@margoengine/core';
import { MargoError } from '@margoengine/math/errors';
import {
  VoxelPathTracer,
  type VoxelPathTracerOptions,
  type VoxelTraceScene,
  type TraceMaterial,
  type TraceModel,
  type TraceVec3,
} from '@margoengine/voxel-pathtracer';

/** A palette medium; different cells may reference different coefficients. */
export interface MediaTraceMaterial extends TraceMaterial {
  /** RGB extinction per world unit, each 0 to 1e6. Media only. Default [density, density, density]. */
  extinction?: TraceVec3;
}

/** Voxel model with an optional independent medium palette. */
export interface MediaTraceModel extends Omit<TraceModel, 'materials'> {
  /** Model-local palette, overriding the scene palette. */
  materials?: readonly MediaTraceMaterial[];
}

/** Piecewise constant media use the existing voxel grid, shapes, instances and hierarchy. */
export interface MediaTraceScene extends Omit<VoxelTraceScene, 'materials' | 'models'> {
  /** Scene palette. Medium color is single-scattering albedo, not extinction. */
  materials: readonly MediaTraceMaterial[];
  /** Model grids whose palette indices select local density and colour. */
  models: readonly MediaTraceModel[];
}

/** Options for heterogeneous RGB media. Other settings retain the root tracer's defaults. */
export interface MediaVoxelPathTracerOptions extends Omit<VoxelPathTracerOptions, 'scene'> {
  /** Voxel scene with RGB extinction on its media. */
  scene: MediaTraceScene;
}

function palette(materials: readonly MediaTraceMaterial[]): readonly TraceMaterial[] {
  if (!Array.isArray(materials)) throw new TypeError('MediaVoxelPathTracer materials must be an array');
  return materials.map((m) => {
    if (!m || typeof m !== 'object') throw new TypeError('MediaVoxelPathTracer expects material objects');
    const { extinction, ...rest } = m;
    if (extinction === undefined) return m.type === 'media' ? { ...rest, metalColor: [1, 1, 1] as const } : rest;
    if (m.type !== 'media') throw new TypeError('MediaVoxelPathTracer extinction is supported only on media');
    if (!Array.isArray(extinction) || extinction.length !== 3)
      throw new TypeError('MediaVoxelPathTracer extinction must contain three numbers');
    for (const v of extinction) {
      if (typeof v !== 'number') throw new TypeError('MediaVoxelPathTracer extinction must contain numbers');
      if (!Number.isFinite(v) || v < 0 || v > 1e6)
        throw new RangeError('MediaVoxelPathTracer extinction must be finite and between 0 and 1e6 per world unit');
    }
    const density = Math.max(...extinction);
    // Media have no metal lobe. Reuse its three packed floats without changing
    // the root table, upload protocol, resource layout or restoration path.
    return {
      ...rest,
      density,
      metalColor: extinction.map((v) => (density === 0 ? 0 : v / density)) as unknown as TraceVec3,
    };
  });
}

function scene(input: MediaTraceScene): VoxelTraceScene {
  if (!input || typeof input !== 'object' || !Array.isArray(input.models))
    throw new TypeError('MediaVoxelPathTracer scene must contain models and materials');
  return {
    ...input,
    materials: palette(input.materials),
    models: input.models.map((m) => (m?.materials === undefined ? m : { ...m, materials: palette(m.materials) })),
  };
}

/**
 * RGB free-flight mixture sampling and exact piecewise Beer-Lambert shadow integration.
 * The voxel palette supplies heterogeneous coefficients; no density resampling,
 * null-collision majorant, CPU geometry build or additional GPU resource is needed.
 */
export class MediaVoxelPathTracer extends VoxelPathTracer {
  protected constructor(options: MediaVoxelPathTracerOptions) {
    if (!options || typeof options !== 'object')
      throw new TypeError('MediaVoxelPathTracer.attach expects (engine, {scene, ...options})');
    super({ ...options, scene: scene(options.scene) });
  }

  /** Attach with the root tracer's lifecycle and capture APIs. Plain WebGL2 reports unsupported with help. */
  static override attach(engine: EngineKernel, options: MediaVoxelPathTracerOptions): MediaVoxelPathTracer {
    return super.attach(engine, options) as MediaVoxelPathTracer;
  }

  /** Validate and replace the whole palette and grid atomically; accumulation restarts. */
  override setScene(value: MediaTraceScene): void {
    super.setScene(scene(value));
  }

  protected override tracingSource(): string {
    let source = super.tracingSource();
    const edit = (from: string, to: string) => {
      if (!source.includes(from))
        throw new MargoError(
          'state',
          'Media kernel mismatch; rebuild the package, see https://margoengine.com/errors#voxel-pathtracer',
        );
      source = source.replace(from, to);
    };
    // Vectorize the existing exact voxel shadow walk. Sentinel tests still
    // distinguish an opaque obstruction from arbitrarily dense coloured media.
    const vectorize = (start: string, end: string, depth: string) => {
      const a = source.indexOf(start),
        b = source.indexOf(end, a);
      if (a < 0 || b < a)
        throw new MargoError(
          'state',
          'Media shadow kernel mismatch; see https://margoengine.com/errors#voxel-pathtracer',
        );
      const original = source.slice(a, b);
      let result = original
        .replace('->f32 {', '->vec3f {')
        .replaceAll('return -1.0;', 'return vec3f(-1.0);')
        .replaceAll('return 0.0;', 'return vec3f(0.0);')
        .replaceAll('return 1.0;', 'return vec3f(1.0);')
        .replaceAll('if(k<0.0)', 'if(k.x<0.0)')
        .replaceAll('if(x<0.0)', 'if(x.x<0.0)');
      result = result.replace(`var ${depth}=0.0;`, `var ${depth}=vec3f(0.0);`);
      edit(original, result);
    };
    edit('fn extinction(v:u32,own:bool)->f32 {', 'fn extinction(v:u32,own:bool)->vec3f {');
    edit('return select(-1.0,x.x,(fl&MEDIA)', 'return select(vec3f(-1.0),x.x*mat(v*MV+4u).yzw,(fl&MEDIA)');
    vectorize('fn marchShadow(', '// A surface of another instance', 'depth');
    vectorize('fn shadow(', 'fn unitAxis(', 'tau');
    edit('if(v>0.0){L+=e.f*radiance*v*', 'if(any(v>vec3f(0.0))){L+=e.f*radiance*v*');
    edit('exp(-(md.absorb+md.sigma)*min(h.t,1e30))', 'exp(-mediaExtinction(wMedium)*min(h.t,1e30))');
    // Preserve the scalar kernel exactly for neutral media and all glass.
    edit(
      'if(medium!=0u){\n   let md=mediumOf(medium);',
      `if(medium!=0u){
   let md=mediumOf(medium);
   let st=mediaExtinction(medium);
   if(md.media&&any(st!=st.xxx)){
    let distance=min(h.t,1e30);
    if(any(md.emit!=vec3f(0.0))){
     let add=thr*md.emit*mediaIntegral(st,distance);L+=add;if(focused){C+=add;}
    }
    if(all(md.albedo==vec3f(0.0))){thr*=exp(-st*distance);}
    else{
     let channel=min(u32(rand()*3.0),2u);let rate=st[channel];
     var ts=INF;if(rate>0.0){ts=-log(1.0-rand())/rate;}
     let flight=ts<h.t;
     let t=select(distance,ts,flight);
     // Cancel the common exponential before forming ratios. No 0/0 at
     // very large optical depths; zero-extinction channels retain support.
     let relative=exp(-(st-min(min(st.x,st.y),st.z))*t);
     if(flight){
      let pdf=dot(st,relative)/3.0;
      thr*=relative*st*md.albedo/pdf;p=o+d*ts;
      if(feature){feature=false;res.albedo=tint*md.albedo;res.normal=-d;res.primary=select(0.0,1.0,bounces==0u);}
      bounces++;
      if((material(medium).flags&SUNLIT)!=0u){if(bounces>f.config.x||nu+4u*nd>=(f.limits.z>>16u)){break;}nu++;}
      else{if(bounces>f.config.x||nm>=(f.limits.z&0xffffu)){break;}nm++;}
      scatter=true;
     }else{thr*=relative/(dot(relative,vec3f(1.0))/3.0);}
    }
   }else{`,
    );
    edit('if(!scatter){thr*=exp(-md.absorb*h.t);}\n  }', 'if(!scatter){thr*=exp(-md.absorb*h.t);}\n   }\n  }');
    const helpers = /* wgsl */ `
fn mediaExtinction(id:u32)->vec3f {
 let m=material(id);
 if((m.flags&MEDIA)!=0u){return m.density*m.metalColor;}
 let md=mediumOf(id);return md.absorb+md.sigma;
}
// Integral of exp(-sigma t) over a segment. A short Taylor series avoids
// subtracting nearly equal floats in optically thin, emissive cells.
fn mediaIntegral(sigma:vec3f,d:f32)->vec3f {
 let tau=sigma*d;
 let series=d*(vec3f(1.0)-tau*0.5+tau*tau/6.0-tau*tau*tau/24.0);
 return select((vec3f(1.0)-exp(-tau))/sigma,series,tau<vec3f(0.001));
}
`;
    edit('@compute @workgroup_size(8,8) fn trace', helpers + '\n@compute @workgroup_size(8,8) fn trace');
    return source;
  }
}
