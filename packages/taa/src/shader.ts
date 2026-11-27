import { MargoError } from '@margoengine/math/errors';
import { animationCode, opacityCode, solidVertexDepth } from '../../shared/caster.js';
import { displacementCode } from '../../shared/displacement.js';
import { sectionShader } from '../../shared/section.js';

// `offset.xy` is this frame's jitter minus the history frame's, in uv: the part of every velocity that is not motion.
const frame = `struct Temporal {current:mat4x4f,previous:mat4x4f,inverse:mat4x4f,settings:vec4f,offset:vec4f}
@group(0) @binding(0) var<uniform> temporal:Temporal;`;
export const fullscreen = `struct Fullscreen {@builtin(position) clip:vec4f}
@vertex fn vertex(@builtin(vertex_index) i:u32)->Fullscreen {let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));var o:Fullscreen;o.clip=vec4f(p[i],0,1);return o;}`;
// `velocity.w` is 1, the coverage channel of an rgba16float object target (TAA's KB-TAA-COMPATEDGE1 route on the
// WebGL2 layer); an rg16float target drops it.
const motion = `struct Motion {@location(0) velocity:vec4f,@location(1) depth:f32}
fn motion(current:vec2f,previous:vec4f)->Motion {var o:Motion;o.velocity=vec4f(0,0,0,1);o.depth=-1;
  if(previous.w>0){o.velocity=vec4f(current-(previous.xy/previous.w*vec2f(0.5,-0.5)+0.5),0,1);o.depth=previous.z/previous.w;}return o;}`;
// The sky (depth 0, the reversed-Z far plane) moves with the camera's turn like any pixel and keeps history (depth 0)
// from sky alone, so what is drawn over it with no depth of its own (volumetric clouds, stars, weather) is averaged
// too; a surface's history there has a greater depth and is still rejected. Before 2026-11-13 the sky had none.
export const cameraVelocity =
  frame +
  fullscreen +
  motion +
  `
@group(0) @binding(1) var depth:texture_depth_2d;
@fragment fn fragment(i:Fullscreen)->Motion {let size=vec2f(textureDimensions(depth));let uv=i.clip.xy/size;let d=textureLoad(depth,vec2i(i.clip.xy),0);
  let world=temporal.inverse*vec4f(uv*vec2f(2,-2)+vec2f(-1,1),d,1);var o=motion(uv,temporal.previous*world);
  if(d==0){o.depth=0;}return o;}`;
// At 4x MSAA the sky writes skySample instead, outside every depth's 0..1, and the motion resolve turns a pixel whose
// four samples all hold it into 0. The WebGL2 layer cannot read single samples: its motion resolve reads the mean of
// the four. A silhouette pixel there mixes object and sky samples, and with the sky at 0 the mean was a false depth
// between them with motion diluted toward the camera's (upscale-velocity-browser.mjs --compat). Any sky share now
// drives the mean below 0 for every depth up to 1 (one of four: (-4 + 3) / 4), so that pixel rejects history as it did before
// 2026-11-13. The value is a power of two, so the mean of four equal samples is exact. WebGPU picks the nearest sample.
export const skySample = -4;
export const multisampledCameraVelocity = /* @__PURE__ */ cameraVelocity.replace(
  'if(d==0){o.depth=0;}',
  `if(d==0){o.depth=${skySample};}`,
);
/**
 * An object velocity program for a gltf/pbr instanced primitive (PBRInstances): slot 1 holds this frame's instance rows
 * (locations 5 to 10, the colour pass's layout), slot 2 last frame's (11 to 14, the matrix columns). Each vertex moves by
 * node x instance matrix now and then, as reverse reprojection does for whole objects (Nehab et al. 2007; Yang, Liu
 * and Salvi 2020, section 4.1). The current position keeps the colour pass's expression, (node x instance) x vertex,
 * so the 'equal' depth test meets it (@invariant). The instance's UV scale and offset and its tint's alpha cut as the
 * colour pass does.
 */
