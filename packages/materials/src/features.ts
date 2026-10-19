// Optional material features (alphaMap, ...), applied after a material's own shader patch (so NodeMaterial's too). Each
// is compiled in only while the material uses it, one letter of `key` each: a material using none keeps its shader
// text, bindings and uniforms exactly. Bindings (group 2): 198 the uniform below, 180-187 one texture and sampler per
// map, in uniform-row order.
import { MargoError } from '@margoengine/math/errors';
/** Uniform rows: [bumpScale, displacementScale, displacementBias, lightMapIntensity], then two UV rows per map. */
export const featureStruct = 'struct MargoFeatures {values:vec4f,uvt:array<vec4f,8>}';
/** Feature maps in UV-row (and binding) order, with their WGSL names. */
export const featureMaps = ['alphaMap', 'bumpMap', 'displacementMap', 'lightMap'] as const;
const names = ['Alpha', 'Bump', 'Displacement', 'Light'];
const sample = (k: number) => `textureSample(margo${names[k]}Map,margo${names[k]}Sampler,margoFeatureUV(i.uv,${k}u))`;
const cache = new Map<string, Map<string, string>>();
function edit(code: string, from: string | RegExp, to: string | ((match: string, ...groups: string[]) => string)) {
  const next = code.replace(from, to as string);
  if (next === code)
    throw new MargoError(
      'unsupported',
      'Material features require the standard gltf-pro PBR shader; use matching @margoengine/gltf-pro and materials versions',
    );
  return next;
}
/** `code` with the features `key` names: `a` alphaMap. */
export function featureShader(code: string, group: number, key: string): string {
  let inner = cache.get(code);
  const id = key + group,
    hit = inner?.get(id);
  if (hit !== undefined) return hit;
  const maps = featureMaps.map((_, k) => key.includes('abdl'[k]));
  let out = code;
  if (maps[0]) out = edit(out, '\n  let mr=', `\n  s.base.a*=${sample(0)}.g;\n  let mr=`);
  const declarations = maps.some(Boolean)
    ? `${featureStruct}
@group(${group}) @binding(198) var<uniform> margoFeatures:MargoFeatures;
${maps.map((used, k) => (used ? `@group(${group}) @binding(${180 + k * 2}) var margo${names[k]}Map:texture_2d<f32>;\n@group(${group}) @binding(${181 + k * 2}) var margo${names[k]}Sampler:sampler;\n` : '')).join('')}fn margoFeatureUV(uv:vec4f,k:u32)->vec2f {let a=margoFeatures.uvt[k*2]; let p=vec3f(select(uv.xy,uv.zw,a.w>0.5),1); return vec2f(dot(a.xyz,p),dot(margoFeatures.uvt[k*2+1].xyz,p));}
`
    : '';
  out = declarations + out;
  if (!inner) {
    if (cache.size >= 64) cache.clear();
    cache.set(code, (inner = new Map()));
  }
  inner.set(id, out);
  return out;
}
