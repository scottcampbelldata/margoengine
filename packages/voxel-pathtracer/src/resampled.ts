import type { EngineKernel } from '@margoengine/core';
import { MargoError } from '@margoengine/math/errors';
import { VoxelPathTracer, type VoxelPathTracerOptions } from '@margoengine/voxel-pathtracer';
import { validateFeatureOptions, type VoxelTraceFeature } from './compose-types.js';

/** Options for emissive-face resampled importance sampling. */
export interface ResampledVoxelPathTracerOptions extends VoxelPathTracerOptions {
  /** Light and directional proposals per shading point, integer 1 to 64. Default 8. */
  candidates?: number;
}

function candidateCount(candidates: number): number {
  if (typeof candidates !== 'number') throw new TypeError('ResampledVoxelPathTracer candidates must be a number');
  if (!Number.isInteger(candidates) || candidates < 1 || candidates > 64)
    throw new RangeError('ResampledVoxelPathTracer candidates must be an integer from 1 to 64');
  return candidates;
}

/** Many-light RIS for a composed tracer. Default 8 proposals; 1 retains the root sampler. */
export function resampledEmitters(
  options: Pick<ResampledVoxelPathTracerOptions, 'candidates'> = {},
): VoxelTraceFeature {
  validateFeatureOptions(options, 'resampledEmitters');
  const candidates = candidateCount(options.candidates === undefined ? 8 : options.candidates);
  return Object.freeze({ id: 'resampling', source: (source: string) => resampledSource(source, candidates) });
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
    candidateCount(candidates);
    super(rest);
    this.candidates = candidates;
  }

  /** Attach with 8 proposals by default; `candidates: 1` uses the original kernel exactly. */
  static override attach(engine: EngineKernel, options: ResampledVoxelPathTracerOptions): ResampledVoxelPathTracer {
    return super.attach(engine, options) as ResampledVoxelPathTracer;
  }

  protected override tracingSource(): string {
    return resampledSource(super.tracingSource(), this.candidates);
  }
}

