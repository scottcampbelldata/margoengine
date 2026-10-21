// Optional material features (alphaMap, ...), applied after a material's own shader patch (so NodeMaterial's too). Each
// is compiled in only while the material uses it, one letter of `key` each: a material using none keeps its shader
// text, bindings and uniforms exactly. Bindings (group 2): 198 the uniform below, 180-187 one texture and sampler per
// map, in uniform-row order.
import { MargoError } from '@margoengine/math/errors';
// The uniform (MargoFeatures: [bumpScale, displacementScale, displacementBias, lightMapIntensity], then two UV rows per
// map) and the displacement are shared with the shadow casters' depth shaders.
import { featureStruct, displacementWgsl } from '../../shared/displacement.js';
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
// Bump mapping from screen-space derivatives (Mikkelsen 2010, "Bump Mapping Unparametrized Surfaces on the GPU"): the
// height's screen gradient through the surface's, R1 = dP/dy x N, R2 = N x dP/dx, N' = |det| N - sign(det) (dH/dx R1 +
// dH/dy R2). det takes the face's sign so a back face sees the bump mirrored, as the surface's other side.
const bump = `fn margoBump(n:vec3f,p:vec3f,height:f32,facing:bool)->vec3f {
  let sx=dpdx(p); let sy=dpdy(p); let r1=cross(sy,n); let r2=cross(n,sx);
  let det=dot(sx,r1)*select(-1.0,1.0,facing); let o=abs(det)*n-sign(det)*(dpdx(height)*r1+dpdy(height)*r2);
  return select(n,normalize(o),dot(o,o)>0.0);
}
`;
/**
 * `code` with the features `key` names: `a` alphaMap, `b` bumpMap, `d` displacementMap, `f` flatShading, `v`
 * vertexColors false, `g` fog false, `t` toneMapped false, `l` lightMap on a lit shading (baked irradiance: diffuse colour times the map, added like
 * emissive) or `u` on an unlit one (the map multiplies the colour), `n` a tangent-space map, anisotropy or an extension
 * lobe sampling one (the derived normal-map frame follows this package's UV orientation).
 */
export function featureShader(code: string, group: number, key: string): string {
  let inner = cache.get(code);
  const id = key + group,
    hit = inner?.get(id);
  if (hit !== undefined) return hit;
  const has = (letter: string) => key.includes(letter),
    maps = [has('a'), has('b'), has('d'), has('l') || has('u')];
  let out = code;
  if (maps[0]) out = edit(out, '\n  let mr=', `\n  s.base.a*=${sample(0)}.g;\n  let mr=`);
  // Fog: the output hook (shared/pbr-hooks.js) wraps the tone-mapped colour at this anchor; the colour it fogs is then
  // replaced by the same value unfogged, which keeps the fog's bindings in the layout and its mix dead.
  if (has('g'))
    out = edit(
      out,
      '  if(f.settings.w<0.5) {color=pbrNeutral(max(color,vec3f(0))); color=',
      '  let margoUnfogged=select(color,pbrNeutral(max(color,vec3f(0))),f.settings.w<0.5);\n  if(f.settings.w<0.5) {color=pbrNeutral(max(color,vec3f(0)));}color=margoUnfogged;\n  if(f.settings.w<0.5) { color=',
    );
  // No tone map: every pbrNeutral call (the display line, fog's wrap of it) becomes the clamp unlit output applies.
  if (has('t'))
    out = edit(
      out,
      'fn pbrNeutral(input:vec3f)->vec3f {',
      'fn pbrNeutral(input:vec3f)->vec3f {return min(input,vec3f(1));}\nfn margoNeutral(input:vec3f)->vec3f {',
    );
  // Vertex colours: the vertex stage passes white (instancing still multiplies its tints in).
  if (has('v')) out = edit(out, 'o.uv=i.uv; o.color=i.color;', 'o.uv=i.uv; o.color=vec4f(1);');
  // The face normal from the world position's screen derivatives; framebuffer y points down, so dP/dy x dP/dx faces
  // the camera on both sides, the side the back-face flip would have chosen.
  if (has('f'))
    out = edit(
      out,
      'let n=normalize(i.normal)*select(-1.0,1.0,facing);',
      'let n=normalize(cross(dpdy(i.position),dpdx(i.position)));',
    );
  // A normal map's +Y is up the image (glTF 2.0 material.schema.json normalTexture: "+X is right and +Y is up").
  // gltf-pro's derived frame (shared/tangent-frame.js) sends B toward decreasing v, up the image for glTF's upper-left
  // texture origin. Materials meshes have a bottom-left UV origin and flipY uploads, so up the image is increasing v,
  // where MikkTSpace tangents of these UVs put B too (mikktspace.c: vOt along increasing t; bitangent = fSign *
  // cross(vN, tangent)). Authored tangents keep b = cross(n, t) * w: this only changes the frame drawn without them.
  // One definition serves every caller: the base surface and extension lobes (clearcoat(), lobes, node normalMap).
  if (has('n')) out = edit(out, 'mat3x3f(t*scale,-b*scale,n)', 'mat3x3f(t*scale,b*scale,n)');
  // After the normal map: the bump tilts the mapped normal.
  if (maps[1])
    out = edit(
      out,
      /\n {2}s\.n=normalize\([^\n]*\);/,
      (line) => `${line}\n  s.n=margoBump(s.n,i.position,${sample(1)}.r*margoFeatures.values.x,facing);`,
    );
  const light = `${sample(3)}.rgb*margoFeatures.values.w`;
  if (has('u')) out = edit(out, '\n  let mr=', `\n  s.base=vec4f(s.base.rgb*${light},s.base.a);\n  let mr=`);
  // Indirect diffuse: occlusion applies, metals reflect none.
  if (has('l'))
    out = edit(out, '\n  let facing=', `\n  s.emissive+=s.base.rgb*(1-s.metal)*s.occlusion*${light};\n  let facing=`);
  // In mesh space, before the model (or instance) matrix, so every pass drawing this shader displaces alike.
  if (maps[2])
    out = edit(
      out,
      /let p=f\.model\*vec4f\(([^;]*),1\);/,
      (_, position) => `let p=f.model*vec4f(${position}+i.normal.xyz*margoDisplacement(i.uv),1);`,
    );
  const declarations = maps.some(Boolean)
    ? `${featureStruct}
@group(${group}) @binding(198) var<uniform> margoFeatures:MargoFeatures;
${maps.map((used, k) => (used ? `@group(${group}) @binding(${180 + k * 2}) var margo${names[k]}Map:texture_2d<f32>;\n@group(${group}) @binding(${181 + k * 2}) var margo${names[k]}Sampler:sampler;\n` : '')).join('')}fn margoFeatureUV(uv:vec4f,k:u32)->vec2f {let a=margoFeatures.uvt[k*2]; let p=vec3f(select(uv.xy,uv.zw,a.w>0.5),1); return vec2f(dot(a.xyz,p),dot(margoFeatures.uvt[k*2+1].xyz,p));}
${maps[1] ? bump : ''}${maps[2] ? displacementWgsl : ''}`
    : '';
  out = declarations + out;
  if (!inner) {
    if (cache.size >= 64) cache.clear();
    cache.set(code, (inner = new Map()));
  }
  inner.set(id, out);
  return out;
}