export function instancedVelocity(code: string): string {
  const edits: [string, string][] = [
    [
      '@vertex fn vertex(i:Input,',
      'struct MargoInstance {@location(5) m0:vec4f,@location(6) m1:vec4f,@location(7) m2:vec4f,@location(8) m3:vec4f,@location(9) tint:vec4f,@location(10) uvt:vec4f,@location(11) p0:vec4f,@location(12) p1:vec4f,@location(13) p2:vec4f,@location(14) p3:vec4f}\n@vertex fn vertex(i:Input,k:MargoInstance,',
    ],
    ['let world=f.model*p;', 'let world=(f.model*mat4x4f(k.m0,k.m1,k.m2,k.m3))*p;'],
    ['o.previous=camera.previous*f.previousModel*old;', 'o.previous=camera.previous*(f.previousModel*mat4x4f(k.p0,k.p1,k.p2,k.p3))*old;'],
    ['o.uv=i.uv;o.alpha=i.color.a;', 'o.uv=i.uv;o.uv=o.uv*k.uvt.xyxy+k.uvt.zwzw;o.alpha=i.color.a*k.tint.a;'],
  ];
  for (const [from, to] of edits) {
    if (!code.includes(from))
      throw new MargoError('state', 'TAA instanced velocity patch target missing; use matching @margoengine/taa sources');
    code = code.replace(from, to);
  }
  return code;
}
export function objectVelocity(
  pbr: boolean,
  transformed = false,
  opacity = false,
  solid = false,
  displaced = false,
  clipped = false,
  graph?: (code: string, group: number) => string,
  before?: { move: readonly string[]; binding: number },
  animated = false,
  instanced = false,
): string {
  // A moving cut-out (MToon UV animation) reads its alpha map at the animated UV, bound at 9 to 11.
  let code = `${opacity ? opacityCode(0, 5) : ''}${animated ? animationCode(0, 9) : ''}
struct ObjectCamera {current:mat4x4f,previous:mat4x4f,settings:vec4f,viewport:vec4f}
struct ObjectFrame {model:mat4x4f,previousModel:mat4x4f,settings:vec4f,alpha:vec4f${transformed ? ',alphaUV0:vec4f,alphaUV1:vec4f' : ''}}
@group(0) @binding(0) var<uniform> f:ObjectFrame;
@group(0) @binding(4) var<uniform> camera:ObjectCamera;
${pbr ? '@group(0) @binding(1) var<storage,read> previousVertices:array<vec4f>;\n@group(0) @binding(2) var alphaMap:texture_2d<f32>;\n@group(0) @binding(3) var alphaSampler:sampler;' : ''}
struct Input {@location(0) position:${pbr ? 'vec4f' : 'vec3f'}${pbr ? ',@location(1) uv:vec4f,@location(2) color:vec4f' : ''}}
struct Out {@builtin(position) @invariant clip:vec4f,@location(4) current:vec4f,@location(0) previous:vec4f${pbr ? ',@location(1) uv:vec4f,@location(2) alpha:f32' : ''}}
@vertex fn vertex(i:Input,@builtin(vertex_index) index:u32)->Out {var o:Out;let p=vec4f(i.position.xyz,1);let valid=f.settings.z*camera.settings.z>0;let world=f.model*p;o.clip=camera.current*world;
  ${pbr ? 'let old=select(p,vec4f(previousVertices[index*5].xyz,1),valid);' : 'let old=p;'}
  o.current=o.clip;o.previous=camera.previous*f.previousModel*old;if(!valid){o.previous.w=-1;}
  ${pbr ? 'o.uv=i.uv;o.alpha=i.color.a;' : ''}return o;}
${motion}
@fragment fn fragment(i:Out)->Motion {${pbr ? 'var uv=select(i.uv.xy,i.uv.zw,f.alpha.z>0.5);' + (transformed ? 'uv=vec2f(dot(f.alphaUV0.xy,uv)+f.alphaUV0.z,dot(f.alphaUV1.xy,uv)+f.alphaUV1.z);' : '') + `let alpha=textureSample(alphaMap,alphaSampler,${animated ? 'margoAnimatedUV(i.uv)' : 'uv'}).a*${opacity ? 'margoOpacityAt(i.uv)*' : ''}i.alpha*f.alpha.x;if(alpha<f.alpha.y){discard;}` : ''}
  // Both positions use the same perspective interpolation. Fragment position includes raster subpixel snapping,
  // which otherwise appears as false velocity even when the surface has only projection jitter.
  let current=(i.current.xy/i.current.w*vec2f(0.5,-0.5)+0.5)*camera.viewport.xy+camera.viewport.zw;
  return motion(current,i.previous);}`;
  if (instanced) code = instancedVelocity(code);
  if (solid) code = solidVertexDepth(code);
  // The previous frame's vertex moves by the same amount: a map or scale changing moves a surface without any velocity.
  if (graph)
    code = graph(
      code
        .replace(',@location(1) uv:vec4f,', ',@location(3) normal:vec4f,@location(1) uv:vec4f,')
        .replace(
          'let p=vec4f(i.position.xyz,1);',
          'let shift=margoPosition-i.position.xyz;let p=vec4f(margoPosition,1);',
        )
        .replace('vec4f(previousVertices[index*5].xyz,1)', 'vec4f(previousVertices[index*5].xyz+shift,1)'),
      1,
    );
  else if (displaced)
    code =
      displacementCode(1) +
      code
        .replace(',@location(1) uv:vec4f,', ',@location(3) normal:vec4f,@location(1) uv:vec4f,')
        .replace(
          'let p=vec4f(i.position.xyz,1);',
          'let shift=i.normal.xyz*margoDisplacement(i.uv);let p=vec4f(i.position.xyz+shift,1);',
        )
        .replace('vec4f(previousVertices[index*5].xyz,1)', 'vec4f(previousVertices[index*5].xyz+shift,1)');
  if (graph && before) code = beforeMove(code, before.move, before.binding);
  if (clipped)
    code = sectionShader(
      code
        .replace('struct Out {', 'struct Out {@location(3) position:vec3f,')
        .replace('o.uv=i.uv;', 'o.position=world.xyz;o.uv=i.uv;'),
      0,
      8,
      'materialClip',
    );
  return code;
}
export const snapshot = `@group(0) @binding(0) var<storage,read> source:array<vec4f>;
@group(0) @binding(1) var<storage,read_write> destination:array<vec4f>;
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id:vec3u) {if(id.x<arrayLength(&destination)){destination[id.x]=source[id.x];}}`;
// sRGB decode: IEC 61966-2-1. RGB to/from YCoCg: Malvar & Sullivan, "YCoCg-R" (2003).
export const color = `override manualSRGB:bool=true;
fn linear(c:vec3f)->vec3f{if(!manualSRGB){return c;}return select(c/12.92,pow((c+0.055)/1.055,vec3f(2.4)),c>vec3f(0.04045));}
fn ycocg(c:vec3f)->vec3f {return vec3f(dot(c,vec3f(0.25,0.5,0.25)),(c.r-c.b)*0.5,dot(c,vec3f(-0.25,0.5,-0.25)));}
fn rgb(c:vec3f)->vec3f {return vec3f(c.x+c.y-c.z,c.x+c.z,c.x-c.y-c.z);}`;
// Reprojection, 3x3 YCoCg neighbourhood clamp and history blend after B. Karis, "High Quality Temporal Supersampling"
// (SIGGRAPH 2014 course); the depth rejection of history is Margo's.
// History is kept at the unjittered pixel centres, so it is fetched by the motion alone: the velocity buffer holds the
// jitter difference too (taa.velocity's documented contract), and the resolve takes it back out (`offset`). Fetching by
// the whole vector moved a still view's history by the jitter difference, up to 0.8 px, through a bilinear tap every
// frame: the history blurred and the clamp cut it back only in part, so 8 px stripes converged 10.5 sRGB levels off the
// supersampled mean (KB-TAA-CLAMP1). Repeated resampling blur: L. Yang, D. Nehab, P. V. Sander, P. Sitthi-amorn,
// J. Lawrence and H. Hoppe, "Amortized Supersampling" (ACM TOG 28(5), 2009); unjittered reprojection as in Karis 2014,
// L. J. F. Pedersen, "Temporal Reprojection Anti-Aliasing in INSIDE" (GDC 2016) and the survey of L. Yang, S. Liu and
// M. Salvi, "A Survey of Temporal Antialiasing Techniques" (Computer Graphics Forum 39(2), 2020).
const perTap =
  frame +
  color +
  `
@group(0) @binding(1) var scene:texture_2d<f32>;
@group(0) @binding(2) var velocity:texture_2d<f32>;
@group(0) @binding(3) var expected:texture_2d<f32>;
@group(0) @binding(4) var depth:texture_depth_2d;
@group(0) @binding(5) var history:texture_2d<f32>;
@group(0) @binding(6) var historyDepth:texture_2d<f32>;
@group(0) @binding(7) var output:texture_storage_2d<rgba16float,write>;
@group(0) @binding(8) var outputDepth:texture_storage_2d<r32float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u) {
  let size=textureDimensions(output);if(any(id.xy>=size)){return;}let p=vec2i(id.xy);let current=linear(textureLoad(scene,p,0).rgb);
  var lo=vec3f(1e30);var hi=vec3f(-1e30);for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
    let sample=ycocg(linear(textureLoad(scene,clamp(p+vec2i(x,y),vec2i(0),vec2i(size)-1),0).rgb));lo=min(lo,sample);hi=max(hi,sample);}}
  let uv=(vec2f(id.xy)+0.5)/vec2f(size)-textureLoad(velocity,p,0).xy+temporal.offset.xy;
  let previousDepth=textureLoad(expected,p,0).r;var result=current;
  if(temporal.settings.z>0&&previousDepth>=0&&previousDepth<=1&&all(uv>=vec2f(0))&&all(uv<vec2f(1))){
    let q=uv*vec2f(size)-0.5;let base=vec2i(floor(q));let fraction=fract(q);var old=vec3f(0);var total=0.0;
    for(var y=0;y<2;y++){for(var x=0;x<2;x++){let pixel=clamp(base+vec2i(x,y),vec2i(0),vec2i(size)-1);
      let d=textureLoad(historyDepth,pixel,0).r;let weight=select(1-fraction.x,fraction.x,x==1)*select(1-fraction.y,fraction.y,y==1);
      if(abs(d-previousDepth)<=max(0.000001,temporal.settings.y*max(d,previousDepth))){old+=textureLoad(history,pixel,0).rgb*weight;total+=weight;}}}
    if(total>0.001){result=mix(current,rgb(clamp(ycocg(old/total),lo,hi)),temporal.settings.x);}}
  textureStore(output,p,vec4f(max(result,vec3f(0)),1));textureStore(outputDepth,p,vec4f(textureLoad(depth,p,0)));}`;
