// Clearing maps (`@margoengine/scatter/clearing-map`): instances of a GPU Scatter thin out and stand shorter where a
// world map is high, so ground cover opens around the feet of trunks and stones that move or stream in. The fixed
// circles of `ScatterOptions.clearings` do the same for objects known at construction.
// - The map is read per instance in the distribute pass, at its root and at four places `reach` metres away, and the
//   largest of the five counts: a clump leans over ground some way from its root.
// - Thinning: the instance is dropped with chance min(1, thin x weight), by a hash of its own.
// - Height: a survivor is scaled by 1 - shorten x weight. Herbaceous cover is both sparser and lower near a stem, where
//   litter lies deepest and less light and rain reach the ground (Clary 1983, after Despain 1973: herb cover falls from
//   the open into the spruce-fir edge). The numbers are chosen on rendered stills.
import { MargoError } from '@margoengine/math/errors';
import type { ScatterThinningSource } from './index.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };

/** A map over a rectangle of the world: its red channel, 0 to 1, row 0 at `minZ`. */
export interface ClearingMap {
  /** Any filterable colour format; only red is read. */
  readonly texture: GPUTexture;
  /** The world rectangle it covers, `[minX, minZ, maxX, maxZ]` metres. Outside it nothing is cleared. */
  readonly bounds: readonly [number, number, number, number];
}
/** How instances answer the map; every field is live. */
export interface ClearingMapLook {
  /** Chance of dropping an instance per unit of map value, 0 to 8 (the chance stops at 1). Default 1.4. */
  thin?: number;
  /** Share of its height an instance loses per unit of map value, 0 to 1. Default 0.6. */
  shorten?: number;
  /** Metres around its root at which the map is also read, 0 to 10: a leaning clump is cleared with them. Default 0.25. */
  reach?: number;
}

const first = 12;
const declarations = /* wgsl */ `@group(0) @binding(${first}) var clearingTexture:texture_2d<f32>;
struct ClearingLook {rect:vec4f,look:vec4f}
@group(0) @binding(${first + 1}) var<uniform> clearing:ClearingLook;
fn clearingAt(p:vec2f)->f32 {
 let uv=(p-clearing.rect.xy)*clearing.rect.zw;
 if(any(uv<vec2f(0.0))||any(uv>=vec2f(1.0))){return 0.0;}
 return textureLoad(clearingTexture,vec2i(uv*vec2f(textureDimensions(clearingTexture))),0).r;
}
`;
/** The distribute shader's lines the test is put before and into. */
const placing = ' let angle=hash(',
  placed = 'var instance=Instance(vec4f(p,scale*shrink),';

/** The distribute shader with the clearing test, for instances whose random numbers are keyed by `key`. */
export function clearingMapCode(code: string, key: 'i' | 'key'): string {
  if (code.split(placing).length !== 2 || code.split(placed).length !== 2 || !code.includes('@compute'))
    throw new MargoError(
      'unsupported',
      "clearingMap needs scatter's distribute shader as it was written for it; update the edits in scatter/src/clearing-map.ts",
    );
  const test = ` let by=clearing.look.z;let open=max(clearingAt(p.xz),max(max(clearingAt(p.xz+vec2f(by,0.0)),clearingAt(p.xz-vec2f(by,0.0))),max(clearingAt(p.xz+vec2f(0.0,by)),clearingAt(p.xz-vec2f(0.0,by)))));
 if(hash((${key}*7u+6u)^0x7c3a21f5u)<clearing.look.x*open){return;}
 let stand=1.0-clearing.look.y*open;
`;
  return code
    .replace('@compute', declarations + '@compute')
    .replace(placing, test + placing)
    .replace(placed, 'var instance=Instance(vec4f(p,scale*shrink*stand),');
}

interface Held {
  readonly buffer: GPUBuffer;
  /** Bound while the map is not there: one texel of 0. */
  readonly empty: GPUTexture;
  texture?: GPUTexture;
  entries?: GPUBindGroupEntry[];
}

const LIMITS = { thin: 8, shorten: 1, reach: 10 } as const;

/**
 * A `ScatterOptions.thinning` source that clears instances where a world map is high. One source may serve any number
 * of scatters; {@link ScatterClearingMap.set} changes the look from the next frame. WebGPU and the WebGL2
 * compatibility layer.
 * @example
 * const thinning = clearingMap(() => view.groundContact?.mask());
 * GrassScatter.attach(engine, { area: [40, 40], follow: true, bounds, thinning });
 */
export class ScatterClearingMap implements ScatterThinningSource, Disposable {
  /** The current look (live; change it with `set`). */
  readonly look: Required<ClearingMapLook> = { thin: 1.4, shorten: 0.6, reach: 0.25 };
  readonly #map: () => ClearingMap | undefined;
  readonly #held = new Map<GPUDevice, Held>();
  readonly #data = new Float32Array(8);
  #disposed = false;

  constructor(map: () => ClearingMap | undefined, look: ClearingMapLook = {}) {
    if (typeof map !== 'function')
      throw new TypeError('clearingMap needs a function that returns { texture, bounds } or undefined');
    this.#map = map;
    this.set(look);
  }

  /** Sets any of `thin`, `shorten` and `reach` (others keep theirs). */
  set(look: ClearingMapLook): void {
    const next = { ...this.look };
    for (const key of ['thin', 'shorten', 'reach'] as const) {
      const v = look?.[key];
      if (v === undefined) continue;
      if (!(typeof v === 'number' && v >= 0 && v <= LIMITS[key]))
        throw new RangeError(`clearingMap ${key} must be a number from 0 to ${LIMITS[key]}`);
      next[key] = v;
    }
    Object.assign(this.look, next);
  }

  cullCode(code: string, key: 'i' | 'key'): string {
    return clearingMapCode(code, key);
  }

  /** @throws MargoError `'disposed'` after `dispose()`; RangeError for map bounds without an area. */
  entries(device: GPUDevice): GPUBindGroupEntry[] {
    if (this.#disposed) throw new MargoError('disposed', 'This clearing map was disposed; make a new one');
    let held = this.#held.get(device);
    if (!held)
      this.#held.set(
        device,
        (held = {
          buffer: device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
          empty: device.createTexture({
            size: [1, 1],
            format: 'r8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
          }),
        }),
      );
    const map = this.#map(),
      data = this.#data;
    data.fill(0);
    if (map) {
      const [x0, z0, x1, z1] = map.bounds;
      if (!(x1 > x0 && z1 > z0 && Number.isFinite(x1 - x0) && Number.isFinite(z1 - z0)))
        throw new RangeError('clearingMap bounds must be [minX, minZ, maxX, maxZ] with max above min');
      data.set([x0, z0, 1 / (x1 - x0), 1 / (z1 - z0)]); // float division: view only
      data.set([this.look.thin, this.look.shorten, this.look.reach], 4);
    }
    device.queue.writeBuffer(held.buffer, 0, data);
    const texture = map?.texture ?? held.empty;
    if (held.texture !== texture || !held.entries) {
      held.texture = texture;
      held.entries = [
        { binding: first, resource: texture.createView() },
        { binding: first + 1, resource: { buffer: held.buffer } },
      ];
    }
    return held.entries;
  }

  /** Frees the uniform and the stand-in texture; dispose the scatters that use it first. The map's texture is borrowed. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const held of this.#held.values()) {
      held.buffer.destroy();
      held.empty.destroy();
    }
    this.#held.clear();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** `new ScatterClearingMap(map, look)`. */
export function clearingMap(map: () => ClearingMap | undefined, look?: ClearingMapLook): ScatterClearingMap {
  return new ScatterClearingMap(map, look);
}
