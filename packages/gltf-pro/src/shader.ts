import {acesShader} from '../../shared/aces.js';
// margoFaceTest/margoAlphaTest are pipeline constants (HANDOFF 1e.f): gltf-pro turns them off where they can never discard
// (back faces are culled; only MASK materials alpha-test), because any discard in the shader costs early depth testing
// (0.85 -> 0.52 ms GPU, full-screen DamagedHelmet, Arc 140V).
export const pbrShader = /* wgsl */`
${acesShader}
struct Frame {
  camera:mat4x4f, model:mat4x4f, normalMatrix:mat4x4f, view:mat4x4f,
  eye:vec4f, light:vec4f, radiance:vec4f, base:vec4f, factors:vec4f, emissive:vec4f,
  settings:vec4f, coordsA:vec4f, coordsB:vec4f, ext:vec4f, uvt:array<vec4f,26>, coat:vec4f, specular:vec4f, sheen:vec4f
}
@group(0) @binding(0) var<uniform> f:Frame;
override margoFaceTest:bool=true;
override margoAlphaTest:bool=true;
@group(1) @binding(0) var baseMap:texture_2d<f32>;
@group(1) @binding(1) var baseSampler:sampler;
@group(1) @binding(2) var mrMap:texture_2d<f32>;
@group(1) @binding(3) var mrSampler:sampler;
@group(1) @binding(4) var normalMap:texture_2d<f32>;
@group(1) @binding(5) var normalSampler:sampler;
@group(1) @binding(6) var aoMap:texture_2d<f32>;
@group(1) @binding(7) var aoSampler:sampler;
@group(1) @binding(8) var emissiveMap:texture_2d<f32>;
@group(1) @binding(9) var emissiveSampler:sampler;
struct Input {
  @location(0) position:vec4f, @location(1) normal:vec4f,
  @location(2) tangent:vec4f, @location(3) uv:vec4f, @location(4) color:vec4f
}
struct Out {
  @builtin(position) clip:vec4f, @location(0) position:vec3f, @location(1) normal:vec3f,
  @location(2) tangent:vec4f, @location(3) uv:vec4f, @location(4) color:vec4f
}
@vertex fn vertex(i:Input)->Out {
  var o:Out; let p=f.model*vec4f(i.position.xyz,1);
  o.clip=f.camera*p; o.position=p.xyz;
  o.normal=(f.normalMatrix*vec4f(i.normal.xyz,0)).xyz;
  o.tangent=vec4f((f.model*vec4f(i.tangent.xyz,0)).xyz,i.tangent.w*f.coordsB.y);
  o.uv=i.uv; o.color=i.color; return o;
}
fn uv(i:Out, k:f32)->vec2f {let m=f.uvt[u32(k)*2]; let p=vec3f(select(i.uv.xy,i.uv.zw,m.w>0.5),1); return vec2f(dot(m.xyz,p),dot(f.uvt[u32(k)*2+1].xyz,p));}
struct Surface {base:vec4f, n:vec3f, roughness:f32, metal:f32, occlusion:f32, emissive:vec3f}
fn surface(i:Out,front:bool)->Surface {
  var s:Surface;
  s.base=textureSample(baseMap,baseSampler,uv(i,f.coordsA.x))*f.base*i.color;
  let mr=textureSample(mrMap,mrSampler,uv(i,f.coordsA.y));
  let sampledNormal=textureSample(normalMap,normalSampler,uv(i,f.coordsA.z)).xyz*2-1;
  s.occlusion=mix(1.0,textureSample(aoMap,aoSampler,uv(i,f.coordsA.w)).r,f.factors.w);
  s.emissive=textureSample(emissiveMap,emissiveSampler,uv(i,f.coordsB.x)).rgb*f.emissive.xyz;
  s.roughness=clamp(mr.g*f.factors.x,0.045,1.0); s.metal=clamp(mr.b*f.factors.y,0.0,1.0);
  let facing=front==(f.coordsB.y>0); let n=normalize(i.normal)*select(-1.0,1.0,facing);
  var t=i.tangent.xyz-n*dot(n,i.tangent.xyz);
  var b=cross(n,t)*i.tangent.w;
  let dp1=dpdx(i.position); let dp2=dpdy(i.position); let duv1=dpdx(uv(i,f.coordsA.z)); let duv2=dpdy(uv(i,f.coordsA.z));
  if(abs(i.tangent.w)<0.5) {
    let p1=cross(n,dp1); let p2=cross(dp2,n);
    t=p2*duv1.x+p1*duv2.x; b=p2*duv1.y+p1*duv2.y;
    let scale=inverseSqrt(max(max(dot(t,t),dot(b,b)),0.000001)); t*=scale; b*=scale;
  } else {t=normalize(t); b=normalize(cross(n,t))*i.tangent.w;}
  s.n=normalize(t*sampledNormal.x*f.factors.z+b*sampledNormal.y*f.factors.z+n*sampledNormal.z);
  if(margoFaceTest&&!facing&&f.settings.z<0.5){discard;}
  if(margoAlphaTest&&f.settings.x>0.5&&f.settings.x<1.5&&s.base.a<f.settings.y){discard;}
  return s;
}
fn ambient(s:Surface)->vec3f {
  let f0=mix(vec3f(0.04),s.base.rgb,s.metal);
  let hemisphere=mix(vec3f(0.35,0.3,0.25),vec3f(1),clamp(s.n.y*0.5+0.5,0.0,1.0));
  return (s.base.rgb*(1-s.metal)+f0*0.5)*hemisphere*f.radiance.w*s.occlusion;
}
@fragment fn fragment(i:Out,@builtin(front_facing) front:bool)->@location(0) vec4f {
  let s=surface(i,front); let v=normalize(f.eye.xyz-i.position); let l=normalize(f.light.xyz); let h=(v+l)/max(length(v+l),0.0001);
  let nl=clamp(dot(s.n,l),0.0,1.0); let nv=clamp(dot(s.n,v),0.0001,1.0); let nh=clamp(dot(s.n,h),0.0,1.0); let vh=clamp(dot(v,h),0.0,1.0);
  let a=s.roughness*s.roughness; let a2=a*a; let d=a2/(3.14159265*pow(nh*nh*(a2-1)+1,2.0));
  let g=2*nv/(nv+sqrt(a2+(1-a2)*nv*nv))*2*nl/max(nl+sqrt(a2+(1-a2)*nl*nl),0.0001);
  let f0=mix(vec3f(0.04),s.base.rgb,s.metal); let fresnel=f0+(1-f0)*pow(1-vh,5.0);
  let direct=((1-fresnel)*(1-s.metal)*s.base.rgb/3.14159265+d*g*fresnel/max(4*nl*nv,0.0001))*nl*f.radiance.rgb*f.light.w;
  var color=direct+ambient(s)+s.emissive;
  if(f.ext.x>0.5){color=s.base.rgb;}
  if(f.settings.w<0.5) {color=aces(max(color,vec3f(0))/0.6); color=select(color*12.92,1.055*pow(color,vec3f(1.0/2.4))-0.055,color>=vec3f(0.0031308));}
  return vec4f(color,select(1.0,s.base.a,f.settings.x>1.5));
}
@fragment fn gbuffer(i:Out,@builtin(front_facing) front:bool)->@location(0) vec4f {
  let s=surface(i,front); return vec4f(normalize((f.view*vec4f(s.n,0)).xyz),-(f.view*vec4f(i.position,1)).z);
}
@fragment fn ambientFragment(i:Out,@builtin(front_facing) front:bool)->@location(0) vec4f {
  let s=surface(i,front); return vec4f(ambient(s),select(1.0,s.base.a,f.settings.x>1.5));
}
`;
/**
 * Lighting hooks of the PBR fragment (contract version 1, README "Lighting hooks"). A `LightingEffect.pbr(group)` returns one;
 * gltf-pro composes it into the standard and physical shaders, so effects never search gltf-pro's WGSL. In scope: `i` (Out),
 * `s` (Surface: base, n, roughness, metal, occlusion, emissive), `v` (to the eye), `f` (Frame: eye, light, radiance...).
 */
