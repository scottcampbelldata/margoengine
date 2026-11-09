import type { EngineKernel } from '@margoengine/core';
import { MargoError } from '@margoengine/math/errors';
import { VoxelPathTracer, type VoxelPathTracerOptions } from '@margoengine/voxel-pathtracer';

/** Hero-wavelength transport and an optional paraxial dispersive thin lens. */
export interface SpectralVoxelPathTracerOptions extends VoxelPathTracerOptions {
  /** Lens Abbe number, fixed at attachment: 0 (achromatic), or 5 to 200. Default 0. Camera projection only. */
  lensAbbe?: number;
  /** Lens focal length, fixed at attachment, in world units, 1e-6 to 1e6. Default 0.05 (50 mm in metre scenes). */
  focalLength?: number;
}

function number(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number') throw new TypeError(`SpectralVoxelPathTracer ${name} must be a number`);
  if (!Number.isFinite(value) || value < min || value > max)
    throw new RangeError(`SpectralVoxelPathTracer ${name} must be finite and between ${min} and ${max}`);
  return value;
}

/**
 * Four equally spaced wavelengths follow a uniform hero. Companion paths use the
 * same random stream and end at the first dispersive interface; the hero then
 * carries their weight. A dispersive camera lens collapses the packet at the sensor.
 * RGB material/light coefficients retain the root integrator's colour model.
 */
export class SpectralVoxelPathTracer extends VoxelPathTracer {
  readonly #abbe: number;
  readonly #focal: number;

  protected constructor(options: SpectralVoxelPathTracerOptions) {
    if (!options || typeof options !== 'object')
      throw new TypeError('SpectralVoxelPathTracer.attach expects (engine, {scene, ...options})');
    const { lensAbbe = 0, focalLength = 0.05, ...rest } = options;
    const abbe = number(lensAbbe, 'lensAbbe', 0, 200),
      focal = number(focalLength, 'focalLength', 1e-6, 1e6);
    if (abbe !== 0 && abbe < 5) throw new RangeError('SpectralVoxelPathTracer lensAbbe must be 0 or 5 to 200');
    super(rest);
    this.#abbe = abbe;
    this.#focal = focal;
  }

  /** Attach with the root lifecycle, AOV and capture APIs. Plain WebGL2 reports linked unsupported. */
  static override attach(engine: EngineKernel, options: SpectralVoxelPathTracerOptions): SpectralVoxelPathTracer {
    return super.attach(engine, options) as SpectralVoxelPathTracer;
  }

  protected override tracingSource(): string {
    let source = super.tracingSource();
    const edit = (from: string, to: string) => {
      if (!source.includes(from))
        throw new MargoError(
          'state',
          'Spectral kernel mismatch; rebuild the package, see https://margoengine.com/errors#voxel-pathtracer',
        );
      source = source.replace(from, to);
    };
    edit(
      'fn radiance(px:vec2u)->Path {',
      `var<private> spectralLambda:f32;
var<private> spectralLane:u32;
var<private> spectralFixed:bool;
var<private> spectralSplit:bool;
var<private> spectralDiscard:bool;
fn spectralPath(px:vec2u)->Path {`,
    );
    edit('var lambda=bitcast<f32>(f.lights.w);', 'var lambda=spectralLambda;');
    const a = source.indexOf('fn collapse('),
      b = source.indexOf('fn groundMat()', a);
    if (a < 0 || b < a)
      throw new MargoError('state', 'Spectral collapse mismatch; see https://margoengine.com/errors#voxel-pathtracer');
    edit(
      source.slice(a, b),
      `fn collapse(lambda:ptr<function,f32>,thr:ptr<function,vec3f>) {
 if(spectralFixed||spectralSplit){return;}
 spectralSplit=true;
 if(spectralLane!=0u){spectralDiscard=true;return;}
 *thr*=4.0;
}
`,
    );
    // Each call is inside the integrator loop. Stop companions before sampling a
    // wavelength-dependent direction, preserving their already accumulated light.
    source = source.replaceAll('collapse(&lambda,&thr);', 'collapse(&lambda,&thr);if(spectralDiscard){break;}');
    edit(
      '  let ray=cameraRay(vec2f(px)+(vec2f(f32(s%8u),f32(s/8u))',
      `  spectralLambda=bitcast<f32>(f.lights.w);
  if(spectralLambda<=0.0){spectralLambda=380.0+400.0*rand();}
  let ray=cameraRay(vec2f(px)+(vec2f(f32(s%8u),f32(s/8u))`,
    );
    edit(
      ' s.ok=true;\n return s;\n}\n// One lobe',
      ' s.w*=select(1.0,eta*eta,s.transmit);\n s.ok=true;\n return s;\n}\n// One lobe',
    );
    edit('wT*=1.0-fr;', 'wT*=(1.0-fr)*ma.ior*ma.ior;');
    edit('*(1.0-fr);wJ*=', '*(1.0-fr)*eta*eta;wJ*=');
    // Lensmaker power: P(lambda)-P(d) = B/(n_d-1)/f * (lambda^-2-d^-2).
    // Slope form remains finite when the wavelength focus passes through infinity.
    const power = this.#abbe === 0 ? 0 : 1 / (this.#abbe * (1 / 0.4861 ** 2 - 1 / 0.6563 ** 2) * this.#focal);
    edit(
      'r.d=normalize(focus-r.o);',
      `r.d=normalize(focus-r.o);
  let um=spectralLambda*0.001;
  let dp=${power.toExponential(12)}*(1.0/(um*um)-1.0/(0.5876*0.5876));
  r.d=normalize(r.d/dot(r.d,fw)-(rt*l.x+up*l.y)*dp);`,
    );
    edit(
      '@compute @workgroup_size(8,8) fn trace(',
      `fn radiance(px:vec2u)->Path {
 let fixed=bitcast<f32>(f.lights.w);
 spectralFixed=fixed>0.0;
 var hero=0.0;if(!spectralFixed){hero=rand();}let pathSeed=rng;
 var result:Path;
 for(var lane=0u;lane<4u;lane++){
  if(spectralFixed&&lane>0u){break;}
  // A dispersive lens chooses the hero direction before the scene is reached.
  if(${this.#abbe > 0 ? 'true' : 'false'}&&f.forward.w>0.0&&f.projection.x==0u&&lane>0u){break;}
  spectralLane=lane;spectralSplit=${this.#abbe > 0 ? 'true' : 'false'}&&f.forward.w>0.0&&f.projection.x==0u;spectralDiscard=false;
  spectralLambda=select(380.0+400.0*fract(hero+f32(lane)*0.25),fixed,spectralFixed);
  rng=pathSeed;
  let p=spectralPath(px);
  var weight=100.0*spectralRgb(spectralLambda);
  if(${this.#abbe > 0 ? 'true' : 'false'}&&f.forward.w>0.0&&f.projection.x==0u){weight*=4.0;}
  if(spectralFixed){weight=vec3f(1.0);}
  result.color+=p.color*weight;result.caustic+=p.caustic*weight;
  if(lane==0u){result.albedo=p.albedo;result.normal=p.normal;result.inv=p.inv;result.primary=p.primary;}
 }
 return result;
}
@compute @workgroup_size(8,8) fn trace(`,
    );
    return source;
  }
}
