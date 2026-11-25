// Retroreflection: light returned toward where it came from (road signs, safety vests, reflective paint, cat's eyes).
// Clean room from Portsmouth, Raab, Belcour and Liu, "The Minimal Retroreflective Microfacet Model", Journal of
// Computer Graphics Techniques 15(1), 2026 (https://arxiv.org/abs/2606.08739): a microfacet BRDF becomes
// retroreflective when the view direction is mirrored about the normal before it is evaluated, which puts the half
// vector between the light and the mirrored view (the back vector of Belcour, Pacanowski, Delahaie, Laville-Geay and
// Eveline, "Bidirectional reflectance distribution function measurements and analysis of retroreflective materials",
// JOSA A 31(12), 2014, https://doi.org/10.1364/JOSAA.31.002561). With a reflection-symmetric distribution it stays
// reciprocal and its albedo is the forward lobe's, so the paper's energy bound carries over. The lobe is GGX (Walter
// et al., EGSR 2007) with height-correlated Smith masking (Heitz, JCGT 3(2), 2014) and Schlick's Fresnel (1994) at
// F0 = color x base colour. The material is the mix (1 - strength) x base + strength x retro lobe, so it never reflects
// more than the larger of the two. Image light uses the same mirrored view: the environment is read toward the eye.
// ponytail: one strength for the whole material; a strength map (stripes on cloth) is two materials until someone
// needs it per texel.
import { clusterBrdf, ggxD, smithGCorrelated } from '../../shared/light-terms.js';
import type { MaterialFeature } from './built-material.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };

/** Options of `retroreflection()`. Each is also a live property of the feature. */
export interface RetroreflectionOptions {
  /** Share of the surface that retroreflects, 0 (the material as it was) to 1 (the retro lobe alone). Default 0.5. */
  strength?: number;
  /** Perceptual roughness of the retro lobe, 0 to 1, drawn no lower than 0.045: how widely the return spreads. Default 0.2. */
  roughness?: number;
  /**
   * Linear reflectance of the retro lobe toward the light, three numbers from 0 to 1; the material's base colour (and
   * its `map`) multiplies it, so a red sign returns red light. Default [1, 1, 1].
   */
  color?: readonly [number, number, number];
}
/** What `retroreflection()` returns: the feature, and the numbers that stay live. */
export interface RetroreflectionFeature extends MaterialFeature {
  /** Share of the surface that retroreflects, 0 to 1. */
  strength: number;
  /** Perceptual roughness of the retro lobe, 0 to 1. */
  roughness: number;
  /** Linear reflectance of the retro lobe; assign a new array to change it. */
  color: readonly [number, number, number];
}

const share = (v: unknown, label: string): number => {
  if (typeof v !== 'number' || !(v >= 0 && v <= 1))
    throw new RangeError(`retroreflection ${label} must be from 0 to 1; pass a number such as 0.5`);
  return v;
};
const direct = /fn direct_light\(s:Surface,v:vec3f,l:vec3f\)->vec3f \{[^}]*\}/,
  localTerm = `result+=${clusterBrdf}*nl*`;
const wgsl = (group: number) => `struct MargoRetroRows {shape:vec4f, color:vec4f}
@group(${group}) @binding(160) var<uniform> margoRetroRows:MargoRetroRows;
fn margoRetroLobe(n:vec3f,v:vec3f,l:vec3f,base:vec3f)->vec3f {
  let w=reflect(-v,n); let h=(w+l)/max(length(w+l),0.0001);
  let nl=clamp(dot(n,l),0.0,1.0); let nv=clamp(dot(n,v),0.0001,1.0); let nh=clamp(dot(n,h),0.0,1.0); let vh=clamp(dot(w,h),0.0,1.0);
  let r=max(margoRetroRows.shape.y,0.045); let a=r*r; let a2=a*a; let d=${ggxD}; let g=${smithGCorrelated};
  let f0=margoRetroRows.color.rgb*base; let fresnel=f0+(1-f0)*pow(1-vh,5.0);
  return d*g*fresnel/max(4*nl*nv,0.0001);
}
// The surface the image light sees through the mirrored view: a metal of the retro lobe's colour and roughness.
fn margoRetroSurface(under:Surface)->Surface {
  var s=under; s.base=vec4f(margoRetroRows.color.rgb*under.base.rgb,under.base.a); s.metal=1.0;
  s.roughness=max(margoRetroRows.shape.y,0.045); return s;
}
`;
/** The lighting effects' ambient term, mixed with the same term of the retro surface seen through the mirrored view. */
const ambient = (_: string, term: string) => {
  const mirrored = term.replace(/(?<![.\w])s(?!\w)/g, 'margoRetroS').replace(/(?<![.\w])v(?!\w)/g, 'margoRetroV');
  return `let margoRetroS=margoRetroSurface(s);let margoRetroV=reflect(-v,s.n);let margoAmbient=mix(${term},${mirrored},margoRetroRows.shape.x);`;
};

