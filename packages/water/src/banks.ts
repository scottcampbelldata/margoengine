/// <reference lib="esnext.disposable" preserve="true" />
// Water over a clipmap terrain's coarse rings. A geometry clipmap (Losasso and Hoppe, "Geometry clipmaps: terrain
// rendering using nested regular grids", ACM TOG 23(3), 2004, https://doi.org/10.1145/1015706.1015799; with the CDLOD
// morph of Strugar, "Continuous Distance-Dependent Level of Detail for Rendering Heightmaps", JGT 14(4), 2009,
// https://doi.org/10.1080/2151237X.2009.10129287) samples the heights only at its vertices, whose spacing doubles ring
// by ring. Far off a channel narrower than a ring cell is bridged by triangles between its banks, which stand above the
// water, so the depth test hides the water wherever no vertex falls in the channel: a creek breaks into patches
// (KB-BIOMES-RIVERSTEP1). Each ring's geometric error is bounded by its spacing (Ulrich, "Rendering Massive Terrains
// using Chunked Level of Detail Control", SIGGRAPH 2002 course notes), so the water may pass ground drawn up to that
// error above it: every vertex of the surface moves toward the eye along its own view ray until it stands `slack`
// higher, which keeps its pixel and only brings its depth nearer (the projected-depth offset of Lengyel, "Tweaking a
// Vertex's Projected Depth Value", Game Programming Gems, 2000). The waterline then comes from the ground's own heights,
// not from the rings: a fragment over ground at or above the surface is dropped (the free surface's intersection with
// the bed, as Water's coastal grid draws it, at the terrain heightmap's resolution).
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type PassContext } from '@margoengine/core/extension';
import { addSurfaceEffect, surfaceEffects } from './surface-effects.js';
import type { Water } from './index.js';
import { fault, rangeError } from '../../shared/errors.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** Settings for {@link WaterBanks}. */
export interface WaterBanksOptions {
  /** Live Water attached to this engine, bounded (`horizon` false). */
  surface: Water;
  /**
   * The ground's heights as the terrain draws them: a sampleable `r32float` texture of world Y, its texels on the
   * corners of `origin` and `size` (as `Terrain` reads its heightmap with `heightScale` 1), read every frame. Undefined
   * draws the water as it was.
   */
  heightmap: () => GPUTexture | undefined;
  /** World XZ of the heightmap's first texel. */
  origin: readonly [number, number];
  /** World XZ extent the heightmap covers, each above 0 and at most 100,000. */
  size: readonly [number, number];
  /** The terrain's finest ring spacing in metres (`Terrain` `cellSize`), above 0. Default 1. */
  cell?: number;
  /** Cells per ring side (`Terrain` `resolution`), 8 to 256. Default 64. */
  resolution?: number;
  /** World XZ the rings are centred on (`Terrain` `clipmapAnchor`), or `'camera'`. Default `'camera'`. */
  centre?: readonly [number, number] | 'camera';
  /**
   * Steepest bank the rings' error is allowed for, rise over run, 0 to 10: the water passes ground drawn up to this
   * times a ring cell above it, beyond the rings that sample every texel. Default 0.25.
   */
  slope?: number;
  /** The most the water passes drawn ground by, metres, 0 to 100. Default 2 (a still river stands at most 1.5 m deep). */
  limit?: number;
}

let sequence = 0;
const scalar = (value: number, min: number, max: number, label: string): number => {
  if (!Number.isFinite(value) || value < min || value > max)
    throw rangeError(`Water banks ${label} must be a finite number from ${min} to ${max}`, 'geometry');
  return value;
};

