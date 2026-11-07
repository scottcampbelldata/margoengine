/**
 * How `Shadows` filters its depth map. `'soft'`: PCSS, penumbrae that widen with blocker distance and `lightSize`
 * (16 blocker reads and 32 comparison taps per lit pixel). `'pcf'`: four hardware comparison taps half a texel apart,
 * a smooth edge about three texels wide, no blocker search. `'hard'`: one hardware comparison tap (the sampler's own
 * 2x2 bilinear comparison), the cheapest edge.
 */
export type ShadowFilter = 'soft' | 'pcf' | 'hard';
/** The first binding of `effects`; each effect has four from there. Past Shadows' and the other lighting effects' own. */
export const EFFECT_BINDING = 40;
/** What a {@link ShadowEffect} sees of a frame. Borrowed: use it synchronously. */
export interface ShadowEffectFrame<Context = unknown> {
  /** The frame's WebGPU pass context; no pass is open on its encoder. */
  context: Context;
  /** Unit direction towards the light. */
  light: ArrayLike<number>;
  /** The depth map changed this frame. */
  changed: boolean;
  /** The depth map, `depth32float`, one layer per cascade; undefined on `VirtualShadows`. */
  map?: GPUTextureView;
}
/** The depth map's size, for an effect that keeps maps of its own. */
export interface ShadowEffectMap {
  width: number;
  height: number;
  layers: number;
}
/**
 * Something the shadow pass multiplies the sun by, from `@margoengine/shadows/light-function` and the other optional
 * entries, or written by hand. Give it in the `effects` option of `Shadows` or `VirtualShadows`: every receiver, gltf-pro
 * models and materials included, then takes it. WebGPU only; resource names start `shadowFx`.
 */
