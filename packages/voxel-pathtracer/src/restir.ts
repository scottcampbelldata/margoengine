import type { EngineKernel } from '@margoengine/core';
import { MargoError } from '@margoengine/math/errors';
import { VoxelPathTracer, type VoxelPathTracerOptions } from '@margoengine/voxel-pathtracer';

/** Options for emissive-face resampled importance sampling. */
export interface ResampledVoxelPathTracerOptions extends VoxelPathTracerOptions {
  /** Light and directional proposals per shading point, integer 1 to 64. Default 8. */
  candidates?: number;
}

/**
 * Optional many-light sampler using Bitterli et al. 2020, sections 2 and 3 (RIS).
 * Combines power-weighted light and cosine/phase proposals using balance MIS
 * (Wyman et al. 2023, section 3.3). Visibility is included in the reservoir target.
 * No spatial or temporal reuse. All other tracing and lifecycle behavior is inherited.
 */
export class ResampledVoxelPathTracer extends VoxelPathTracer {
  private readonly candidates: number;

  protected constructor(options: ResampledVoxelPathTracerOptions) {
    if (!options || typeof options !== 'object')
      throw new TypeError('ResampledVoxelPathTracer.attach expects (engine, {scene, ...options})');
    const { candidates = 8, ...rest } = options;
    if (typeof candidates !== 'number') throw new TypeError('ResampledVoxelPathTracer candidates must be a number');
    if (!Number.isInteger(candidates) || candidates < 1 || candidates > 64)
      throw new RangeError('ResampledVoxelPathTracer candidates must be an integer from 1 to 64');
    super(rest);
    this.candidates = candidates;
  }

  /** Attach with 8 proposals by default; `candidates: 1` uses the original kernel exactly. */
  static override attach(engine: EngineKernel, options: ResampledVoxelPathTracerOptions): ResampledVoxelPathTracer {
    return super.attach(engine, options) as ResampledVoxelPathTracer;
  }

  protected override tracingSource(): string {
    const source = super.tracingSource();
    if (this.candidates === 1) return source;
    const edits = [
      ['var<private> rng:u32;', 'var<private> rng:u32;var<private> emitterSearch:bool;'],
      // Directional light proposals pass media without scattering. The final shadow
      // evaluation supplies their transmittance, just as for power-based proposals.
      ['let u=ue;', 'let u=select(ue,0u,emitterSearch&&(u32(mat(ue*MV+3u).w)&MEDIA)!=0u);'],
      [
        'let v=select(0u,base|pv,pv!=0u);',
        'var v=select(0u,base|pv,pv!=0u);if(emitterSearch&&(u32(mat(v*MV+3u).w)&MEDIA)!=0u){v=0u;}',
      ],
      ['pv!=0u&&!uniform&&!step);', 'v!=0u&&!uniform&&!step);'],
      [
        'let t=rectHit(k,o,d);\n  if(t<=0.0',
        'if(emitterSearch&&!opaqueArea(k)){continue;}\n  let t=rectHit(k,o,d);\n  if(t<=0.0',
      ],
      ['var ls:LightPoint;', 'if(q==1u){L+=resampledEmitters(kind,m,n,wo,o,mask);continue;}\n   var ls:LightPoint;'],
      // This integral is now entirely estimated by the mixed reservoir. Delta
      // paths and camera emission (lastPdf == 0) retain their original treatment.
      ['return power2(lastPdf,lp);', 'return 0.0;'],
    ];
    if (edits.some(([original]) => !source.includes(original)))
      throw new MargoError(
        'state',
        'Emissive sampling kernel does not match this tracer; rebuild the package, see https://margoengine.com/errors#voxel-pathtracer',
      );
    let result = source;
    for (const [original, replacement] of edits) result = result.replace(original, replacement);
    const lights = Math.ceil(this.candidates / 2),
      directions = Math.floor(this.candidates / 2);
    const helpers = /* wgsl */ `
// A directional proposal's emitting surface and the power sampler's area PDF.
fn directionalEmitter(o:vec3f,wi:vec3f)->LightPoint {
 var light:LightPoint;
 emitterSearch=true;
 let h=closest(o,wi,0u,NONE);
 emitterSearch=false;
 if(h.inst>=AREA||h.value==0u){return light;}
 let m=material(h.value);
 if((m.flags&EMISSIVE)==0u){return light;}
 let ib=f.scene.y+h.inst*INSTANCE;
 let total=fl(f.scene.x+scene[ib+36u]*MODEL+10u);
 let pick=fl(ib+38u);
 if(pick<=0.0||total<=0.0){return light;}
 let w=worldX(h.inst);
 let area=length(cross(colOf(w,(h.axis+1u)%3u),colOf(w,(h.axis+2u)%3u)));
 // End shadow rays outside the emitting voxel, as sampleEmitter does. Ending
 // exactly on its face lets rounding put the endpoint inside its own occluder.
 light.p=o+wi*h.t+h.sgn*EPS*colOf(w,h.axis);
 light.n=h.sgn*normalize(rowOf(localX(h.inst),h.axis));
 light.radiance=m.emission;
 light.pdfA=pick*lum(m.emission)/total/area;
 return light;
}
// Each candidate contributes f / (N_light p_light + N_direction p_direction).
// The weights partition unity in solid angle, including null/missed candidates.
// With target luminance(f), the selected RGB contribution is sum(weights)*RGB/luminance(RGB).
fn resampledEmitters(kind:u32,m:Mat,n:vec3f,wo:vec3f,o:vec3f,mask:u32)->vec3f {
 var kept=vec3f(0.0);var scale=0.0;var sum=0.0;
 for(var candidate=0u;candidate<${this.candidates}u;candidate++){
  var light:LightPoint;
  if(candidate<${lights}u){light=sampleEmitter();}
  else{
   var wi=cosineDir(n);
   if(kind==1u){wi=sampleHg(-wo,m.g);}
   light=directionalEmitter(o,wi);
  }
  if(light.pdfA<=0.0){continue;}
  let v=light.p-o;let d2=dot(v,v);
  if(d2<=0.0){continue;}
  let wi=v/sqrt(d2);var cosine=-dot(light.n,wi);
  if(light.twoSided){cosine=abs(cosine);}
  if(cosine<=0.0){continue;}
  let e=evalAt(kind,m,n,wo,wi,mask);
  var bp=max(dot(n,wi),0.0)*INV_PI;
  if(kind==1u){bp=hgPdf(dot(-wo,wi),m.g);}
  let denominator=${lights}.0*light.pdfA*d2/cosine+${directions}.0*bp;
  var visibility=shadow(o,wi,sqrt(d2));
  if(f.fog.z>0.0){visibility*=exp(-f.fog.x*sqrt(d2));}
  let contribution=e.f*light.radiance*visibility/denominator;
  let weight=lum(contribution);
  if(weight<=0.0){continue;}
  // Normalize by the largest weight so the reservoir sum cannot overflow as candidates accumulate.
  if(weight>scale){sum*=scale/weight;scale=weight;}
  let scaled=weight/scale;sum+=scaled;
  if(rand()*sum<scaled){kept=contribution/weight;}
 }
 return kept*(scale*sum);
}
`;
    // The compatibility route extracts declarations before the compute entry.
    const entry = '@compute @workgroup_size(8,8) fn trace';
    return result.replace(entry, helpers + '\n' + entry);
  }
}
