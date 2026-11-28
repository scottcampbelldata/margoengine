/// <reference lib="esnext.disposable" preserve="true" />
// Ground contact (`@margoengine/terrain/ground-contact`): a terrain lighting effect that draws the ground around the
// feet of the objects standing on it, a ring of soil and litter and the sky light the object keeps from the ground, so
// trunks and stones sit in the hill instead of on it.
//
// - Footprints (x, z, radius, kind) are kept by key and baked on the CPU into one rg8 mask around the camera: red the
//   soil weight, green the share of the sky's light lost. The mask is re-centred when the camera has moved far enough
//   and rebaked when footprints in it change.
// - Sky lost: the ground at distance d from the foot of a body of radius r loses the form factor of a sphere resting
//   there, (1 + (d / r)^2)^-1.5 (Quilez, "Sphere ambient occlusion", https://iquilezles.org/articles/sphereao/; the
//   analytic occluder of Evans, "Fast Approximations for Global Illumination on Dynamic Scenes", SIGGRAPH 2006 course),
//   faded to 0 from 3.5 to 4 radii. A trunk, thinner than a sphere of its radius is tall, takes 0.6 of it (chosen).
// - Soil around a trunk: weight exp(-s / (1.1 r)) at s metres past the bark, none beyond 3 radii. Duff is deepest at
//   the stem and thins outward under mature pine (Ryan and Frandsen 1991, "Basal injury from smoldering fires in mature
//   Pinus ponderosa Laws.", International Journal of Wildland Fire 1(2):107-118,
//   https://www.fs.usda.gov/rm/pubs/rmrs_gtr292/1991_ryan.pdf); the 1.1 radii e-fold is a fit chosen for conifers.
// - Soil around a stone: full to a quarter radius (at least 0.06 m) past its edge, then an e-fold of 0.35 radius (at
//   least 0.05 m), at 0.75 strength. No measurement of this ring was found; the numbers are chosen.
import { requireWebGPU } from '../../shared/require-webgpu.js';
import { engineRuntime, type Engine, type EnginePlugin } from '@margoengine/core/extension';
import type { EngineKernel } from '@margoengine/core';
import { MargoError } from '@margoengine/math/errors';
import type { Terrain, TerrainLighting } from './index.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };

/** The look of ground contact; every field is live. */
export interface GroundContactLook {
  /** Linear RGB albedo of the soil and litter at the feet, 0-1. Default [0.1, 0.08, 0.055]. */
  color?: readonly [number, number, number];
  /** How far the ground turns to `color` where the soil weight is full, 0-1. Default 1. */
  soil?: number;
  /** How much of the sky light lost at a foot is taken, 0-1. Default 1. */
  occlusion?: number;
}
/** Options of {@link TerrainGroundContact.attach}. */
export interface GroundContactOptions extends GroundContactLook {
  /** Metres a mask texel covers, 0.05 to 4. Default 0.2. */
  texel?: number;
  /** Mask texels a side, an integer 64 to 4096 (2 bytes each). Default 1024: 205 m around the camera. */
  resolution?: number;
  /** The first of the three lighting-group bindings the effect declares. Default 124. */
  binding?: number;
}
/** The baked mask: red the soil weight and green the sky lost, over a world rectangle with row 0 at `minZ`. */
export interface GroundContactMask {
  /** rg8unorm. Borrowed: `dispose()` frees it. */
  readonly texture: GPUTexture;
  /** `[minX, minZ, maxX, maxZ]`, world metres. */
  readonly bounds: readonly [number, number, number, number];
}
/** A footprint's kind: 0 a trunk (soil that thins outward), 1 a stone (a narrow ring). */
export type FootprintKind = 0 | 1;

const COLOR = [0.1, 0.08, 0.055] as const;
const fragmentColor = 'fn terrainColor(position:vec3f,normal:vec3f)->vec3f {',
  ambient = '+base*frame.radiance.w*frame.ambient.rgb',
  lit = /let linear=/g;
const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * The soil weight and the sky lost, both 0-1, `d` metres from the centre of a footprint of radius `r`; returns
 * `[0, 0]` from 4 radii out.
 * @example footprintAt(0.4, 0.4, 1)[1]; // 0.354, a stone's sky loss one radius from its centre
 */
