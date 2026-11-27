// The ground past a streamed terrain's window: a second, coarser window of tiles, and heights that blend from the fine
// data to the coarse with distance. Two levels of a geometry clipmap's data over the mesh rings the terrain already
// draws: Losasso and Hoppe 2004, "Geometry Clipmaps: Terrain Rendering Using Nested Regular Grids", SIGGRAPH
// (https://hhoppe.com/geomclipmap.pdf), and Asirvatham and Hoppe 2005, "Terrain Rendering Using GPU-Based Geometry
// Clipmaps", GPU Gems 2 ch. 2 (https://developer.nvidia.com/gpugems/gpugems2/part-i-geometric-complexity/chapter-2-terrain-rendering-using-gpu-based-geometry).
// Their transition region, h = mix(fine, coarse, clamp((distance - start) / width, 0, 1)) per vertex with the larger of
// the two axis distances, is used here: the blended height is one continuous function of world position and camera
// position, so no two vertices can disagree about it. That leaves no crack to stitch (no zero-area triangles or skirts,
// as separate coarse and fine meshes need) and nothing to pop: where the fine window gains or loses tiles the blend is
// already fully coarse. The mesh itself morphs between rings as before (Strugar 2009, "Continuous Distance-Dependent
// Level of Detail for Rendering Heightmaps", JGT 14(4), https://doi.org/10.1080/2151237X.2009.10129287).
// A fine tile that is late, failed or has no data is Margo's own addition: its ground is the coarse ground, ramped over
// half a tile or less into its neighbours (a weight per tile, read at the four nearest), and it fades in when it arrives.
import { MargoError } from '@margoengine/math/errors';
import type { TerrainSource } from './index.js';
import type { TerrainStreamFar, TerrainStreamWindow } from './stream.js';
import type { TerrainStreamLoad } from './stream-window.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };

/** {@link terrainFar} options. */
export interface TerrainFarOptions {
  /**
   * Loads far tile (x, z): like the stream's `load`, but a far tile is `scale` times as wide and starts at the stream's
   * `origin + [x, z] * scale * tileSize`. Give the same weights, normals and tint a near tile would, `tileTexels` square.
   */
  readonly load: TerrainStreamLoad;
  /** Far tile width in near tiles, an integer from 2 to 64. Default 4. */
  readonly scale?: number;
  /** Samples per far tile side, an integer from 4 to 1,024. Default: the stream's `tileTexels`. */
  readonly tileTexels?: number;
  /** Far tiles per window side, an even integer from 2 to 16. Default: the stream's `window`. */
  readonly window?: number;
  /**
   * World distance over which the fine heights blend into the far ones, above 0. It ends where the near window is sure
   * to reach, `(window / 2 - 0.75) * tileSize - 2 * tileSize / tileTexels` from the camera on each axis. Default: half
   * a tile, or half that distance when it is smaller.
   */
  readonly blend?: number;
  /** Seconds a near tile takes to fade in over the far ground once uploaded, 0 or more. Default 0.5. */
  readonly fade?: number;
}

/** The sizes the blend works with, from the two windows. */
interface Sizes {
  /** Near tiles per window side. */
  readonly count: number;
  readonly tile: number;
  readonly spacing: number;
  readonly farSpacing: number;
  readonly near: number;
  readonly width: number;
  readonly hole: number;
  readonly reach: number;
}

const integer = (v: unknown, lo: number, hi: number): boolean =>
  Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
const clamp = (v: number): number => Math.min(1, Math.max(0, v));

/** Height sample at (u, v) in 0..1 of an `n` x `n` heightmap, bilinear between samples, as the terrain's shader reads it. */
const sample = (heights: Float32Array, n: number, u: number, v: number): number => {
  const x = clamp(u) * (n - 1),
    z = clamp(v) * (n - 1),
    i = Math.floor(x),
    j = Math.floor(z),
    i1 = Math.min(i + 1, n - 1),
    j1 = Math.min(j + 1, n - 1),
    a = heights[j * n + i] + (heights[j * n + i1] - heights[j * n + i]) * (x - i),
    b = heights[j1 * n + i] + (heights[j1 * n + i1] - heights[j1 * n + i]) * (x - i);
  return a + (b - a) * (z - j);
};

/** Replaces `from`, a line of the terrain's own shader (shader.ts), and fails rather than draw without it. */
const swap = (code: string, from: string, to: string): string => {
  if (!code.includes(from))
    throw new MargoError('unsupported', 'Terrain far ring found no "' + from + '" in the terrain shader');
  return code.replace(from, to);
};

