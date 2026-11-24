// An eye: a sphere whose front is a clear cornea over a flat iris set back from it. The view ray refracts at the cornea by
// Snell's law into the aqueous humour and meets the iris plane, so the iris sits inside the eye and shifts with the view, instead of being painted
// on the ball. The light refracts the same way, so the iris is lit through the cornea, brightest on the side away from the
// light. The sizes are those of Gullstrand's schematic eye as usually quoted: cornea index 1.376, aqueous humour 1.336,
// an eyeball 24 mm across, an iris about 11.7 mm across and an anterior chamber about 3 mm deep. The cornea is thin
// (about 0.5 mm) with nearly parallel faces, so a ray crossing it leaves in the direction Snell's law gives from air
// straight into the aqueous humour: the view and light rays bend by the chamber's index, and the cornea's own index sets
// only the reflection at its front face. Outside the cornea the material is the sclera. The reflection is GGX on the
// smooth cornea, F0 from the cornea's index; a normal map shows on the sclera only.
// The cornea is steeper than the eyeball: its front radius is 7.8 mm against the globe's 12 (Le Grand's full theoretical
// eye, in Atchison and Smith, Optics of the Human Eye, 2000), so the rays refract on a sphere of that radius whose apex is
// the mesh's, and the pupil plane sits 3.6 mm behind the apex. The entrance pupil then appears 1.13 times the real one,
// as the published eye gives (test/features-browser.mjs traces it). The whole front is wet: a tear film of index 1.337
// (Craig, Simmons, Patel and Tomlinson 1995) lies over cornea and sclera alike, an optically smooth coat (keratometry reads
// the cornea's curvature off its reflection) with the cornea's roughness, over the rough white, which keeps the light the
// film does not reflect.
// The upper lid shades the ball under it. Its margin is a ledge about 2 mm thick (the lid margin's width, Snell and Lemp,
// Clinical Anatomy of the Eye, 2nd ed., 1998) standing out from the globe, so a point x below the margin sees the sky only
// below the ledge: a ray going up at slope wy / wz is blocked when x wz < D wy. Its cosine-weighted visibility over a
// sky brighter overhead (the CIE standard overcast sky, L = (1 + 2 sin elevation) / 3, Moon and Spencer 1942, CIE S
// 011/E:2003, over ground of albedo 0.2), integrated per azimuth as ambient occlusion with a horizon (Zhukov, Iones and
// Kronin, "An Ambient Light Illumination Model", EGWR 1998; Jimenez, Wu, Pesce and Jarabo, "Practical Realtime Strategies
// for Accurate Indirect Occlusion", SIGGRAPH 2016 course), is 0.2015 at the margin and fits
// V(q) = 0.2015 + 0.7985 (1 - 1 / (1 + 0.44 q + 1.15 q^2)), q = x / D, within 0.005 of the integral. A light the ledge
// blocks by that same test casts the lid's shadow. Film eyes darken the ball under the lid the same way (Jimenez, von der
// Pahlen et al., "Next-Generation Character Rendering", GDC 2013, eye occlusion). The term stays above a measured eye's
// own profile: in a CC0 frontal eye photograph the sclera reads 0.15, 0.25, 0.42, 0.55, 0.69, 0.80 of its middle in the
// twentieths under the margin, the term alone 0.28, 0.41, 0.54, 0.66, 0.75, 0.83 for an 8 mm high opening (above the
// photograph in every band for openings of 7 mm and more); the rest is the lashes and the ball's own curve. The margin sits `height` radii above the axis on the eye's up side, as a parabola
// across it (the margin reflex distance, 4 to 5 mm above the pupil in adults, Putterman, "Margin Reflex Distance (MRD) 1,
// 2, and 3", Ophthalmic Plastic and Reconstructive Surgery 28(4), 2012), and the upper lid follows the eye up and down
// (Becker and Fuchs, "Lid-eye coordination during vertical gaze changes in man and monkey", J. Neurophysiology 60(4),
// 1988), so the margin turns with `follow`.
// The lower lid is the same ledge turned over (`lowerLid`): a point above its margin loses the rays going down at slope
// steeper than q = x / D, which see only the ground. The ground is of even radiance, so the share of the lower half a
// forward-facing point still sees is q / sqrt(1 + q^2) exactly (the cosine-weighted integral; the upper ledge's uniform
// case is 1/2 (1 + q / sqrt(1 + q^2)), which the same integral gives), and the lower half carries 0.2015 of the light
// under the overcast sky above: V(q) = 1 - 0.2015 (1 - q / sqrt(1 + q^2)), 0.7985 at the margin. The two ledges block
// rays on either side of the horizon, which never overlap, so the eye's ambient visibility is V_upper + V_lower - 1. The
// lower margin sits 5 to 5.5 mm under the pupil in adults (the margin reflex distance 2, Putterman 2012; Boboridis,
// Assi, Indar, Bunce and Tyers, "Repeatability and reproducibility of upper eyelid measurements", Br J Ophthalmol
// 85(1), 2001), and rises toward the corners. The term stays above the CC0 photograph's lower white (0.58 and 0.49 of
// its middle in the bottom fifths, references/eyes/LABEL.md): the rest there is the ball turning away from the light.
import { ggxD, smithGCorrelated } from '../../shared/light-terms.js';
import { direction, float, localShaded, shaded, vertexFields, within } from './character-light.js';
import { whiteTexture } from '../../shared/white-texture.js';
import type { Material, MaterialFeature, Texture } from './built-material.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };

