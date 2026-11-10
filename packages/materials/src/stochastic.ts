// Stochastic tiling: a tiled texture read through a grid of triangles whose corners each carry a random offset, so no two
// tiles line up and the repeat disappears. Each pixel reads the texture three times, once per corner of its triangle, and
// blends by barycentric weight (the grid and the variance-preserving blend of Heitz and Neyret 2018, "High-Performance
// By-Example Noise using a Histogram-Preserving Blending Operator"; the sharpened weights of Mikkelsen 2022, "Practical
// Real-Time Hex-Tiling"). Blending independent reads flattens contrast by sqrt(sum w^2), so the sum is scaled back up
// about the texture's mean, which is its 1 x 1 mip: no table is built per texture. The result stays inside the three reads,
// which keeps it in range and leaves a flat area exactly as it was. Every read keeps the unshifted UV's derivatives, so a
// triangle edge never selects another mip. Maps on one UV set share offsets and weights, so they stay in register.
import { mapSlots, type MapSlot, type Material, type MaterialFeature, type Texture } from './built-material.js';

/** A material map `stochasticTiling()` can read. */
export type StochasticMap = MapSlot | 'alphaMap' | 'bumpMap';
/** Options of `stochasticTiling()`. */
export interface StochasticOptions {
  /** Side of a grid triangle in texture repeats: small mixes more, large keeps more of the texture whole. Default 0.5. */
  cellSize?: number;
  /** Share of a triangle given to blending, above 0, at most 1: 1 blends across all of it, small makes hard patches. Default 0.3. */
  blend?: number;
  /** The maps read this way. They must repeat. Default all of them; leave out a map baked on its own unwrap. */
  maps?: readonly StochasticMap[];
}
// Plain materials name their first five maps; a material with physical maps numbers them in mapSlots order.
const named: Record<string, StochasticMap> = {
    mat_baseMap: 'map',
    mat_mrMap: 'metalRoughnessMap',
    mat_normalMap: 'normalMap',
    mat_aoMap: 'aoMap',
    mat_emissiveMap: 'emissiveMap',
    margoAlphaMap: 'alphaMap',
    margoBumpMap: 'bumpMap',
  },
  allMaps = [...mapSlots, 'alphaMap', 'bumpMap'] as StochasticMap[],
  physical = /^margoPhysicalUV\(i,(\d+)\)$/,
  layerRead = /^(?:margoLayerUV\d+|\(i\.uv\.)/;
// The skew turns a square grid into equilateral triangles of side 1.
const grid = (cellSize: string, sharpen: string) => `struct MargoTileGrid {a:vec2f, b:vec2f, c:vec2f, w:vec3f, gain:f32}
fn margoTileOffset(corner:vec2f)->vec2f {
  var v=bitcast<vec2u>(vec2i(corner))*1664525u+1013904223u;
  v.x+=v.y*1664525u; v.y+=v.x*1664525u; v^=v>>vec2u(16u); v.x+=v.y*1664525u; v.y+=v.x*1664525u; v^=v>>vec2u(16u);
  return vec2f(v>>vec2u(8u))/16777216.0;
}
fn margoTileGrid(uv:vec2f)->MargoTileGrid {
  let q=uv/${cellSize}; let skewed=vec2f(q.x-q.y*0.57735027,q.y*1.15470054);
  let low=floor(skewed); let t=skewed-low; let z=1.0-t.x-t.y; let lower=z>0.0;
  var g:MargoTileGrid;
  g.a=margoTileOffset(low+select(vec2f(1),vec2f(0),lower));
  g.b=margoTileOffset(low+vec2f(0,1)); g.c=margoTileOffset(low+vec2f(1,0));
  let raw=select(vec3f(-z,1.0-t.x,1.0-t.y),vec3f(z,t.y,t.x),lower);
  let sharp=pow(max(raw,vec3f(0)),vec3f(${sharpen})); g.w=sharp/(sharp.x+sharp.y+sharp.z);
  g.gain=inverseSqrt(dot(g.w,g.w));
  return g;
}
`;
/** The read of texture `map` through the grid; `layered` adds an array layer argument. */
const read = (map: string, sampler: string, layered: boolean) => {
  const at = layered ? ',layer' : '';
  return `fn margoTile_${map}(uv:vec2f${layered ? ',layer:i32' : ''})->vec4f {
  let g=margoTileGrid(uv); let dx=dpdx(uv); let dy=dpdy(uv); let top=textureNumLevels(${map})-1u;
  let a=textureSampleGrad(${map},${sampler},uv+g.a${at},dx,dy); let b=textureSampleGrad(${map},${sampler},uv+g.b${at},dx,dy);
  let c=textureSampleGrad(${map},${sampler},uv+g.c${at},dx,dy); let mean=textureSampleLevel(${map},${sampler},vec2f(0.5)${at},f32(top));
  let gain=select(1.0,g.gain,all(textureDimensions(${map},top)==vec2u(1u)));
  return clamp(mean+(a*g.w.x+b*g.w.y+c*g.w.z-mean)*gain,min(a,min(b,c)),max(a,max(b,c)));
}
`;
};
/** The bracket closing the call whose arguments start at `from`, and the commas between its arguments. */
function callEnd(code: string, from: number): { end: number; commas: number[] } {
  const commas: number[] = [];
  let depth = 1;
  for (let k = from; k < code.length; k++) {
    const c = code[k];
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return { end: k, commas };
    else if (c === ',' && depth === 1) commas.push(k);
  }
  throw new TypeError('stochasticTiling found an unfinished texture read; use matching gltf-pro and materials versions');
}
/** The material map a read of texture `map` at `uv` serves, if any. */
const slotOf = (map: string, uv: string) => named[map] ?? (mapSlots[+(physical.exec(uv)?.[1] ?? -1)] as StochasticMap);
function tiled(source: string, wanted: Set<StochasticMap>, declarations: string): string {
  const functions = new Map<string, string>(),
    opening = 'textureSample(';
  let out = '',
    cursor = 0,
    at = source.indexOf(opening);
  while (at >= 0) {
    const start = at + opening.length,
      { end, commas } = callEnd(source, start),
      map = source.slice(start, commas[0]),
      sampler = source.slice(commas[0] + 1, commas[1]),
      uv = source.slice(commas[1] + 1, commas[2] ?? end),
      layer = commas[2] === undefined ? undefined : source.slice(commas[2] + 1, end);
    if (wanted.has(slotOf(map, uv)) || (map.startsWith('margoLayerMap') && layerRead.test(uv))) {
      functions.set(map, read(map, sampler, layer !== undefined));
      out += `${source.slice(cursor, at)}margoTile_${map}(${uv}${layer === undefined ? '' : `,${layer}`})`;
      cursor = end + 1;
    }
    at = source.indexOf(opening, end);
  }
  if (!functions.size) return source;
  return declarations + [...functions.values()].join('') + out + source.slice(cursor);
}
/**
 * Reads a material's tiled textures with a random offset per patch and soft blends between patches, so repeats vanish on
 * large floors, walls and landscapes with no extra art. Assign it through `Material.features`, after `layered()` when a
 * material has both: its tiled layers and detail are read this way too (each layer's maps must repeat). Costs three reads
 * per map in place of one, and binds nothing.
 */
export function stochasticTiling(options: StochasticOptions = {}): MaterialFeature {
  const { cellSize = 0.5, blend = 0.3 } = options,
    maps: readonly StochasticMap[] = options.maps ?? allMaps;
  if (typeof cellSize !== 'number' || !(cellSize > 0) || !Number.isFinite(Math.fround(cellSize)))
    throw new RangeError('stochasticTiling cellSize must be a finite number above 0; pass texture repeats such as 0.5');
  if (typeof blend !== 'number' || !(blend > 0) || blend > 1)
    throw new RangeError('stochasticTiling blend must be above 0 and at most 1; pass a share such as 0.3');
  if (!Array.isArray(options.maps ?? allMaps) || !maps.length || maps.some((m) => !allMaps.includes(m)))
    throw new TypeError(`stochasticTiling maps must list some of ${allMaps.join(', ')}; pass at least one`);
  const wanted = new Set(maps),
    // WGSL float literals, whatever the numbers' text.
    declarations = grid(cellSize.toExponential(), (1 / blend).toExponential()),
    cached = new Map<string, string>();
  return {
    name: 'stochasticTiling',
    serialization: () => ({ cellSize, blend, maps: [...maps] }),
    shader(source, _group, material: Material) {
      const list = material.features;
      if (list.findIndex((v) => v.name === 'layered') > list.findIndex((v) => v.name === 'stochasticTiling'))
        throw new TypeError('stochasticTiling reads what comes before it; list layered() ahead of it in Material.features');
      for (const slot of maps) {
        const texture = material[slot as keyof Material] as Texture | null;
        if (texture && (texture.wrapS === 'clamp' || texture.wrapT === 'clamp'))
          throw new TypeError(
            `stochasticTiling needs maps that repeat; make ${slot} with {wrapS: 'repeat', wrapT: 'repeat'} or leave it out of maps`,
          );
      }
      let out = cached.get(source);
      if (out !== undefined) return out;
      out = tiled(source, wanted, declarations);
      if (cached.size >= 16) cached.clear();
      cached.set(source, out);
      return out;
    },
  };
}