export interface ShadowEffect<Context = unknown> {
  /** WGSL declarations for bind group `group`, resources named `shadowFx...` from binding `binding` up (four at most). */
  wgsl(group: number, binding: number): string;
  /**
   * With `colored`, a WGSL `vec3f` for the light reaching a receiver from a tint caster, over `through` (the tint map's
   * colour) and `gap` (world distance behind the caster). Omitted, it goes straight on as `through`.
   */
  readonly tint?: string;
  /** A WGSL `vec3f` over `position` and `normal` that multiplies the light; omitted, the effect multiplies nothing. */
  readonly call?: string;
  /** The name of a WGSL function from the light's whole shadow to what it leaves, both `vec3f`. One effect at most has this. */
  readonly style?: string;
  /** The resources of those bindings in order, read when the receivers' bindings are made. */
  resources?(): readonly GPUBindingResource[];
  /** Makes GPU objects; runs at attach, after a new map size and after a device loss. Runs again on the same effect. */
  setup?(device: GPUDevice, map: ShadowEffectMap): void;
  /** Runs once per frame after the depth passes. */
  update?(frame: ShadowEffectFrame<Context>): void;
  /** Frees GPU objects. */
  dispose?(): void;
}
/** A {@link ShadowEffect} that replaces the edge filter: `filter` takes it in place of a name. */
export interface ShadowFilterEffect<Context = unknown> extends ShadowEffect<Context> {
  /** WGSL that returns visibility, 0 to 1, in place of the named filters, with `uv`, `layer` and `reference` in scope. */
  readonly body: string;
}
// Each filter's last step, after the cascade lookup (layer) and receiver-plane bias shared by all three.
const filters: Record<ShadowFilter, string> = {
  // Taps follow a golden-angle (Vogel) spiral computed in the loop: tap j sits at radius sqrt((j+0.5)/n), turned one
  // golden angle (2.39996323 rad, shadowGolden) from tap j-1. No constant tables: drivers can place indexed constant
  // arrays in per-pixel scratch memory, which phone GPUs handle badly. Each pixel starts the spiral at its own angle
  // from interleaved gradient noise of its screen position (Jimenez 2014), so a penumbra shows fine noise instead of
  // the steps of one pattern shared by every pixel. No time term: the same view renders the same pixels every frame.
  // PCSS blocker search and penumbra estimate: Fernando 2005, "Percentage-Closer Soft Shadows". The search reaches
  // from the receiver to the nearest caster in its layer (shadowFrame.nearest, the layer's smallest depth this frame):
  // a blocker farther up cannot exist, so the 16 reads stay where blockers are, however far casterMargin and the
  // cascade sphere put the near plane. Tap 0 reads the receiver's own texel, so a receiver whose texel is covered always
  // finds a blocker. A read counts only when it is nearer the light than both the receiver plane and the receiver
  // itself (min(...,0)): a surface behind the receiver cannot shade it, however the plane tilts on that side, which
  // keeps a curved or faceted receiver from reading its own far side, or the ground behind it, as a blocker.
  soft: /* wgsl */ `
  let angle=noise.x*6.2831853;let turn=vec2f(cos(angle),sin(angle));
  let search=max(texel.x,shadowFrame.settings.x*max(reference-shadowFrame.nearest[layer],0.0)*shadowFrame.ranges[layer]*length(rowX)*0.5);
  var blockers=0.0;var sum=0.0;var direction=turn;
  for(var j=0u;j<16u;j++){
    let offset=direction*sqrt(f32(j)/16.0)*search;direction=shadowGolden*direction;
    let coord=vec2i((uv+offset)*dimensions);
    if(any(coord<vec2i(0))||any(coord>=vec2i(dimensions))){continue;}
    let d=textureLoad(shadowMap,coord,i32(layer),0);
    let plane=min(dot((vec2f(coord)+0.5)*texel-uv,slope),0.0);
    if(d<reference+plane){sum+=d-plane;blockers+=1;}
  }
  if(blockers==0){return 1;}
  let blocker=sum/blockers;
  let penumbra=shadowFrame.settings.x*(reference-blocker)*shadowFrame.ranges[layer]*length(rowX)*0.5;
  let radius=clamp(penumbra,texel.x,0.1);var visibility=0.0;direction=turn;
  for(var j=0u;j<32u;j++){
    let offset=direction*sqrt((f32(j)+0.5)/32.0)*radius;direction=shadowGolden*direction;
    let coord=uv+offset;
    if(any(coord<vec2f(0))||any(coord>vec2f(1))){visibility+=1;}else{visibility+=textureSampleCompareLevel(shadowMap,shadowSampler,coord,i32(layer),reference+min(dot(offset,slope),0.0));}
  }
  return visibility/32.0;`,
  // Each tap is the sampler's 2x2 bilinear comparison; four of them half a texel apart add up to a 3x3-texel
  // quadratic B-spline. Written out, not looped: no arrays, no blocker search, no transcendental per tap.
  // PCF: Reeves, Salesin & Cook 1987, "Rendering Antialiased Shadows with Depth Maps".
  pcf: /* wgsl */ `
  let h=texel*0.5;let tapLayer=i32(layer);let a=vec2f(h.x,-h.y);
  return (textureSampleCompareLevel(shadowMap,shadowSampler,uv-h,tapLayer,reference-dot(h,slope))+textureSampleCompareLevel(shadowMap,shadowSampler,uv+h,tapLayer,reference+dot(h,slope))+textureSampleCompareLevel(shadowMap,shadowSampler,uv-a,tapLayer,reference-dot(a,slope))+textureSampleCompareLevel(shadowMap,shadowSampler,uv+a,tapLayer,reference+dot(a,slope)))*0.25;`,
  hard: /* wgsl */ `
  return textureSampleCompareLevel(shadowMap,shadowSampler,uv,i32(layer),reference);`,
};
// Compare on the receiver plane; cover comparison-sampler subtexel footprints.
// Receiver-plane depth bias: Isidoro 2006, GDC "Shadow Mapping: GPU-based Tips and Techniques". Normal-offset
// receiver position: Holbert 2011, "Normal Offset Shadows". shadowNoise is interleaved gradient noise (Jimenez 2014).
// Directional lights use angular size and orthographic depth separation.
// shadowNoise rebuilds the fragment's screen pixel from the camera view and settings.w (pixels per unit at depth 1), so
// it needs no fragment input: x is interleaved gradient noise of the pixel, y of the transposed pixel (a second pattern,
// uncorrelated with x). The last tenth of each cascade's depth range dithers into the next cascade (noise.y threshold):
// no hard seam where texel size changes, still one map lookup per tap; the next cascade's sphere holds the band. The
// last cascade (its split equals splits.w) and unused ones never switch. Comments stay out of the WGSL: they would ship.
// `anisotropic` (a non-square map or an explicit frustum): light-space x and y map to UVs at different scales, so the
// receiver-plane slope and the PCSS radii take each axis's own row length and texel; otherwise the text is unchanged.
// `colored`: the tint map of Shadows' `colored` option. The map's depth tells a receiver behind the tinting casters
// from one in front; it adds three bindings past the other lighting effects' (27 to 29) and changes shadowLit.
// `level`: a device at the compatibility level, which forbids textureLoad of a depth texture, and a plain sampler on
// one. The blocker search reads the same map bound a second time as float (binding 30), which only `'soft'` needs.
export function shadowSampling(
  group: number,
  filter: ShadowFilter | ShadowFilterEffect = 'soft',
  anisotropic = false,
  colored = false,
  level = false,
  effects: readonly ShadowEffect[] = [],
): string {
  const search = level && filter === 'soft',
    chosen = search
      ? filters.soft.replace(
          'textureLoad(shadowMap,coord,i32(layer),0)',
          'textureLoad(shadowDepth,coord,i32(layer),0).x',
        )
      : typeof filter === 'object'
        ? // Never taken: a binding no code reads leaves an 'auto' layout, and the receivers' groups bind the sampler.
          `if(reference>2){return textureSampleCompareLevel(shadowMap,shadowSampler,uv,i32(layer),reference);}${filter.body}`
        : filters[filter],
    body = anisotropic
      ? chosen
          .replaceAll('length(rowX)*0.5', 'vec2f(length(rowX),length(rowY))*0.5')
          .replace('max(texel.x,', 'max(texel,')
          .replace('clamp(penumbra,texel.x,0.1)', 'clamp(penumbra,texel,vec2f(0.1))')
      : chosen;
  // Declared first: its `tint` names the binding `wgsl` chose.
  const declarations = effectDeclarations(group, effects),
    spread = effects.find((effect) => effect.tint)?.tint;
  return /* wgsl */ `
struct ShadowFrame {matrices:array<mat4x4f,4>,view:mat4x4f,splits:vec4f,ranges:vec4f,settings:vec4f,nearest:vec4f}
@group(${group}) @binding(1) var<uniform> shadowFrame:ShadowFrame;
@group(${group}) @binding(2) var shadowMap:texture_depth_2d_array;
@group(${group}) @binding(3) var shadowSampler:sampler_comparison;
${search ? `@group(${group}) @binding(30) var shadowDepth:texture_2d_array<f32>;\n` : ''}${filter === 'soft' ? 'const shadowGolden=mat2x2f(-0.737368878,0.675490294,-0.675490294,-0.737368878);\n' : ''}fn shadowNoise(position:vec3f)->vec2f {
  let eye=shadowFrame.view*vec4f(position,1);let pixel=eye.xy/max(-eye.z,0.000001)*shadowFrame.settings.w;
  let magic=vec2f(0.06711056,0.00583715);
  return fract(52.9829189*fract(vec2f(dot(pixel,magic),dot(pixel.yx,magic))));
}
fn shadowVisibility(position:vec3f,normal:vec3f)->f32 {
  let depth=-(shadowFrame.view*vec4f(position,1)).z;
  if(depth>shadowFrame.splits.w){return 1;}
  let cascade=u32(depth>shadowFrame.splits.x)+u32(depth>shadowFrame.splits.y)+u32(depth>shadowFrame.splits.z);
  let noise=shadowNoise(position);let split=shadowFrame.splits[cascade];
  let band=0.1*(split-select(0.0,shadowFrame.splits[max(cascade,1u)-1u],cascade>0u));
  let layer=cascade+u32(split<shadowFrame.splits.w&&depth>split-band*(1.0-noise.y));
  let projected=shadowFrame.matrices[layer]*vec4f(position+normalize(normal)*shadowFrame.settings.z,1);
  let uv=projected.xy*vec2f(0.5,-0.5)+0.5;var reference=projected.z-shadowFrame.settings.y;
  if(any(uv<vec2f(0))||any(uv>vec2f(1))||reference<=0||reference>=1){return 1;}
  let dimensions=vec2f(textureDimensions(shadowMap));let texel=1.0/dimensions;
  let matrix=shadowFrame.matrices[layer];let rowX=vec3f(matrix[0].x,matrix[1].x,matrix[2].x);let rowY=vec3f(matrix[0].y,matrix[1].y,matrix[2].y);let rowZ=vec3f(matrix[0].z,matrix[1].z,matrix[2].z);
  let lightNormal=vec3f(dot(normal,normalize(rowX)),dot(normal,normalize(rowY)),dot(normal,normalize(rowZ)));var slope=vec2f(0);
  if(abs(lightNormal.z)>0.001){slope=clamp(${anisotropic ? 'vec2f(-lightNormal.x/length(rowX),lightNormal.y/length(rowY))*2*length(rowZ)/lightNormal.z' : 'vec2f(-lightNormal.x,lightNormal.y)*2*length(rowZ)/(length(rowX)*lightNormal.z)'},vec2f(-2),vec2f(2));}
  reference-=dot(abs(slope),texel)*0.5;${body}
}
${
  colored
    ? `@group(${group}) @binding(27) var shadowTintMap:texture_2d_array<f32>;
@group(${group}) @binding(28) var shadowTintDepth:texture_depth_2d_array;
@group(${group}) @binding(29) var shadowTintSampler:sampler;
fn shadowTint(position:vec3f,normal:vec3f)->vec3f {
  let depth=-(shadowFrame.view*vec4f(position,1)).z;
  if(depth>shadowFrame.splits.w){return vec3f(1);}
  let cascade=u32(depth>shadowFrame.splits.x)+u32(depth>shadowFrame.splits.y)+u32(depth>shadowFrame.splits.z);
  let split=shadowFrame.splits[cascade];
  let band=0.1*(split-select(0.0,shadowFrame.splits[max(cascade,1u)-1u],cascade>0u));
  let layer=cascade+u32(split<shadowFrame.splits.w&&depth>split-band*(1.0-shadowNoise(position).y));
  let projected=shadowFrame.matrices[layer]*vec4f(position+normalize(normal)*shadowFrame.settings.z,1);
  let uv=projected.xy*vec2f(0.5,-0.5)+0.5;let reference=projected.z-shadowFrame.settings.y;
  if(any(uv<vec2f(0))||any(uv>vec2f(1))||reference<=0||reference>=1){return vec3f(1);}
  ${spread ? `let through=textureSampleLevel(shadowTintMap,shadowTintSampler,uv,i32(layer),0).rgb;let gap=max(reference-textureLoad(shadowTintDepth,vec2i(uv*vec2f(textureDimensions(shadowTintDepth))),i32(layer),0),0.0)*shadowFrame.ranges[layer];\n  return mix(${spread},vec3f(1),textureSampleCompareLevel(shadowTintDepth,shadowSampler,uv,i32(layer),reference));` : 'return mix(textureSampleLevel(shadowTintMap,shadowTintSampler,uv,i32(layer),0).rgb,vec3f(1),textureSampleCompareLevel(shadowTintDepth,shadowSampler,uv,i32(layer),reference));'}
}
`
    : ''
}${effects.length ? 'fn shadowReach()->f32 {return shadowFrame.splits.w;}\n' : ''}${declarations}fn shadowLit(direct:vec3f,position:vec3f,normal:vec3f)->vec3f {if(all(direct==vec3f(0))){return direct;}return ${effectLight(effects, `shadowVisibility(position,normal)${colored ? '*shadowTint(position,normal)' : ''}`)};}
`;
}
/** The effects' declarations. */
export const effectDeclarations = (group: number, effects: readonly ShadowEffect[]): string =>
  effects.map((effect, i) => effect.wgsl(group, EFFECT_BINDING + i * 4)).join('');