/** Options of `eye()`. */
export interface EyeOptions {
  /** Iris picture, its centre at the middle of the map. Default none: fibres drawn in `irisColor`. */
  irisMap?: Texture;
  /** Pupil radius in `irisMap`, as a share of the iris's radius. Default 0.3. */
  irisMapPupil?: number;
  /**
   * Iris radius in `irisMap`, in UV units from the map's middle, above 0 and at most 0.5. Default 0.5 (the iris fills
   * the map). Character Creator's eye maps hold the iris in the middle eighth: 0.123.
   */
  irisMapRadius?: number;
  /** Linear colour of the iris, three numbers; it multiplies `irisMap`. Live on the feature. Default a grey blue. */
  irisColor?: readonly [number, number, number];
  /** Pupil radius, as a share of the iris's radius, above 0, below 1. Live on the feature. Default 0.3. */
  pupil?: number;
  /** Iris radius, as a share of the eyeball's radius. Default 0.49. */
  irisRadius?: number;
  /** How far the iris sits behind the front of the eyeball, as a share of its radius. Default 0.3 (3.6 mm of 12). */
  depth?: number;
  /**
   * Radius of the cornea's front, as a share of the eyeball's radius, above 0 and at most 1 (1: the eyeball's own
   * sphere, as before 2026-11-18). Default 0.65 (7.8 mm of 12, Le Grand).
   */
  corneaRadius?: number;
  /**
   * How much of the tear film's reflection shows, 0 to 1: 1 is a healthy wet eye, 0 a dry one (the white's own
   * `roughness` alone, and the cornea's own index at its front). Live on the feature. Default 1.
   */
  wetness?: number;
  /** Index of refraction of the cornea, which sets its reflection (F0). Default 1.376. */
  ior?: number;
  /**
   * Index of refraction of the aqueous humour behind the thin cornea, which sets how far the view and light rays bend
   * on their way to the iris. Default 1.336 (Gullstrand).
   */
  chamberIor?: number;
  /** The way the eye looks, in the mesh's axes. Default [0, 0, 1]. */
  axis?: readonly [number, number, number];
  /** The eye's up, in the mesh's axes: where the upper lid is, and the iris picture's up. Default [0, 1, 0]. */
  up?: readonly [number, number, number];
  /**
   * The upper lid over the eye, whose margin shades the ball below it (ambient occlusion and the lid's shadow), or false
   * for a bare eyeball. Default {@link EyeLid}'s defaults.
   */
  lid?: EyeLid | false;
  /**
   * The lower lid under the eye, whose margin shades the ball above it (ambient occlusion of the ground light, and the
   * shadow of a light from below), or false for none. Its `height` is below the axis (negative). Default height -0.45
   * (5.4 mm of 12, an adult's margin reflex distance 2), tilt 0, curve 0.3 (rising toward the corners), depth 1/6.
   */
  lowerLid?: EyeLid | false;
  /** The centre of the eyeball, in the mesh's axes. Default [0, 0, 0]. */
  center?: readonly [number, number, number];
  /**
   * What moves the eyeball within its mesh, read on every draw: 16 numbers, a column-major 4x4 matrix in the mesh's
   * axes, that carries `center` and `axis` along. For an eyeball skinned to a joint pass that joint's skin matrix (the
   * mesh's inverse world matrix times the joint's world matrix times its inverse bind matrix), as the skinning moves its
   * vertices; `@margoengine/humans` `addPerson` does it for you. Default none: the eye stays where `center` puts it.
   */
  follow?: () => ArrayLike<number>;
}
/** The upper lid of `eye()`: its margin, as heights on the ball in eyeball radii, and how far it stands out. */
export interface EyeLid {
  /** Height of the margin above the eye's axis, in radii, from -1 to 1. Default 0.375 (4.5 mm of 12, an adult's margin reflex distance). */
  height?: number;
  /** How much the margin rises per radius toward the eye's right (`up` cross `axis`), from -2 to 2. Default 0. */
  tilt?: number;
  /** How much it falls toward the corners: height + tilt s + curve s^2 at s radii across. From -2 to 2. Default -0.4. */
  curve?: number;
  /** How far the lid stands out from the ball, in radii, above 0 and at most 1. Default 1/6 (2 mm of 12). */
  depth?: number;
}
/** What `eye()` returns: the feature, and the numbers that stay live. */
export interface EyeFeature extends MaterialFeature {
  /** Pupil radius, as a share of the iris's radius. */
  pupil: number;
  /** Linear colour of the iris. */
  irisColor: [number, number, number];
  /** How much of the tear film's reflection shows, 0 to 1. */
  wetness: number;
}
// In the shader: `cn` is the cornea's own sphere, its apex on the mesh's; its normal bends the rays and carries the
// reflection. `below` is how far under the upper lid's margin a point is, in radii, `lq` that over the lid's depth (the
// ledge's ambient occlusion), and `lit` whether the ledge lets a light through. In margoEyeLight the front over the cornea is the tear film when wet, and over the white the film is a
// smooth coat (`coat`, `film`) on the rough lobe.
const tearF0 = ((1.337 - 1) / (1.337 + 1)) ** 2;
const lidAmbient = (q: string) => `(0.2015+0.7985*(1.0-1.0/(1.0+0.44*${q}+1.15*${q}*${q})))`;
const code = (
  group: number,
  mapped: boolean,
  chamber: string,
  f0: string,
  mapPupil: string,
  cornea: string,
  mapRadius: string,
) => `struct MargoEyeRows {iris:vec4f, shape:vec4f, centre:vec4f, axis:vec4f, right:vec4f, lid:vec4f, low:vec4f}
@group(${group}) @binding(132) var<uniform> margoEyeRows:MargoEyeRows;
${mapped ? `@group(${group}) @binding(133) var margoEyeMap:texture_2d<f32>;\n@group(${group}) @binding(134) var margoEyeSampler:sampler;\n` : ''}var<private> margoEyeCornea:f32;
var<private> margoEyeLook:vec3f;
var<private> margoEyeRoughness:f32;
var<private> margoEyeWet:f32;
var<private> margoEyeUp:vec3f;
var<private> margoEyeBelow:f32;
var<private> margoEyeDepth:f32;
var<private> margoEyeAbove:f32;
var<private> margoEyeLowDepth:f32;
fn margoEyeHash(k:f32)->f32 {
  var x=bitcast<u32>(i32(k))*747796405u+2891336453u; x=((x>>((x>>28u)+4u))^x)*277803737u; x^=x>>22u;
  return f32(x>>8u)/16777216.0;
}
fn margoEyeSpokes(angle:f32,count:f32)->f32 {
  let a=(angle/6.2831853+0.5)*count; let low=floor(a); let t=a-low;
  return mix(margoEyeHash(low),margoEyeHash(low+1.0-select(0.0,count,low+1.0>=count)),t*t*(3.0-2.0*t));
}
// Fibres: spokes of two scales, darker toward the pupil and the rim, and a lighter ring a third of the way out.
fn margoEyeFibres(q:vec2f,t:f32)->vec3f {
  let angle=atan2(q.y,q.x); let fine=margoEyeSpokes(angle,96.0); let broad=margoEyeSpokes(angle,24.0);
  let ring=exp(-pow((t-0.32)/0.14,2.0));
  return vec3f((0.45+0.35*fine+0.3*broad)*(0.8+0.5*ring));
}
fn margoEyeSurface(i:Out,n:vec3f,under:Surface)->Surface {
  let axis=normalize(i.margoEyeAxis); let right=normalize(i.margoEyeRight-axis*dot(i.margoEyeRight,axis)); let up=cross(axis,right);
  let k=margoEyeRows.shape; let d=i.position-i.margoEyeCentre; let radius=length(d); let iris=radius*k.y;
  let height=dot(d,axis); let rim=length(d-axis*height)/iris;
  let cn=normalize(d-axis*(radius*(1.0-${cornea})));
  let v=normalize(f.eye.xyz-i.position); let r=refract(-v,cn,1.0/${chamber});
  let hit=d+r*((radius*(1.0-k.w)-height)/min(dot(r,axis),-0.0001));
  let q=vec2f(dot(hit,right),dot(hit,up))/iris; let dx=dpdx(q); let dy=dpdy(q); let reach=length(q);
  let t=clamp((reach-k.z)/(1.0-k.z),0.0,1.0);
  let picture=${mapped ? `textureSampleGrad(margoEyeMap,margoEyeSampler,q/max(reach,0.00001)*mix(${mapPupil},1.0,t)*${mapRadius}+0.5,dx*${mapRadius},dy*${mapRadius}).rgb` : 'margoEyeFibres(q,t)'};
  let soft=max(length(dx)+length(dy),0.004);
  let colour=margoEyeRows.iris.rgb*picture*smoothstep(k.z-soft,k.z+soft,reach)*mix(1.0,0.25,smoothstep(0.8,1.0,reach));
  // Where the ray misses the iris it meets the white of the eye, in the iris's shadow.
  let inside=mix(colour,under.base.rgb*0.25,smoothstep(1.0,1.08,reach));
  let cornea=select(0.0,1.0-smoothstep(0.94,1.06,rim),height>0.0);
  var s=under; s.base=vec4f(mix(under.base.rgb,inside,cornea),under.base.a); s.n=normalize(mix(under.n,cn,cornea));
  s.roughness=mix(under.roughness,0.05,cornea); s.metal=0.0;
  margoEyeCornea=cornea; margoEyeLook=axis; margoEyeRoughness=s.roughness; margoEyeWet=margoEyeRows.iris.a;
  let lid=margoEyeRows.lid; let sx=dot(d,right)/radius; let below=lid.x+(lid.y+lid.z*sx)*sx-dot(d,up)/radius;
  let lq=max(below,0.0)/max(lid.w,0.0001);
  let low=margoEyeRows.low; let above=dot(d,up)/radius-(low.x+(low.y+low.z*sx)*sx);
  let uq=max(above,0.0)/max(low.w,0.0001);
  s.occlusion*=select(1.0,${lidAmbient('lq')},lid.w>0.0)+select(0.0,-0.2015*(1.0-uq/sqrt(1.0+uq*uq)),low.w>0.0);
  margoEyeUp=up; margoEyeBelow=below; margoEyeDepth=lid.w; margoEyeAbove=above; margoEyeLowDepth=low.w;
  return s;
}
fn margoEyeLight(n:vec3f,v:vec3f,l:vec3f,base:vec3f)->vec3f {
  let h=(v+l)/max(length(v+l),0.0001); let nl=clamp(dot(n,l),0.0,1.0); let nv=clamp(dot(n,v),0.0001,1.0);
  let nh=clamp(dot(n,h),0.0,1.0); let vh=clamp(dot(v,h),0.0,1.0); let a=margoEyeRoughness*margoEyeRoughness; let a2=a*a;
  let d=${ggxD}; let g=${smithGCorrelated};
  let f0=mix(0.04,mix(${f0},${float(tearF0)},margoEyeWet),margoEyeCornea); let fresnel=f0+(1-f0)*pow(1-vh,5.0);
  let coat=margoEyeWet*(1.0-margoEyeCornea)*(${float(tearF0)}+${float(1 - tearF0)}*pow(1-vh,5.0)); let w2=0.0025*0.0025;
  let film=coat*${ggxD.replaceAll('a2', 'w2')}*${smithGCorrelated.replaceAll('a2', 'w2')}/max(4*nv,0.0001);
  let through=select(0.0,max(dot(-refract(-l,n,1.0/${chamber}),margoEyeLook),0.0),nl>0.0);
  let lit=select(1.0,1.0-smoothstep(0.0,0.02,margoEyeDepth*dot(l,margoEyeUp)-margoEyeBelow*dot(l,margoEyeLook)),margoEyeDepth>0.0)*
    select(1.0,1.0-smoothstep(0.0,0.02,-margoEyeLowDepth*dot(l,margoEyeUp)-margoEyeAbove*dot(l,margoEyeLook)),margoEyeLowDepth>0.0);
  return lit*(1-coat)*((1-fresnel)*base/3.14159265*mix(nl,through,margoEyeCornea)+d*g*fresnel/max(4*nv,0.0001))+lit*film;
}
`;
/**
 * An eye for a sphere mesh: a refracting cornea over an iris set back inside it, with a pupil that opens and closes.
 * Assign it through `Material.features` on a `PbrMaterial`, whose `color`, `map` and `roughness` are the white of the eye.
 * Works on any size of sphere with nothing else; `feature.pupil` and `feature.irisColor` are live.
 */