// Silhouettes (KB-TAA-EDGE1): the motion and the expected depth are those of the nearest surface in the 3x3
// neighbourhood (closest-depth velocity dilation: B. Karis, "High Quality Temporal Supersampling", SIGGRAPH 2014; the
// depth and motion dilation stage of AMD's FidelityFX Super Resolution 2 documentation, 2022; the survey of L. Yang,
// S. Liu and M. Salvi, "A Survey of Temporal Antialiasing Techniques", Computer Graphics Forum 39(2), 2020), and
// history is kept when that surface's expected depth lies inside the depth range of the 3x3 history footprint round the
// reprojected point (the footprint test of upscale.ts, after the reverse-reprojection cache test of D. Nehab, P. V.
// Sander, J. Lawrence, N. Tatarchuk and J. R. Isidoro, "Accelerating Real-Time Shading with Reverse Reprojection
// Caching", Graphics Hardware 2007). Before, each pixel took its own motion and each bilinear tap was tested against its
// own expected depth: at a silhouette the jitter moves the edge across the pixel centre, so the pixel's surface, motion
// and expected depth changed from frame to frame, its history was dropped on alternate frames and the raw jittered
// sample showed: the edge alternated 3.3 sRGB levels a frame round a thin post (packages/taa/test/stability-browser.mjs,
// 5.3 on the WebGL2 layer) where TAAUpscale's footprint test alternates 0.2. A disocclusion (the reprojected surface
// absent from the whole footprint) is still rejected, and the colour clamp then removes what the footprint's other
// surface brings. Only neighbours whose expected depth is valid (0 to 1) are candidates, so a 4x silhouette pixel whose
// motion mean is a false depth (skySample) takes its neighbour's surface; with none valid the pixel rejects as before.
export const resolve = (() => {
  const own = `  let uv=(vec2f(id.xy)+0.5)/vec2f(size)-textureLoad(velocity,p,0).xy+temporal.offset.xy;
  let previousDepth=textureLoad(expected,p,0).r;var result=current;
`,
    tap = 'if(abs(d-previousDepth)<=max(0.000001,temporal.settings.y*max(d,previousDepth))){old+=',
    read = 'let d=textureLoad(historyDepth,pixel,0).r;';
  if ([own, tap, read].some((t) => perTap.split(t).length !== 2))
    throw new MargoError('state', 'TAA silhouette patch target missing; update resolve to the per-tap shader');
  return perTap
    .replace(
      own,
      `  var moved=p;var near=-1.0;for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){let q=clamp(p+vec2i(x,y),vec2i(0),vec2i(size)-1);
    let e=textureLoad(expected,q,0).r;if(e>=0&&e<=1&&e>near){near=e;moved=q;}}}
  let uv=(vec2f(id.xy)+0.5)/vec2f(size)-textureLoad(velocity,moved,0).xy+temporal.offset.xy;
  let previousDepth=textureLoad(expected,moved,0).r;var result=current;
  var depthLo=1e30;var depthHi=-1e30;{let c=vec2i(floor(uv*vec2f(size)));for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
    let h=textureLoad(historyDepth,clamp(c+vec2i(x,y),vec2i(0),vec2i(size)-1),0).r;depthLo=min(depthLo,h);depthHi=max(depthHi,h);}}}
  let footprint=max(depthLo-previousDepth,previousDepth-depthHi)<=max(0.000001,temporal.settings.y*max(depthHi,previousDepth));
`,
    )
    .replace(read, '')
    .replace(tap, 'if(footprint){old+=');
})();
// `stochastic` (TAAOptions): a surface cut by noise holds two depths per pixel, so history is accepted over the 3x3 depth
// range, and the nearest pixel there gives the motion.
export const stochasticResolve = () =>
  perTap
    .replace(
      `  let uv=(vec2f(id.xy)+0.5)/vec2f(size)-textureLoad(velocity,p,0).xy+temporal.offset.xy;
  let previousDepth=textureLoad(expected,p,0).r;var result=current;
`,
      `  var previousDepth=textureLoad(expected,p,0).r;var result=current;var far=previousDepth;var moved=p;
  for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){let q=clamp(p+vec2i(x,y),vec2i(0),vec2i(size)-1);
    let d=textureLoad(expected,q,0).r;far=min(far,d);if(d>previousDepth){previousDepth=d;moved=q;}}}
  let uv=(vec2f(id.xy)+0.5)/vec2f(size)-textureLoad(velocity,moved,0).xy+temporal.offset.xy;
`,
    )
    .replace(
      'if(abs(d-previousDepth)<=max(0.000001,temporal.settings.y*max(d,previousDepth))){old+=',
      'let slack=max(0.000001,temporal.settings.y*max(d,previousDepth));if(d>=far-slack&&d<=previousDepth+slack){old+=',
    );