/**
 * Retroreflection for a `PbrMaterial` (or a loaded model's material through `install`): part of the light goes back
 * toward its source, brightest where the light sits at the eye. Assign it through `Material.features`; the material's
 * colour, maps and normal map stay in force. `strength`, `roughness` and `color` are live.
 */
export function retroreflection(options: RetroreflectionOptions = {}): RetroreflectionFeature {
  const data = new Float32Array(8),
    cached = new Map<string, string>(),
    buffers = new Map<GPUDevice, { buffer: GPUBuffer; last: Float32Array }>();
  let users = 0,
    strength = 0.5,
    roughness = 0.2,
    color: readonly [number, number, number] = [1, 1, 1];
  const feature: RetroreflectionFeature = {
    name: 'retroreflection',
    serialization: () => ({ strength, roughness, color: [...color] }),
    get strength() {
      return strength;
    },
    set strength(v: number) {
      strength = share(v, 'strength');
    },
    get roughness() {
      return roughness;
    },
    set roughness(v: number) {
      roughness = share(v, 'roughness');
    },
    get color() {
      return color;
    },
    set color(v: readonly [number, number, number]) {
      if (!Array.isArray(v) || v.length !== 3 || !v.every((c) => typeof c === 'number' && c >= 0 && c <= 1))
        throw new RangeError('retroreflection color must be three numbers from 0 to 1; pass a linear colour');
      color = Object.freeze([v[0], v[1], v[2]] as const);
    },
    shader(source, group) {
      const id = group + source;
      let out = cached.get(id);
      if (out !== undefined) return out;
      const found = direct.exec(source)?.[0];
      if (!found)
        throw new TypeError(
          'retroreflection needs a PbrMaterial without anisotropy or a thin film, and matching gltf/pbr and materials versions',
        );
      out =
        wgsl(group) +
        source.replace(
          found,
          () => `${found.replace('fn direct_light(', 'fn margoRetroUnder(')}
fn direct_light(s:Surface,v:vec3f,l:vec3f)->vec3f {
  let retro=margoRetroLobe(s.n,v,l,s.base.rgb)*clamp(dot(s.n,l),0.0,1.0)*f.radiance.rgb*f.light.w;
  return mix(margoRetroUnder(s,v,l),retro,margoRetroRows.shape.x);
}`,
        );
      if (cached.size >= 16) cached.clear();
      cached.set(id, out);
      return out;
    },
    // Clustered's per-light loop, then the lighting effects' ambient term read once more with the mirrored view.
    lit: (source) =>
      source
        .split(localTerm)
        .join(`result+=mix(${clusterBrdf},margoRetroLobe(n,v,l,base),margoRetroRows.shape.x)*nl*`)
        .replace(/let margoAmbient=([^;]*);/g, ambient),
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
      data.set([strength, roughness, 0, 0, ...color, 0]);
      // Steady frames upload nothing.
      if (data.some((v, k) => v !== held.last[k])) {
        device.queue.writeBuffer(held.buffer, 0, data);
        held.last.set(data);
      }
      return [{ binding: 160, resource: { buffer: held.buffer } }];
    },
    attach() {
      users++;
    },
    detach() {
      if (--users > 0) return;
      for (const { buffer } of buffers.values()) buffer.destroy();
      buffers.clear();
    },
  };
  feature.strength = options.strength ?? 0.5;
  feature.roughness = options.roughness ?? 0.2;
  feature.color = options.color ?? [1, 1, 1];
  return feature;
}
