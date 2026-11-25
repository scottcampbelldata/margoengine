// The room as the scene's specular light in AR, from the WebXR Lighting Estimation API (W3C Immersive Web Working
// Group, immersive-web.github.io/lighting-estimation: XRLightProbe, `reflectionFormat`, `getReflectionCubeMap` and the
// `reflectionchange` event). Where the binding gives the probe's reflection cube map as a WebGPU texture it is copied
// into this class's own cube texture; where it does not (the spec gives the cube map to XRWebGLBinding only), the cube
// is painted from the probe's spherical harmonics, the 9-term radiance of Ramamoorthi and Hanrahan, "An Efficient
// Representation for Irradiance Environment Maps", SIGGRAPH 2001, so it is a blurred room (bands 0 to 2) and not a
// mirror. An Environment made from the texture (`Environment.create(engine, {texture})`) filters it into the specular
// mips and its own diffuse spherical harmonics.
import { shBasis } from '@margoengine/math/sh';
import { margoError } from '../../shared/errors.js';
import { ARLight, type ARHost } from './ar.js';
import type { XREyeTarget } from './eye-target.js';
import type { XRBinding } from './types.js';
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number; COPY_SRC: number };

/** What {@link ARReflection.create} needs of an `XR`. */
export interface ARReflectionHost extends ARHost {
  onEye(callback: (target: XREyeTarget) => void): () => void;
}
/** The part of an `Environment` that {@link ARReflection.attach} drives. */
export interface ReflectionEnvironment {
  refresh(): Promise<void>;
}
/** Options for {@link ARReflection.create}. */
export interface ARReflectionOptions {
  /** The engine's device (`engine.gpu`). */
  device: GPUDevice;
  /** An ARLight whose probe and estimate to use; one is made, and stopped with this, when left out. */
  light?: ARLight;
  /** Edge of the cube made from spherical harmonics, a power of two from 8 to 256. Default 32. */
  size?: number;
  /** Format asked of the browser's cube map. Default 'rgba16f'. */
  reflectionFormat?: 'srgb8' | 'rgba16f';
  /** Fewest milliseconds between two repaints from spherical harmonics. Default 500. */
  interval?: number;
  /** Paint from spherical harmonics even where the binding gives the browser's cube map. Default false. */
  forceSH?: boolean;
}
/** Where the cube's pixels come from. */
export type ReflectionSource = 'binding' | 'sh';

/** Cube layers, +X -X +Y -Y +Z -Z: the direction of texel (u, v), each -1 to 1 with v down. */
const FACES: Array<(u: number, v: number) => [number, number, number]> = [
  (u, v) => [1, -v, -u],
  (u, v) => [-1, -v, u],
  (u, v) => [u, 1, v],
  (u, v) => [u, -1, -v],
  (u, v) => [u, -v, 1],
  (u, v) => [-u, -v, -1],
];
const floatBits = new Float32Array(1),
  intBits = new Uint32Array(floatBits.buffer);
/** A non-negative number as binary16, truncated; beyond 65504 it holds 65504. */
function half(value: number): number {
  if (!(value > 0)) return 0;
  if (value >= 65504) return 0x7bff;
  floatBits[0] = value;
  const x = intBits[0],
    e = ((x >>> 23) & 255) - 112;
  if (e <= 0) return e < -10 ? 0 : ((x & 0x7fffff) | 0x800000) >>> (14 - e);
  return (e << 10) | ((x & 0x7fffff) >>> 13);
}

/**
 * Paints the cube of the room's radiance from the nine RGB spherical harmonics `sh` (`k * 3 + channel`, the order of
 * `@margoengine/math` SH3) into `rgba16float` words: 6 faces of `size * size` texels, 4 words each, row 0 at the top.
 */
export function paintCubeFromSH(sh: ArrayLike<number>, size: number): Uint16Array {
  const out = new Uint16Array(6 * size * size * 4),
    basis = new Float64Array(9);
  let i = 0;
  for (const face of FACES)
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const [dx, dy, dz] = face(((x + 0.5) * 2) / size - 1, ((y + 0.5) * 2) / size - 1);
        shBasis({ x: dx, y: dy, z: dz }, basis);
        for (let c = 0; c < 3; c++) {
          let sum = 0;
          for (let k = 0; k < 9; k++) sum += sh[k * 3 + c] * basis[k];
          out[i++] = half(sum);
        }
        out[i++] = 0x3c00;
      }
  return out;
}

/** Whether the browser's texture is a cube Margo's environment can take: rgba16float, square, power of two, 6 layers. */
function usable(t: GPUTexture | null | undefined): t is GPUTexture {
  return (
    !!t &&
    t.format === 'rgba16float' &&
    t.width === t.height &&
    (t.width & (t.width - 1)) === 0 &&
    t.depthOrArrayLayers === 6
  );
}

