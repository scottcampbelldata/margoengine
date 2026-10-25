// Per-material environment maps (`Material.envMap`). Standard shading takes the cube as its image-based light:
// specular radiance along the reflected (or refracted) view ray from the mip level of its roughness, weighted by the
// split-sum environment BRDF in Karis's analytic fit ("Physically Based Shading on Mobile", 2014, after Lazarov 2013),
// and diffuse irradiance from the cube's coarse mips or, for an @margoengine/environment Environment, its L2 spherical
// harmonics (Ramamoorthi and Hanrahan 2001). It replaces the material's ambient term (the built-in hemisphere and any
// scene IBL): a material's own map takes precedence over the scene's environment. Basic, Lambert and Phong shading
// combine the sharp reflection with their lit colour instead (`combine`: multiply, mix or add, by `reflectivity`).
// Bindings (group 2): 188 the cube, 189 its sampler, 190 the MargoEnv uniform below.
import { MargoError } from '@margoengine/math/errors';

/**
 * An `@margoengine/environment` Environment, read structurally (materials does not import environment): its
 * prefiltered specular cube, spherical-harmonic irradiance, rotation about +Y and intensity.
 */
export interface EnvironmentMap {
  readonly specularView: GPUTextureView;
  readonly specularMips: number;
  readonly sampler: GPUSampler;
  readonly sh: { readonly irradiance: ArrayLike<number> };
  readonly rotation: number;
  readonly intensity: number;
}
/** How a Lambert, Phong or basic material mixes its colour with the reflection (`Material.combine`). */
export type EnvCombine = 'multiply' | 'mix' | 'add';
/** The MargoEnv uniform: 12 vec4f (192 bytes). */
export const envFloats = 48;
/**
 * Writes the MargoEnv uniform into `out`: [cos, sin of the Y rotation, highest mip, intensity], [1 when `sh` holds
 * irradiance, the mip read for irradiance otherwise, the refraction ratio (0 reflects), reflectivity], [combine 0
 * multiply / 1 mix / 2 add], then nine RGB irradiance / pi coefficients.
 */
export function packEnv(
  out: Float32Array,
  rotation: number,
  levels: number,
  intensity: number,
  sh: ArrayLike<number> | undefined,
  refraction: number,
  reflectivity: number,
  combine: EnvCombine,
): Float32Array {
  out.fill(0);
  out.set([Math.cos(rotation), Math.sin(rotation), Math.max(0, levels - 1), intensity], 0);
  // Without harmonics, irradiance reads a level about four texels across (a cosine-wide average), or the last one.
  out.set([sh ? 1 : 0, Math.max(0, levels - 3), refraction, reflectivity], 4);
  out[8] = combine === 'multiply' ? 0 : combine === 'mix' ? 1 : 2;
  if (sh) for (let k = 0; k < 9; k++) out.set([sh[k * 3], sh[k * 3 + 1], sh[k * 3 + 2]], 12 + k * 4);
  return out;
}
// Roughness to mip: lod = roughness x top mip (linear; Margo's choice). Ambient = radiance x (F0 A + B) + diffuse
// irradiance: Karis 2013 split sum ("Real Shading in Unreal Engine 4"); SH basis: Ramamoorthi and Hanrahan 2001.
const declarations = (
  group: number,
  f0: string,
  kd: string,
) => `struct MargoEnv {params:vec4f, mode:vec4f, extra:vec4f, sh:array<vec4f,9>}
@group(${group}) @binding(188) var margoEnvMap:texture_cube<f32>;
@group(${group}) @binding(189) var margoEnvSampler:sampler;
@group(${group}) @binding(190) var<uniform> margoEnv:MargoEnv;
var<private> margoEnvEye:vec3f;
fn margoEnvRotate(d:vec3f)->vec3f {let p=margoEnv.params; return vec3f(p.x*d.x-p.y*d.z,d.y,p.y*d.x+p.x*d.z);}
fn margoEnvRadiance(d:vec3f,lod:f32)->vec3f {return textureSampleLevel(margoEnvMap,margoEnvSampler,margoEnvRotate(d),lod).rgb*margoEnv.params.w;}
fn margoEnvIrradiance(n:vec3f)->vec3f {
  if(margoEnv.mode.x<0.5){return margoEnvRadiance(n,margoEnv.mode.y);}
  let d=margoEnvRotate(n); let h=margoEnv.sh;
  return max(h[0].rgb*0.282094792+h[1].rgb*(0.488602512*d.y)+h[2].rgb*(0.488602512*d.z)+h[3].rgb*(0.488602512*d.x)
    +h[4].rgb*(1.092548431*d.x*d.y)+h[5].rgb*(1.092548431*d.y*d.z)+h[6].rgb*(0.315391565*(3.0*d.z*d.z-1.0))
    +h[7].rgb*(1.092548431*d.x*d.z)+h[8].rgb*(0.546274215*(d.x*d.x-d.y*d.y)),vec3f(0))*margoEnv.params.w;
}
fn margoEnvRay(n:vec3f,v:vec3f)->vec3f {
  let r=reflect(-v,n); if(margoEnv.mode.z<=0.0){return r;}
  let t=refract(-v,n,margoEnv.mode.z); return select(r,t,dot(t,t)>0.0);
}
fn margoEnvBrdf(nv:f32,roughness:f32)->vec2f {
  let q=roughness*vec4f(-1,-0.0275,-0.572,0.022)+vec4f(1,0.0425,1.04,-0.04); let a=min(q.x*q.x,exp2(-9.28*nv))*q.x+q.y;
  return vec2f(-1.04,1.04)*a+q.zw;
}
fn margoEnvAmbient(s:Surface,v:vec3f)->vec3f {
  let nv=clamp(dot(s.n,v),0.0001,1.0); let f0=mix(${f0},s.base.rgb,s.metal); let ab=margoEnvBrdf(nv,s.roughness);
  let spec=f0*ab.x+ab.y; let radiance=margoEnvRadiance(margoEnvRay(s.n,v),s.roughness*margoEnv.params.z);
  return (radiance*spec+(1-spec)*(1-s.metal)*${kd}*s.base.rgb*margoEnvIrradiance(s.n))*s.occlusion;
}
fn margoEnvCombine(c:vec3f,n:vec3f,v:vec3f)->vec3f {
  let e=margoEnvRadiance(margoEnvRay(n,v),0.0); let k=margoEnv.mode.w;
  if(margoEnv.extra.x<0.5){return mix(c,c*e,k);} if(margoEnv.extra.x<1.5){return mix(c,e,k);} return c+e*k;
}
`;
function edit(code: string, from: string | RegExp, to: string): string {
  const next = code.replace(from, () => to);
  if (next === code)
    throw new MargoError(
      'unsupported',
      'Material envMap requires the standard gltf-pro PBR shader; use matching @margoengine/gltf-pro and materials versions',
    );
  return next;
}
const surfaces = new Map<string, string>(),
  lit = new Map<string, string>();