// shader.ts's edge test (`terrainOutside`), written out: importing it would split the root's shader into a chunk of its
// own, which costs every terrain user bytes. `swap` fails if the two ever differ.
const EDGE = 'if(any(i.position.xz<frame.map.xy)||any(i.position.xz>frame.map.xy+frame.map.zw)){discard;}';

/** The shader additions for `weights` weight textures, with a normal map and a tint when streamed, bound from `binding`. */
function farShader(code: string, binding: number, weights: number, normals: boolean, tint: boolean): string {
  // The edge: a square of `reach` around the camera, which moves with it, in place of the heightmap's bounds.
  code = code
    .split(EDGE)
    .join('if(any(abs(i.position.xz-frame.map.xy-terrainFarData.blend.xy)>vec2f(terrainFarData.tiles.x))){discard;}');
  const head = 'fn height(position:vec2f)->f32 {';
  if (!code.includes(head)) return code;
  let at = binding;
  const bind = (declaration: string) => `@group(0) @binding(${at++}) ${declaration};\n`;
  let declarations =
    'struct TerrainFar {map:vec4f,blend:vec4f,tiles:vec4f}\n' +
    bind('var<uniform> terrainFarData:TerrainFar') +
    bind('var terrainResidency:texture_2d<f32>') +
    bind('var terrainFarHeight:texture_2d<f32>');
  if (normals) declarations += bind('var terrainFarNormal:texture_2d<f32>');
  if (weights) declarations += bind('var terrainFarWeights:texture_2d_array<f32>');
  if (tint) declarations += bind('var terrainFarTint:texture_2d<f32>');
  // map: the far window's corner less the near one's (frame.map.xy), and its extent. blend: the camera less the near
  // corner, where the distance blend starts and 1 / its width. tiles: reach, near tile width, near sample spacing, and
  // 1 / the width of the ramp around a missing tile.
  declarations += /* wgsl */ `fn terrainFarBlend(xz:vec2f)->f32 {
  let p=xz-frame.map.xy;let d=abs(p-terrainFarData.blend.xy);
  var a=clamp((max(d.x,d.y)-terrainFarData.blend.z)*terrainFarData.blend.w,0.0,1.0);
  if(a>=1.0){return 1.0;}
  let tile=terrainFarData.tiles.y;let n=i32(textureDimensions(terrainResidency).x);
  let u=p/tile;let c=vec2i(floor(u));let s=select(vec2i(-1),vec2i(1),fract(u)>=vec2f(0.5));
  for(var k=0;k<4;k++){
    let q=c+vec2i(s.x*(k%2),s.y*(k/2));
    if(any(q<vec2i(0))||any(q>=vec2i(n))){continue;}
    let low=vec2f(q)*tile-vec2f(terrainFarData.tiles.z);let high=vec2f(q)*tile+vec2f(tile);
    let g=max(max(low-p,p-high),vec2f(0));
    a=max(a,(1.0-textureLoad(terrainResidency,q,0).r)*clamp(1.0-max(g.x,g.y)*terrainFarData.tiles.w,0.0,1.0));
  }
  return a;
}
fn terrainFarUV(xz:vec2f)->vec2f {return clamp((xz-frame.map.xy-terrainFarData.map.xy)/terrainFarData.map.zw,vec2f(0),vec2f(1));}
fn height(position:vec2f)->f32 {
  let a=terrainFarBlend(position);
  if(a<=0.0){return terrainNearHeight(position);}
  let d=vec2i(textureDimensions(terrainFarHeight));let pixel=terrainFarUV(position)*vec2f(d-vec2i(1));let lo=vec2i(floor(pixel));let hi=min(lo+vec2i(1),d-vec2i(1));let t=fract(pixel);
  let low=mix(textureLoad(terrainFarHeight,lo,0).r,textureLoad(terrainFarHeight,vec2i(hi.x,lo.y),0).r,t.x);let high=mix(textureLoad(terrainFarHeight,vec2i(lo.x,hi.y),0).r,textureLoad(terrainFarHeight,hi,0).r,t.x);
  let far=mix(low,high,t.y)*frame.heights.x+frame.heights.y;
  if(a>=1.0){return far;}
  return mix(terrainNearHeight(position),far,a);
}
`;
  if (normals)
    declarations += /* wgsl */ `fn terrainFarNormalAt(xz:vec2f,near:vec3f)->vec3f {
  let a=terrainFarBlend(xz);if(a<=0.0){return near;}
  let d=vec2i(textureDimensions(terrainFarNormal));
  return mix(near,textureLoad(terrainFarNormal,min(vec2i(terrainFarUV(xz)*vec2f(d)),d-vec2i(1)),0).xyz*2-1,a);
}
`;
  code = swap(code, head, 'fn terrainNearHeight(position:vec2f)->f32 {');
  // The normal's central differences widen from a near sample to a far one with the heights.
  code = swap(
    code,
    'let step=frame.map.zw/max(vec2f(textureDimensions(heightMap))-1,vec2f(1));',
    'let step=mix(frame.map.zw/max(vec2f(textureDimensions(heightMap))-1,vec2f(1)),terrainFarData.map.zw/max(vec2f(textureDimensions(terrainFarHeight))-1,vec2f(1)),terrainFarBlend(xz));',
  );
  if (normals)
    code = swap(
      code,
      'textureLoad(normalMap,min(vec2i(uv*vec2f(dimensions)),dimensions-vec2i(1)),0).xyz*2-1',
      'terrainFarNormalAt(xz,textureLoad(normalMap,min(vec2i(uv*vec2f(dimensions)),dimensions-vec2i(1)),0).xyz*2-1)',
    );
  if (weights && code.includes('var packed=')) {
    const coarse = (map: string) =>
      `let d=vec2f(textureDimensions(${map}));let uv=clamp(terrainFarUV(position.xz),vec2f(0.5)/d,vec2f(1)-vec2f(0.5)/d);`;
    code = swap(
      code,
      'var color=vec3f(0);var total=0.0;',
      `let farBlend=terrainFarBlend(position.xz);if(farBlend>0.0){${coarse('terrainFarWeights')}for(var k=0;k<${weights};k++){packed[k]=mix(packed[k],textureSampleLevel(terrainFarWeights,terrainSampler,uv,k,0.0),farBlend);}${
        tint
          ? 'terrainTintTexel=mix(terrainTintTexel,textureSampleLevel(terrainFarTint,terrainSampler,uv,0.0),farBlend);'
          : ''
      }}
  var color=vec3f(0);var total=0.0;`,
    );
  }
  return declarations + code;
}