export const present =
  fullscreen +
  `
override manualSRGB:bool=true;
@group(0) @binding(0) var image:texture_2d<f32>;
@fragment fn fragment(i:Fullscreen)->@location(0) vec4f {let c=max(textureLoad(image,vec2i(i.clip.xy),0).rgb,vec3f(0));
  return vec4f(select(c,select(c*12.92,1.055*pow(c,vec3f(1.0/2.4))-0.055,c>=vec3f(0.0031308)),manualSRGB),1);}`;

/**
 * A graph's move that reads its uniform block (`ndu`, a NodeMaterial positionNode changing over time) runs a second
 * time on last frame's block, `nduBefore` at `binding` of group 1, at last frame's model matrix, and the previous vertex
 * moves by that: the graph writes its own motion. Placed first, so the current move's varyings win.
 */
export function beforeMove(code: string, move: readonly string[], binding: number): string {
  const start = '{var o:Out;',
    shift = 'previousVertices[index*5].xyz+shift';
  if (code.split(start).length !== 2 || code.split(shift).length !== 2)
    throw new MargoError('state', 'TAA graph velocity patch target missing; use matching @margoengine/shader and taa');
  return (
    code
      .replace(
        start,
        start +
          'var margoBefore=i.position.xyz;{let margoWorld=(f.previousModel*vec4f(i.position.xyz,1)).xyz;' +
          'let margoWorldNormal=normalize((f.previousModel*vec4f(i.normal.xyz,0)).xyz);var margoPosition=i.position.xyz;\n' +
          move.join('\n').replaceAll('ndu.', 'nduBefore.').replaceAll('i.ndVertex', 'index') +
          '\nmargoBefore=margoPosition;}',
      )
      .replace(shift, 'previousVertices[index*5].xyz+margoBefore-i.position.xyz') +
    `\n@group(1) @binding(${binding}) var<uniform> nduBefore:NdUniforms;`
  );
}
/**
 * `reactive` (TAAOptions): binding 9 is a mask whose red channel, 0 to 1, takes that share of the history weight away
 * (1 keeps none), for pixels that change in ways motion vectors cannot describe: particles, blended surfaces, splats.
 * The mask is read at the pixel's place scaled to its own size, so a lower-resolution mask works. History alpha carries
 * each frame's mask to the next, so the pixels an effect left (its trail) distrust history too: max(now, before).
 * `reactAll` holds that share for the whole pixel, so settling (settle.ts) never holds a reactive pixel either.
 */
