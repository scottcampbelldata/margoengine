// @margoengine/lightmap/mesh: bakes any triangle mesh into a lightmap addressed by the mesh's own second UV set (glTF
// TEXCOORD_1), on the CPU. Texels are found by rasterizing each triangle in UV space, conservatively (every texel whose
// cell the triangle touches; Hasselgren, Akenine-Moller and Ohlsson, "Conservative Rasterization", GPU Gems 2, ch. 42,
// 2005), then lit with shadowed direct light and ambient occlusion through @margoengine/bvh, then dilated outward.
import type { BakeLight } from '@margoengine/bvh/bake';
import { bakeMesh } from './mesh-bake.js';

/** A triangle mesh to bake. Positions and UVs are per vertex; `indices` lists triangles (three per triangle). */
export interface LightmapMesh {
  /** xyz per vertex, world space. */
  positions: Float32Array;
  /** The lightmap UV per vertex (glTF TEXCOORD_1), 0 to 1, origin top-left. Charts must not overlap. */
  uv1: Float32Array;
  /** xyz shading normal per vertex. Default each triangle's own normal (counterclockwise front). */
  normals?: Float32Array;
  /** Three vertex indices per triangle. Default the vertices in order, three per triangle. */
  indices?: Uint32Array | Uint16Array;
}

/** Geometry that casts shadows and occludes AO but is not baked, such as the rest of the scene. */
export interface LightmapOccluder {
  positions: Float32Array;
  indices?: Uint32Array | Uint16Array;
}

/** Options of {@link bakeMeshLightmap}. Every budget is checked before any texture is allocated or ray traced. */
export interface MeshLightmapOptions {
  /** Lightmap width in texels, 1 to 2,048. Default 256. */
  width?: number;
  /** Lightmap height in texels, 1 to 2,048. Default `width`. */
  height?: number;
  /** Passes that grow each chart by one texel into empty space, 0 to 16, so filtering and mips do not read black. Default 2. */
  dilate?: number;
  /** 'legacy' (default) stores direct irradiance times AO; 'physical' stores irradiance alone (AO in `ao`). */
  radiometry?: 'legacy' | 'physical';
  /** Direct lights (ambient, directional, point, spot), traced with shadows. Default none. */
  lights?: readonly BakeLight[];
  /** Ambient-occlusion rays per texel, 1 to 128. Default 32. */
  aoRays?: number;
  /** Ambient-occlusion ray length in world units. Default 4. */
  aoDistance?: number;
  /** Ray origins move this far along the normal, in world units, 0 to 1. Default 0.001. */
  bias?: number;
  /** Unsigned 32-bit seed of the ray directions; the same seed gives the same lightmap. Default 0. */
  seed?: number;
  /** More geometry that blocks light and AO but is not baked. Default none. */
  occluders?: readonly LightmapOccluder[];
  /** Most covered texels, 1 to 4,194,304. Default 1,048,576. */
  maxSamples?: number;
  /** Most rays, 1 to 67,108,864. Default 16,777,216. */
  maxRays?: number;
  /** Most bytes of textures and working buffers, estimated, 1 to 268,435,456. Default 201,326,592. */
  maxBytes?: number;
  /** Cancels the bake (checked every 256 texels). */
  signal?: AbortSignal;
  /** Called with texels done and texels in all, every 256 texels. */
  onProgress?: (done: number, total: number) => void;
}

/** What {@link bakeMeshLightmap} returns: the lightmap at the mesh's own UV1, row 0 at the top. */
export interface MeshLightmap {
  width: number;
  height: number;
  /** RGBA8 baked light divided by `lightmapScale`; alpha 255 where baked or dilated, 0 where empty. */
  lightmap: Uint8Array;
  /** RGBA8 linear ambient occlusion, grey; alpha as `lightmap`. */
  ao: Uint8Array;
  /** Linear RGB baked light per texel, undivided (HDR), after dilation; 0 where empty. */
  irradiance: Float32Array;
  /** The triangle each texel was baked from, -1 for a dilated or empty texel. */
  triangle: Int32Array;
  /** Multiply the lightmap's RGB (0 to 1) by this to get the baked light; at least 1. */
  lightmapScale: number;
  /** Set when the lightmap holds physical irradiance; consumers apply diffuse reflectance divided by pi. */
  radiometry?: 'physical';
  /** Texels baked (covered by a triangle). */
  samples: number;
  /** Rays reserved (an upper bound of those traced). */
  rays: number;
  /** Texels whose centre lies strictly inside two or more triangles: overlapping UV charts, which share light. */
  overlaps: number;
  /** Triangles with no area in UV space, which cover no texel. */
  degenerate: number;
}

/**
 * Bakes a triangle mesh's lighting into a lightmap at its own second UV set (`uv1`, glTF TEXCOORD_1), so any mesh with
 * lightmap UVs bakes, not only quads. Each texel a triangle touches samples the surface (its centre's point, or the
 * triangle's nearest point for texels on a chart border), gets shadowed direct light and cosine-weighted AO traced
 * through @margoengine/bvh against the mesh and `occluders`, and charts are then dilated by `dilate` texels. Inputs are
 * copied before the first await; the bake yields every 256 texels for `signal` and `onProgress`.
 */
export function bakeMeshLightmap(mesh: LightmapMesh, options: MeshLightmapOptions = {}): Promise<MeshLightmap> {
  return bakeMesh('bakeMeshLightmap', mesh, options);
}

export type { BakeLight } from '@margoengine/bvh/bake';
