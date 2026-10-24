// Baked light for the voxel renderer (`VoxelRenderer.lightmap`), its own entry so worlds without it carry none of it.

/** Options of {@link voxelLightmap}: an atlas from `@margoengine/lightmap` and the quads it was baked for. */
export interface VoxelLightmapOptions {
  /** The atlas: a 2D texture with TEXTURE_BINDING usage holding linear light (not sRGB). Borrowed, never destroyed. */
  texture: GPUTexture;
  /**
   * The charts: 12 numbers per quad, corners p0 to p3 counterclockwise from outside, axis-aligned rectangles on integer
   * world cells in [-16,777,215, 16,777,215]. At most 32,768 quads covering 1,048,576 cell faces, no two on one face.
   */
  positions: ArrayLike<number>;
  /** Atlas coordinates in [0, 1]: 8 numbers per quad, in the corner order of `positions`. */
  uv: ArrayLike<number>;
  /** Decode multiplier of the atlas (`lightmapScale` of the bake), >= 1. Default 1. */
  scale?: number;
  /**
   * What the atlas holds, as the bake's `radiometry`: `'legacy'` light is multiplied by the diffuse colour as is,
   * `'physical'` irradiance is divided by pi first (Lambertian diffuse). Default `'legacy'`.
   */
  radiometry?: 'legacy' | 'physical';
}

/** Baked light ready for `VoxelRenderer.lightmap`, from {@link voxelLightmap}. */
export interface VoxelLightmap {
  /** The atlas texture (borrowed). */
  readonly texture: GPUTexture;
  /** A header, then 24 floats per chart: corner, u and v edges with inverse squared lengths, normal, atlas corners. */
  readonly charts: Float32Array;
  /** Hash index of every covered cell face: x, y, z, (chart + 1) << 3 | face; at most 16 probes per lookup. */
  readonly index: Int32Array;
  /** @internal A voxel beauty shader with the baked light composed in. */
  shader(code: string): string;
}

/**
 * Prepares baked light for `VoxelRenderer.lightmap`: the charts are copied and indexed. Fragments on a chart then take
 * the atlas's light times their diffuse colour instead of the sun and ambient terms; emission still adds.
 *
 * ```ts
 * const atlas = await bakeLightmap({ positions, albedo }, { radiometry: 'physical' });
 * voxels.lightmap = voxelLightmap({ texture, positions, uv: atlas.uv, scale: atlas.lightmapScale, radiometry: 'physical' });
 * ```
 * @throws TypeError without a texture, for a `radiometry` other than `'legacy'` or `'physical'`, or a chart that is
 * not an axis-aligned rectangle.
 * @throws RangeError for chart counts, coordinates, UVs or `scale` out of range, overlapping charts, or an index that
 * cannot meet its 16-probe budget in 64 MiB.
 */
export function voxelLightmap(options: VoxelLightmapOptions): VoxelLightmap {
  return { texture: options?.texture, ...charts(options), shader };
}

const CELLS = 1048576;

