// Strand hair. A fibre scatters light into a cone about the plane across it, so the highlights run across the strands
// and follow the direction of the hair instead of the surface normal (Kajiya and Kay 1989). Marschner, Jensen, Cammarano,
// Worley and Hanrahan ("Light scattering from human hair fibers", 2003) split what a fibre sends out by the path inside it:
// R reflects off the surface, white; TT crosses the fibre and leaves on the far side, so a hair lit from behind glows in
// its own colour; TRT crosses, reflects off the back and leaves on the near side, a tinted second highlight. Cuticle
// scales tilt the surface toward the root by alpha, so R peaks alpha toward the root, TT alpha / 2 and TRT 3 alpha / 2 the
// other way, with widths beta, beta / 2 and 2 beta. Each lobe is S_p = M_p(theta_i, theta_r) A_p N_p(phi) / cos^2 theta_d:
// a longitudinal Gaussian normalised over theta_i (d'Eon, Francois, Hill, Letteri and Aubry, "An energy-conserving hair
// reflectance model", 2011), the attenuation A_p of the path, and an azimuthal lobe: R's 1/4 cos(phi / 2), TT's spread
// about phi = pi (its width from Marschner's dphi/dh at the fibre's middle, 2 / eta - 2, widened by the azimuthal
// roughness), TRT's and the rest's even over the circle. A_R = f, A_TT = (1 - f)^2 T, A_TRT = (1 - f)^2 f T^2, and every
// longer path together (1 - f)^2 f^2 T^3 / (1 - f T) (Chiang, Bitterli, Tappan and Burley, "A practical and controllable
// hair and fur model for production path tracing", 2016), with f Schlick's Fresnel at the cuticle's index 1.55 and
// T = exp(-sigma_a 2 / cos theta_t) the absorption across the middle of the fibre. With no absorption the lobes sum to 1:
// the fibre loses no light. sigma_a comes from the hair's colour by Chiang et al.'s fit, or from melanin by d'Eon et al.'s
// coefficients. Light that bounced between many fibres stays the Kajiya and Kay diffuse in the hair's colour. A hash per
// strand moves alpha and scales TRT, which breaks the highlight into strands.
// Every lobe is measured from the fibre's tangent (Kajiya and Kay 1989; Marschner et al. 2003), so on a skinned mesh
// the tangent has to turn with the bones. A UV direction reads the deformed tangents, which linear blend and dual
// quaternion skinning turn per vertex by the blended joint rotation (Kavan, Collins, Zara and O'Sullivan, "Geometric
// skinning with approximate dual quaternion blending", 2008). A mesh-axis direction is one vector for the mesh, so it
// turns by one joint's skin matrix, `follow`, read every draw: the vertex stage holds deformed vertices only, without
// the rest frame or joints a per-vertex turn would need (Scheuermann, "Practical real-time hair rendering and
// shading", SIGGRAPH 2004 sketch, takes the strand direction from the mesh's tangents for the same reason).
import { direction, float, localShaded, shaded, vec3, vertexFields, within } from './character-light.js';
import type { Material, MaterialFeature } from './built-material.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };

/** Options of `hair()`. */
export interface HairOptions {
  /** The way strands run, root to tip: along the UV's `'u'` or `'v'`, or a direction in the mesh's axes, such as [0, -1, 0]. Default 'v'. */
  direction?: 'u' | 'v' | readonly [number, number, number];
  /** Angle in radians of the white highlight (R) toward the root; TT goes half as far the other way, TRT 1.5 times as far. Default 0.09. */
  shift?: number;
  /** Longitudinal width in radians of the white highlight (R); TT is half as wide, TRT twice. Default 0.12. */
  width?: number;
  /** Azimuthal roughness, 0 to 1: how far light through the fibre (TT) spreads round it. Default 0.3. */
  roughness?: number;
  /**
   * Absorption inside the fibre per fibre radius, red, green and blue, as `melaninAbsorption()` gives. Default none: it
   * comes from the material's colour (Chiang et al. 2016), so a map's blond and dark strands each glow their own colour.
   */
  absorption?: readonly [number, number, number];
  /** Strength of the light scattered by the fibre (R, TT, TRT and the rest). Default 1. */
  specular?: number;
  /** Strands across one unit of UV, each with its own highlight. Default 200. */
  strands?: number;
  /** How far a strand's shift wanders, in radians. Default 0.06. */
  jitter?: number;
  /**
   * What turns a mesh-axis `direction` within its mesh, read on every draw: 16 numbers, a column-major 4x4 matrix in the
   * mesh's axes. On hair skinned to a joint pass that joint's skin matrix (the mesh's inverse world matrix times the
   * joint's world matrix times its inverse bind matrix), as the skinning moves its vertices, so the strands turn with
   * the head; `@margoengine/humans` `addPerson` does it for you. Only for a direction given as three numbers: a `'u'` or
   * `'v'` direction reads the skinned tangents, which already turn with every joint. Default none: the direction stays
   * fixed in the mesh.
   */
  follow?: () => ArrayLike<number>;
}
/** Cuticle index 1.55: Schlick's F0, ((1.55 - 1) / (1.55 + 1))^2. */
const eta = 1.55,
  f0 = ((eta - 1) / (eta + 1)) ** 2,
  // TT's azimuthal spread on a smooth fibre: Marschner's N = A / (2 |dphi / dh|) peaks at phi = pi, where |dphi / dh| is
  // 2 - 2 / eta, at A / (4 - 4 / eta); the Gaussian of that peak height has this deviation, about 0.57 radians.
  smoothTT = (2 - 2 / eta) / (0.5 * Math.sqrt(2 * Math.PI));