export function reactiveResolve(code: string): string {
  const targets = [
    '@group(0) @binding(8) var outputDepth:texture_storage_2d<r32float,write>;',
    'let current=linear(textureLoad(scene,p,0).rgb);',
    'var old=vec3f(0);var total=0.0;',
    'old+=textureLoad(history,pixel,0).rgb*weight;',
    'result=mix(current,rgb(clamp(ycocg(old/total),lo,hi)),temporal.settings.x);',
    'textureStore(output,p,vec4f(max(result,vec3f(0)),1));',
  ];
  if (targets.some((t) => code.split(t).length !== 2))
    throw new MargoError('state', 'TAA reactive patch target missing; update reactiveResolve to the resolve shader');
  const [binding, scene, taps, tap, blend, store] = targets;
  return code
    .replace(binding, binding + '\n@group(0) @binding(9) var reactiveMask:texture_2d<f32>;')
    .replace(
      scene,
      scene +
        'let maskSize=vec2f(textureDimensions(reactiveMask));' +
        'let react=clamp(textureLoad(reactiveMask,vec2i(min((vec2f(id.xy)+0.5)/vec2f(size)*maskSize,maskSize-1.0)),0).r,0.0,1.0);' +
        'var reactAll=react;',
    )
    .replace(taps, taps + 'var oldReact=0.0;')
    .replace(tap, 'let h=textureLoad(history,pixel,0);old+=h.rgb*weight;oldReact+=h.a*weight;')
    .replace(
      blend,
      'reactAll=max(react,oldReact/total);' +
        'result=mix(current,rgb(clamp(ycocg(old/total),lo,hi)),temporal.settings.x*(1.0-max(react,oldReact/total)));',
    )
    .replace(store, 'textureStore(output,p,vec4f(max(result,vec3f(0)),react));');
}

