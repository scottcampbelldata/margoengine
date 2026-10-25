// Toon shading: Lambert's diffuse with n.l replaced by a ramp. The ramp's coordinate is the
// half-Lambert u = n.l * 0.5 + 0.5 (Mitchell, McTaggart and Green 2006, "Shading in Valve's Source Engine"), so the
// whole sphere of normals maps onto [0, 1]: a gradient map's RGB at (u, 0.5), or `steps` flat bands, band k of n
// holding k / (n - 1), which is what a nearest-filtered gradient of n texels ramping 0 to 1 gives. The sun, clustered
// point, spot and directional lights all go through the ramp; the hemisphere, an IBL ambient and baked light stay the
// Lambert surface's (roughness 1, no metal, no highlight). Bindings (group 2): 191 the uniform [gradient on, steps],
// 192 and 193 the gradient map and its sampler.
import { MargoError } from '@margoengine/math/errors';
import { clusterBrdf } from '../../shared/light-terms.js';

/** Module-scope WGSL of the toon ramp in bind group `group`. */
// Ramp lookup on half-Lambert n.l x 0.5 + 0.5: Mitchell, McTaggart and Green 2006 ("Shading in Valve's Source Engine").
export const toonDeclarations = (group: number): string => `@group(${group}) @binding(191) var<uniform> margoToon:vec4f;
@group(${group}) @binding(192) var margoToonMap:texture_2d<f32>;
@group(${group}) @binding(193) var margoToonSampler:sampler;
fn margoToonRamp(nl:f32)->vec3f {
  let u=clamp(nl*0.5+0.5,0.0,1.0);
  if(margoToon.x>0.5){return textureSampleLevel(margoToonMap,margoToonSampler,vec2f(u,0.5),0.0).rgb;}
  let n=max(margoToon.y,2.0); return vec3f(min(floor(u*n),n-1.0)/(n-1.0));
}
`;
/**
 * Edits of gltf-pro's lit PBR shader for toon shading: the hemisphere and direct terms (Lambert's hemisphere, the ramped
 * direct light), the layered-hook surface (margoFront: roughness 1, no metal) and, so the G-buffer and ambient entries
 * keep the beauty bind group layout, the ramp's bindings named in `surface`. The hemisphere colours are a Margo design
 * choice.
 */
export const toonEdits: readonly [RegExp | string, string][] = [
  [
    /fn hemisphere_ambient\(s:Surface\)->vec3f \{[^}]*\}/,
    'fn hemisphere_ambient(s:Surface)->vec3f {return s.base.rgb*mix(vec3f(0.35,0.3,0.25),vec3f(1),clamp(s.n.y*0.5+0.5,0.0,1.0))*f.radiance.w*s.occlusion;}',
  ],
  [
    /fn direct_light\(s:Surface,v:vec3f,l:vec3f\)->vec3f \{[^}]*\}/,
    'fn direct_light(s:Surface,v:vec3f,l:vec3f)->vec3f {\n  return s.base.rgb/3.14159265*margoToonRamp(dot(s.n,l))*f.radiance.rgb*f.light.w;\n}',
  ],
  [
    '@fragment fn fragment(',
    `fn margoFront(s:Surface)->Surface {var o=s; o.metal=0; o.roughness=1.0; return o;}
fn margoAmbientTerm(i:Out,s:Surface,v:vec3f)->vec3f {return vec3f(0);}
fn margoAmbientLayers(i:Out,s:Surface,v:vec3f)->vec3f {var o=margoFront(s); let d=margoAmbientTerm(i,o,v); o.base=vec4f(vec3f(0),o.base.a); return d-margoAmbientTerm(i,o,v);}
@fragment fn fragment(`,
  ],
  [
    'fn surface(i:Out,front:bool)->Surface {',
    'fn surface(i:Out,front:bool)->Surface {\n  _=&margoToon;_=margoToonMap;_=margoToonSampler;',
  ],
];
const surfaces = new Map<string, string>(),
  lit = new Map<string, string>();
/**
 * gltf-pro's PBR shader `code` (a loaded model's material) shaded as toon, its ramp bound in `group`. Code with
 * layered physical terms (transmission, extended materials) is refused: `toonModel` strips those layers first.
 */
export function toonShader(code: string, group: number): string {
  const key = group + ':' + code;
  let out: string | undefined = surfaces.get(key);
  if (out !== undefined) return out;
  out = code;
  const refuse = () =>
    new MargoError(
      'unsupported',
      'Toon shading requires the standard gltf-pro PBR shader; use matching @margoengine/gltf-pro and materials versions',
    );
  if (code.includes('fn margoAmbientLayers(')) throw refuse();
  for (const [from, to] of toonEdits) {
    const next: string = out.replace(from, () => to);
    if (next === out) throw refuse();
    out = next;
  }
  out = toonDeclarations(group) + out;
  if (surfaces.size >= 64) surfaces.clear();
  surfaces.set(key, out);
  return out;
}
/** The composed shader `code` with clustered lights' per-light BRDF and n.l replaced by the toon ramp. */
export function toonLit(code: string): string {
  let out = lit.get(code);
  if (out === undefined) {
    if (lit.size >= 64) lit.clear();
    out = code.split('result+=' + clusterBrdf + '*nl*').join('result+=base/3.14159265*margoToonRamp(dot(n,l))*');
    lit.set(code, out);
  }
  return out;
}