export interface PBRLighting {
  /** Module-scope WGSL put before the shader: the effect's bindings in the group passed to `pbr(group)`, helper functions. */
  readonly declarations:string;
  /** Wraps the directional light term (shadows), e.g. `direct => \`shadowLit(${direct},i.position,s.n)\``. */
  direct?(direct:string):string;
  /** vec3f light added before the directional term (local lights). */
  readonly light?:string;
  /** vec3f replacing the hemisphere ambient (image-based lighting). SSAO's ambient replay returns it. At most one effect. */
  readonly ambient?:string;
  /** Wraps the display colour after tone mapping, before sRGB encoding (fog). */
  output?(color:string):string;
}
const lit=new WeakMap<PBRLighting,Map<string,string>>();
/** `code` (the PBR shader, possibly already lit) with one effect's hooks composed in at gltf-pro's hook points. */
export function lightPBR(code:string,hooks:PBRLighting):string {
  let cache=lit.get(hooks),out=cache?.get(code);if(out!==undefined)return out;out=code;
  const edit=(from:string|RegExp,to:string|((match:string,terms:string)=>string))=>{const next=out!.replace(from,to as string);if(next===out)throw new Error('PBR lighting hook point missing or used twice: '+from);out=next;};
  if(hooks.direct)edit('direct+ambient(s)',hooks.direct('direct')+'+ambient(s)');
  if(hooks.light)edit('var color=','var color='+hooks.light+'+');
  if(hooks.ambient){edit(/fn ambient\(s:Surface\)->vec3f \{[^}]*\}/,'fn ambient(s:Surface)->vec3f {return vec3f(0);}');edit(/var color=([^;]+)\+s\.emissive;/,(_,terms)=>`let margoAmbient=${hooks.ambient};var color=${terms}+s.emissive+margoAmbient;`);}
  if(hooks.output)edit('if(f.settings.w<0.5) {color=aces(max(color,vec3f(0))/0.6);',`color=${hooks.output('select(color,aces(max(color,vec3f(0))/0.6),f.settings.w<0.5)')};if(f.settings.w<0.5) {`);
  out=hooks.declarations+out;if(!cache)lit.set(hooks,cache=new Map());if(cache.size>=64)cache.clear();cache.set(code,out);return out;
}
/**
 * Transparency hook (contract version 1, README "Transparency hook"), set with `PBRModel.setTransparency`. While set, BLEND
 * primitives (no transmission, no `renderState`) leave the beauty pass and draw only when the owner calls
 * `model.draw(c, 'transparent', ...)`, into `begin()`'s pass with these `targets`, depth tested (greater-equal) and not
 * written. Their fragment returns `margoTransparent(color, i)` instead of `color` (the beauty colour, alpha included).
 */