/**
 * Absorption per fibre radius, red, green and blue, of hair with `eumelanin` (dark brown to black) and `pheomelanin`
 * (red) concentrations, by d'Eon et al. 2011's coefficients. About 0.3 eumelanin is blond, 1.3 brown, 8 black.
 */
export function melaninAbsorption(eumelanin: number, pheomelanin = 0): [number, number, number] {
  if (!(eumelanin >= 0) || !(pheomelanin >= 0) || !Number.isFinite(eumelanin + pheomelanin))
    throw new RangeError('hair melanin must be finite numbers of 0 or more; pass 0.3 for blond, 8 for black');
  const eu = [0.419, 0.697, 1.37],
    pheo = [0.187, 0.4, 1.05];
  return [0, 1, 2].map((c) => eumelanin * eu[c] + pheomelanin * pheo[c]) as [number, number, number];
}
/** Chiang et al. 2016's divisor that turns a colour into absorption, for azimuthal roughness `beta`. */
const colorScale = (beta: number) =>
  5.969 - 0.215 * beta + 2.532 * beta ** 2 - 10.73 * beta ** 3 + 5.574 * beta ** 4 + 0.245 * beta ** 5;
/** Absorption per fibre radius of hair whose many-bounce colour is `color` (linear), at azimuthal roughness `roughness`. */
export function colorAbsorption(color: readonly number[], roughness = 0.3): [number, number, number] {
  const s = colorScale(roughness);
  return [0, 1, 2].map((c) => (Math.log(Math.min(1, Math.max(color[c], 1e-3))) / s) ** 2) as [number, number, number];
}
// Five-point Gauss-Legendre on [0, 1], for the Fresnel of a fibre averaged over where light strikes it.
const nodes = [0.0469101, 0.2307653, 0.5, 0.7692347, 0.9530899],
  weights = [0.1184634, 0.2393143, 0.2844444, 0.2393143, 0.1184634];
/**
 * Schlick's Fresnel averaged over the fibre's width: light that strikes at h in [-1, 1] meets the cuticle at
 * cos theta_d sqrt(1 - h^2). It is also the share R reflects, so A_R + A_TT + A_TRT + ... is 1 with no absorption.
 */
const meanFresnel = (cd: number) =>
  nodes.reduce((sum, h, k) => sum + weights[k] * (f0 + (1 - f0) * (1 - cd * Math.sqrt(1 - h * h)) ** 5), 0);
const gauss = (x: number, w: number) => Math.exp((-x * x) / (2 * w * w)) / (w * Math.sqrt(2 * Math.PI));
/** Width of TT's azimuthal lobe at azimuthal roughness `roughness`. */
const ttWidth = (roughness: number) => Math.hypot(smoothTT, roughness);
/**
 * The fibre's scattering S(l, v) of `hair()`, red, green and blue, without the strand hash, the diffuse and the cosine:
 * radiance out along `v` per irradiance from `l` on a fibre running along `tangent` (unit vectors). For tests and
 * tooling; the shader computes the same.
 */