/**
 * The far ring of one streamed terrain: pass it as `TerrainStreamOptions.far`. Make it with {@link terrainFar}; it
 * serves one stream at a time.
 */
export class TerrainFar implements TerrainStreamFar {
  /** The options given, as given. */
  readonly options: TerrainFarOptions;
  #tiles?: TerrainStreamWindow;
  #read?: (x: number, z: number) => number | undefined;
  /** The sizes of the last `plan`, and of the stream drawing the ring. */
  #planned?: Sizes;
  #sizes?: Sizes;

  constructor(options: TerrainFarOptions) {
    const o = options;
    if (!o || typeof o.load !== 'function') throw new TypeError('Invalid terrain far ring; pass load(x, z, signal).');
    if (
      !integer(o.scale ?? 4, 2, 64) ||
      (o.tileTexels !== undefined && !integer(o.tileTexels, 4, 1024)) ||
      (o.window !== undefined && (!integer(o.window, 2, 16) || o.window % 2 !== 0)) ||
      (o.blend !== undefined && !(o.blend > 0 && Number.isFinite(o.blend))) ||
      !((o.fade ?? 0.5) >= 0 && Number.isFinite(o.fade ?? 0.5))
    )
      throw new RangeError(
        'Invalid terrain far ring options; give a scale 2..64, tileTexels 4..1024, an even window 2..16, a blend above 0 and a fade of 0 s or more.',
      );
    this.options = o;
  }

  get load(): TerrainStreamLoad {
    return this.options.load;
  }
  /** While a stream draws it: the far window's tiles (CPU copies, tile indices on the far lattice, changes). */
  get tiles(): TerrainStreamWindow | undefined {
    return this.#tiles;
  }
  /** While attached: how far from the camera on each axis ground is drawn, in world units. */
  get reach(): number | undefined {
    return this.#sizes?.reach;
  }
  /** While attached: how far from the camera on each axis loaded ground is drawn from the fine heights alone. */
  get detail(): number | undefined {
    return this.#sizes?.near;
  }

  /**
   * The world height the terrain draws at world (x, z) this frame: the fine heights near the camera, the far ones past
   * the blend, mixed between. Undefined past `reach` and while no stream draws the ring. The mesh joins such heights
   * with flat triangles, so ground between vertices differs by what a triangle cuts off.
   */
  heightAt(x: number, z: number): number | undefined {
    return this.#read?.(x, z);
  }