export function footprintAt(d: number, r: number, kind: FootprintKind): [soil: number, loss: number] {
  if (!(r > 0) || !(d < 4 * r + 0.3)) return [0, 0];
  const x = d / r,
    s = Math.max(0, d - r);
  const loss = ((kind === 0 ? 0.6 : 1) / (1 + x * x) ** 1.5) * (1 - smooth(3.5, 4, x));
  const soil =
    kind === 0
      ? Math.exp(-s / (1.1 * r)) * (1 - smooth(2.5 * r, 3 * r, s))
      : 0.75 * Math.exp(-Math.max(0, s - Math.max(0.06, 0.25 * r)) / Math.max(0.05, 0.35 * r)) * (1 - smooth(3, 4, x));
  return [soil < 1 / 255 ? 0 : soil, loss];
}

/**
 * Bakes footprints (flat `[x, z, radius, kind, ...]` lists) into an rg8 mask of `size` x `size` texels of `texel`
 * metres whose first corner is `origin`: soil weights take the largest, sky losses combine as independent occluders.
 * `out` (2 bytes a texel) is cleared and returned.
 */
export function bakeGroundContact(
  lists: Iterable<ArrayLike<number>>,
  origin: readonly [number, number],
  size: number,
  texel: number,
  out: Uint8Array = new Uint8Array(size * size * 2),
): Uint8Array {
  out.fill(0);
  for (const list of lists)
    for (let k = 0; k + 3 < list.length; k += 4) {
      const x = list[k] - origin[0],
        z = list[k + 1] - origin[1],
        r = list[k + 2],
        kind = list[k + 3] ? 1 : 0,
        // A footprint smaller than a texel is spread over one, its weights scaled down to the area it really covers.
        wide = Math.max(r, texel * 0.5),
        share = Math.min(1, r / wide),
        reach = 4 * wide + 0.3;
      const u0 = Math.max(0, Math.floor((x - reach) / texel)), // float division: view only
        u1 = Math.min(size - 1, Math.ceil((x + reach) / texel)), // float division: view only
        v0 = Math.max(0, Math.floor((z - reach) / texel)), // float division: view only
        v1 = Math.min(size - 1, Math.ceil((z + reach) / texel)); // float division: view only
      for (let v = v0; v <= v1; v++)
        for (let u = u0; u <= u1; u++) {
          const [soil, loss] = footprintAt(Math.hypot((u + 0.5) * texel - x, (v + 0.5) * texel - z), wide, kind);
          const at = (v * size + u) * 2;
          const w = Math.round(soil * share * 255);
          if (w > out[at]) out[at] = w;
          if (loss > 0) out[at + 1] = Math.round(255 - (255 - out[at + 1]) * (1 - loss * share));
        }
    }
  return out;
}

interface Held {
  readonly list: Float32Array;
  /** The footprints' reach as a rectangle: min x, min z, max x, max z. */
  readonly box: readonly [number, number, number, number];
}

let nextId = 0;
/**
 * Soil, litter and contact shade on a clipmap {@link Terrain} around the objects standing on it:
 * `const contact = TerrainGroundContact.attach(engine, terrain)`, then `contact.set('rocks', [x, z, radius, 1])`.
 * WebGPU (and the WebGL2 compatibility layer).
 * @throws TypeError for a missing terrain; RangeError for an option, a look or a footprint out of range.
 * @throws MargoError `'disposed'` after `dispose()`, `'unsupported'` when the terrain's shader has no lit ambient term.
 */
export class TerrainGroundContact implements EnginePlugin, TerrainLighting, Disposable {
  readonly name = 'ground-contact:' + nextId++;
  /** Whether the effect has been disposed. */
  disposed = false;
  readonly texel: number;
  readonly resolution: number;
  readonly binding: number;
  /** The current look (live; change it with `setLook`). */
  readonly look: Required<GroundContactLook> = { color: COLOR, soil: 1, occlusion: 1 };
  readonly #held = new Map<string, Held>();
  #terrain?: Terrain;
  /** The terrain's world corner as it was given. */
  readonly #corner: readonly [number, number];
  #engine?: Engine;
  #remove?: () => void;
  #buffer?: GPUBuffer;
  #mask?: GPUTexture;
  #sampler?: GPUSampler;
  #entries: GPUBindGroupEntry[] = [];
  #current?: GroundContactMask;
  #data = new Float32Array(8);
  #texels?: Uint8Array;
  /** The mask's first corner, undefined until its first bake. */
  #origin?: [number, number];
  #dirty = true;
  #looked = true;
  readonly #shaders = new Map<string, string>();