/**
 * `rejection: 'variance'` (TAAOptions): history is clipped toward the centre of the box mean +- gamma * sigma of the 3x3
 * neighbourhood in YCoCg (gamma in `temporal.settings.w`), cut to the min/max box, instead of clamped per axis to the
 * min/max box: one outlier pixel no longer opens the box for a ghost. After M. Salvi, "An Excursion in Temporal
 * Supersampling" (GDC 2016, variance clipping) and Karis 2014 (clipping toward the centre, not clamping).
 */
export function varianceResolve(code: string): string {
  const targets = [
    '@compute @workgroup_size(8,8)',
    'var lo=vec3f(1e30);var hi=vec3f(-1e30);',
    'lo=min(lo,sample);hi=max(hi,sample);',
    'clamp(ycocg(old/total),lo,hi)',
  ];
  if (targets.some((t) => code.split(t).length !== 2))
    throw new MargoError('state', 'TAA variance patch target missing; update varianceResolve to the resolve shader');
  const [entry, box, sample, clamp] = targets;
  return code
    .replace(
      entry,
      'fn clipHistory(h:vec3f,lo:vec3f,hi:vec3f,m1:vec3f,m2:vec3f)->vec3f {let mean=m1/9.0;' +
        'let sigma=sqrt(max(m2/9.0-mean*mean,vec3f(0)))*temporal.settings.w;let a=max(lo,mean-sigma);let b=min(hi,mean+sigma);' +
        'let centre=(a+b)*0.5;let extent=max((b-a)*0.5,vec3f(1e-6));let d=h-centre;' +
        'let t=max(abs(d.x)/extent.x,max(abs(d.y)/extent.y,abs(d.z)/extent.z));return select(h,centre+d/t,t>1.0);}\n' +
        entry,
    )
    .replace(box, box + 'var m1=vec3f(0);var m2=vec3f(0);')
    .replace(sample, sample + 'm1+=sample;m2+=sample*sample;')
    .replace(clamp, 'clipHistory(ycocg(old/total),lo,hi,m1,m2)');
}
/**
 * `locks` (TAAOptions): a pixel one pixel wide against its neighbours across x or y (a wire, a fence, a far edge: its
 * luminance differs from both by more than a quarter of its own) takes a lock that lasts eight frames, the Halton
 * cycle, renewed while the feature is seen and carried from the nearest accepted history tap. A locked pixel keeps its
 * history unclipped, so a feature the jitter misses on some frames does not flash. Bindings 10 and 11 read and write
 * the lock (r32float); rejected history, a disocclusion or a reactive pixel drops it. Margo-own design.
 */
