// The glows fires put on a haze (`fog.fireSpots`) and on the smoke layer over it (`atmosphere.fireSpots`): one list
// shape, checked and packed here for both, two vec4 each: colour and reach squared, then x, lit height and z. A spot
// left out is all zero, and the shaders stop at the first reach of 0.
import type { SkyFireSpot } from './base.js';

/** Fire spots a haze or a smoke layer takes: `fog.fireSpots` and `atmosphere.fireSpots` hold at most this many. */
export const SKY_FIRE_SPOTS = 8;

const within = (v: unknown, lo: number, hi: number): boolean => typeof v === 'number' && v >= lo && v <= hi;

/** Throws a RangeError naming `what` unless `spots` is left out or a list of at most eight valid spots. */
export function checkFireSpots(spots: readonly SkyFireSpot[] | undefined, what: string): void {
  if (spots === undefined) return;
  if (!Array.isArray(spots) || spots.length > SKY_FIRE_SPOTS)
    throw new RangeError(`Invalid sky ${what}; use a list of at most ${SKY_FIRE_SPOTS} spots {color, x, z}`);
  for (const s of spots as readonly SkyFireSpot[])
    if (
      typeof s !== 'object' ||
      s === null ||
      !Array.isArray(s.color) ||
      s.color.length !== 3 ||
      !s.color.every((v) => within(v, 0, 4)) ||
      !within(s.x, -1e7, 1e7) ||
      !within(s.z, -1e7, 1e7) ||
      !within(s.height ?? 1000, -1e5, 1e5) ||
      !within(s.reach ?? 1000, 1, 1e6)
    )
      throw new RangeError(
        `Invalid sky ${what}; each spot is {color: three numbers 0 to 4, x, z, height -1e5 to 1e5, reach 1 to 1e6}`,
      );
}

/** Writes the eight spots' 64 floats at `at`, each colour times `scale`. */
export function writeFireSpots(
  out: Float32Array,
  at: number,
  spots: readonly SkyFireSpot[] | undefined,
  scale = 1,
): void {
  out.fill(0, at, at + 8 * SKY_FIRE_SPOTS);
  spots?.forEach((s, i) => {
    const o = at + 8 * i;
    out[o] = s.color[0] * scale;
    out[o + 1] = s.color[1] * scale;
    out[o + 2] = s.color[2] * scale;
    out[o + 3] = (s.reach ?? 1000) ** 2;
    out[o + 4] = s.x;
    out[o + 5] = s.height ?? 1000;
    out[o + 6] = s.z;
  });
}

/**
 * WGSL of `fireLayer(w)`, the fires' light on the smoke layer toward a ray `w`, reading the spots from `<u>.fires` (16
 * vec4, as {@link writeFireSpots} packs them, the first spot's unused w holding the sight) and the eye from `<u>.eye`
 * (metres). The ray meets each spot's lit height at r metres across from it, where the layer takes (R^2 / (R^2 +
 * r^2))^1.5 of its colour, an isotropic source's light on a plane (cos / d^2), so the pall glows over each fire and falls
 * off between and beyond them (KB-SKY-PALLFALLOFF1); no ray takes the layer farther across than the sight. The sky's dome
 * (`frame`) and the volumetric clouds over the layer (`clouds`, KB-SKY-FIREDAY1) both draw it from this one source.
 */
export const fireLayerWgsl = (u: string): string => `fn fireLayer(w:vec3f)->vec3f {
 let ray=normalize(w);let up=max(ray.y,0.052336);var light=vec3f(0.0);let sight=${u}.fires[1].w;let flat=length(ray.xz);
 for(var i=0u;i<8u;i++){
  let spot=${u}.fires[2u*i];if(spot.w<=0.0){break;}let at=${u}.fires[2u*i+1u].xyz;
  var run=max(at.y-${u}.eye.y,0.0)/up;if(sight>0.0&&run*flat>sight){run=sight/flat;}
  let across=${u}.eye.xz+ray.xz*run-at.xz;
  light+=spot.rgb*pow(spot.w/(spot.w+dot(across,across)),1.5);
 }
 return light;
}
`;

