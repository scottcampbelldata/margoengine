// The `alpha` entry: raycasts that see through the holes of alpha-masked textures, so a click on a fence or a leaf card
// lands on what shows through. It runs on the CPU path: every hit's TEXCOORD_0 is sampled in a mask the caller supplies.
import {
  Raycaster,
  type Candidate,
  type DeformedPickingSource,
  type IntersectOptions,
  type RaycasterHit,
  type RaycastRuntime,
} from './raycaster.js';

/** Top-left row-major RGBA8 pixels of a texture, as `getImageData` gives, and how a hit reads them. */
export interface AlphaMask {
  width: number;
  height: number;
  data: ArrayLike<number>;
  /** Share of full alpha at which a surface counts as solid, as glTF's alphaCutoff. Default 0.5. */
  cutoff?: number;
  /** What uv outside 0..1 reads: 'repeat' wraps, 'clamp' holds the edge. Default 'repeat'. */
  wrap?: 'repeat' | 'clamp';
}
/** Picks the mask of a hit; null or undefined keeps the hit, for surfaces with no mask. */
export type AlphaMaskSource = (hit: RaycasterHit) => AlphaMask | null | undefined;

function texel(position: number, size: number, repeat: boolean): number {
  return repeat ? ((position % size) + size) % size : Math.min(Math.max(position, 0), size - 1);
}

/** Alpha of a mask at a uv, 0 to 1, filtered between the four nearest pixels as a linear sampler filters them. */
export function sampleAlpha(mask: AlphaMask, u: number, v: number): number {
  const { width, height, data, wrap = 'repeat' } = mask;
  if (!(width > 0) || !(height > 0) || data.length !== width * height * 4)
    throw new TypeError('Invalid alpha mask; pass width, height and width * height * 4 RGBA bytes.');
  if (wrap !== 'repeat' && wrap !== 'clamp') throw new TypeError("Invalid alpha mask wrap; use 'repeat' or 'clamp'.");
  const repeat = wrap === 'repeat',
    x = u * width - 0.5,
    y = v * height - 0.5,
    left = Math.floor(x),
    top = Math.floor(y),
    tx = x - left,
    ty = y - top,
    x0 = texel(left, width, repeat),
    x1 = texel(left + 1, width, repeat),
    y0 = texel(top, height, repeat) * width,
    y1 = texel(top + 1, height, repeat) * width,
    upper = data[(y0 + x0) * 4 + 3] * (1 - tx) + data[(y0 + x1) * 4 + 3] * tx,
    lower = data[(y1 + x0) * 4 + 3] * (1 - tx) + data[(y1 + x1) * 4 + 3] * tx;
  return (upper * (1 - ty) + lower * ty) / 255;
}

/**
 * A Raycaster that drops hits on the transparent parts of alpha-masked surfaces. Set `alphaMask` to name each hit's
 * mask. Every setting and intersect call of Raycaster works as before, `SceneBVH.intersect` included. A hit with no
 * `uv` (core geometry holds none) stays.
 */
export class AlphaRaycaster extends Raycaster {
  /** Names the mask of a hit. Default null: no hit is dropped. */
  alphaMask: AlphaMaskSource | null = null;

  /** @internal */
  override castCandidates(runtime: RaycastRuntime, candidates: Candidate[]): RaycasterHit[] {
    const first = this.firstHitOnly;
    // The nearest hit may be a hole, so a first-hit query must see them all.
    this.firstHitOnly = first && !this.alphaMask;
    try {
      return this.#solid(super.castCandidates(runtime, candidates), first);
    } finally {
      this.firstHitOnly = first;
    }
  }

  override async intersectModel(source: DeformedPickingSource, options?: IntersectOptions): Promise<RaycasterHit[]> {
    const first = this.firstHitOnly;
    this.firstHitOnly = first && !this.alphaMask;
    // intersectModel reads its settings before its first wait, so the field goes back at once.
    const found = super.intersectModel(source, options);
    this.firstHitOnly = first;
    return this.#solid(await found, first);
  }

  #solid(hits: RaycasterHit[], first: boolean): RaycasterHit[] {
    const source = this.alphaMask;
    if (!source) return hits;
    const solid: RaycasterHit[] = [];
    for (const hit of hits) {
      const mask = hit.uv ? source(hit) : null;
      if (mask) {
        const cutoff = mask.cutoff ?? 0.5;
        if (!(cutoff >= 0 && cutoff <= 1)) throw new RangeError('Invalid alpha cutoff; pass a share from 0 to 1.');
        if (sampleAlpha(mask, hit.uv![0], hit.uv![1]) < cutoff) continue;
      }
      solid.push(hit);
      if (first) break;
    }
    return solid;
  }
}