  plan(near: { tileSize: number; tileTexels: number; window: number }): {
    tileSize: number;
    tileTexels: number;
    window: number;
    reach: number;
  } {
    const o = this.options,
      tileSize = near.tileSize * (o.scale ?? 4),
      tileTexels = o.tileTexels ?? near.tileTexels,
      window = o.window ?? near.window,
      spacing = near.tileSize / near.tileTexels,
      // Where the near window is sure to reach (it moves past 0.75 of a tile), less two samples: the last one is a
      // spacing short of the edge, and a tile exposed by a move must still be wholly past the blend.
      end = (near.window / 2 - 0.75) * near.tileSize - 2 * spacing,
      reach = (window / 2 - 0.75) * tileSize - 2 * (tileSize / tileTexels),
      width = o.blend ?? Math.min(near.tileSize / 2, end / 2);
    if (!(end > 0))
      throw new RangeError(
        'Terrain far ring: the near window is too small to blend in; raise its window to 4 or its tileTexels above 8.',
      );
    if (tileTexels < 4 || near.tileTexels < 4)
      throw new RangeError('Terrain far ring: both windows need tileTexels of 4 or more.');
    if (!(width <= end))
      throw new RangeError(`Terrain far ring blend must be at most ${end}, the reach of the near window.`);
    if (!(reach > end))
      throw new RangeError(
        `Terrain far ring reaches ${reach}, inside the near window's ${end}; raise far.scale or far.window.`,
      );
    this.#planned = {
      count: near.window,
      tile: near.tileSize,
      spacing,
      farSpacing: tileSize / tileTexels,
      near: end - width,
      width,
      hole: Math.min(width, near.tileSize / 2 - spacing),
      reach,
    };
    return { tileSize, tileTexels, window, reach };
  }
  bind(
    near: TerrainStreamWindow,
    far: TerrainStreamWindow,
    terrain: { heightScale?: number; heightOffset?: number },
  ): ReturnType<TerrainStreamFar['bind']> {
    if (this.#tiles)
      throw new MargoError('attached', 'This terrain far ring draws another stream; make one terrainFar per stream');
    const sizes = this.#planned!,
      fade = this.options.fade ?? 0.5,
      n = sizes.count,
      farSpacing = sizes.farSpacing,
      weights = near.weights.length,
      normals = !!near.normals,
      tint = !!near.tint,
      // The weight of each near tile of the window, row by row, and the window tile it was last computed at.
      residency = new Float32Array(n * n),
      scratch = new Float32Array(n * n),
      held = [near.tile[0], near.tile[1]],
      // The uniform: far corner and extent, blend centre and ramp, reach and tile sizes.
      values = new Float32Array(12),
      sent = new Float32Array(12),
      // The blend's centre: the camera, in steps of 1/256 of the blend, so a still-looking camera redraws no shadows.
      centre = [Number.NaN, Number.NaN];
    let device: GPUDevice | undefined,
      uniform: GPUBuffer | undefined,
      weight: GPUTexture | undefined,
      fresh = true;
    const write = () => {
      device!.queue.writeBuffer(uniform!, 0, values);
      device!.queue.writeTexture({ texture: weight! }, residency, { bytesPerRow: n * 4 }, [n, n]);
    };
    const release = () => {
      uniform?.destroy();
      weight?.destroy();
      uniform = weight = undefined;
    };
    /** Sets the weights for this frame (a tile's rises over `fade` seconds); whether any changed. */
    const weigh = (delta: number): boolean => {
      const dx = near.tile[0] - held[0],
        dz = near.tile[1] - held[1];
      let changed = false;
      if (dx || dz) {
        scratch.set(residency);
        for (let j = 0; j < n; j++)
          for (let i = 0; i < n; i++) {
            const from = i + dx >= 0 && i + dx < n && j + dz >= 0 && j + dz < n;
            residency[j * n + i] = from ? scratch[(j + dz) * n + i + dx] : 0;
          }
        held[0] = near.tile[0];
        held[1] = near.tile[1];
        changed = true;
      }
      const step = fade > 0 ? (delta > 0 ? delta / fade : 0) : 1;
      for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++) {
          const k = j * n + i,
            was = residency[k],
            now = near.holds(near.tile[0] + i, near.tile[1] + j) ? Math.min(1, was + step) : 0;
          if (Math.fround(now) !== was) {
            residency[k] = now;
            changed = true;
          }
        }
      return changed;
    };
    this.#tiles = far;
    this.#sizes = sizes;
    this.#read = (x, z) => {
      const [cx, cz] = centre,
        px = x - near.origin[0],
        pz = z - near.origin[1],
        d = Math.max(Math.abs(x - cx), Math.abs(z - cz));
      if (!(d <= sizes.reach)) return undefined;
      let a = clamp((d - sizes.near) / sizes.width);
      const ux = px / sizes.tile,
        uz = pz / sizes.tile,
        i = Math.floor(ux),
        j = Math.floor(uz),
        sx = ux - i >= 0.5 ? 1 : -1,
        sz = uz - j >= 0.5 ? 1 : -1;
      for (let k = 0; k < 4; k++) {
        const qx = i + sx * (k % 2),
          qz = j + sz * (k >> 1);
        if (qx < 0 || qz < 0 || qx >= n || qz >= n) continue;
        const gx = Math.max(qx * sizes.tile - sizes.spacing - px, px - (qx + 1) * sizes.tile, 0),
          gz = Math.max(qz * sizes.tile - sizes.spacing - pz, pz - (qz + 1) * sizes.tile, 0);
        a = Math.max(a, (1 - residency[qz * n + qx]) * clamp(1 - Math.max(gx, gz) / sizes.hole));
      }
      const side = (m: TerrainStreamWindow, spacing: number) => (m.columns - 1) * spacing,
        fine = sample(near.heights, near.columns, px / side(near, sizes.spacing), pz / side(near, sizes.spacing)),
        coarse = sample(
          far.heights,
          far.columns,
          (x - far.origin[0]) / side(far, farSpacing),
          (z - far.origin[1]) / side(far, farSpacing),
        );
      return (fine + (coarse - fine) * a) * (terrain.heightScale ?? 100) + (terrain.heightOffset ?? 0);
    };
    return {
      source: (gpu): TerrainSource => {
        release();
        device = gpu;
        uniform = gpu.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        weight = gpu.createTexture({
          size: [n, n],
          format: 'r32float',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        fresh = true;
        return {
          entries: (binding) => {
            const both = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
              fragment = GPUShaderStage.FRAGMENT,
              plain: GPUTextureBindingLayout = { sampleType: 'unfilterable-float' },
              entries: Omit<GPUBindGroupLayoutEntry, 'binding'>[] = [
                { visibility: both, buffer: { type: 'uniform' } },
                { visibility: both, texture: plain },
                { visibility: both, texture: plain },
                ...(normals ? [{ visibility: both, texture: plain }] : []),
                ...(weights
                  ? [{ visibility: fragment, texture: { viewDimension: '2d-array' as GPUTextureViewDimension } }]
                  : []),
                ...(tint ? [{ visibility: fragment, texture: {} }] : []),
              ];
            return entries.map((entry, i) => ({ ...entry, binding: binding + i }));
          },
          resources: () => {
            const t = far.textures;
            return [
              { buffer: uniform! },
              weight!.createView(),
              t.height.createView(),
              ...(normals ? [t.normals!.createView()] : []),
              ...(weights ? [t.weights[0].createView({ dimension: '2d-array' })] : []),
              ...(tint ? [t.tint!.createView()] : []),
            ];
          },
          shader: (code, binding) => farShader(code, binding, weights, normals, tint),
        };
      },
      update: (delta, x, z) => {
        if (!device) return false;
        const quantum = sizes.width / 256;
        let changed = weigh(delta);
        if (Number.isFinite(x) && Number.isFinite(z)) {
          const cx = Math.round(x / quantum) * quantum,
            cz = Math.round(z / quantum) * quantum;
          changed ||= cx !== centre[0] || cz !== centre[1];
          centre[0] = cx;
          centre[1] = cz;
        }
        const side = (far.columns - 1) * farSpacing;
        // Everything relative to the near corner, so a floating origin changes none of it.
        values.set([
          far.origin[0] - near.origin[0],
          far.origin[1] - near.origin[1],
          side,
          side,
          (centre[0] || 0) - near.origin[0],
          (centre[1] || 0) - near.origin[1],
          sizes.near,
          1 / sizes.width,
          sizes.reach,
          sizes.tile,
          sizes.spacing,
          1 / sizes.hole,
        ]);
        let moved = fresh || changed;
        for (let k = 0; k < 12; k++) if (values[k] !== sent[k]) moved = true;
        if (moved) {
          write();
          sent.set(values);
          fresh = false;
        }
        return changed;
      },
      dispose: () => {
        release();
        device = undefined;
        this.#tiles = this.#read = this.#sizes = undefined;
      },
    };
  }
}

/**
 * A coarser ring of ground past a streamed terrain's window, for `TerrainStreamOptions.far`.
 * @throws TypeError without `load`; RangeError for options out of range.
 */
export function terrainFar(options: TerrainFarOptions): TerrainFar {
  return new TerrainFar(options);
}
