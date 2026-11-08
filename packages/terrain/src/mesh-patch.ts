// Shared by the patches that shade ordinary meshes inside core's standard fragment shader (terrain colors, mesh to
// terrain blending): the mesh-ID varying, the per-pixel block and the value noise. Each patch checks for the others'
// text, so any of them can run first and the shader carries one copy of each.

// Core's fragment computes its shading normal on this line (tests/shader-contracts). The patches open a block after
// it whose `i` and `n` are per-pixel copies and close it with the fragment, so every later lighting patch (shadows,
// clustered, IBL, SSAO, SSR, scatter) keeps its text and shades the patched albedo, roughness and normal.
export const normalLine = 'let n=normalize(i.normal)*select(-1.0,1.0,facing);';
export const block = 'let terrainSource=i;let terrainNormal=n;{var i=terrainSource;var n=terrainNormal;';
// Value noise on an integer lattice hashed with lowbias32 (C. Wellons, "Prospecting for Hash Functions"), returned with
// its analytic derivatives (value 0..1, d/dx, d/dy). It is not periodic, so no pattern repeats and no tile needs hiding.
export const noiseCode = `
fn terrainHash(seed:u32)->u32 {
 var h=seed;h^=h>>16u;h*=0x7feb352du;h^=h>>15u;h*=0x846ca68bu;h^=h>>16u;return h;
}
// Corner values: terrainHash nested over the cell (y, then x plus that result), top 24 bits as 0..1. They are blended
// along x, then y, with the cubic fade s(t) = 3t^2 - 2t^3; by the product rule each blend's slope along its own axis is
// s'(t) = 6t(1-t) times the difference of what it blends, and the y blend carries the x blends' slopes along.
fn terrainNoise(p:vec2f)->vec3f {
 let base=floor(p);let c=bitcast<vec2u>(vec2i(base));let t=p-base;
 let row0=terrainHash(c.y);let row1=terrainHash(c.y+1u);
 let v00=f32(terrainHash(c.x+row0)>>8u)*5.9604645e-8;let v10=f32(terrainHash(c.x+1u+row0)>>8u)*5.9604645e-8;
 let v01=f32(terrainHash(c.x+row1)>>8u)*5.9604645e-8;let v11=f32(terrainHash(c.x+1u+row1)>>8u)*5.9604645e-8;
 let s=t*t*(3.0-2.0*t);let ds=6.0*t*(1.0-t);
 let low=mix(v00,v10,s.x);let high=mix(v01,v11,s.x);
 let slopeX=ds.x*mix(v10-v00,v11-v01,s.y);
 return vec3f(mix(low,high,s.y),slopeX,ds.y*(high-low));
}
`;
/** The first @location a struct does not use: patches that add varyings to a shared struct must not collide. */
export const freeLocation = (struct: string): number =>
  Math.max(-1, ...[...struct.matchAll(/@location\((\d+)\)/g)].map((m) => Number(m[1]))) + 1;

/**
 * Core's standard shader with the flat mesh-ID varying (`i.terrainId`, the mesh id plus 1) and the per-pixel block,
 * each added once, and the index just inside the block where a patch puts its per-mesh code. Undefined when the
 * source is not core's standard shader (the patches then leave it as it is, like core's other optional patches).
 */
export function openMeshBlock(source: string): { code: string; at: number } | undefined {
  let code = source;
  if (!code.includes('terrainId:f32'))
    code = code
      .replace(/struct Output \{[^}]+\}/, (output) =>
        output.replace('}', `,@location(${freeLocation(output)}) @interpolate(flat) terrainId:f32 }`),
      )
      .replace('o.color=i.color.rgb;', 'o.terrainId=i.factors.w+1.0;o.color=i.color.rgb;');
  if (!code.includes('terrainId:f32') || !code.includes('o.terrainId=')) return undefined;
  let at = code.indexOf(block);
  if (at < 0) {
    at = code.indexOf(normalLine);
    if (at < 0) return undefined;
    at += normalLine.length;
    let end = at;
    for (let depth = 1; end < code.length; end++)
      if (code[end] === '{') depth++;
      else if (code[end] === '}' && --depth === 0) break;
    code = code.slice(0, at) + block + code.slice(at, end) + '}' + code.slice(end);
  }
  return { code, at: at + block.length };
}