/**
 * `code` (a material's shader before lighting effects) reading the environment map: standard shading's ambient (and a
 * physical material's clearcoat and sheen ambient), or basic shading's output colour. Lambert and Phong combine in
 * `envMapLit`, once lights are composed.
 */
export function envMapShader(code: string, group: number, shading: 'standard' | 'basic' | 'lit'): string {
  const key = shading + group + ':' + code;
  let out = surfaces.get(key);
  if (out !== undefined) return out;
  out = edit(
    code,
    'fn surface(i:Out,front:bool)->Surface {',
    'fn surface(i:Out,front:bool)->Surface {\n  margoEnvEye=normalize(f.eye.xyz-i.position);_=margoEnvMap;_=margoEnvSampler;_=&margoEnv;',
  );
  if (shading === 'standard') {
    out = edit(
      out,
      /fn ambient\(s:Surface\)->vec3f \{[^}]*\}/,
      'fn ambient(s:Surface)->vec3f {return margoEnvAmbient(s,margoEnvEye);}',
    );
    if (out.includes('fn margoCoatAmbient('))
      out = edit(
        out,
        /fn margoCoatAmbient\(s:Surface,v:vec3f\)->vec3f \{return [^;]*;\}/,
        'fn margoCoatAmbient(s:Surface,v:vec3f)->vec3f {return margoEnvRadiance(reflect(-v,s.cn),s.cr*margoEnv.params.z)*s.occlusion;}',
      );
    if (out.includes('fn margoSheenAmbient('))
      out = edit(
        out,
        /fn margoSheenAmbient\(s:Surface,v:vec3f\)->vec3f \{return [^;]*;\}/,
        // Sheen albedo (declared by the physical shader) times the map's irradiance at the base normal.
        'fn margoSheenAmbient(s:Surface,v:vec3f)->vec3f {return margoSheenAlbedo(clamp(dot(s.n,v),0.0001,1.0),s.sh.w)*margoEnvIrradiance(s.n)*s.occlusion;}',
      );
  } else if (shading === 'basic')
    out = edit(
      out,
      'return vec4f(mat_out(s.base.rgb+s.emissive),alpha);',
      'return vec4f(mat_out(margoEnvCombine(s.base.rgb+s.emissive,s.n,margoEnvEye)),alpha);',
    );
  // Physical surfaces carry their IOR/specular F0 and the transmitted share.
  out =
    declarations(
      group,
      code.includes(' f0:vec3f') ? 's.f0' : 'vec3f(0.04)',
      code.includes(' tr:f32') ? '(1-s.tr)' : '1.0',
    ) + out;
  if (surfaces.size >= 64) surfaces.clear();
  surfaces.set(key, out);
  return out;
}
/**
 * The composed shader `code` with the environment in place: standard shading's ambient overrides a scene IBL's (whose
 * bindings stay referenced); Lambert and Phong combine the reflection with their lit colour.
 */
export function envMapLit(code: string, shading: 'standard' | 'basic' | 'lit'): string {
  if (shading === 'basic') return code;
  const key = shading + ':' + code;
  let out = lit.get(key);
  if (out !== undefined) return out;
  if (shading === 'standard')
    out = code.replace(
      /let margoAmbient=([^;]*);/,
      (_, scene) => `let margoSceneAmbient=${scene};let margoAmbient=margoEnvAmbient(s,v);`,
    );
  else {
    const color = /var color=[^;]*;/.exec(code)?.[0];
    out = edit(code, /var color=[^;]*;/, color + '\n  color=margoEnvCombine(color,s.n,v);');
  }
  if (lit.size >= 64) lit.clear();
  lit.set(key, out);
  return out;
}