  constructor(terrain: Terrain, options: GroundContactOptions = {}) {
    if (!terrain || typeof terrain.addLighting !== 'function')
      throw new TypeError('TerrainGroundContact needs a clipmap Terrain (@margoengine/terrain)');
    const { texel = 0.2, resolution = 1024, binding = 124 } = options;
    if (!(Number.isFinite(texel) && texel >= 0.05 && texel <= 4))
      throw new RangeError('TerrainGroundContact texel must be 0.05 to 4 metres');
    if (!Number.isInteger(resolution) || resolution < 64 || resolution > 4096)
      throw new RangeError('TerrainGroundContact resolution must be an integer 64 to 4096');
    if (!Number.isInteger(binding) || binding < 0 || binding > 997)
      throw new RangeError('TerrainGroundContact binding must be an integer 0 to 997');
    this.#terrain = terrain;
    const corner = terrain.options?.origin;
    this.#corner = [corner?.[0] ?? 0, corner?.[1] ?? 0];
    this.texel = texel;
    this.resolution = resolution;
    this.binding = binding;
    this.setLook(options);
  }

  /** Attaches ground contact to `terrain` on `engine`. */
  static attach(engine: EngineKernel, terrain: Terrain, options: GroundContactOptions = {}): TerrainGroundContact {
    const contact = new TerrainGroundContact(terrain, options);
    engineRuntime(engine).use(contact);
    return contact;
  }

  /** Sets any of `color`, `soil` and `occlusion` (others keep theirs); nothing is rebuilt. */
  setLook(look: GroundContactLook): void {
    this.#live();
    const next = { ...this.look };
    if (look.color !== undefined) {
      if (look.color.length !== 3 || !look.color.every((v) => Number.isFinite(v) && v >= 0 && v <= 1))
        throw new RangeError('TerrainGroundContact color must be a linear RGB of 0-1');
      next.color = [look.color[0], look.color[1], look.color[2]];
    }
    for (const key of ['soil', 'occlusion'] as const) {
      const v = look[key];
      if (v === undefined) continue;
      if (!(typeof v === 'number' && v >= 0 && v <= 1))
        throw new RangeError(`TerrainGroundContact ${key} must be a number from 0 to 1`);
      next[key] = v;
    }
    Object.assign(this.look, next);
    this.#looked = true;
  }

  /**
   * Holds the footprints of `key`, replacing its last: flat `[x, z, radius, kind, ...]`, world metres, kind 0 a trunk
   * or 1 a stone. An empty list removes the key. The list is copied.
   */
  set(key: string, footprints: ArrayLike<number>): void {
    this.#live();
    const n = footprints?.length;
    if (typeof key !== 'string' || !Number.isInteger(n) || n % 4 !== 0)
      throw new RangeError('TerrainGroundContact.set needs a key and a flat [x, z, radius, kind, ...] list');
    if (!n) return this.remove(key);
    const list = Float32Array.from(footprints);
    const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let k = 0; k < n; k += 4) {
      const [x, z, r] = [list[k], list[k + 1], list[k + 2]];
      if (!Number.isFinite(x) || !Number.isFinite(z) || !(r >= 0 && r <= 100))
        throw new RangeError('TerrainGroundContact footprints need finite x and z and a radius of 0 to 100 m');
      const reach = 4 * Math.max(r, this.texel) + 0.3;
      box[0] = Math.min(box[0], x - reach);
      box[1] = Math.min(box[1], z - reach);
      box[2] = Math.max(box[2], x + reach);
      box[3] = Math.max(box[3], z + reach);
    }
    const before = this.#held.get(key);
    this.#held.set(key, { list, box });
    if (this.#covers(box) || (before && this.#covers(before.box))) this.#dirty = true;
  }