export function hairScattering(
  l: readonly number[],
  v: readonly number[],
  tangent: readonly number[],
  color: readonly number[],
  options: Pick<HairOptions, 'shift' | 'width' | 'roughness' | 'absorption'> = {},
): [number, number, number] {
  const { shift = 0.09, width = 0.12, roughness = 0.3 } = options,
    sigma = options.absorption ?? colorAbsorption(color, roughness),
    dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    si = Math.min(1, Math.max(-1, dot(l, tangent))),
    sr = Math.min(1, Math.max(-1, dot(v, tangent))),
    x = Math.asin(si) + Math.asin(sr),
    td = (Math.asin(sr) - Math.asin(si)) / 2,
    cd = Math.cos(td),
    lp = l.map((c, k) => c - tangent[k] * si),
    vp = v.map((c, k) => c - tangent[k] * sr),
    cphi = Math.min(1, Math.max(-1, dot(lp, vp) / Math.sqrt(Math.max(dot(lp, lp) * dot(vp, vp), 1e-16)))),
    phi = Math.acos(cphi),
    a = -shift,
    fr = f0 + (1 - f0) * (1 - Math.sqrt(0.5 + 0.5 * dot(l, v))) ** 5,
    f = meanFresnel(cd),
    sinT = Math.sin(td) / eta,
    path = 2 / Math.sqrt(1 - sinT * sinT),
    mR = gauss(x - 2 * a, 2 * width),
    mTT = gauss(x + a, width),
    mTRT = gauss(x + 3 * a, 4 * width),
    nR = 0.25 * Math.sqrt(0.5 + 0.5 * cphi),
    nTT = gauss(Math.PI - phi, ttWidth(roughness)),
    ti = Math.asin(si),
    // A lobe leaves over directions that weigh cos^2 theta_r (a fibre seen at theta_r shows cos theta_r of its width, over
    // d omega = cos theta_r d theta d phi), so each Gaussian is divided by the mean of cos^2 theta_r under it, for
    // theta_r ~ N(mu, s^2) (1 + cos(2 mu) e^(-2 s^2)) / 2: then it sums to A_p over the sphere. At a narrow lobe's peak this
    // is Marschner's 1 / cos^2 theta_d.
    spread = (centre: number, s: number) =>
      2 / Math.max(1 + Math.cos(2 * (centre - ti)) * Math.exp(-2 * s * s), 0.005),
    out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const t = Math.exp(-sigma[c] * path),
      g = (1 - f) * (1 - f) * t;
    out[c] =
      mR * fr * nR * spread(2 * a, 2 * width) +
      mTT * g * nTT * spread(-a, width) +
      (mTRT * (g * f * t + (g * f * f * t * t) / (1 - f * t)) * spread(-3 * a, 4 * width)) / (2 * Math.PI);
  }
  return out;
}
const code = (
  shift: string,
  width: string,
  specular: string,
  jitter: string,
  scale: string,
  tt: string,
  absorption: string,
  spreads: readonly string[],
) => `var<private> margoHairStrand:vec3f;
var<private> margoHairNoise:f32;
fn margoHairHash(k:f32)->f32 {
  var x=bitcast<u32>(i32(floor(k)))*747796405u+2891336453u; x=((x>>((x>>28u)+4u))^x)*277803737u; x^=x>>22u;
  return f32(x>>8u)/16777216.0;
}
fn margoHairGauss(x:f32,w:f32)->f32 {return exp(-x*x/(2.0*w*w))/(w*2.5066283);}
fn margoHairFresnel(cd:f32)->f32 {
  var m=0.0; ${nodes.map((h, k) => `m+=${float(weights[k])}*pow(1.0-cd*${float(Math.sqrt(1 - h * h))},5.0);`).join(' ')}
  return ${float(f0)}+${float(1 - f0)}*m;
}
fn margoHairSpread(r:f32,k:f32)->f32 {return 2.0/max(1.0+cos(2.0*r)*k,0.005);}
fn margoHairLight(n:vec3f,v:vec3f,l:vec3f,base:vec3f)->vec3f {
  let t=margoHairStrand; let si=clamp(dot(l,t),-1.0,1.0); let sr=clamp(dot(v,t),-1.0,1.0);
  let ti=asin(si); let x=ti+asin(sr); let td=(asin(sr)-ti)*0.5; let cd=cos(td); let across=sqrt(max(1.0-si*si,0.0));
  let lp=l-t*si; let vp=v-t*sr; let cphi=clamp(dot(lp,vp)*inverseSqrt(max(dot(lp,lp)*dot(vp,vp),1e-16)),-1.0,1.0);
  let a=-(${shift}+(margoHairNoise-0.5)*${jitter}); let w=${width};
  let fr=${float(f0)}+${float(1 - f0)}*pow(1.0-sqrt(0.5+0.5*dot(l,v)),5.0); let fd=margoHairFresnel(cd);
  let st=sin(td)/${float(eta)}; let path=2.0/sqrt(1.0-st*st);
  let sigma=${absorption}; let tr=exp(-sigma*path); let g=(1.0-fd)*(1.0-fd)*tr;
  let r=margoHairGauss(x-2.0*a,2.0*w)*fr*0.25*sqrt(0.5+0.5*cphi)*margoHairSpread(2.0*a-ti,${spreads[0]});
  let tt=margoHairGauss(x+a,w)*margoHairGauss(3.14159265-acos(cphi),${tt})*g*margoHairSpread(-a-ti,${spreads[1]});
  let trt=margoHairGauss(x+3.0*a,4.0*w)*(g*fd*tr*(0.5+margoHairNoise)+g*fd*fd*tr*tr/(1.0-fd*tr))/6.2831853*margoHairSpread(-3.0*a-ti,${spreads[2]});
  let wrap=clamp((dot(n,l)+0.5)/1.5,0.0,1.0);
  return base/3.14159265*across*wrap+(vec3f(r)+tt+trt)*across*${specular};
}
fn margoHairColorSigma(c:vec3f)->vec3f {let k=log(clamp(c,vec3f(0.001),vec3f(1.0)))/${scale}; return k*k;}
`;
/**
 * Strand hair after Marschner et al. 2003: a white highlight, light through the fibre that makes backlit hair glow, and
 * a tinted second highlight, for hair cards, hair meshes and strand ribbons. Assign it through `Material.features` on a
 * `PbrMaterial`, which keeps its `color` and `map`; the fibre's own scattering replaces its `roughness` and `metalness`.
 * Works with nothing else; pair it with `alphaHash()` for soft card edges.
 */
