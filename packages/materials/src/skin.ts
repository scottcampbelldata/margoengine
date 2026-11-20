// Skin. Light that enters skin leaves it nearby, red further than green and blue: the three-layer diffusion profile of
// d'Eon and Luebke ("Advanced Techniques for Realistic Real-Time Skin Rendering", GPU Gems 3, 2007), a sum of six Gaussians
// per colour, whose variances and weights are their published fit. A curved surface lit from one side then shows that
// profile as a red band past the terminator. Pre-integrated skin shading (Penner and Borshukov, GPU Pro 2, 2011) integrates
// the profile around a circle of radius r once, for every angle to the light and every curvature, into a table:
//   D(theta, r) = int cos+(theta + x) R(2 r sin(x / 2)) dx / int R(2 r sin(x / 2)) dx, x over the whole circle,
// read per pixel with the curvature |dN| / |dP| from screen derivatives, in one pass, with nothing to blur. Fine detail
// scatters too, so red reads a normal between the mesh's and the normal map's, green closer to the map, and blue the map.
// The specular lobe is GGX with skin's index of 1.4 (F0 0.028, d'Eon and Luebke).
// Given what the skin is made of (melanin, blood), the profile is instead the two-layer spectral model of Donner and
// Jensen 2006 fitted with the same Gaussians (skin-spectrum.ts): measured against that model, the published fit holds
// fair skin, but it spreads light about ten times too far for melanin-rich skin, whose epidermis absorbs the light that
// would travel in the dermis (test/skin-measured.test.js).
import { ggxD, smithGCorrelated } from '../../shared/light-terms.js';
import { float, localShaded, shaded, within } from './character-light.js';
import { mipTexture } from './mips.js';
import type { MaterialFeature, Texture } from './built-material.js';
import { skinPhysiology, skinProfileOf, type SkinPhysiology } from './skin-spectrum.js';
export {
  diffusionReflectance,
  skinColor,
  skinFrequency,
  skinProfileOf,
  skinReflectance,
  skinWavelengths,
  type SkinPhysiology,
} from './skin-spectrum.js';

/**
 * Options of `skin()`. With any of `melanin`, `melaninBlend`, `hemoglobin` or `oxygenation` set, the profile is that of
 * skin made of them (`skinProfileOf`, Donner and Jensen 2006): melanin-rich skin keeps its light close, as the epidermis
 * absorbs what would spread in the dermis. Without them it is d'Eon and Luebke's published fit. Pair it with
 * `color: skinColor(sameOptions)`.
 */
export interface SkinOptions extends SkinPhysiology {
  /** Scene units in a metre, as the profile is in millimetres. Default 1, the unit of glTF. */
  unitsPerMeter?: number;
  /**
   * With the material's `subsurface` above 0: the depth of skin, in scene units, that `subsurfaceThickness` 1 (times the
   * red of `subsurfaceThicknessMap`) stands for. Light from behind passes through that depth by the skin profile, red
   * furthest (ears, nostrils, fingers against a light). Default 0.004 (4 mm at `unitsPerMeter` 1).
   */
  thickness?: number;
}
/** A diffusion profile as Gaussians: rows of a variance in square millimetres, then the red, green and blue weights. */
export type SkinGaussians = readonly (readonly [number, number, number, number])[];
/** d'Eon and Luebke's published fit, the default profile. */
export const skinPublishedProfile: SkinGaussians = [
  [0.0064, 0.233, 0.455, 0.649],
  [0.0484, 0.1, 0.336, 0.344],
  [0.187, 0.118, 0.198, 0],
  [0.567, 0.113, 0.007, 0.007],
  [1.99, 0.358, 0.004, 0],
  [7.41, 0.078, 0, 0],
];
const tableSize = 64,
  steps = 256;
/** The diffusion profile at `distance` millimetres, red, green and blue. */
export function skinProfile(distance: number, profile: SkinGaussians = skinPublishedProfile): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  for (const [variance, ...weights] of profile) {
    const g = Math.exp((-distance * distance) / (2 * variance)) / (2 * Math.PI * variance);
    for (let c = 0; c < 3; c++) out[c] += weights[c] * g;
  }
  return out;
}
/**
 * The share of light, red, green and blue, that leaves the back of a flat slab of skin `depth` millimetres thick under
 * an even irradiance on its front: the profile integrated over the back plane, sum of w e^(-depth^2 / 2v), as Jimenez et
 * al. 2010 derive it (their Eq. 9 writes e^(-s^2 / v) for their own Gaussian; with d'Eon and Luebke's G above the
 * integral of 2 pi r G(v, sqrt(r^2 + d^2)) dr over r is e^(-d^2 / 2v)). 1 at depth 0.
 */