/** The effects' factors, each with its leading `*`. */
export const effectCalls = (effects: readonly ShadowEffect[]): string =>
  effects.map((effect) => (effect.call ? '*' + effect.call : '')).join('');
/** `direct` times the shadow `visibility` and the effects give, through the style if an effect has one. */
export const effectLight = (effects: readonly ShadowEffect[], visibility: string): string => {
  const style = effects.find((effect) => effect.style)?.style;
  return style ? `direct*${style}(vec3f(1)*${visibility}${effectCalls(effects)})` : `direct*${visibility}${effectCalls(effects)}`;
};
/** The effects' bind group entries. */
export const effectEntries = (effects: readonly ShadowEffect[]): GPUBindGroupEntry[] =>
  effects.flatMap((effect, i) =>
    (effect.resources?.() ?? []).map((resource, k) => ({ binding: EFFECT_BINDING + i * 4 + k, resource })),
  );
/** `options.effects`, checked. */
export const validEffects = (effects: unknown): readonly ShadowEffect[] => {
  if (effects === undefined) return [];
  if (!Array.isArray(effects) || !effects.every((effect) => typeof effect?.wgsl === 'function'))
    throw new TypeError('Invalid shadow effects; give an array of effects such as cloudShadows(sky)');
  if (effects.filter((effect) => 'style' in effect).length > 1) throw new TypeError('Invalid shadow effects; give one shadowStyle');
  return effects;
};
/** Moves the effects' declarations in `code` to the bindings `map` gives (a scene's `section` plugin holds their slots). */
export const moveEffects = (code: string, map: (binding: number) => number): string =>
  code.replace(/@binding\((\d+)\)( var(?:<[^>]*>)? ?shadowFx)/g, (_, binding, rest) => `@binding(${map(+binding)})${rest}`);