export function eye(options: EyeOptions = {}): EyeFeature {
  const {
      irisMap,
      irisMapPupil = 0.3,
      irisMapRadius = 0.5,
      irisRadius = 0.49,
      depth = 0.3,
      corneaRadius = 0.65,
      ior = 1.376,
      chamberIor = 1.336,
      center = [0, 0, 0],
    } = options,
    look = direction(options.axis ?? [0, 0, 1], 'eye axis'),
    upward = direction(options.up ?? [0, 1, 0], 'eye up'),
    lid = options.lid === false ? undefined : (options.lid ?? {}),
    lower = options.lowerLid === false ? undefined : (options.lowerLid ?? {});
  if (options.lid !== false && (lid === null || typeof lid !== 'object'))
    throw new TypeError('eye lid must be an object of lid numbers or false; pass {} for the default lid');
  if (options.lowerLid !== false && (lower === null || typeof lower !== 'object'))
    throw new TypeError('eye lowerLid must be an object of lid numbers or false; pass {} for the default lower lid');
  const lidRow = lid
    ? [
        within(lid.height ?? 0.375, -1.000001, 1, 'eye lid height'),
        within(lid.tilt ?? 0, -2.000001, 2, 'eye lid tilt'),
        within(lid.curve ?? -0.4, -2.000001, 2, 'eye lid curve'),
        within(lid.depth ?? 1 / 6, 0, 1, 'eye lid depth'),
      ]
    : [0, 0, 0, 0];
  const lowRow = lower
    ? [
        within(lower.height ?? -0.45, -1.000001, 1, 'eye lowerLid height'),
        within(lower.tilt ?? 0, -2.000001, 2, 'eye lowerLid tilt'),
        within(lower.curve ?? 0.3, -2.000001, 2, 'eye lowerLid curve'),
        within(lower.depth ?? 1 / 6, 0, 1, 'eye lowerLid depth'),
      ]
    : [0, 0, 0, 0];
  within(irisMapPupil, 0, 0.99, 'eye irisMapPupil');
  within(irisMapRadius, 0, 0.5, 'eye irisMapRadius');
  if (options.follow !== undefined && typeof options.follow !== 'function')
    throw new TypeError('eye follow must be a function returning a 4x4 matrix of 16 numbers; pass one or leave it out');
  within(irisRadius, 0, 1, 'eye irisRadius');
  within(depth, 0, 1, 'eye depth');
  within(corneaRadius, 0, 1, 'eye corneaRadius');
  within(ior, 1, 3, 'eye ior');
  within(chamberIor, 1, 3, 'eye chamberIor');
  if (!Array.isArray(center) || center.length !== 3 || !center.every((v) => Number.isFinite(Math.fround(v))))
    throw new TypeError("eye center must be three finite numbers; pass a point in the mesh's axes");
  if (irisMap !== undefined && typeof irisMap?.bind !== 'function')
    throw new TypeError('eye irisMap must be a Texture; pass one');
  // The eye's up across its axis; any other direction across it when up lies along the axis.
  const along = Math.abs(upward[0] * look[0] + upward[1] * look[1] + upward[2] * look[2]),
    across =
      along <= 0.9 * Math.hypot(...look) * Math.hypot(...upward)
        ? upward
        : Math.abs(look[0]) > 0.9 * Math.hypot(...look)
          ? [0, 1, 0]
          : [1, 0, 0],
    side = [
      across[1] * look[2] - across[2] * look[1],
      across[2] * look[0] - across[0] * look[2],
      across[0] * look[1] - across[1] * look[0],
    ],
    f0 = ((ior - 1) / (ior + 1)) ** 2,
    cached = new Map<string, string>(),
    data = new Float32Array(28),
    moved = new Float64Array(9),
    buffers = new Map<GPUDevice, { buffer: GPUBuffer; last: Float32Array }>();
  let users = 0,
    pupil = 0.3,
    wetness = 1;
  const feature: EyeFeature = {
    name: 'eye',
    serialization: () => ({
      ...options,
      follow: undefined,
      irisColor: [...feature.irisColor],
      pupil: feature.pupil,
      wetness: feature.wetness,
      axis: [...look],
      center: [...center],
    }),
    irisColor: [...(options.irisColor ?? [0.16, 0.3, 0.42])],
    get pupil() {
      return pupil;
    },
    set pupil(v: number) {
      if (typeof v !== 'number' || !(v > 0 && v < 1))
        throw new RangeError('eye pupil must be above 0 and below 1; pass a share of the iris radius such as 0.3');
      pupil = v;
    },
    get wetness() {
      return wetness;
    },
    set wetness(v: number) {
      if (typeof v !== 'number' || !(v >= 0 && v <= 1))
        throw new RangeError('eye wetness must be from 0 to 1; pass 1 for a healthy wet eye');
      wetness = v;
    },
    shader(source, group) {
      const id = group + source;
      let out = cached.get(id);
      if (out !== undefined) return out;
      out = shaded(source, 'margoEyeLight', '  s=margoEyeSurface(i,n,s);', 'eye');
      out = vertexFields(
        out,
        '@location(13) @interpolate(flat) margoEyeAxis:vec3f, @location(14) @interpolate(flat) margoEyeRight:vec3f, @location(15) @interpolate(flat) margoEyeCentre:vec3f',
        'o.margoEyeAxis=(margoObjectModel*vec4f(margoEyeRows.axis.xyz,0)).xyz; o.margoEyeRight=(margoObjectModel*vec4f(margoEyeRows.right.xyz,0)).xyz; o.margoEyeCentre=(margoObjectModel*vec4f(margoEyeRows.centre.xyz,1)).xyz;',
        'eye',
      );
      out =
        code(group, !!irisMap, float(chamberIor), float(f0), float(irisMapPupil), float(corneaRadius), float(irisMapRadius)) +
        out;
      if (cached.size >= 16) cached.clear();
      cached.set(id, out);
      return out;
    },
    lit: (source) => localShaded(source, 'margoEyeLight'),
    bindings(device: GPUDevice) {
      let held = buffers.get(device);
      if (!held)
        buffers.set(
          device,
          (held = {
            buffer: device.createBuffer({
              size: data.byteLength,
              usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            }),
            last: new Float32Array(data.length).fill(Number.NaN),
          }),
        );
      // The centre, axis and a side direction, in the mesh's axes, moved by `follow` when the eyeball moves in its mesh.
      const m = options.follow?.();
      if (m !== undefined && (m.length !== 16 || !Array.from(m).every(Number.isFinite)))
        throw new TypeError('eye follow must return 16 finite numbers, a column-major 4x4 matrix');
      for (let r = 0; r < 3; r++) {
        const at = (c: number) => (m ? m[c * 4 + r] : +(c === r));
        moved[r] = at(0) * center[0] + at(1) * center[1] + at(2) * center[2] + (m ? m[12 + r] : 0);
        moved[3 + r] = at(0) * look[0] + at(1) * look[1] + at(2) * look[2];
        moved[6 + r] = at(0) * side[0] + at(1) * side[1] + at(2) * side[2];
      }
      data.set([...feature.irisColor, wetness, 1, irisRadius, pupil, depth]);
      data.set([moved[0], moved[1], moved[2], 1, moved[3], moved[4], moved[5], 0, moved[6], moved[7], moved[8], 0], 8);
      data.set(lidRow, 20);
      data.set(lowRow, 24);
      // Steady frames upload nothing.
      if (data.some((v, k) => v !== held.last[k])) {
        device.queue.writeBuffer(held.buffer, 0, data);
        held.last.set(data);
      }
      const entries: GPUBindGroupEntry[] = [{ binding: 132, resource: { buffer: held.buffer } }];
      if (irisMap) {
        const [view, sampler] = irisMap.bind(device, true) ?? whiteTexture(device, '2d');
        entries.push({ binding: 133, resource: view }, { binding: 134, resource: sampler });
      }
      return entries;
    },
    attach(_material: Material) {
      users++;
    },
    detach(_material: Material) {
      if (--users > 0) return;
      for (const { buffer } of buffers.values()) buffer.destroy();
      buffers.clear();
    },
  };
  feature.pupil = options.pupil ?? 0.3;
  feature.wetness = options.wetness ?? 1;
  return feature;
}