function resampledSource(source: string, candidates: number): string {
  if (candidates === 1) return source;
  const lights = Math.ceil(candidates / 2),
    directions = Math.floor(candidates / 2);
  // One proposal per pass of the light kinds loop: light kind 1 runs KIND_REPEAT.y times in a row (the WebGL2 route
  // draws its sample, shadow and gather programs that many times, src/compat-staged.ts), and the reservoir lives in
  // private state between the passes. A loop of proposals inside one pass held closest() and shadow() in one staged
  // program; fxc (ANGLE Direct3D 11) took 254 s to link it and 356 s more at its first draw (KB-L5a-3). The proposals,
  // their random numbers and the sums are those of the loop, in the same order.
  const edits: [string | RegExp, (match: string) => string][] = [
    [
      'var<private> rng:u32;',
      (m) =>
        `${m}var<private> emitterSearch:bool;var<private> risC:u32;var<private> risKept:vec3f;var<private> risScale:f32;var<private> risSum:f32;`,
    ],
    // Directional light proposals pass media without scattering. The final shadow
    // evaluation supplies their transmittance, just as for power-based proposals.
    ['let u=ue;', () => 'let u=select(ue,0u,emitterSearch&&(u32(mat(ue*MV+3u).w)&MEDIA)!=0u);'],
    [
      'let v=select(0u,base|pv,pv!=0u);',
      () => 'var v=select(0u,base|pv,pv!=0u);if(emitterSearch&&(u32(mat(v*MV+3u).w)&MEDIA)!=0u){v=0u;}',
    ],
    ['pv!=0u&&!uniform&&!step);', () => 'v!=0u&&!uniform&&!step);'],
    [
      'let t=rectHit(k,o,d);\n  if(t<=0.0',
      () => 'if(emitterSearch&&!opaqueArea(k)){continue;}\n  let t=rectHit(k,o,d);\n  if(t<=0.0',
    ],
    // Pass start: the first proposal empties the reservoir; the pass after the last adds its estimate to L (where the
    // loop added it, before kind 2 adds anything). Natively the loop goes back to kind 1 until every proposal ran.
    [
      /for\(var q=0u;q<[^;{}]+;q\+\+\)\{/,
      (m) =>
        `${m}\n   if(q==1u){if(risC==0u){risKept=vec3f(0.0);risScale=0.0;risSum=0.0;}risC++;}` +
        `else if(q==2u&&risC!=0u){if(risC<KIND_REPEAT.y){q=1u;risC++;}else{L+=risKept*(risScale*risSum);risC=0u;}}`,
    ],
    // The proposal: power-sampled emitters first, then cosine (or phase) directions to the emitter they meet.
    [
      'if(q==1u){ls=sampleEmitter();}',
      () =>
        `if(q==1u){if(risC<=${lights}u){ls=sampleEmitter();}else{var wd=cosineDir(n);if(kind==1u){wd=sampleHg(-wo,m.g);}ls=directionalEmitter(o,wd);}}`,
    ],
    ['let v=ls.p-o;let d2=dot(v,v);', (m) => `${m}if(q==1u&&d2<=0.0){continue;}`],
    // Each proposal contributes f / (N_light p_light + N_direction p_direction); lp holds that denominator.
    [
      'radiance=ls.radiance;lp=ls.pdfA*d2/cl;',
      (m) =>
        `${m}\n   if(q==1u){var bp=max(dot(n,wi),0.0)*INV_PI;if(kind==1u){bp=hgPdf(dot(-wo,wi),m.g);}lp=${lights}.0*ls.pdfA*d2/cl+${directions}.0*bp;}`,
    ],
    // The weights partition unity in solid angle, including null and missed proposals. With target luminance(f), the
    // selected RGB contribution is sum(weights)*RGB/luminance(RGB). The largest weight normalizes the sum so it cannot
    // overflow as proposals accumulate. Visibility is in the target; a proposal no BSDF lobe reaches adds nothing.
    [
      'if(fogged&&!far){v*=exp(-f.fog.x*dist);}',
      (m) =>
        `${m}\n    if(q==1u){let contribution=e.f*radiance*v/lp;let weight=lum(contribution);if(!(weight<=0.0)){` +
        'if(weight>risScale){risSum*=risScale/weight;risScale=weight;}let scaled=weight/risScale;risSum+=scaled;' +
        'if(rand()*risSum<scaled){risKept=contribution/weight;}}}\n    else ',
    ],
    // This integral is now entirely estimated by the mixed reservoir. Delta
    // paths and camera emission (lastPdf == 0) retain their original treatment.
    ['return power2(lastPdf,lp);', () => 'return 0.0;'],
  ];
  if (edits.some(([original]) => (typeof original === 'string' ? !source.includes(original) : !original.test(source))))
    throw new MargoError(
      'state',
      'Emissive sampling kernel does not match this tracer; rebuild the package, see https://margoengine.com/errors#voxel-pathtracer',
    );
  let result = source;
  for (const [original, replacement] of edits) result = result.replace(original, replacement);
  const helpers = /* wgsl */ `
// Light kind 1 runs once per proposal (x: the kind, y: the passes).
const KIND_REPEAT=vec2u(1u,${candidates}u);
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
 let x=instX(h.inst);let w=x.world;
 let area=length(cross(colOf(w,(h.axis+1u)%3u),colOf(w,(h.axis+2u)%3u)));
 // End shadow rays outside the emitting voxel, as sampleEmitter does. Ending
 // exactly on its face lets rounding put the endpoint inside its own occluder.
 light.p=o+wi*h.t+h.sgn*EPS*colOf(w,h.axis);
 light.n=h.sgn*normalize(rowOf(x.local,h.axis));
 light.radiance=m.emission;
 light.pdfA=pick*lum(m.emission)/total/area;
 return light;
}
`;
  // The compatibility route extracts declarations before the compute entry.
  const entry = '@compute @workgroup_size(8,8) fn trace';
  return result.replace(entry, helpers + '\n' + entry);
}