/**
 * Writes the haze's spots (`fog.fireSpots`) for a sky layer at `at` (64 floats, as {@link writeFireSpots}), each colour
 * over `picture` (2 to the sky's exposure times its picture scale: the fog adds them after its exposure, the sky before
 * its own), with the haze's path end, 2 / density metres as the fog shader ends it, in the first spot's spare float.
 * All zero without a fog, with density 0 or with no spots (KB-SKY-HAZEGLOW1).
 */
export function writeHazeFires(
  out: Float32Array,
  at: number,
  fog: { readonly density?: number; readonly fireSpots?: readonly SkyFireSpot[] } | undefined,
  picture = 1,
): void {
  const density = fog?.density ?? 0.01,
    on = fog !== undefined && density > 0 && (fog.fireSpots?.length ?? 0) > 0 && picture > 0;
  writeFireSpots(out, at, on ? fog.fireSpots : undefined, on ? 1 / picture : 1);
  out[at + 7] = on ? 2 / density : 0;
}

/**
 * WGSL of `name(start, end)`: the fires' light on a haze along the ground path from `start` to `end` (world xz, metres),
 * each spot (its two vec4 read by `spot(0)` and `spot(1)`, as {@link writeFireSpots} packs them, `i` the spot) adding its
 * colour times the mean of (R^2 / (R^2 + r^2))^1.5 along the path, seen from above, in closed form: with u along the
 * path from the closest approach to the spot and a^2 = R^2 + d^2, the integral is R^3 u / (a^2 sqrt(a^2 + u^2)). The
 * fog draws it over the scene and the sky toward its own rays (`fireSky`), one law for one light (KB-SKY-HAZEGLOW1).
 */
export const fireTrackWgsl = (
  name: string,
  spot: (part: 0 | 1) => string,
): string => `fn ${name}(start:vec2f,end:vec2f)->vec3f {
 let path=end-start;let span=length(path);var light=vec3f(0.0);
 for(var i=0u;i<8u;i++){
  let spot=${spot(0)};let R2=spot.w;if(R2<=0.0){break;}let toFire=${spot(1)}.xz-start;
  if(span<1.0){let near=toFire-path*0.5;light+=spot.rgb*pow(R2/(R2+dot(near,near)),1.5);continue;}
  let s0=dot(toFire,path/span);let a2=R2+max(dot(toFire,toFire)-s0*s0,0.0);let u1=span-s0;
  let mean=(R2/a2)*sqrt(R2)*(u1/sqrt(a2+u1*u1)+s0/sqrt(a2+s0*s0))/span;
  light+=spot.rgb*clamp(mean,0.0,1.0);
 }
 return light;
}
`;

/**
 * WGSL of `fireSky(w, t)`, the fires' light a sky ray `w` takes, reading `<u>.fires` (the layer's spots, `fireLayer`),
 * `<u>.hazeFires` ({@link writeHazeFires}) and `<u>.eye`, with `t` the low layer's transmittance along the ray. The
 * layer's glow is seen through the haze under it, t of it, and the haze's own glow in front, 1 - t of it, by the fog's
 * law along the ray's ground path to the fog's path end: so a far ground the fog hides fully (its colour the sky's
 * radiance, KB-SKY-HAZEHORIZON1, plus that glow) takes the sky's colour over it, a slab's airlight in front of what is
 * behind it (Koschmieder 1924; B. Sun, R. Ramamoorthi, S. G. Narasimhan and S. K. Nayar, "A Practical Analytic Single
 * Scattering Model for Real Time Rendering", SIGGRAPH 2005, https://doi.org/10.1145/1186822.1073309). Without haze
 * spots the layer's glow is drawn as it is (KB-SKY-HAZEGLOW1).
 */
export const fireSkyWgsl = (
  u: string,
): string => `${fireLayerWgsl(u)}${fireTrackWgsl('fireHazeTrack', (part) => `${u}.hazeFires[2u*i${part ? '+1u' : ''}]`)}fn fireSky(w:vec3f,t:vec3f)->vec3f {
 let layer=fireLayer(w);if(${u}.hazeFires[0].w<=0.0){return layer;}
 let ray=normalize(w);
 return layer*t+(vec3f(1.0)-t)*fireHazeTrack(${u}.eye.xz,${u}.eye.xz+ray.xz*${u}.hazeFires[1].w);
}
`;
