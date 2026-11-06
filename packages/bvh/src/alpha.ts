// The `alpha` entry: raycasts that see through the holes of alpha-masked textures, so a click on a fence or a leaf card
// lands on what shows through. It runs on the CPU path: every hit's TEXCOORD_0 is sampled in a mask, which the caller
// supplies or `modelAlphaMasks` reads from a loaded model's materials.
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
  /** What uv outside 0..1 reads, for both axes or as `[u, v]`. Default 'repeat'. */
  wrap?: AlphaWrap | readonly [AlphaWrap, AlphaWrap];
  /** Maps a hit's uv first: `u' = t[0] u + t[1] v + t[2]`, `v' = t[3] u + t[4] v + t[5]`. Default none. */
  transform?: readonly number[];
  /** Multiplies the sampled alpha, as a glTF base colour factor does. Default 1. */
  factor?: number;
}
/** 'repeat' wraps, 'mirror' wraps and flips each second tile, 'clamp' holds the edge. */
export type AlphaWrap = 'repeat' | 'mirror' | 'clamp';
/** Picks the mask of a hit; null or undefined keeps the hit, for surfaces with no mask. */
export type AlphaMaskSource = (hit: RaycasterHit) => AlphaMask | null | undefined;

function texel(position: number, size: number, wrap: AlphaWrap): number {
  if (wrap === 'clamp') return Math.min(Math.max(position, 0), size - 1);
  if (wrap === 'repeat') return ((position % size) + size) % size;
  const period = size * 2,
    place = ((position % period) + period) % period;
  return place < size ? place : period - 1 - place;
}
const isWrap = (wrap: unknown) => wrap === 'repeat' || wrap === 'mirror' || wrap === 'clamp';

/** Alpha of a mask at a uv, 0 to 1, filtered between the four nearest pixels as a linear sampler filters them. */
export function sampleAlpha(mask: AlphaMask, u: number, v: number): number {
  const { width, height, data, wrap = 'repeat', transform: t, factor = 1 } = mask;
  if (!(width > 0) || !(height > 0) || data.length !== width * height * 4)
    throw new TypeError('Invalid alpha mask; pass width, height and width * height * 4 RGBA bytes.');
  const [wrapU, wrapV] = typeof wrap === 'string' ? [wrap, wrap] : (wrap as readonly AlphaWrap[]);
  if (!isWrap(wrapU) || !isWrap(wrapV))
    throw new TypeError("Invalid alpha mask wrap; use 'repeat', 'mirror' or 'clamp', or a pair of them.");
  if (t && t.length !== 6) throw new TypeError('Invalid alpha mask transform; pass six numbers, two rows of three.');
  const x = (t ? t[0] * u + t[1] * v + t[2] : u) * width - 0.5,
    y = (t ? t[3] * u + t[4] * v + t[5] : v) * height - 0.5,
    left = Math.floor(x),
    top = Math.floor(y),
    tx = x - left,
    ty = y - top,
    x0 = texel(left, width, wrapU),
    x1 = texel(left + 1, width, wrapU),
    y0 = texel(top, height, wrapV) * width,
    y1 = texel(top + 1, height, wrapV) * width,
    upper = data[(y0 + x0) * 4 + 3] * (1 - tx) + data[(y0 + x1) * 4 + 3] * tx,
    lower = data[(y1 + x0) * 4 + 3] * (1 - tx) + data[(y1 + x1) * 4 + 3] * tx;
  return ((upper * (1 - ty) + lower * ty) / 255) * factor;
}

/** What {@link modelAlphaMasks} reads of a model: `PBRModel` from `@margoengine/gltf-pro` is one. */
export interface AlphaMaskedModel {
  readonly primitives: readonly { readonly material: AlphaMaskedMaterial }[];
  readonly asset: {
    readonly doc: {
      readonly textures?: readonly {
        readonly source?: number;
        readonly sampler?: number;
        readonly extensions?: Readonly<Record<string, { readonly source?: number } | undefined>>;
      }[];
      readonly samplers?: readonly { readonly wrapS?: number; readonly wrapT?: number }[];
    };
  };
  image(index: number): unknown;
}
/** The fields of a loaded glTF material a mask reads: `settings` holds the alpha mode index and the cutoff. */
export interface AlphaMaskedMaterial {
  readonly name?: string;
  readonly base: readonly number[];
  readonly settings: readonly number[];
  readonly maps: readonly (AlphaMaskedMap | undefined)[];
}
interface AlphaMaskedMap {
  readonly index: number;
  readonly texCoord?: number;
  readonly extensions?: { readonly KHR_texture_transform?: AlphaTextureTransform };
}
interface AlphaTextureTransform {
  readonly offset?: readonly number[];
  readonly rotation?: number;
  readonly scale?: readonly number[];
  readonly texCoord?: number;
}
/** Options of {@link modelAlphaMasks}. */
export interface ModelAlphaMasksOptions {
  /** Stops the read; the promise rejects with the signal's reason. */
  signal?: AbortSignal;
  /** Reads an image's RGBA pixels. Default: through an `OffscreenCanvas`, which Node has not; pass this there. */
  pixels?: (image: unknown) => AlphaPixels | Promise<AlphaPixels>;
}
/** Top-left row-major RGBA8 pixels, as `getImageData` gives. */
export type AlphaPixels = Pick<AlphaMask, 'width' | 'height' | 'data'>;
/** A mask source for one model, and what it could not read: those materials pick as solid. */
export interface ModelAlphaMaskSource extends AlphaMaskSource {
  readonly skipped: readonly { readonly material: AlphaMaskedMaterial; readonly reason: string }[];
}