/** The WGSL the surface shader gains: the ground's heights, the rings' error and the two uses of them. */
export function banksShader(binding: number): string {
  return `
struct BanksFrame {place:vec4f,rings:vec4f,error:vec4f}
@group(0) @binding(${binding}) var<uniform> banks:BanksFrame;
@group(0) @binding(${binding + 1}) var banksGround:texture_2d<f32>;
// The ground's own height at xz, bilinear between texels on the corners of the heightmap's rectangle; far below any
// water outside it or before the heights exist.
fn banksGroundAt(xz:vec2f)->f32 {
 let uv=(xz-banks.place.xy)/banks.place.zw;
 if(banks.error.z<0.5||any(uv<vec2f(0))||any(uv>vec2f(1))){return -1e30;}
 let size=vec2i(textureDimensions(banksGround));let pixel=uv*vec2f(size-vec2i(1));let lo=vec2i(floor(pixel));
 let hi=min(lo+vec2i(1),size-vec2i(1));let t=fract(pixel);
 let a=mix(textureLoad(banksGround,lo,0).r,textureLoad(banksGround,vec2i(hi.x,lo.y),0).r,t.x);
 let b=mix(textureLoad(banksGround,vec2i(lo.x,hi.y),0).r,textureLoad(banksGround,hi,0).r,t.x);
 return mix(a,b,t.y);
}
// How far the rings may draw the ground above its heights at xz: ring i reaches resolution / 2 cells of cell 2^i from
// the centre and morphs to twice its spacing toward its edge, so the spacing there is at most cell 2^(i+1). Rings whose
// spacing is a texel or less sample every texel: no error.
fn banksSlack(xz:vec2f)->f32 {
 if(banks.error.z<0.5){return 0.0;}
 let size=vec2f(textureDimensions(banksGround));
 let texel=max(banks.place.z/max(size.x-1.0,1.0),banks.place.w/max(size.y-1.0,1.0));
 let d=max(abs(xz.x-banks.rings.x),abs(xz.y-banks.rings.y));
 let level=max(0.0,ceil(log2(max(d,0.001)/(banks.rings.w*0.5*banks.rings.z))));
 return clamp((banks.rings.z*exp2(level+1.0)-texel)*banks.error.x,0.0,banks.error.y);
}
// The surface point moved toward the eye along its view ray until it stands slack higher: the same pixel, a nearer
// depth. At most half way, for an eye only just above the water.
fn banksPull(p:vec3f)->vec3f {
 let s=banksSlack(p.xz);let rise=frame.eye.y-p.y;
 if(s<=0.0||rise<=0.0){return p;}
 return p+(frame.eye.xyz-p)*min(s/rise,0.5);
}
fn banksDry(xz:vec2f,level:f32)->bool {return banksGroundAt(xz)>=level;}
`;
}

const vertexMark = 'var clip=frame.camera*vec4f(v.position,1);';
const vertexHead = '@vertex fn vertex(@location(0) grid:vec2f';
const dryMark = 'if(dry';

/**
 * Lets a bounded Water show through a clipmap terrain's coarse rings where its own heights hold water: far off, a
 * channel narrower than a ring cell is no longer covered by triangles bridging its banks, and the waterline follows the
 * heightmap instead of the rings (KB-BIOMES-RIVERSTEP1). Near the camera, where the rings sample every texel, the water
 * is drawn as before. `BiomeView` attaches one to its river and lake water.
 * @example
 * const banks = WaterBanks.attach(engine, {
 *   surface: water,
 *   heightmap: () => heights,
 *   origin: [-2048, -2048],
 *   size: [4096, 4096],
 * });
 */
export class WaterBanks implements EnginePlugin {
  readonly name = `water:banks-${sequence++}`;
  private readonly surface: Water;
  private readonly heightmap: () => GPUTexture | undefined;
  private readonly centre: readonly [number, number] | 'camera';
  private readonly values = new Float32Array(12);
  private engine?: Engine;
  private uniform?: GPUBuffer;
  private fallback?: GPUTexture;
  private ground?: { texture: GPUTexture; view: GPUTextureView };
  private resources: GPUBindingResource[] = [];
  private remove?: () => void;
  private removeDispose?: () => void;
  private disposed = false;

