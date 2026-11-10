/** A screen-door coverage interval. Shared across replacement levels, in [0,1]. */
export type DitherRange = readonly [number, number];
/** Refuses invalid coverage intervals instead of silently clamping a transition. */
export declare function checkDitherRange(range: readonly number[]): void;
/** Ordered 4 by 4 Bayer rank, from integer drawing-buffer coordinates. */
export declare function ditherRank(x: number, y: number): number;
/** Same rank in WGSL for meshes, point discs and sorted Gaussian fragments. */
export declare const ditherWGSL =
  'fn margoDitherRank(p:vec2f)->u32 {\n let x=u32(p.x)&3u;let y=u32(p.y)&3u;\n return 4u*(2u*((x&1u)^(y&1u))+(y&1u))+2u*(((x>>1u)&1u)^((y>>1u)&1u))+((y>>1u)&1u);\n}';