// The chart table and the hash index of every covered cell face (16 linear probes, seed and size in the header).
function charts(atlas: VoxelLightmapOptions): { charts: Float32Array; index: Int32Array } {
  if (!atlas || typeof atlas.texture?.createView !== 'function')
    throw new TypeError('voxelLightmap needs {texture, positions, uv}; upload the bake atlas first');
  const { positions: p, uv } = atlas,
    scale = atlas.scale ?? 1,
    count = p?.length / 12;
  if (!(scale >= 1 && Math.fround(scale) < Infinity))
    throw new RangeError(`voxelLightmap scale ${scale} must be finite and at least 1`);
  if (atlas.radiometry !== undefined && atlas.radiometry !== 'legacy' && atlas.radiometry !== 'physical')
    throw new TypeError("voxelLightmap radiometry must be 'legacy' or 'physical', as the bake's");
  if (!Number.isInteger(count) || count < 1 || count > 32768 || uv?.length !== count * 8)
    throw new RangeError('voxelLightmap needs 1 to 32,768 quads: 12 positions and 8 uv numbers per quad');
  const data = new Float32Array(4 + count * 24),
    cells: number[] = [],
    taken = new Set<string>();
  data[0] = count;
  data[1] = atlas.radiometry === 'physical' ? scale / Math.PI : scale;
  for (let q = 0; q < count; q++) {
    const at = q * 12,
      out = 4 + q * 24,
      a = [p[at], p[at + 1], p[at + 2]],
      u = a.map((n, i) => p[at + 3 + i] - n),
      v = a.map((n, i) => p[at + 9 + i] - n),
      ua = u.findIndex((n) => n !== 0),
      va = v.findIndex((n) => n !== 0);
    for (let i = 0; i < 12; i++)
      if (!Number.isInteger(p[at + i]) || Math.abs(p[at + i]) > 16777215)
        throw new RangeError('voxelLightmap charts must use integer cells in [-16777215, 16777215]');
    if (
      ua < 0 ||
      va < 0 ||
      ua === va ||
      u.some((n, i) => i !== ua && n !== 0) ||
      v.some((n, i) => i !== va && n !== 0) ||
      a.some((n, i) => p[at + 6 + i] - n !== u[i] + v[i])
    )
      throw new TypeError('voxelLightmap charts must be axis-aligned rectangles; pass voxel mesh quads');
    const normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]],
      axis = normal.findIndex((n) => n !== 0),
      face = axis * 2 + +(normal[axis] < 0),
      lo = a.map((n, i) => Math.min(n, n + u[i] + v[i])),
      hi = a.map((n, i) => Math.max(n, n + u[i] + v[i]));
    if (cells.length / 4 + Math.abs(u[ua] * v[va]) > CELLS)
      throw new RangeError('voxelLightmap charts cover over 1,048,576 cell faces; bake fewer surfaces');
    hi[axis] = lo[axis] + 1;
    for (let y = lo[1]; y < hi[1]; y++)
      for (let z = lo[2]; z < hi[2]; z++)
        for (let x = lo[0]; x < hi[0]; x++) {
          const key = `${x},${y},${z},${face}`;
          if (taken.has(key))
            throw new RangeError(`voxelLightmap charts overlap at cell ${x},${y},${z}; give each face one chart`);
          taken.add(key);
          cells.push(x, y, z, ((q + 1) << 3) | face);
        }
    for (let i = 0; i < 8; i++)
      if (!(uv[q * 8 + i] >= 0 && uv[q * 8 + i] <= 1))
        throw new RangeError('voxelLightmap uv coordinates must be in [0, 1]');
    const length = Math.hypot(normal[0], normal[1], normal[2]);
    data.set(a, out);
    data.set(u, out + 4);
    data[out + 7] = 1 / (u[ua] * u[ua]);
    data.set(v, out + 8);
    data[out + 11] = 1 / (v[va] * v[va]);
    data.set(
      normal.map((n) => n / length),
      out + 12,
    );
    for (let i = 0; i < 8; i++) data[out + 16 + i] = uv[q * 8 + i];
  }
  // The smallest power-of-two table (and seed) where every cell face is found within 16 probes.
  for (let capacity = 16; capacity <= 4194304; capacity *= 2) {
    if (capacity < cells.length / 2) continue;
    for (let seed = 0; seed < 8; seed++) {
      const index = new Int32Array(capacity * 4),
        mask = capacity - 1;
      let fits = true;
      for (let cell = 0; cell < cells.length && fits; cell += 4) {
        const x = cells[cell],
          y = cells[cell + 1],
          z = cells[cell + 2],
          packed = cells[cell + 3];
        let hash =
          (Math.imul(x, 73856093) ^
            Math.imul(y, 19349663) ^
            Math.imul(z, 83492791) ^
            Math.imul(packed & 7, 2654435761) ^
            seed) >>>
          0;
        hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d) >>> 0;
        hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b) >>> 0;
        hash = (hash ^ (hash >>> 16)) & mask;
        fits = false;
        for (let probe = 0; probe < 16 && !fits; probe++) {
          const out = ((hash + probe) & mask) * 4;
          if (!index[out + 3]) {
            index.set([x, y, z, packed], out);
            fits = true;
          }
        }
      }
      if (fits) {
        data[2] = mask;
        data[3] = seed;
        return { charts: data, index };
      }
    }
  }
  throw new RangeError('voxelLightmap index needs over 64 MiB for 16 probes; bake fewer surfaces');
}

