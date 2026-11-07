// autoLOD's bake: what simplifying took from each primitive, baked into maps its levels draw with. Each map is read
// through the source's own UVs, and written in the frame the level shades with, its kept vertices' normals and tangents.
import type { BakeImage, BakeSurface } from '@margoengine/mesh-edit/bake';
import type { GLTFCompressedImage, PBRPrimitive } from '@margoengine/gltf-pro';
import type { PackedGeometry } from './attributes.js';

/** Options of `bake` on `autoLOD`. */
export interface AutoLODBake {
  /** Texels across the first level's maps, 1 to 8192; each lower level has half the last, down to 32. Default 512. */
  size?: number;
  /** Which maps to make: `'normal'`, `'ao'` or both. Default `['normal']`. */
  maps?: readonly ('normal' | 'ao')[];
  /** How far from a level's surface rays search, in the mesh's own units. Default 5% of the primitive's size. */
  distance?: number;
}
/** The maps of one primitive on one level. */
export interface LevelMaps {
  normal?: BakeImage;
  ao?: BakeImage;
}
/** Per primitive, the maps of each level; a level with nothing to bake has none. */
export type BakedLevels = ReadonlyMap<PBRPrimitive['definition'], (LevelMaps | undefined)[]>;
/** Which maps a primitive can take. */
export type BakeWants = (primitive: PBRPrimitive) => {
  normal: boolean;
  ao: boolean;
  /** The surface's frame has green along increasing V, as a materials mesh with no tangents draws it; the bake's runs the other way. */
  greenUp?: boolean;
};

/** Share of a primitive's texels that may be claimed twice: past this its UVs overlap, and a map would be wrong on one side. */
const SHARED = 0.02;
const SMALLEST = 32;
/** A texel the bake left empty reads flat and open, so mips and filtering meet the surface's own shading. */
const EMPTY = { normal: [128, 128, 255, 255], ao: [255, 255, 255, 255] } as const;

/** `bake` as given, as options, or undefined when off. */
export function bakeOptions(bake: boolean | AutoLODBake | undefined): AutoLODBake | undefined {
  if (bake === undefined || bake === false) return undefined;
  if (bake === true) return {};
  if (typeof bake !== 'object' || bake === null) throw new TypeError('autoLOD bake must be true, false or an options object');
  if (bake.maps !== undefined && (!Array.isArray(bake.maps) || !bake.maps.length || bake.maps.some((m) => m !== 'normal' && m !== 'ao')))
    throw new TypeError("autoLOD bake maps must list 'normal', 'ao' or both; choose from those");
  return bake;
}

/** A packed primitive as the baker takes it: its own normals and tangents, the frame the level shades in. */
function surface({ vertices, indices }: PackedGeometry): BakeSurface {
  const count = vertices.length / 20,
    positions = new Float32Array(count * 3),
    normals = new Float32Array(count * 3),
    tangents = new Float32Array(count * 4),
    uvs = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const o = i * 20;
    for (let k = 0; k < 3; k++) {
      positions[i * 3 + k] = vertices[o + k];
      normals[i * 3 + k] = vertices[o + 4 + k];
    }
    for (let k = 0; k < 4; k++) tangents[i * 4 + k] = vertices[o + 8 + k];
    uvs[i * 2] = vertices[o + 12];
    uvs[i * 2 + 1] = vertices[o + 13];
  }
  return { positions, normals, tangents, uvs, indices };
}
/** True when every UV lies in the unit square: a tiled layout has no texel of its own for each part of the surface. */
function inSquare(uvs: ArrayLike<number>): boolean {
  for (let i = 0; i < uvs.length; i++) if (!(uvs[i] >= 0 && uvs[i] <= 1)) return false;
  return true;
}
function fill(image: BakeImage, flat: readonly number[]): void {
  const { data } = image;
  for (let i = 0; i < data.length; i += 4) if (!data[i + 3]) for (let k = 0; k < 4; k++) data[i + k] = flat[k];
}

/**
 * Bakes each primitive's levels against the primitive itself, a primitive at a time, on the calling thread. A primitive
 * that wants no map, has UVs that leave the unit square or overlap, or has no UV area, gets no maps: its levels draw as
 * they would without `bake`.
 */
export async function bakeLevels(
  primitives: readonly PBRPrimitive[],
  simplified: ReadonlyMap<PBRPrimitive['definition'], PackedGeometry[]>,
  wants: BakeWants,
  options: AutoLODBake,
  signal?: AbortSignal,
): Promise<BakedLevels> {
  signal?.throwIfAborted();
  const { bakeSurfaceMaps } = await import('@margoengine/mesh-edit/bake');
  signal?.throwIfAborted();
  const { size = 512, maps = ['normal'], distance } = options,
    baked = new Map<PBRPrimitive['definition'], (LevelMaps | undefined)[]>();
  for (const p of primitives) {
    const levels = simplified.get(p.definition),
      want = wants(p),
      asked = maps.filter((map) => want[map]);
    if (!levels || baked.has(p.definition) || !asked.length) continue;
    const high = surface(p);
    if (!inSquare(high.uvs)) continue;
    baked.set(
      p.definition,
      levels.map(() => undefined),
    );
    for (let level = 0; level < levels.length; level++) {
      // The page gets a turn between bakes.
      await new Promise((done) => setTimeout(done));
      signal?.throwIfAborted();
      const width = Math.max(Math.min(size, SMALLEST), Math.floor(size / 2 ** level)),
        made = bakeSurfaceMaps(surface(levels[level]), high, {
          width,
          maps: asked,
          signal,
          ...(distance === undefined ? {} : { distance }),
        });
      if (!made.covered || made.shared > made.covered * SHARED) continue;
      const out: LevelMaps = {};
      if (want.greenUp && made.normal)
        for (let i = 1; i < made.normal.data.length; i += 4) made.normal.data[i] = 255 - made.normal.data[i];
      for (const map of asked) {
        fill(made[map]!, EMPTY[map]);
        out[map] = made[map];
      }
      baked.get(p.definition)![level] = out;
    }
  }
  return baked;
}

/** The next mip of `image`: each texel the mean of the four under it. */
function halve({ data, width, height }: { data: Uint8Array; width: number; height: number }) {
  const w = Math.max(1, width >> 1),
    h = Math.max(1, height >> 1),
    out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const x0 = x * 2,
        y0 = y * 2,
        x1 = Math.min(width - 1, x0 + 1),
        y1 = Math.min(height - 1, y0 + 1);
      for (let k = 0; k < 4; k++)
        out[(y * w + x) * 4 + k] =
          (data[(y0 * width + x0) * 4 + k] +
            data[(y0 * width + x1) * 4 + k] +
            data[(y1 * width + x0) * 4 + k] +
            data[(y1 * width + x1) * 4 + k] +
            2) >>
          2;
    }
  return { data: out, width: w, height: h };
}
/** A baked map as a loaded model holds images: RGBA8 with every mip, so it uploads again after a lost device. */
export function levelImage(image: BakeImage): GLTFCompressedImage {
  const { width, height, data } = image,
    mipmaps = [{ data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width, height }];
  while (mipmaps.at(-1)!.width > 1 || mipmaps.at(-1)!.height > 1) mipmaps.push(halve(mipmaps.at(-1)!));
  return { width, height, format: 'rgba8unorm', mipmaps };
}
