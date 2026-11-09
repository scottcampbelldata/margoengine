import type { EngineKernel } from '@margoengine/core';
import { MargoError } from '@margoengine/math/errors';
import { VoxelPathTracer, type VoxelPathTracerOptions } from '@margoengine/voxel-pathtracer';
import { validateFeatureOptions, type VoxelTraceFeature } from './compose-types.js';

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

/** Deferred hero transport and an optional lens for a composed tracer. Defaults: achromatic, focal length 0.05. */
export function spectralTransport(
  options: Pick<SpectralVoxelPathTracerOptions, 'lensAbbe' | 'focalLength'> = {},
): VoxelTraceFeature {
  validateFeatureOptions(options, 'spectralTransport');
  const abbe = number(options.lensAbbe === undefined ? 0 : options.lensAbbe, 'lensAbbe', 0, 200);
  const focal = number(options.focalLength === undefined ? 0.05 : options.focalLength, 'focalLength', 1e-6, 1e6);
  if (abbe !== 0 && abbe < 5) throw new RangeError('SpectralVoxelPathTracer lensAbbe must be 0 or 5 to 200');
  return Object.freeze({ id: 'spectral', source: (source: string) => spectralSource(source, abbe, focal) });
}

/**
 * One RGB path carries wavelength-independent transport. At the first dispersive
 * glass interface (or an active dispersive camera lens), sample an importance-
 * weighted hero once. Earlier contributions stay RGB; later ones use its weight.
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
    return spectralSource(super.tracingSource(), this.#abbe, this.#focal);
  }
}

function spectralSource(input: string, abbe: number, focal: number): string {
  let source = input;
  const edit = (from: string, to: string) => {
    if (!source.includes(from))
      throw new MargoError(
        'state',
        'Spectral kernel mismatch; rebuild the package, see https://margoengine.com/errors#voxel-pathtracer',
      );
    source = source.replace(from, to);
  };
  edit('fn radiance(px:vec2u)->Path {', 'var<private> spectralLambda:f32;\nfn radiance(px:vec2u)->Path {');
  // Keep the root's deferred, importance-sampled collapse for glass. Only an
  // active chromatic lens needs a wavelength before its camera ray is made.
  edit(
    ' let ray=cameraRay(vec2f(px)+jit);',
    ` var cameraLambda=bitcast<f32>(f.lights.w);var cameraWeight=vec3f(1.0);
 if(${abbe > 0 ? 'true' : 'false'}&&f.forward.w>0.0&&f.projection.x==0u){collapse(&cameraLambda,&cameraWeight);}
 spectralLambda=cameraLambda;
 let ray=cameraRay(vec2f(px)+jit);`,
  );
  edit('var thr=vec3f(1.0);var L=vec3f(0.0);', 'var thr=cameraWeight;var L=vec3f(0.0);');
  edit('var lambda=bitcast<f32>(f.lights.w);', 'var lambda=cameraLambda;');
  // Alpha estimates geometric coverage, so its wavelength density stays uniform
  // and receives no colour weight. Never consume wavelength draws for a pinhole.
  edit(
    '  let ray=cameraRay(vec2f(px)+(vec2f(f32(s%8u),f32(s/8u))',
    `  spectralLambda=bitcast<f32>(f.lights.w);
  if(${abbe > 0 ? 'true' : 'false'}&&f.forward.w>0.0&&f.projection.x==0u&&spectralLambda<=0.0){spectralLambda=380.0+400.0*rand();}
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
  const power = abbe === 0 ? 0 : 1 / (abbe * (1 / 0.4861 ** 2 - 1 / 0.6563 ** 2) * focal);
  if (abbe > 0)
    edit(
      'r.d=normalize(focus-r.o);',
      `r.d=normalize(focus-r.o);
  let um=spectralLambda*0.001;
  let dp=${power.toExponential(12)}*(1.0/(um*um)-1.0/(0.5876*0.5876));
  r.d=normalize(r.d/dot(r.d,fw)-(rt*l.x+up*l.y)*dp);`,
    );
  return source;
}