export function skinTransmittance(
  depth: number,
  profile: SkinGaussians = skinPublishedProfile,
): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  for (const [variance, ...weights] of profile) {
    const t = Math.exp((-depth * depth) / (2 * variance));
    for (let c = 0; c < 3; c++) out[c] += weights[c] * t;
  }
  return out;
}
/** The curvature row `y` of the table reads: 1 / radius in 1 / mm is `y` squared. */
export const skinCurvature = (y: number): number => y * y;
/**
 * The pre-integrated table, `size` by `size` RGBA floats: x is n.l * 0.5 + 0.5, y the square root of curvature in 1 / mm.
 * Row 0 is a flat surface, plain n.l.
 */
export function skinTable(size = tableSize, profile: SkinGaussians = skinPublishedProfile): Float32Array {
  const data = new Float32Array(size * size * 4),
    angles = new Float64Array(steps),
    weights = new Float64Array(steps * 3);
  for (let row = 0; row < size; row++) {
    const y = (row + 0.5) / size,
      radius = 1 / skinCurvature(y),
      // Past 14 mm, five of the widest Gaussian's deviations, the profile is nothing. The cube packs the samples at the
      // middle, where the narrowest Gaussian, 0.08 mm across, needs them.
      reach = 2 * Math.asin(Math.min(1, 7 / radius)),
      sum = [0, 0, 0];
    for (let k = 0; k < steps; k++) {
      const u = ((k + 0.5) / steps) * 2 - 1,
        x = reach * u ** 3,
        r = skinProfile(2 * radius * Math.abs(Math.sin(x / 2)), profile);
      angles[k] = x;
      for (let c = 0; c < 3; c++) {
        weights[k * 3 + c] = r[c] * u * u;
        sum[c] += r[c] * u * u;
      }
    }
    for (let column = 0; column < size; column++) {
      const theta = Math.acos(((column + 0.5) / size) * 2 - 1),
        total = [0, 0, 0];
      for (let k = 0; k < steps; k++) {
        const light = Math.max(0, Math.cos(theta + angles[k]));
        for (let c = 0; c < 3; c++) total[c] += light * weights[k * 3 + c];
      }
      const at = (row * size + column) * 4;
      for (let c = 0; c < 3; c++) data[at + c] = total[c] / sum[c];
      data[at + 3] = 1;
    }
  }
  return data;
}
const code = (group: number, scale: string) => `@group(${group}) @binding(130) var margoSkinMap:texture_2d<f32>;
@group(${group}) @binding(131) var margoSkinSampler:sampler;
var<private> margoSkinMesh:vec3f;
var<private> margoSkinCurve:f32;
var<private> margoSkinRoughness:f32;
fn margoSkinRead(n:vec3f,l:vec3f)->vec3f {return textureSampleLevel(margoSkinMap,margoSkinSampler,vec2f(dot(n,l)*0.5+0.5,margoSkinCurve),0.0).rgb;}
fn margoSkinLight(n:vec3f,v:vec3f,l:vec3f,base:vec3f)->vec3f {
  let h=(v+l)/max(length(v+l),0.0001); let nl=clamp(dot(n,l),0.0,1.0); let nv=clamp(dot(n,v),0.0001,1.0);
  let nh=clamp(dot(n,h),0.0,1.0); let vh=clamp(dot(v,h),0.0,1.0); let a=margoSkinRoughness*margoSkinRoughness; let a2=a*a;
  let d=${ggxD}; let g=${smithGCorrelated}; let fresnel=0.028+0.972*pow(1-vh,5.0);
  let scattered=vec3f(margoSkinRead(normalize(mix(margoSkinMesh,n,0.25)),l).r,margoSkinRead(normalize(mix(margoSkinMesh,n,0.6)),l).g,margoSkinRead(n,l).b);
  return (1-fresnel)*base/3.14159265*scattered+d*g*fresnel/max(4*nv,0.0001);
}
fn margoSkinBend(n:vec3f,p:vec3f)->f32 {
  let bend=max(length(dpdx(n)),length(dpdy(n)))/max(max(length(dpdx(p)),length(dpdy(p))),1e-12);
  return sqrt(clamp(bend*${scale},0.0,1.0));
}
`;
// Light through thin skin (Jimenez, Whelan, Sundstedt and Gutierrez 2010): the back's irradiance is the front albedo
// times max(0.3 - n.l, 0) on the mesh normal (Eq. 10: the reversed normal stands for the back's, widened by 0.3 so the
// lit band does not end at the terminator), leaving through the depth by skinTransmittance, as a Lambert exitance. It
// takes the material's subsurface weight, colour, thickness and map, and like subsurface's own translucency it is the
// directional light's, added outside its shadow (the shadow map sees the lit side of the part the light passes through).
const through = (depth: string, profile: SkinGaussians) =>
  `fn margoSkinThrough(i:Out,s:Surface,l:vec3f)->vec3f {
  let k=margoSurface.sss; let c=margoSurface.sssColor; let d=c.a*margoThickness(i)*${depth}; let d2=-d*d*0.5;
  let t=${profile.map(([v, r, g, b]) => `vec3f(${[r, g, b].map(float).join(',')})*exp(d2/${float(v)})`).join('+')};
  return k.x*s.base.rgb*c.rgb*t*max(0.3-dot(margoSkinMesh,l),0.0)/3.14159265*f.radiance.rgb*f.light.w;
}
`;
const statements =
  '  _=margoSkinMap;_=margoSkinSampler;margoSkinMesh=n; margoSkinCurve=margoSkinBend(n,i.position); margoSkinRoughness=s.roughness;';