export interface PBRTransparency {
  /** Module-scope WGSL: `struct MargoTransparent` (one output per target), `fn margoTransparent(color:vec4f,i:Out)->MargoTransparent`, its bindings in `group`. Return the same string on steady frames. */
  declarations(group:number):string;
  /** Group-2 entries for those bindings (after any lighting effects' entries). */
  bindings():GPUBindGroupEntry[];
  /** Colour targets of the transparent pass, in `MargoTransparent` location order. */
  readonly targets:readonly GPUColorTargetState[];
  /** This frame's transparent pass: the scene depth read-only and these targets; begun on the first draw, ended by the owner. */
  begin():GPURenderPassEncoder;
}
const head='@fragment fn fragment(i:Out,@builtin(front_facing) front:bool)->@location(0) vec4f {',through=new Map<string,Map<string,string>>();
/** `code` (the lit PBR shader) with a `transparent` entry point returning `margoTransparent(<beauty colour>, i)`. */
export function transparentPBR(code:string,declarations:string):string {
  let cache=through.get(declarations),out=cache?.get(code);if(out!==undefined)return out;
  if(code.split(head).length!==2)throw new Error('PBR transparency hook point missing or used twice');
  out=declarations+code.replace(head,'fn margoShade(i:Out,front:bool)->vec4f {')+'\n@fragment fn transparent(i:Out,@builtin(front_facing) front:bool)->MargoTransparent {return margoTransparent(margoShade(i,front),i);}\n';
  if(!cache){if(through.size>=8)through.clear();through.set(declarations,cache=new Map());}if(cache.size>=64)cache.clear();cache.set(code,out);return out;
}
/**
 * Material capture hook (contract version 1, README "Capture hook"), set with `PBRModel.setCapture`; screen-space
 * reflections (`@margoengine/post` SSR) use it. While set, `model.draw(c, 'capture', ...)` draws the model's opaque and
 * MASK primitives (not BLEND, transmission or unlit) into `begin()`'s pass with these `targets`, depth tested
 * (greater-equal) and written. The shader is the lit beauty shader, its lighting in a dead block (every binding stays,
 * nothing is lit), with an entry point `capture` returning `margoCapture(s, v, k)`: `s` the Surface, `v` toward the eye,
 * `k` the share of the base layer's light left after clearcoat and sheen (vec3f(1) for standard materials).
 */