const MASK = 1,
  /** glTF's sampler wrap numbers. */
  WRAPS: Readonly<Record<number, AlphaWrap>> = { 33071: 'clamp', 33648: 'mirror', 10497: 'repeat' },
  /** The sources gltf-pro decodes in place of `source`, in its order. */
  SOURCES = ['KHR_texture_basisu', 'EXT_texture_webp', 'EXT_texture_avif'];

function canvasPixels(image: unknown): AlphaPixels {
  const { width, height } = image as ImageBitmap;
  if (typeof OffscreenCanvas === 'undefined')
    throw new TypeError('modelAlphaMasks needs OffscreenCanvas to read an image here; pass the pixels option.');
  const context = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true })!;
  context.drawImage(image as ImageBitmap, 0, 0);
  return context.getImageData(0, 0, width, height);
}

/** The rows of `KHR_texture_transform`: the offset, then the rotation, then the scale of the spec. */
function transformRows({ offset = [0, 0], rotation = 0, scale = [1, 1] }: AlphaTextureTransform): number[] {
  const cos = Math.cos(rotation),
    sin = Math.sin(rotation);
  return [cos * scale[0], sin * scale[1], offset[0], -sin * scale[0], cos * scale[1], offset[1]];
}

async function readMask(
  model: AlphaMaskedModel,
  { base, settings, maps }: AlphaMaskedMaterial,
  pixels: NonNullable<ModelAlphaMasksOptions['pixels']>,
): Promise<AlphaMask | string> {
  const cutoff = settings[1],
    factor = base[3] ?? 1,
    map = maps[0];
  if (!map) return { width: 1, height: 1, data: [255, 255, 255, 255], cutoff, factor };
  const transform = map.extensions?.KHR_texture_transform;
  if ((transform?.texCoord ?? map.texCoord ?? 0) !== 0) return 'its base colour map reads TEXCOORD_1, and a hit carries TEXCOORD_0';
  const { textures = [], samplers = [] } = model.asset.doc,
    texture = textures[map.index],
    sampler = samplers[texture?.sampler ?? -1],
    source = SOURCES.map((name) => texture?.extensions?.[name]?.source).find((index) => index !== undefined) ?? texture?.source,
    image = model.image(source as number) as object;
  if ('ktx2' in image || 'mipmaps' in image) return 'its base colour map is compressed for the GPU, so no pixels can be read';
  const read = await pixels(image);
  return {
    width: read.width,
    height: read.height,
    data: read.data,
    cutoff,
    factor,
    wrap: [WRAPS[sampler?.wrapS ?? 10497] ?? 'repeat', WRAPS[sampler?.wrapT ?? 10497] ?? 'repeat'],
    transform: transform && transformRows(transform),
  };
}

/**
 * Reads the masks of a loaded model, for `AlphaRaycaster.alphaMask`: each `MASK` material's base colour alpha, its
 * cutoff and factor, its sampler's wrap per axis and its `KHR_texture_transform`. Other materials pick as solid. The
 * pixels are read once, here, and the source keeps them; call again after changing a material. Hits of another model
 * answer null, so two sources chain: `(hit) => a(hit) ?? b(hit)`.
 */
export async function modelAlphaMasks(
  model: AlphaMaskedModel,
  { signal, pixels = canvasPixels }: ModelAlphaMasksOptions = {},
): Promise<ModelAlphaMaskSource> {
  const masks = new Map<AlphaMaskedMaterial, AlphaMask>(),
    skipped: { material: AlphaMaskedMaterial; reason: string }[] = [],
    seen = new Set<AlphaMaskedMaterial>();
  for (const { material } of model.primitives) {
    signal?.throwIfAborted();
    if (seen.has(material) || material.settings[0] !== MASK) continue;
    seen.add(material);
    const mask = await readMask(model, material, pixels);
    if (typeof mask === 'string') skipped.push({ material, reason: mask });
    else masks.set(material, mask);
  }
  signal?.throwIfAborted();
  const source = (hit: RaycasterHit) => {
    if (hit.model && hit.model !== (model as unknown)) return null;
    const primitive = hit.primitive ?? model.primitives[hit.primitiveIndex ?? -1];
    return masks.get((primitive as { material?: AlphaMaskedMaterial } | undefined)?.material!) ?? null;
  };
  return Object.assign(source, { skipped });
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