/**
 * The AR room's light as a cube texture for the scene's specular reflections, in a session started with the
 * 'light-estimation' feature. Read `texture` after `await reflection.ready`, make an Environment from it and
 * `attach` the Environment so it is filtered again each time the room's light changes.
 * @throws RangeError for a bad `size` or `interval`; MargoError 'state' and 'unsupported' as {@link ARLight.create}.
 */
export class ARReflection {
  /** Resolves with the cube texture once the first estimate arrived. */
  readonly ready: Promise<GPUTexture>;
  /** Where the last paint came from; null before the first. */
  source: ReflectionSource | null = null;
  /** Count of repaints. */
  updates = 0;
  private cube: GPUTexture | null = null;
  private environment: ReflectionEnvironment | null = null;
  private binding: XRBinding | undefined;
  private dirty = true;
  private last = -Infinity;
  private painted: Float32Array | null = null;
  private resolve!: (texture: GPUTexture) => void;
  private disposed = false;
  private readonly stops: Array<() => void> = [];
  private constructor(
    private readonly host: ARReflectionHost,
    private readonly light: ARLight,
    private readonly ownsLight: boolean,
    private readonly options: Required<Omit<ARReflectionOptions, 'light'>>,
  ) {
    this.ready = new Promise((resolve) => {
      this.resolve = resolve;
    });
    const probe = light.probe as unknown as EventTarget;
    const changed = () => {
      this.dirty = true;
    };
    probe.addEventListener?.('reflectionchange', changed);
    this.stops.push(
      () => probe.removeEventListener?.('reflectionchange', changed),
      host.onEye((target) => {
        this.binding = target.binding;
      }),
      host.onFrame((state) => this.update(state.time)),
    );
  }
  static async create(xr: ARReflectionHost, options: ARReflectionOptions): Promise<ARReflection> {
    const { size = 32, interval = 500, reflectionFormat = 'rgba16f', forceSH = false, device } = options;
    if (!device) throw margoError('state', 'ARReflection needs the engine device; pass device: engine.gpu');
    if (!(Number.isInteger(size) && size >= 8 && size <= 256 && (size & (size - 1)) === 0))
      throw new RangeError('ARReflection size is a power of two from 8 to 256; pass 32');
    if (!(Number.isFinite(interval) && interval >= 0))
      throw new RangeError('ARReflection interval is milliseconds, 0 or more; pass 500');
    const light = options.light ?? (await ARLight.withReflection(xr, { reflectionFormat }));
    return new ARReflection(xr, light, !options.light, { device, size, interval, reflectionFormat, forceSH });
  }
  /** The cube texture (rgba16float, 6 layers, COPY_SRC), or null before the first estimate. */
  get texture(): GPUTexture | null {
    return this.cube;
  }
  /** Gives the Environment made from `texture`; it is refreshed after each repaint. */
  attach(environment: ReflectionEnvironment): void {
    this.environment = environment;
  }
  private update(time: number): void {
    if (this.disposed) return;
    const { device, size, interval, forceSH } = this.options,
      probe = this.light.probe,
      native = forceSH ? null : this.binding?.getReflectionCubeMap?.(probe);
    let words: Uint16Array | null = null;
    if (usable(native)) {
      if (!this.dirty && this.cube) return;
      this.dirty = false;
      this.ensure(native.width);
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToTexture({ texture: native }, { texture: this.cube! }, [native.width, native.width, 6]);
      device.queue.submit([encoder.finish()]);
      this.source = 'binding';
    } else {
      const estimate = this.light.estimate;
      if (!estimate || time - this.last < interval) return;
      if (this.painted && estimate.sh.every((v, i) => Math.abs(v - this.painted![i]) < 1e-3 * (1 + Math.abs(v))))
        return;
      this.painted = Float32Array.from(estimate.sh);
      this.last = time;
      this.ensure(size);
      words = paintCubeFromSH(estimate.sh, size);
      device.queue.writeTexture(
        { texture: this.cube! },
        words as Uint16Array<ArrayBuffer>,
        { bytesPerRow: size * 8, rowsPerImage: size },
        [size, size, 6],
      );
      this.source = 'sh';
    }
    this.updates++;
    if (this.environment) this.environment.refresh().catch(() => {});
  }
  private ensure(edge: number): void {
    if (this.cube?.width === edge) return;
    this.cube?.destroy();
    this.cube = this.options.device.createTexture({
      size: [edge, edge, 6],
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
      label: 'AR reflection cube',
    });
    this.resolve(this.cube);
  }
  /** Stops following the room and frees the cube texture; the light it made is stopped too. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const stop of this.stops) stop();
    if (this.ownsLight) this.light.dispose();
    this.cube?.destroy();
    this.cube = null;
    this.environment = null;
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
