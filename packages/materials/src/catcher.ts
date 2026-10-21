// ShadowCatcherMaterial's shader: a Lambert surface (lit for nothing but its shadows) whose colour is its own `color`
// and whose alpha is opacity x (1 - light received / light it would receive unshadowed), in luminance, over the sun
// (Shadows) and clustered point, spot, directional and area lights (integrated maps, LocalShadows). Ambient and
// environment light do not count: they cast no shadow here.
import { MargoError } from '@margoengine/math/errors';
// The pre-lighting shader marks itself with this placeholder, which catcherLit replaces (so clones are catchers too).
const placeholder = 'fn margoCatcher(i:Out,s:Surface)->f32 {return 0.0;}',
  surfaceCode = new Map<string, string>(),
  composedCode = new Map<string, string>();
function edit(code: string, from: string, to: string): string {
  if (code.split(from).length !== 2)
    throw new MargoError(
      'unsupported',
      'ShadowCatcherMaterial requires the standard gltf-pro PBR shader; use matching @margoengine/gltf-pro and materials versions',
    );
  return code.replace(from, () => to);
}
/** The Lambert shader `code` (materialShader) drawing only the shadow: colour `f.base.rgb`, alpha from margoCatcher. */
export function catcherShader(code: string): string {
  let out = surfaceCode.get(code);
  if (out !== undefined) return out;
  out = edit(
    code,
    '  var color=direct+ambient(s)+s.emissive;\n',
    '  var color=direct+ambient(s)+s.emissive;\n  let margoShadow=margoCatcher(i,s); color=f.base.rgb;\n',
  );
  out = edit(out, 'return vec4f(color,select(1.0,s.base.a,f.settings.x>1.5));', 'return vec4f(color,margoShadow);');
  out += `\n${placeholder}\n`;
  if (surfaceCode.size >= 64) surfaceCode.clear();
  surfaceCode.set(code, out);
  return out;
}
/**
 * The composed shader `code` (lighting effects in) with margoCatcher measuring what shadows it holds: the sun through
 * `shadowVisibility` and clustered lights through `clusterLighting` against a copy of it without its shadow terms
 * (point, spot and directional factors removed; area lights through an unshadowed copy of `clusterAreaLighting`).
 * Code that is not a catcher's comes back unchanged.
 */
export function catcherLit(code: string): string {
  let out = composedCode.get(code);
  if (out !== undefined) return out;
  if (composedCode.size >= 64) composedCode.clear();
  if (!code.includes(placeholder)) {
    composedCode.set(code, code);
    return code;
  }
  // Area lights shadow inside clusterAreaLighting (LocalShadows' clusterAreaShadow factor): the unshadowed copy of the
  // light loop calls an unshadowed copy of it. Directional lights' factor sits in the loop itself, as point lights' do.
  const area = /fn clusterAreaLighting\([\s\S]*?\n\}/.exec(code)?.[0],
    areaShadowed = !!area?.includes('*clusterAreaShadow(j,position,n,c,r,u)'),
    openArea = areaShadowed
      ? area!
          .replace(/\*clusterAreaShadow\(j,position,n,c,r,u\)/g, '')
          .replace('fn clusterAreaLighting(', 'fn margoCatcherArea(')
      : '';
  const sun = code.includes('fn shadowVisibility(') ? '*shadowVisibility(i.position,n)' : '',
    loop = /fn clusterLighting\([\s\S]*?\n\}/.exec(code)?.[0]?.replace('fn clusterLighting(', 'fn margoCatcherLights('),
    stripped = loop?.replace(
      /\*clusterShadow(?:Visibility)?\(light,position,n\)|\*clusterDirectionalShadow\(j,position,n,l\)/g,
      '',
    ),
    unshadowed = areaShadowed ? stripped?.replace('clusterAreaLighting(', 'margoCatcherArea(') : stripped,
    shadowed = unshadowed !== loop,
    args = '(i.clip.xy,i.position,n,f.eye.xyz,vec3f(1),1.0,0.0),w)',
    // Unshadowed local lights count too: they make a shadow of the others lighter.
    local = !loop
      ? ''
      : shadowed
        ? `\n  lit+=dot(clusterLighting${args}; all+=dot(margoCatcherLights${args};`
        : `\n  let margoLocal=dot(clusterLighting${args}; lit+=margoLocal; all+=margoLocal;`;
  out = edit(
    code,
    placeholder,
    `fn margoCatcher(i:Out,s:Surface)->f32 {
  let w=vec3f(0.2126,0.7152,0.0722); let n=s.n; let sun=clamp(dot(n,normalize(f.light.xyz)),0.0,1.0)*dot(f.radiance.rgb,w)*f.light.w;
  var lit=sun${sun}; var all=sun;${local}
  return f.base.a*select(0.0,clamp(1.0-lit/all,0.0,1.0),all>0.000001);
}${shadowed ? `\n${unshadowed}` : ''}${areaShadowed ? `\n${openArea}` : ''}`,
  );
  composedCode.set(code, out);
  return out;
}
