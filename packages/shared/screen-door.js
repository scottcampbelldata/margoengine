/** A screen-door coverage interval. Shared across replacement levels, in [0,1]. */

/** Refuses invalid coverage intervals instead of silently clamping a transition. */
export function checkDitherRange(range) {
  if (range.length !== 2 || !range.every(Number.isFinite) || range[0] < 0 || range[1] > 1 || range[0] > range[1])
    throw new RangeError('Dither fade needs 0 <= lower <= upper <= 1; correct the coverage interval');
}
/** Ordered 4 by 4 Bayer rank, from integer drawing-buffer coordinates. */
export function ditherRank(x, y) {
  const a = Math.floor(x) & 3,
    b = Math.floor(y) & 3;
  return 4 * (2 * ((a & 1) ^ (b & 1)) + (b & 1)) + 2 * (((a >> 1) & 1) ^ ((b >> 1) & 1)) + ((b >> 1) & 1);
}
/** Same rank in WGSL for meshes, point discs and sorted Gaussian fragments. */
export const ditherWGSL = `fn margoDitherRank(p:vec2f)->u32 {
 let x=u32(p.x)&3u;let y=u32(p.y)&3u;
 return 4u*(2u*((x&1u)^(y&1u))+(y&1u))+2u*(((x>>1u)&1u)^((y>>1u)&1u))+((y>>1u)&1u);
}`;