export interface PBRCapture {
  /** Module-scope WGSL for the lit shader `code`: `struct MargoCapture` (one output per target) and `fn margoCapture(s:Surface,v:vec3f,k:vec3f)->MargoCapture`. Return the same string for the same code. */
  declarations(code:string):string;
  /** Colour targets of the capture pass, in `MargoCapture` location order. */
  readonly targets:readonly GPUColorTargetState[];
  /** This frame's capture pass: these targets and a depth attachment of the context's format; begun on the first draw, ended by the owner. */
  begin():GPURenderPassEncoder;
}
const captured=new Map<string,Map<string,string>>();
/** `code` (the lit PBR shader) with a `capture` entry point returning `margoCapture(s,v,k)`; the beauty fragment becomes a dead `margoShade` call. */
export function capturePBR(code:string,declarations:string):string {
  let cache=captured.get(declarations),out=cache?.get(code);if(out!==undefined)return out;
  if(code.split(head).length!==2)throw new Error('PBR capture hook point missing or used twice');
  // Clearcoat and sheen scale the base layer (ambient included) affinely: k = layers(1) - layers(0).
  const k=code.includes('fn layers(')?'layers(s,v,normalize(f.light.xyz),vec3f(1))-layers(s,v,normalize(f.light.xyz),vec3f(0))':'vec3f(1)';
  out=declarations+code.replace(head,'fn margoShade(i:Out,front:bool)->vec4f {')+`\n@fragment fn capture(i:Out,@builtin(front_facing) front:bool)->MargoCapture {if(false){_=margoShade(i,front);}let s=surface(i,front);let v=normalize(f.eye.xyz-i.position);${declarations.includes('var<private> margoPosition:')?'margoPosition=i.position;':''}return margoCapture(s,v,${k});}\n`;
  if(!cache){if(captured.size>=8)captured.clear();captured.set(declarations,cache=new Map());}if(cache.size>=64)cache.clear();cache.set(code,out);return out;
}
// Material map slots 5-12, in PBRModel order. Sheen and specular colors are sRGB.
export const physicalMaps = ['clearcoat','clearcoatRoughness','clearcoatNormal','transmission','sheenColor','sheenRoughness','specular','specularColor'];
const sample = (name: string) => `textureSample(${name}Map,${name}Sampler,uv(i,${physicalMaps.indexOf(name) + 5}))`;
function patch(source: string, edits: [string, string][]): string {
  for (const [from, to] of edits) {if (!source.includes(from)) throw new Error('PBR shader patch target missing: ' + from); source = source.replaceAll(from, to);}
  return source;
}
let physical: string | undefined;
/** Variant for KHR_materials_clearcoat, transmission, ior, volume, sheen and specular, built on first use (so it tree-shakes). Only materials using them compile it; other materials keep pbrShader and its ten group-1 bindings. */
export const physicalShader = (): string => physical ??= patch(pbrShader, [
  ['emissive:vec3f}', 'emissive:vec3f, f0:vec3f, tr:f32, cn:vec3f, cc:f32, cr:f32, sh:vec4f}'],
  ['var emissiveSampler:sampler;', 'var emissiveSampler:sampler;\n' + physicalMaps.map((name, i) => `@group(1) @binding(${10 + i * 2}) var ${name}Map:texture_2d<f32>;\n@group(1) @binding(${11 + i * 2}) var ${name}Sampler:sampler;`).join('\n')],
  // Dielectric F0 from IOR and KHR_materials_specular, transmission weight, clearcoat normal and layer factors.
  ['  if(margoFaceTest&&!facing&&f.settings.z<0.5){discard;}', `  let ior=(f.ext.y-1)/(f.ext.y+1); s.f0=min(ior*ior*f.specular.rgb*${sample('specularColor')}.rgb,vec3f(1))*f.specular.w*${sample('specular')}.a;
  s.tr=f.coat.w*${sample('transmission')}.r; let cm=${sample('clearcoatNormal')}.xyz*2-1; s.cn=normalize(t*cm.x*f.coat.z+b*cm.y*f.coat.z+n*cm.z);
  s.cc=f.coat.x*${sample('clearcoat')}.r; s.cr=clamp(f.coat.y*${sample('clearcoatRoughness')}.g,0.045,1.0);
  s.sh=vec4f(f.sheen.rgb*${sample('sheenColor')}.rgb,max(f.sheen.w*${sample('sheenRoughness')}.a,0.07));
  if(margoFaceTest&&!facing&&f.settings.z<0.5){discard;}`],
  ['mix(vec3f(0.04),s.base.rgb,s.metal)', 'mix(s.f0,s.base.rgb,s.metal)'],
  ['s.base.rgb*(1-s.metal)+', 's.base.rgb*(1-s.metal)*(1-s.tr)+'],
  ['(1-s.metal)*s.base.rgb/', '(1-s.metal)*(1-s.tr)*s.base.rgb/'],
  ['@fragment fn fragment(', `fn ggx(n:vec3f,v:vec3f,l:vec3f,r:f32)->f32 {
  let h=normalize(v+l); let nl=clamp(dot(n,l),0.0,1.0); let nv=clamp(dot(n,v),0.0001,1.0); let nh=clamp(dot(n,h),0.0,1.0);
  let a2=pow(r,4.0); let d=a2/(3.14159265*pow(nh*nh*(a2-1)+1,2.0)); let g=2*nv/(nv+sqrt(a2+(1-a2)*nv*nv))*2*nl/max(nl+sqrt(a2+(1-a2)*nl*nl),0.0001);
  return d*g/max(4*nl*nv,0.0001)*nl;
}
fn layers(s:Surface,v:vec3f,l:vec3f,under:vec3f)->vec3f {
  let light=f.radiance.rgb*f.light.w; let h=normalize(v+l); let nl=clamp(dot(s.n,l),0.0,1.0); let nv=clamp(dot(s.n,v),0.0001,1.0); let nh=clamp(dot(s.n,h),0.0,1.0);
  let inv=1/(s.sh.w*s.sh.w); let sheen=(2+inv)*pow(1-nh*nh,inv*0.5)/6.2831853/(4*(nl+nv-nl*nv))*nl;
  let sky=mix(vec3f(0.35,0.3,0.25),vec3f(1),clamp(s.cn.y*0.5+0.5,0.0,1.0))*f.radiance.w*s.occlusion;
  let color=under*(1-0.157*max(s.sh.r,max(s.sh.g,s.sh.b)))+s.sh.rgb*(sheen*light+0.157*sky);
  let fc=0.04+0.96*pow(1-clamp(dot(s.cn,v),0.0,1.0),5.0);
  return color*(1-s.cc*fc)+s.cc*fc*(ggx(s.cn,v,l,s.cr)*light+0.5*sky);
}
@fragment fn fragment(`],
  ['  if(f.ext.x>0.5){color=s.base.rgb;}', '  color=layers(s,v,l,color);\n  if(f.ext.x>0.5){color=s.base.rgb;}'],
]);
let factors: string | undefined;
/** physicalShader with every extension map replaced by the value of its default 1x1 texture: factors only, pbrShader's five group-1 textures.
 * Drawn for physical materials whose `maps` hold only the five core slots (`@margoengine/materials`). */