  constructor(options: WaterBanksOptions) {
    if (!options?.surface || typeof options.surface.onDispose !== 'function')
      throw fault('state', 'Water banks need a Water surface; pass options.surface');
    if (typeof options.heightmap !== 'function')
      throw rangeError('Water banks heightmap must be a function returning an r32float texture', 'geometry');
    const pair = (v: unknown, min: number, label: string): readonly [number, number] => {
      if (!Array.isArray(v) || v.length !== 2) throw rangeError(`Water banks ${label} must be [x, z]`, 'geometry');
      return [scalar(v[0], min, 1e7, label), scalar(v[1], min, 1e7, label)];
    };
    const origin = pair(options.origin, -1e7, 'origin'),
      size = pair(options.size, 0, 'size');
    if (!(size[0] > 0 && size[1] > 0 && size[0] <= 100000 && size[1] <= 100000))
      throw rangeError('Water banks size must be above 0 and at most 100,000 on each axis', 'geometry');
    const resolution = scalar(options.resolution ?? 64, 8, 256, 'resolution'),
      cell = options.cell ?? 1;
    if (!(Number.isFinite(cell) && cell > 0 && cell <= 1e5))
      throw rangeError('Water banks cell must be above 0 and at most 100,000', 'geometry');
    this.centre =
      options.centre === undefined || options.centre === 'camera' ? 'camera' : pair(options.centre, -1e7, 'centre');
    this.surface = options.surface;
    this.heightmap = options.heightmap;
    this.values.set([
      origin[0],
      origin[1],
      size[0],
      size[1],
      0,
      0,
      cell,
      resolution,
      scalar(options.slope ?? 0.25, 0, 10, 'slope'),
      scalar(options.limit ?? 2, 0, 100, 'limit'),
    ]);
  }
  /** Attach after the Water surface. */
  static attach(engine: EngineKernel, options: WaterBanksOptions): WaterBanks {
    const value = new WaterBanks(options);
    engineRuntime(engine).use(value);
    return value;
  }
  setup(engine: Engine): void {
    this.live();
    if (this.engine) throw fault('attached', 'Water banks already attached; create another WaterBanks', 'state');
    if (!engine.gpu)
      throw fault('unsupported', 'Water banks need WebGPU or the full WebGL2 compatibility layer', 'webgpu');
    if (!engine.hasPlugin(this.surface.name))
      throw fault('state', 'Attach the Water surface to this engine before WaterBanks');
    if (surfaceEffects.get(this.surface)?.some((e) => e.key === 'banks'))
      throw fault('attached', 'Water already has banks; change the attached one', 'state');
    this.engine = engine;
    this.uniform = engine.gpu.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.fallback = engine.gpu.createTexture({
      size: [1, 1],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.resources = [{ buffer: this.uniform }, this.fallback.createView()];
    this.remove = addSurfaceEffect(this.surface, {
      key: 'banks',
      vertex: false,
      count: 2,
      shader: (code, binding) => {
        if (
          code.split(vertexMark).length !== 2 ||
          code.split(vertexHead).length !== 2 ||
          code.split(dryMark).length !== 2
        )
          throw fault(
            'unsupported',
            'Water banks need a bounded Water surface (horizon false) from the same water package version',
          );
        return code
          .replace(vertexHead, banksShader(binding) + '\n' + vertexHead)
          .replace(vertexMark, 'var clip=frame.camera*vec4f(banksPull(v.position),1);')
          .replace(dryMark, 'if(banksDry(i.xz,i.world.y)){discard;}\n ' + dryMark);
      },
      prepare: (c) => this.prepare(c),
    });
    this.removeDispose = this.surface.onDispose(() => this.dispose());
  }
  private prepare(c: Context): readonly GPUBindingResource[] {
    if (c.device !== this.engine?.gpu)
      throw fault('state', 'Water banks and Water must use the same engine; attach both to one engine');
    const texture = this.heightmap();
    if (texture !== this.ground?.texture) {
      this.ground = texture ? { texture, view: texture.createView() } : undefined;
      this.resources = [this.resources[0], this.ground?.view ?? this.fallback!.createView()];
    }
    const centre = this.centre === 'camera' ? [c.camera.position[0], c.camera.position[2]] : this.centre;
    this.values[4] = centre[0];
    this.values[5] = centre[1];
    this.values[10] = this.ground ? 1 : 0;
    c.device.queue.writeBuffer(this.uniform!, 0, this.values);
    return this.resources;
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.engine = undefined;
    this.setup(engine);
  }
  private live(): void {
    if (this.disposed) throw fault('disposed', 'Water banks disposed; create another WaterBanks');
  }
  private release(): void {
    this.remove?.();
    this.removeDispose?.();
    this.remove = this.removeDispose = undefined;
    this.uniform?.destroy();
    this.fallback?.destroy();
    this.uniform = this.fallback = this.ground = undefined;
    this.resources = [];
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