let published: Texture | undefined;
const makeTable = (profile: SkinGaussians) =>
  mipTexture([{ data: skinTable(tableSize, profile), width: tableSize, height: tableSize }], {
    format: 'rgba16float',
    minFilter: 'linear',
    magFilter: 'linear',
  });
const wrapCall = 'direct_light(s,v,l)+margoSubsurfaceWrap(s,l)',
  sssCall = 'margoSubsurface(i,s,v,l)';
/**
 * Skin with a diffusion profile, for faces and hands: light bleeds past shadow edges, red furthest, on thin and curved parts
 * more than on broad ones. Assign it through `Material.features` on a `PbrMaterial`, which keeps its `color`, `map`,
 * `normalMap` and `roughness`. Metalness is ignored. Lengths are real ones: pass `unitsPerMeter` for a model not in metres.
 */
export function skin(options: SkinOptions = {}): MaterialFeature {
  const { unitsPerMeter = 1, thickness = 0.004 } = options;
  within(unitsPerMeter, 0, Number.MAX_VALUE, 'skin unitsPerMeter');
  within(thickness, 0, Number.MAX_VALUE, 'skin thickness');
  const given = (['melanin', 'melaninBlend', 'hemoglobin', 'oxygenation'] as const).filter(
      (k) => options[k] !== undefined,
    ),
    physiology = given.length ? skinPhysiology(options) : undefined,
    profile = physiology ? skinProfileOf(physiology) : skinPublishedProfile;
  // The published table is shared; a physiology's own lives with this feature and goes with its last material.
  let own: Texture | undefined,
    users = 0;
  const scale = float(unitsPerMeter / 1000),
    depth = float((thickness * 1000) / unitsPerMeter),
    cached = new Map<string, string>();
  return {
    name: 'skin',
    serialization: () => ({ unitsPerMeter, thickness, ...Object.fromEntries(given.map((k) => [k, options[k]])) }),
    shader(source, group) {
      const id = group + source;
      let out = cached.get(id);
      if (out !== undefined) return out;
      out = code(group, scale) + shaded(source, 'margoSkinLight', statements, 'skin');
      // With subsurface: the profile already carries light past the terminator, so its wrap goes, and light through
      // the part leaves by the skin profile in place of the generic translucency lobe.
      if (out.includes(sssCall))
        out =
          through(depth, profile) +
          out.replace(wrapCall, 'direct_light(s,v,l)').replace(sssCall, 'margoSkinThrough(i,s,l)');
      if (cached.size >= 16) cached.clear();
      cached.set(id, out);
      return out;
    },
    lit: (source) => localShaded(source, 'margoSkinLight'),
    bindings(device: GPUDevice) {
      const table = physiology ? (own ??= makeTable(profile)) : (published ??= makeTable(profile)),
        [view, sampler] = table.bind(device, false)!;
      return [
        { binding: 130, resource: view },
        { binding: 131, resource: sampler },
      ];
    },
    attach() {
      users++;
    },
    detach() {
      if (--users > 0) return;
      own?.dispose();
      own = undefined;
    },
  };
}