export const factorPhysicalShader = (): string => factors ??= physicalShader()
  .replace(/@group\(1\) @binding\((\d+)\) var \w+:[^;]+;\n?/g, (line, binding) => +binding < 10 ? line : '')
  .replace(/textureSample\((\w+)Map,\1Sampler,uv\(i,\d+\)\)/g, (_, name) => name === 'clearcoatNormal' ? 'vec4f(vec2f(128.0/255.0),1,1)' : 'vec4f(1)');
/**
 * Transmission hook (contract version 1, README "Transmission hook"), set with `PBRModel.setTransmission`;
 * `@margoengine/materials/transmission` uses it to refract the scene. While set, primitives with transmission (no
 * `renderState`) leave the beauty pass and draw only when the owner calls `model.draw(c, 'transmission', ...)`, into
 * `begin()`'s pass with these `targets`, depth tested (greater-equal) and not written. Their shader is the lit physical
 * beauty shader with `margoTransmission(s, v, i)` (vec3f: light arriving through the surface) added to the base layer under
 * clearcoat and sheen; `margoVolume` (group 0) holds the thickness factor and the per-unit-length transmittance of KHR_materials_volume.
 */
export interface PBRTransmission {
  /** Module-scope WGSL: `fn margoTransmission(s:Surface,v:vec3f,i:Out)->vec3f` and its bindings in `group`. Return the same string on steady frames. */
  declarations(group:number):string;
  /** Group-2 entries for those bindings (after any lighting effects' entries). */
  bindings():GPUBindGroupEntry[];
  /** Colour targets of the transmission pass. */
  readonly targets:readonly GPUColorTargetState[];
  /** This frame's transmission pass: the scene colour and depth (read-only); begun on the first draw, ended by the owner. */
  begin():GPURenderPassEncoder;
}
const base='  color=layers(s,v,l,color);',transmitted=new Map<string,Map<string,string>>();
/** `code` (the lit physical shader) with `margoTransmission(s,v,i)` added under the clearcoat and sheen layers. */
export function transmissionPBR(code:string,declarations:string):string {
  let cache=transmitted.get(declarations),out=cache?.get(code);if(out!==undefined)return out;
  if(code.split(base).length!==2)throw new Error('PBR transmission hook point missing or used twice');
  out='@group(0) @binding(1) var<uniform> margoVolume:vec4f;\n'+declarations+code.replace(base,'  color=layers(s,v,l,color+margoTransmission(s,v,i));');
  if(!cache){if(transmitted.size>=8)transmitted.clear();transmitted.set(declarations,cache=new Map());}if(cache.size>=64)cache.clear();cache.set(code,out);return out;
}