// Each layer's nearest depth for the PCSS search (shadowFrame.nearest): a workgroup takes the minimum of a 32x32 block,
// four by four texels per invocation, then one atomicMin per workgroup into the layer's slot. Depths lie in 0..1, where
// f32 bit patterns order as the values do, so atomicMin on the u32 bits is a float minimum. The frame seeds the slots
// with 1.0 (the cleared depth) before the dispatch.
export const nearestDepth = /* wgsl */ `@group(0) @binding(0) var map:texture_depth_2d_array;
@group(0) @binding(1) var<storage,read_write> nearest:array<atomic<u32>,4>;
var<workgroup> block:atomic<u32>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u,@builtin(local_invocation_index) index:u32){
  if(index==0u){atomicStore(&block,0x3f800000u);}
  workgroupBarrier();
  let size=textureDimensions(map);var m=1.0;
  for(var y=0u;y<4u;y++){for(var x=0u;x<4u;x++){let c=id.xy*4u+vec2u(x,y);if(all(c<size)){m=min(m,textureLoad(map,c,id.z,0));}}}
  atomicMin(&block,bitcast<u32>(m));
  workgroupBarrier();
  if(index==0u){atomicMin(&nearest[id.z],atomicLoad(&block));}
}`;
export function shadowDepth(pbr: boolean, transformed = false): string {
  return /* wgsl */ `
struct Frame {camera:mat4x4f,model:mat4x4f,alpha:vec4f${transformed ? ',alphaUV0:vec4f,alphaUV1:vec4f' : ''}}
@group(0) @binding(0) var<uniform> f:Frame;
@group(0) @binding(1) var alphaMap:texture_2d<f32>;
@group(0) @binding(2) var alphaSampler:sampler;
struct In {@location(0) position:${pbr ? 'vec4f' : 'vec3f'},${pbr ? '@location(3) uv:vec4f,@location(4) color:vec4f' : ''}}
struct Out {@builtin(position) clip:vec4f,@location(0) uv:vec2f,@location(1) alpha:f32}
@vertex fn vertex(i:In)->Out {var o:Out;o.clip=f.camera*f.model*vec4f(i.position.xyz,1);${pbr ? 'o.uv=select(i.uv.xy,i.uv.zw,f.alpha.z>0.5);o.alpha=i.color.a;' : 'o.uv=vec2f(0);o.alpha=1;'}${transformed ? 'let sourceUV=o.uv;o.uv=vec2f(dot(f.alphaUV0.xy,sourceUV)+f.alphaUV0.z,dot(f.alphaUV1.xy,sourceUV)+f.alphaUV1.z);' : ''}return o;}
@fragment fn fragment(i:Out){if(textureSampleLevel(alphaMap,alphaSampler,i.uv,0).a*f.alpha.x*i.alpha<f.alpha.y){discard;}}
`;
}
