// Strand hair. A fibre scatters light into a cone about the plane across it, so the highlights run across the strands
// and follow the direction of the hair instead of the surface normal (Kajiya and Kay 1989). Cuticle scales tilt the
// fibre's surface toward the root, which splits the highlight in two (Marschner, Jensen, Cammarano, Worley and Hanrahan
// 2003): the surface reflection R, white, tilted toward the root by `shift`, and the light that crossed the fibre and
// came back, TRT, tinted by the hair, tilted the other way by 1.5 times as much and twice as wide. Both are drawn as tangent
// shifted lobes (Scheuermann 2004, "Hair Rendering and Shading"), normalised over the longitudinal angle as Marschner's
// M(theta) is, with his F / 4 azimuthal weight and a cuticle index of 1.55. A hash per strand moves the shift and scales
// TRT, which breaks the highlight into strands.
import { direction, float, localShaded, shaded, vec3, vertexFields, within } from './character-light.js';
import type { MaterialFeature } from './built-material.js';

/** Options of `hair()`. */
export interface HairOptions {
  /** The way strands run, root to tip: along the UV's `'u'` or `'v'`, or a direction in the mesh's axes, such as [0, -1, 0]. Default 'v'. */
  direction?: 'u' | 'v' | readonly [number, number, number];
  /** Angle in radians of the white highlight toward the root; the tinted one goes 1.5 times as far the other way. Default 0.09. */
  shift?: number;
  /** Width in radians of the white highlight; the tinted one is twice as wide. Default 0.12. */
  width?: number;
  /** Strength of both highlights. Default 1. */
  specular?: number;
  /** Strands across one unit of UV, each with its own highlight. Default 200. */
  strands?: number;
  /** How far a strand's shift wanders, in radians. Default 0.06. */
  jitter?: number;
}
const f0 = 0.0465; // ((1.55 - 1) / (1.55 + 1))^2
const code = (shift: string, power: string, specular: string, jitter: string) => `var<private> margoHairStrand:vec3f;
var<private> margoHairNoise:f32;
fn margoHairHash(k:f32)->f32 {
  var x=bitcast<u32>(i32(floor(k)))*747796405u+2891336453u; x=((x>>((x>>28u)+4u))^x)*277803737u; x^=x>>22u;
  return f32(x>>8u)/16777216.0;
}
fn margoHairLobe(n:vec3f,h:vec3f,shift:f32,power:f32)->f32 {
  let along=dot(normalize(margoHairStrand+n*shift),h);
  return sqrt(power/6.2831853)*pow(max(1.0-along*along,0.0),power*0.5);
}
fn margoHairLight(n:vec3f,v:vec3f,l:vec3f,base:vec3f)->vec3f {
  let h=(v+l)/max(length(v+l),0.0001); let across=sqrt(max(1.0-dot(margoHairStrand,l)*dot(margoHairStrand,l),0.0));
  let wrap=clamp((dot(n,l)+0.5)/1.5,0.0,1.0); let wander=(margoHairNoise-0.5)*${jitter};
  let r=margoHairLobe(n,h,${shift}+wander,${power}); let trt=margoHairLobe(n,h,-1.5*${shift}+wander,${power}*0.25);
  return (base/3.14159265*across+(vec3f(r)+base*trt*(0.5+margoHairNoise))*${float(f0 / 4)}*${specular})*wrap;
}
`;
/**
 * Strand hair with two shifted highlights, for hair cards and hair meshes. Assign it through `Material.features` on a
 * `PbrMaterial`, which keeps its `color` and `map`; the highlights replace its `roughness` and `metalness`. Works with
 * nothing else; pair it with `alphaHash()` for soft card edges.
 */
export function hair(options: HairOptions = {}): MaterialFeature {
  const { direction: along = 'v', shift = 0.09, width = 0.12, specular = 1, strands = 200, jitter = 0.06 } = options;
  for (const [v, label] of [
    [shift, 'shift'],
    [jitter, 'jitter'],
  ] as const)
    if (typeof v !== 'number' || !(v >= -1 && v <= 1))
      throw new RangeError(`hair ${label} must be radians from -1 to 1; pass a small angle`);
  within(width, 0, 1, 'hair width');
  within(strands, 0, 1e6, 'hair strands');
  if (typeof specular !== 'number' || !(specular >= 0) || !Number.isFinite(specular))
    throw new RangeError('hair specular must be a finite number from 0 up; pass 1 for the default strength');
  const axis = along === 'u' || along === 'v' ? undefined : direction(along, 'hair direction'),
    // The lobe pow(cos(theta), p) is a Gaussian of deviation 1 / sqrt(p) about its peak.
    wgsl = code(float(shift), float(1 / (width * width)), float(specular), float(jitter)),
    strand = axis ? 'i.margoHairAxis' : along === 'u' ? 't' : 'b',
    statements = `  margoHairStrand=normalize(${strand}-s.n*dot(${strand},s.n)); margoHairNoise=margoHairHash(${along === 'v' || axis ? 'i.uv.x' : 'i.uv.y'}*${float(strands)});`,
    cached = new Map<string, string>();
  return {
    name: 'hair',
    serialization: () => ({ direction: axis ? [...axis] : along, shift, width, specular, strands, jitter }),
    tangentFrame: !axis,
    shader(source) {
      let out = cached.get(source);
      if (out !== undefined) return out;
      out = shaded(source, 'margoHairLight', statements, 'hair');
      if (axis)
        out = vertexFields(
          out,
          '@location(13) margoHairAxis:vec3f',
          `o.margoHairAxis=(margoObjectModel*vec4f(${vec3(axis)},0)).xyz;`,
          'hair',
        );
      out = wgsl + out;
      if (cached.size >= 16) cached.clear();
      cached.set(source, out);
      return out;
    },
    lit: (source) => localShaded(source, 'margoHairLight'),
  };
}