  /** Forgets the footprints of `key`. */
  remove(key: string): void {
    const held = this.#held.get(key);
    if (!held) return;
    this.#held.delete(key);
    if (this.#covers(held.box)) this.#dirty = true;
  }

  /** The footprints held under all keys. */
  get count(): number {
    let n = 0;
    for (const { list } of this.#held.values()) n += list.length / 4; // float division: whole by construction
    return n;
  }

  #live(): void {
    if (this.disposed) throw new MargoError('disposed', 'This TerrainGroundContact was disposed; attach a new one');
  }

  #covers(box: Held['box']): boolean {
    const o = this.#origin;
    if (!o) return true;
    const span = this.texel * this.resolution;
    return box[2] > o[0] && box[0] < o[0] + span && box[3] > o[1] && box[1] < o[1] + span;
  }

  get owner(): Engine | undefined {
    return this.#engine;
  }

  setup(engine: Engine): void {
    requireWebGPU(engine, 'TerrainGroundContact');
    this.#live();
    this.#engine = engine;
    this.#create(engine.gpu!);
    this.#remove ??= this.#terrain!.addLighting(this);
  }

  onDeviceRestored(engine: Engine): void {
    this.#create(engine.gpu!);
  }

  #create(device: GPUDevice): void {
    const size = this.resolution;
    this.#buffer = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.#mask = device.createTexture({
      size: [size, size],
      format: 'rg8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.#sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
    this.#entries = [
      { binding: this.binding, resource: this.#mask.createView() },
      { binding: this.binding + 1, resource: this.#sampler },
      { binding: this.binding + 2, resource: { buffer: this.#buffer } },
    ];
    this.#dirty = this.#looked = true;
  }

  /**
   * The mask as it stands for this frame, re-centred and rebaked first when the camera or the footprints moved; undefined
   * before the effect is attached. Ground cover reads it to open around the feet:
   * `clearingMap(() => contact.mask())` of `@margoengine/scatter/clearing-map`.
   */
  mask(): GroundContactMask | undefined {
    if (!this.#bake()) return undefined;
    return this.#current;
  }

  /** The lighting group entries, after re-centring and rebaking the mask when the camera or the footprints moved. */
  bindings(): GPUBindGroupEntry[] {
    return this.#bake() ? this.#entries : [];
  }

  /** Brings the mask and the look's uniform up to date; false without a device. */
  #bake(): boolean {
    const device = this.#engine?.gpu;
    if (!device || !this.#mask || !this.#buffer) return false;
    const span = this.texel * this.resolution,
      eye = this.#engine!.camera.position,
      // The mask moves in steps of an eighth of its span, whole texels, so a re-bake shifts nothing on the ground.
      step = Math.max(1, this.resolution >> 3) * this.texel,
      x = Math.round((eye[0] - span / 2) / step) * step,
      z = Math.round((eye[2] - span / 2) / step) * step;
    const o = this.#origin;
    if (!o || Math.abs(x - o[0]) > step * 1.5 || Math.abs(z - o[1]) > step * 1.5) {
      this.#origin = [x, z];
      this.#dirty = this.#looked = true;
    }
    const origin = this.#origin!;
    const kept = this.#current;
    if (!kept || kept.texture !== this.#mask || kept.bounds[0] !== origin[0] || kept.bounds[1] !== origin[1])
      this.#current = { texture: this.#mask, bounds: [origin[0], origin[1], origin[0] + span, origin[1] + span] };
    if (this.#dirty) {
      const lists: Float32Array[] = [];
      for (const held of this.#held.values()) if (this.#covers(held.box)) lists.push(held.list);
      this.#texels = bakeGroundContact(lists, origin, this.resolution, this.texel, this.#texels);
      device.queue.writeTexture(
        { texture: this.#mask },
        this.#texels as Uint8Array<ArrayBuffer>,
        { bytesPerRow: this.resolution * 2 },
        [this.resolution, this.resolution],
      );
      this.#dirty = false;
    }
    if (this.#looked) {
      const l = this.look;
      // The shader reads metres from the terrain's corner (`frame.map.xy`), which a floating origin moves with it.
      const [x0, z0] = this.#corner;
      this.#data.set([origin[0] - x0, origin[1] - z0, 1 / span, l.soil, ...l.color, l.occlusion]); // float: view only
      device.queue.writeBuffer(this.#buffer, 0, this.#data);
      this.#looked = false;
    }
    return true;
  }

  /** The terrain's lit shader with soil on `terrainColor` and the sky light lost taken from the ambient term. */
  shader(source: string, group: number): string {
    const key = group + source,
      cached = this.#shaders.get(key);
    if (cached) return cached;
    if (
      source.split(fragmentColor).length !== 2 ||
      source.split(ambient).length !== 2 ||
      [...source.matchAll(lit)].length !== 1
    )
      throw new MargoError(
        'unsupported',
        "TerrainGroundContact needs the terrain's lit shader with its terrainColor and ambient term",
      );
    const s = '_c' + this.name.slice(this.name.indexOf(':') + 1),
      b = this.binding;
    const own = /* wgsl */ `
@group(${group}) @binding(${b}) var contactMask${s}:texture_2d<f32>;
@group(${group}) @binding(${b + 1}) var contactSampler${s}:sampler;
@group(${group}) @binding(${b + 2}) var<uniform> contactLook${s}:array<vec4f,2>;
fn contactHash${s}(c:vec2i)->f32 {let u=bitcast<vec2u>(c);var x=(u.x*0x8da6b343u)^(u.y*0xd8163841u);x=(x^(x>>16u))*0x7feb352du;x=(x^(x>>15u))*0x846ca68bu;return f32(x^(x>>16u))/4294967296.0;}
fn contactNoise${s}(p:vec2f)->f32 {let c=vec2i(floor(p));let f=fract(p);let t=f*f*(3.0-2.0*f);
 return mix(mix(contactHash${s}(c),contactHash${s}(c+vec2i(1,0)),t.x),mix(contactHash${s}(c+vec2i(0,1)),contactHash${s}(c+vec2i(1,1)),t.x),t.y);}
fn contactAt${s}(p:vec2f)->vec2f {
 let L=contactLook${s}[0];let uv=(p-L.xy)*L.z;let inside=all(uv>=vec2f(0))&&all(uv<=vec2f(1));
 let m=textureSampleLevel(contactMask${s},contactSampler${s},uv,0.0).rg;return select(vec2f(0),m,inside);
}
`;
    // The soil's edge is broken by noise a few tens of centimetres across and its colour speckled like litter.
    const color = `
${fragmentColor}
 let under=terrainColorBare${s}(position,normal);let p=position.xz-frame.map.xy;
 let ragged=vec2f(contactNoise${s}(p*3.1),contactNoise${s}(p*3.1+17.0))-0.5;
 let weight=clamp(contactAt${s}(p+ragged*0.24).x*(0.55+0.9*contactNoise${s}(p*7.3)),0.0,1.0)*contactLook${s}[0].w;
 return mix(under,contactLook${s}[1].rgb*(0.65+0.7*contactNoise${s}(p*23.0)),weight);
}`;
    const code =
      own +
      source
        .replace(fragmentColor, `fn terrainColorBare${s}(position:vec3f,normal:vec3f)->vec3f {`)
        .replace(lit, `let contactSky${s}=1.0-contactAt${s}(i.position.xz-frame.map.xy).y*contactLook${s}[1].w;let linear=`)
        .replace(ambient, `${ambient}*contactSky${s}`) +
      color;
    if (this.#shaders.size >= 16) this.#shaders.clear();
    this.#shaders.set(key, code);
    return code;
  }

  /** Detaches from the terrain (its shader returns to what it was) and frees the mask. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.#remove?.();
    this.#remove = undefined;
    this.#buffer?.destroy();
    this.#mask?.destroy();
    this.#buffer = this.#mask = undefined;
    this.#current = undefined;
    this.#entries = [];
    this.#held.clear();
    this.#shaders.clear();
    this.#texels = undefined;
    const engine = this.#engine;
    this.#engine = undefined;
    this.#terrain = undefined;
    engine?.sceneOf(this)?.removePlugin(this.name);
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