export function lockResolve(code: string): string {
  const targets = [
    '@group(0) @binding(8) var outputDepth:texture_storage_2d<r32float,write>;',
    'var old=vec3f(0);var total=0.0;',
    'let current=linear(textureLoad(scene,p,0).rgb);',
    'if(total>0.001){',
    'textureStore(outputDepth,p,',
    'total+=weight;}',
  ];
  const kept = /(?:clamp|clipHistory)\(ycocg\(old\/total\),lo,hi(?:,m1,m2)?\)/;
  if (targets.some((t) => code.split(t).length !== 2) || code.split(kept).length !== 2)
    throw new MargoError('state', 'TAA lock patch target missing; update lockResolve to the resolve shader');
  const [binding, taps, scene, accepted, store, tap] = targets;
  const react = code.includes('reactiveMask') ? '*(1.0-max(react,oldReact/total))' : '';
  return code
    .replace(
      binding,
      binding +
        '\n@group(0) @binding(10) var lockHistory:texture_2d<f32>;\n@group(0) @binding(11) var lockOutput:texture_storage_2d<r32float,write>;',
    )
    .replace(
      scene,
      scene +
        'let lum=array<f32,4>(ycocg(linear(textureLoad(scene,clamp(p+vec2i(-1,0),vec2i(0),vec2i(size)-1),0).rgb)).x,' +
        'ycocg(linear(textureLoad(scene,clamp(p+vec2i(1,0),vec2i(0),vec2i(size)-1),0).rgb)).x,' +
        'ycocg(linear(textureLoad(scene,clamp(p+vec2i(0,-1),vec2i(0),vec2i(size)-1),0).rgb)).x,' +
        'ycocg(linear(textureLoad(scene,clamp(p+vec2i(0,1),vec2i(0),vec2i(size)-1),0).rgb)).x);' +
        'let centre=ycocg(current).x;let edge=0.25*max(centre,0.05);' +
        'let thin=centre-max(lum[0],lum[1])>edge||centre-max(lum[2],lum[3])>edge||min(lum[0],lum[1])-centre>edge||min(lum[2],lum[3])-centre>edge;' +
        'var lock=select(0.0,1.0,thin);',
    )
    .replace(taps, taps + 'var lockOld=0.0;var nearest=0.0;')
    .replace(tap, 'if(weight>nearest){nearest=weight;lockOld=textureLoad(lockHistory,pixel,0).r;}' + tap)
    .replace(accepted, accepted + 'lock=max(lock,lockOld-0.125)' + react + ';')
    .replace(kept, (m) => `select(${m},ycocg(old/total),lock>0.0)`)
    .replace(store, 'textureStore(lockOutput,p,vec4f(lock));' + store);
}