export function hair(options: HairOptions = {}): MaterialFeature {
  const {
    direction: along = 'v',
    shift = 0.09,
    width = 0.12,
    roughness = 0.3,
    absorption,
    specular = 1,
    strands = 200,
    jitter = 0.06,
  } = options;
  for (const [v, label] of [
    [shift, 'shift'],
    [jitter, 'jitter'],
  ] as const)
    if (typeof v !== 'number' || !(v >= -1 && v <= 1))
      throw new RangeError(`hair ${label} must be radians from -1 to 1; pass a small angle`);
  within(width, 0, 1, 'hair width');
  within(roughness, 0, 1, 'hair roughness');
  within(strands, 0, 1e6, 'hair strands');
  if (typeof specular !== 'number' || !(specular >= 0) || !Number.isFinite(specular))
    throw new RangeError('hair specular must be a finite number from 0 up; pass 1 for the default strength');
  if (options.follow !== undefined && typeof options.follow !== 'function')
    throw new TypeError('hair follow must be a function returning a 4x4 matrix of 16 numbers; pass one or leave it out');
  if (options.follow !== undefined && (along === 'u' || along === 'v'))
    throw new TypeError(
      "hair follow turns a direction given as three numbers; a 'u' or 'v' direction already follows the skinned tangents",
    );
  if (
    absorption !== undefined &&
    (!Array.isArray(absorption) || absorption.length !== 3 || !absorption.every((a) => a >= 0 && Number.isFinite(a)))
  )
    throw new RangeError('hair absorption must be three finite numbers of 0 or more; pass melaninAbsorption(1.3)');
  const axis = along === 'u' || along === 'v' ? undefined : direction(along, 'hair direction'),
    wgsl = code(
      float(shift),
      float(width),
      float(specular),
      float(jitter),
      float(colorScale(roughness)),
      float(ttWidth(roughness)),
      absorption ? vec3(absorption) : 'margoHairColorSigma(base)',
      [2, 1, 4].map((k) => float(Math.exp(-2 * (k * width) ** 2))),
    ),
    strand = axis ? 'i.margoHairAxis' : along === 'u' ? 't' : 'b',
    statements = `  margoHairStrand=normalize(${strand}-s.n*dot(${strand},s.n)); margoHairNoise=margoHairHash(${along === 'v' || axis ? 'i.uv.x' : 'i.uv.y'}*${float(strands)});`,
    cached = new Map<string, string>(),
    follow = axis && options.follow,
    // The direction in the mesh's axes, turned by `follow`, uploaded only when it changes.
    data = new Float32Array(4),
    buffers = new Map<GPUDevice, { buffer: GPUBuffer; last: Float32Array }>();
  let users = 0;
  const feature: MaterialFeature = {
    name: 'hair',
    serialization: () => ({
      direction: axis ? [...axis] : along,
      shift,
      width,
      roughness,
      ...(absorption ? { absorption: [...absorption] } : {}),
      specular,
      strands,
      jitter,
    }),
    tangentFrame: !axis,
    shader(source, group) {
      const id = (follow ? group : '') + source;
      let out = cached.get(id);
      if (out !== undefined) return out;
      out = shaded(source, 'margoHairLight', statements, 'hair');
      if (axis)
        out = vertexFields(
          out,
          '@location(13) margoHairAxis:vec3f',
          `o.margoHairAxis=(margoObjectModel*vec4f(${follow ? 'margoHairRows.axis.xyz' : vec3(axis)},0)).xyz;`,
          'hair',
        );
      out =
        (follow ? `struct MargoHairRows {axis:vec4f}
@group(${group}) @binding(135) var<uniform> margoHairRows:MargoHairRows;
` : '') +
        wgsl +
        out;
      if (cached.size >= 16) cached.clear();
      cached.set(id, out);
      return out;
    },
    lit: (source) => localShaded(source, 'margoHairLight'),
  };
  if (follow && axis) {
    feature.bindings = (device: GPUDevice) => {
      let held = buffers.get(device);
      if (!held)
        buffers.set(
          device,
          (held = {
            buffer: device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
            last: new Float32Array(data.length).fill(Number.NaN),
          }),
        );
      const m = follow();
      if (m?.length !== 16 || !Array.from(m).every(Number.isFinite))
        throw new TypeError('hair follow must return 16 finite numbers, a column-major 4x4 matrix');
      // A direction turns by the matrix's upper 3x3 (the fragment stage normalises it after projecting out the normal).
      for (let r = 0; r < 3; r++) data[r] = m[r] * axis[0] + m[4 + r] * axis[1] + m[8 + r] * axis[2];
      // Steady frames upload nothing.
      if (data.some((v, k) => v !== held.last[k])) {
        device.queue.writeBuffer(held.buffer, 0, data);
        held.last.set(data);
      }
      return [{ binding: 135, resource: { buffer: held.buffer } }];
    };
    feature.attach = (_material: Material) => {
      users++;
    };
    feature.detach = (_material: Material) => {
      if (--users > 0) return;
      for (const { buffer } of buffers.values()) buffer.destroy();
      buffers.clear();
    };
  }
  return feature;
}