const declarations = /* wgsl */ `
@group(0) @binding(8) var voxelLightmap:texture_2d<f32>;
@group(0) @binding(9) var<storage,read> voxelCharts:array<vec4f>;
@group(0) @binding(10) var<storage,read> voxelChartIndex:array<vec4i>;
var<private> voxelBaked:vec4f;
fn voxelAtlas(uv:vec2f)->vec3f {
 let size=vec2i(textureDimensions(voxelLightmap));let p=uv*vec2f(size)-0.5;let b=vec2i(floor(p));let f=fract(p);
 let a=textureLoad(voxelLightmap,clamp(b,vec2i(0),size-1),0).rgb;
 let c=textureLoad(voxelLightmap,clamp(b+vec2i(1,0),vec2i(0),size-1),0).rgb;
 let d=textureLoad(voxelLightmap,clamp(b+vec2i(0,1),vec2i(0),size-1),0).rgb;
 let e=textureLoad(voxelLightmap,clamp(b+vec2i(1,1),vec2i(0),size-1),0).rgb;
 return mix(mix(a,c,f.x),mix(d,e,f.x),f.y)*voxelCharts[0].y;
}
fn voxelChartCell(cell:vec3i,face:u32)->i32 {
 var hash=(bitcast<u32>(cell.x)*73856093u)^(bitcast<u32>(cell.y)*19349663u)^(bitcast<u32>(cell.z)*83492791u)^(face*2654435761u)^u32(voxelCharts[0].w);
 hash=(hash^(hash>>16u))*0x7feb352du;hash=(hash^(hash>>15u))*0x846ca68bu;hash=hash^(hash>>16u);let mask=u32(voxelCharts[0].z);
 for(var probe=0u;probe<16u;probe++) {let entry=voxelChartIndex[(hash+probe)&mask];if(entry.w==0){break;}if(all(entry.xyz==cell)&&(u32(entry.w)&7u)==face){return i32((u32(entry.w)>>3u)-1u);}}
 return -1;
}
fn voxelBakeAt(p:vec3f,n:vec3f)->vec4f {
 var result=vec4f(0);var nearest=0.501;
 // At most 3 axes * 4 boundary neighbours * 16 hash probes, regardless of chart count.
 for(var axis=0u;axis<3u;axis++) {
  if(abs(n[axis])<0.1){continue;}
  let face=axis*2u+select(0u,1u,n[axis]<0.0);let ua=(axis+1u)%3u;let va=(axis+2u)%3u;
  var cell=vec3i(floor(p));cell[axis]=i32(round(p[axis]));
  for(var corner=0u;corner<4u;corner++) {
   var atCell=cell;
   if((corner&1u)!=0u){if(fract(p[ua])>0.00001){continue;}atCell[ua]-=1;}
   if((corner&2u)!=0u){if(fract(p[va])>0.00001){continue;}atCell[va]-=1;}
   let chart=voxelChartCell(atCell,face);if(chart<0){continue;}
   let at=1u+u32(chart)*6u;let d=p-voxelCharts[at].xyz;let normal=voxelCharts[at+3u].xyz;let distance=abs(dot(d,normal));
   let u=voxelCharts[at+1u];let v=voxelCharts[at+2u];let r=vec2f(dot(d,u.xyz)*u.w,dot(d,v.xyz)*v.w);
   if(dot(n,normal)>0.1&&distance<nearest&&all(r>=vec2f(-0.00001))&&all(r<=vec2f(1.00001))) {
    let a=voxelCharts[at+4u];let b=voxelCharts[at+5u];let uv=mix(mix(a.xy,a.zw,r.x),mix(b.zw,b.xy,r.x),r.y);
    result=vec4f(voxelAtlas(uv),1);nearest=distance;
   }
  }
 }
 return result;
}
`;
// The beauty shader with baked light: charted fragments (voxelBakeAt) use the atlas instead of the live sun and ambient.
function shader(source: string): string {
  return (
    declarations +
    source
      .replace(
        'fn ambient(s:Surface)->vec3f {',
        'fn ambient(s:Surface)->vec3f {if(voxelBaked.a>0.0){return s.base.rgb*(1.0-s.metal)*voxelBaked.rgb;}',
      )
      .replace(
        ' let v=normalize(f.eye.xyz-i.position);',
        ' voxelBaked=voxelBakeAt(i.position,outward);\n let v=normalize(f.eye.xyz-i.position);',
      )
      .replace(
        /var color=([^;]+);/,
        '$&if(voxelBaked.a>0.0){color=s.base.rgb*(1.0-s.metal)*voxelBaked.rgb+s.emissive;}',
      )
  );
}