/** Options of `hairCards()`. */
export interface HairCardOptions {
  /**
   * The smallest |cosine| between the view and the card's normal that the layer's path length is taken at, above 0 and
   * at most 1: a card seen edge on is a layer of hair as deep as the card is wide, not an endless one. 0.1 lets the
   * path grow tenfold. Default 0.1.
   */
  grazing?: number;
}
// gltf/pbr's beauty output: colour and, for a BLEND material, the base alpha.
const cardOutput = /return vec4f\(color,select\(1\.0,s\.base\.a,f\.settings\.x>1\.5\)\);/g;
/**
 * Hair cards as the layer of fibres they stand for (eyelashes, brows, card hair): a BLEND card's alpha is the share of
 * light the layer stops looking straight through it, and a ray that crosses it slantwise passes through more fibres.
 * With the layer's transmittance 1 - a at normal incidence, Beer-Lambert over the path 1 / |cos| gives
 * a' = 1 - (1 - a)^(1 / |cos|), the opacity correction of volume rendering (Max 1995, "Optical models for direct volume
 * rendering", IEEE TVCG; Engel, Hadwiger, Kniss, Rezk-Salama and Weiskopf 2006, "Real-Time Volume Graphics", the
 * opacity correction for a changed sampling distance), with the layer read as Kajiya and Kay's (1989) volume of hair.
 * Lashes seen from the front are cards seen nearly edge on, whose filtered alpha (strands averaged with the gaps
 * between them) is a small share: without this a CC eyelash card darkens the lid line by a few percent, with it by the
 * full fringe. Opaque and MASK materials keep their output. Assign it through `Material.features` or `install`.
 */
export function hairCards(options: HairCardOptions = {}): MaterialFeature {
  const { grazing = 0.1 } = options;
  within(grazing, 0, 1, 'hairCards grazing');
  const floor = float(grazing);
  return {
    name: 'hairCards',
    serialization: () => ({ grazing }),
    shader(source) {
      const out = source.replace(
        cardOutput,
        `let margoCardCos=max(abs(dot(normalize(i.normal),v)),${floor});\n  return vec4f(color,select(1.0,1.0-pow(1.0-clamp(s.base.a,0.0,1.0),1.0/margoCardCos),f.settings.x>1.5));`,
      );
      if (out === source)
        throw new TypeError('hairCards needs the standard gltf/pbr shader; use matching gltf/pbr and materials versions');
      return out;
    },
  };
}
