/// <reference lib="esnext.disposable" preserve="true" />
import { Geometry, PbrMaterial, type EngineKernel } from '@margoengine/core';
export { ScatterInstances, type ScatterBatch } from './instances.js';
import { centroid, freeLocation, positiveColor } from './instances.js';
export { randomPlacements, radialPlacements } from './candidates.js';
export {
  PlacementLayout,
  spacePlacements,
  clearPlacements,
  placementBounds,
  instanceTransforms,
  groundTransforms,
  type GroundPlacement,
  type GroundBounds,
  type GroundCircle,
  type GroundPath,
  type Placement,
} from './placement.js';
import { windShader, validateWind, windClockRate, type ScatterWind } from './wind.js';
import {
  checkTextures,
  chainsOf,
  cutoffOf,
  interleave,
  texturedFragment,
  texturedShadow,
  texturedVertex,
  uploadChain,
  type MipChain,
  type ScatterTextures,
} from './maps.js';
export type { ScatterImage, ScatterTextures } from './maps.js';
import { translucencyShader } from './translucency.js';
import { fadeCode, pixelFootprint, poseShader } from './pose.js';
import { outsideLod } from './lod.js';
import { sameBindings, snapshotBindings } from './bindings.js';
export type { ScatterWind } from './wind.js';
export { WIND_THRASH_FROM, windClockRate } from './wind.js';
import { pathSegments, validateExclusions, type GroundBounds, type GroundPath } from './placement.js';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import { group, compute, dispatch } from '../../shared/gpu.js';
import { overlayDepthPass } from '../../shared/pass.js';
import { preset } from '../../shared/preset.js';
import { displayShader } from '../../shared/display.js';
import { MargoError } from '@margoengine/math/errors';
import { applyView } from '../../shared/view-rect.js';
import { loadCompatRoute } from '../../shared/compat.js';
import { coverBlend, coverCode, splitDeclaration } from './cover.js';
export { coverCode, coverDeclaration, splitDeclaration } from './cover.js';
import { OrderedCull, candidateShader } from './order.js';
import { unitLight } from '../../shared/unit-light.js';
import { linearHdr } from '../../shared/hdr-format.js';
declare const GPUBufferUsage: {
  VERTEX: number;
  INDEX: number;
  STORAGE: number;
  INDIRECT: number;
  UNIFORM: number;
  COPY_DST: number;
  COPY_SRC: number;
};
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };
type ScatterPassContext = Extract<PassContext, { backend: 'webgpu' }>;
const heightFormats = ['r32float', 'r16float', 'rgba32float', 'rgba16float', 'r8unorm'];
/** Grass-blade shading for GPU `Scatter` (see `ScatterOptions.blades`). */
export interface ScatterBlades {
  /** Albedo lost at the root, 0-1 (default 0.5): blades darken linearly from the tip (1) to the root (1 - rootShade). */
  rootShade?: number;
  /**
   * Extra blade width at the last LOD distance as a fraction, 0-10 (default 1: twice as wide), growing linearly with
   * distance from 0 at the camera. Thin distant blades otherwise fall below a pixel and shimmer.
   */
  widen?: number;
  /**
   * Sunlight seen through the blades, 0-1 (default 0): wrapped back-light translucency (Barre-Brisebois and Bouchard,
   * GDC 2011), as `ScatterInstances` foliage takes it. Blades glow against a low sun, so a field reads as thin leaves
   * instead of flat card. 1 matches the albedo's front-lit diffuse. 0 leaves the shader as it was.
   */
  translucency?: number;
}
/**
 * Colour spread for lit GPU `Scatter` and `ScatterTiles` (see `ScatterOptions.variation`). Each instance draws its two
 * random numbers from a hash of its world position, so its tint stays put across frames, culling and LOD rings.
 */
export interface ScatterVariation {
  /** Largest hue turn either way around the grey axis, as a fraction of the colour wheel, 0-0.5 (default 0). */
  hue?: number;
  /** Largest brightness change either way, 0-1 (default 0): the albedo scales by a factor from 1 - value to 1 + value. */
  value?: number;
}
/** GPU scatter rules, fixed at construction (out of range throws RangeError). Distances are world units. */
export interface ScatterOptions {
  /** Candidate instances on a stratified grid, an integer 1-1,000,000 (GPU memory: three buffers of this many). Default 10,000. */
  count?: number;
  /** XZ extent covered around `center`, each 0-100,000 (exclusive of 0). Default [50, 50]. */
  area?: readonly [number, number];
  /** World centre of the area; its Y is added to the heightmap. Default [0, 0, 0]. */
  center?: readonly [number, number, number];
  /** Fraction of candidates kept, 0..1. Default 1. */
  density?: number;
  /** Lowest world height that gets instances. Default -10,000. */
  minHeight?: number;
  /** Highest world height that gets instances, >= `minHeight`. Default 10,000. */
  maxHeight?: number;
  /** Steepest ground slope that gets instances, degrees 0-90. Default 45. */
  maxSlope?: number;
  /** Random uniform scale range [min, max], 0 < min <= max <= 100. Default [0.7, 1.3]. */
  scale?: readonly [number, number];
  /** Positive normal f32 distances, strictly increasing after upload; the third is the culling distance. Default [25, 60, 120]. */
  lod?: readonly [number, number, number];
  /**
   * Width of the dithered cross-fade between LOD meshes, in world units (default 2). 0 switches hard and compiles the
   * shaders without the fade's `discard`, which keeps early depth rejection on tile-based phone GPUs; one shared
   * Geometry for all rings does the same. The phone quality tier sets 0 when the app leaves it unset.
   */
  lodFade?: number;
  /** Placement seed, an integer 0..2^32-1. Default 1. */
  seed?: number;
  /** Diffuse colour (linear RGB 0..1) when no `material` is given. Default [0.12, 0.35, 0.08]. */
  color?: readonly [number, number, number];
  /** Shade instances with core's PBR shader (and receive PCSS shadows) instead of the simple diffuse colour. */
  material?: PbrMaterial;
  /**
   * Texture maps of the mesh (a scanned plant, bark or rock): base colour with an alpha cut-out (glTF MASK, also in the
   * shadow casters), a normal map and an occlusion-roughness-metal map, multiplied by `material` as glTF factors. See
   * {@link ScatterTextures}. Needs `material`. Default none: one material colour for the whole mesh. Cost: 8 more bytes
   * a vertex, three texture reads a pixel and, with a cut-out, a fragment stage in the shadow pass.
   */
  textures?: ScatterTextures;
  /** World XZ rectangles `[minX, minZ, maxX, maxZ]` kept free of instances (up to 1,000,000). */
  exclusions?: readonly GroundBounds[];
  /**
   * Ground paths kept free of instances (a road, track or river bed): each instance's footprint stays more than
   * `width / 2` from the path's centreline. `roadPath` from `@margoengine/road` gives a road's. Up to 1,000,000
   * segments in all. Default none.
   */
  paths?: readonly GroundPath[];
  /**
   * Red-channel height texture covering `area` around `center` (r32float, r16float, rgba32float, rgba16float or
   * r8unorm), read every frame. Default: flat ground.
   */
  heightmap?: () => GPUTexture | undefined;
  /**
   * Rooted wind bend `[directionX, directionZ, strength]`, or `[directionX, directionZ, strength, speed]` with the mean
   * wind in m/s at 10 m, which makes the plants thrash faster in a storm (`windClockRate`; a weather drive writes it).
   * Omitted: static.
   */
  wind?: ScatterWind;
  /**
   * How far each instance's up axis tilts from world +Y toward the ground normal, 0-1 (default 0, upright). 1 lays
   * stones and debris along the slope; grass and trees usually stay upright.
   */
  alignToGround?: number;
  /**
   * Lowers each instance by `sink * scale * (1 + tan(slope))` world units (default 0), so roots and stone bases stay
   * buried on the downhill side of steeper ground. The heightmap gives the slope.
   */
  sink?: number;
  /**
   * World units before the last LOD distance over which instances scale down to zero (default 0: cut at that
   * distance). Shrinking instead of cutting keeps the edge of a grass field from popping, without a fragment
   * `discard`; widths past the last distance are clamped to it.
   */
  edgeShrink?: number;
  /**
   * World units from the camera within which nothing is drawn (default 0: off), so another layer can take over nearby,
   * such as stored objects in front of far stand-ins. Instances keep their places and random numbers: those beyond
   * `inner + innerFade` are the same as without it. Measured in 3D, like the LOD distances; must be below the last one.
   */
  inner?: number;
  /**
   * World units past `inner` over which instances appear one by one instead of all at `inner` (default 0: a sharp
   * circle). Each instance takes its own start from a hash, so the band thins toward the camera and nothing changes size.
   */
  innerFade?: number;
  /**
   * Shades instances as grass blades: upright geometry whose local origin is the root and whose tallest vertex is the
   * tip (default off). Albedo darkens toward the root; the shading normal blends from the ground normal at the root to
   * the blade's own normal at the tip, and fully to the ground normal by the last LOD distance, so a field shades like
   * the terrain under it instead of speckling (after Wohllaib, GDC 2021); distant blades widen. `{}` uses the defaults.
   */
  blades?: ScatterBlades;
  /**
   * World rectangle `[minX, minZ, maxX, maxZ]` that `heightmap` and `densityMap` cover, instead of `area` around
   * `center` (default: none, the textures cover `area`). Needed with `follow`, whose area moves.
   */
  bounds?: readonly [number, number, number, number];
  /**
   * Red-channel density texture (0..1) over `bounds` that multiplies `density` per instance, such as a biome detail
   * map (default: none). Instances outside `bounds` are dropped.
   */
  densityMap?: () => GPUTexture | undefined;
  /**
   * Keeps the grid around the camera: `center` moves in whole grid cells every frame, and each instance's random
   * numbers come from its world cell, so instances stay where they are as the camera moves (default off). Needs
   * `bounds` when a `heightmap` or `densityMap` is given.
   */
  follow?: boolean;
  /**
   * Tints each instance from a hash of its world position (default none: every instance takes the material colour):
   * a hue turn of up to `hue` and a brightness change of up to `value` either way, so a forest of one mesh does not
   * read as one colour. Needs `material`. Cost: a few vertex operations; no extra binding.
   */
  variation?: ScatterVariation;
  /**
   * Cell size in mesh units for leaf-cluster shading (default 0: off). The mesh is cut into cubic cells; each vertex
   * is lightened or darkened by up to `variation.value` from a hash of its cell and its instance, and its normal bends
   * away from its cell's centre, so a canopy shades as clumps instead of one smooth blob. Needs `material`. Cost:
   * about ten vertex operations; the shadow pass is unchanged.
   */
  clusters?: number;
  /**
   * Per-instance plant states (default none): a source from `@margoengine/scatter/states` (`PlantStates.plant()`)
   * that scorches, chars, strips, mud-coats, stains and flattens each instance from the state map at its root, in the
   * colour and shadow passes alike. Colour treatments need `material`; the shape treatments work on any Scatter.
   */
  states?: ScatterStateSource;
}
/**
 * What `ScatterOptions.states` takes: code for every posing vertex stage reading `entries()` from `binding` on in bind
 * group `group`, and an update recorded once a frame before the distribute pass. Made by `PlantStates.plant()`.
 */
export interface ScatterStateSource {
  poseCode(code: string, group: number, binding: number): string;
  entries(device: GPUDevice): { buffer: GPUBuffer }[];
  update(context: { device: GPUDevice; encoder: GPUCommandEncoder }): void;
}
const frame = `
struct Frame {camera:mat4x4f,eye:vec4f,area:vec4f,rules:vec4f,scale:vec4f,lod:vec4f,ids:vec4u,color:vec4f,planes:array<vec4f,6>,wind:vec4f,ground:vec4f,blade:vec4f,pixel:vec4f}
struct Instance {position:vec4f,rotation:vec4f}
@group(0) @binding(0) var<uniform> frame:Frame;
`;
const cull =
  frame +
  `
@group(0) @binding(1) var terrain:texture_2d<f32>;
@group(0) @binding(2) var<storage,read_write> near:array<Instance>;
@group(0) @binding(3) var<storage,read_write> middle:array<Instance>;
@group(0) @binding(4) var<storage,read_write> far:array<Instance>;
struct Command {indices:u32,count:atomic<u32>,first:u32,base:u32,instance:u32}
@group(0) @binding(5) var<storage,read_write> commands:array<Command,3>;
@group(0) @binding(6) var<storage,read> exclusions:array<vec4f>;
fn hash(value:u32)->f32 {var x=value^frame.ids.y;x=(x^(x>>16u))*0x7feb352du;x=(x^(x>>15u))*0x846ca68bu;x=x^(x>>16u);return f32(x)/4294967296.0;}
fn height(p:vec2i)->f32 {return textureLoad(terrain,clamp(p,vec2i(0),vec2i(textureDimensions(terrain))-1),0).r;}
fn emit(ring:u32,instance:Instance){
 let slot=atomicAdd(&commands[ring].count,1u);
 if(ring==0u){near[slot]=instance;}else if(ring==1u){middle[slot]=instance;}else{far[slot]=instance;}
}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
 let i=id.x;if(i>=frame.ids.x||hash(i*7u+1u)>frame.rules.w){return;}
 let columns=frame.ids.z;let rows=(frame.ids.x+columns-1u)/columns;
 let uv=vec2f((f32(i%columns)+hash(i*7u+2u))/f32(columns),(f32(i/columns)+hash(i*7u+3u))/f32(rows));
 // Texels hold cell-centre heights: interpolate the four centres around the instance (a nearest read is off by half a
 // cell times the slope), and take the normal from the same bilinear patch's gradient.
 let size=vec2i(textureDimensions(terrain));let texel=uv*vec2f(size)-0.5;let cell=vec2i(floor(texel));let f=texel-floor(texel);
 let h00=height(cell);let h10=height(cell+vec2i(1,0));let h01=height(cell+vec2i(0,1));let h11=height(cell+vec2i(1,1));
 let h=mix(mix(h00,h10,f.x),mix(h01,h11,f.x),f.y)+frame.scale.z;
 let normal=normalize(vec3f(-mix(h10-h00,h11-h01,f.y)*f32(size.x)/frame.area.x,1.0,-mix(h01-h00,h11-h10,f.x)*f32(size.y)/frame.area.y));
 if(h<frame.rules.x||h>frame.rules.y||normal.y<frame.rules.z){return;}
 let scale=mix(frame.scale.x,frame.scale.y,hash(i*7u+4u));let radius=frame.lod.w*scale;
 // Sink deeper on slopes: tan(slope) is how far the ground falls per unit of footprint.
 let p=vec3f((uv.x-0.5)*frame.area.x+frame.area.z,h-frame.ground.y*scale*(1.0+length(normal.xz)/max(normal.y,0.2)),(uv.y-0.5)*frame.area.y+frame.area.w);
 for(var j=0u;j<u32(frame.eye.w);j++){
  let bounds=exclusions[j];let offset=p.xz-clamp(p.xz,bounds.xy,bounds.zw);
  if(dot(offset,offset)<=radius*radius){return;}
 }
 for(var j=0u;j<6u;j++){if(dot(frame.planes[j].xyz,p)+frame.planes[j].w < -radius){return;}}
 let d=distance(p,frame.eye.xyz);if(${outsideLod('d', 'frame.lod.z')}){return;}
 // edgeShrink: scale toward zero approaching the cull distance instead of cutting there.
 let shrink=select(1.0,clamp((frame.lod.z-d)/frame.ground.z,0.0,1.0),frame.ground.z>0.0);
 let angle=hash(i*7u+5u)*6.2831853;let q=round((normal.xz*0.5+0.5)*4095.0);
 var instance=Instance(vec4f(p,scale*shrink),vec4f(angle,q.x+q.y*4096.0,0,0));
 for(var ring=0u;ring<2u;ring++){
  if((frame.ids.w&(1u<<ring))!=0u&&frame.scale.w>0.0&&abs(d-frame.lod[ring])<frame.scale.w*0.5){
   instance.rotation.z=(d-frame.lod[ring])/frame.scale.w+0.5;instance.rotation.w=1.0;emit(ring,instance);
   instance.rotation.w=2.0;emit(ring+1u,instance);return;
  }
 }
 emit(select(select(2u,1u,d<frame.lod.y),0u,d<frame.lod.x),instance);
}`;
const renderCode =
  frame +
  fadeCode +
  windShader +
  poseShader +
  `
@group(0) @binding(1) var<storage,read> instances:array<Instance>;
struct Output {@builtin(position) clip:vec4f,@location(0) normal:vec3f,@location(1) @interpolate(flat) lodFade:vec2f,@location(2) ${centroid} ground:vec4f,@location(3) ${centroid} shade:f32}
@vertex fn vertex(@location(0) p:vec3f,@location(1) n:vec3f,@builtin(instance_index) index:u32)->Output{
 let data=instances[index];let pose=scatterPose(p,n,data.position,data.rotation,frame.ground,frame.blade,frame.eye.xyz,frame.wind,frame.pixel.x);
 return Output(frame.camera*vec4f(pose.world,1),pose.normal,data.rotation.zw,pose.ground,pose.shade);
}
${displayShader}
@fragment fn fragment(i:Output,@builtin(front_facing) front:bool)->@location(0) vec4f {if(!lodVisible(i.clip.xy,i.lodFade)){discard;}let n=normalize(mix(normalize(i.normal)*select(-1.0,1.0,front),i.ground.xyz,i.ground.w));var color=frame.color.rgb*i.shade*(0.25+max(0.0,dot(n,normalize(vec3f(1,2,1))))*0.75);if(frame.color.w<0.5){color=toDisplay(color);}return vec4f(color,1);}
`;
// Without a LOD fade no instance is ever dithered out, yet any `discard` in a fragment shader stops tile-based (phone)
// GPUs from rejecting hidden fragments before shading. This variant has no fade varying, no mask and no discard.
const solidCode = renderCode
  .replace(fadeCode, '')
  .replace(',@location(1) @interpolate(flat) lodFade:vec2f', '')
  .replace(',data.rotation.zw,', ',')
  .replace('if(!lodVisible(i.clip.xy,i.lodFade)){discard;}', '');
/**
 * WGSL of `variation` and `clusters`: an integer hash to 0..1 (the cull pass's mixer over three keys) and a hue turn
 * about the grey axis (Rodrigues; a turn of 0 returns the colour unchanged).
 */
const lookShader = `
fn scatterHash(v:vec3u)->f32 {var x=(v.x*0x8da6b343u)^(v.y*0xd8163841u)^(v.z*0xcb1ab31fu);x=(x^(x>>16u))*0x7feb352du;x=(x^(x>>15u))*0x846ca68bu;x=x^(x>>16u);return f32(x)/4294967296.0;}
fn scatterHue(c:vec3f,turn:f32)->vec3f {let k=vec3f(0.57735027);let a=turn*6.2831853;return max(c*cos(a)+cross(k,c)*sin(a)+k*dot(k,c)*(1.0-cos(a)),vec3f(0));}
`;
/**
 * The `variation` and `clusters` vertex code, before the pose: `tint` is the instance's colour, and with clusters
 * `bent` the cell-shaded normal. The key is the instance's quarter-unit world XZ cell, so it survives culling and the
 * LOD rings; uniform slots: hue in material[0].w, value in material[1].w, cell size in material[3].w (ground.w).
 */
const lookCode = (clusters: boolean) =>
  'let key=vec3u(bitcast<vec2u>(vec2i(floor(data.position.xz*4.0))),1u);' +
  'var tint=scatterHue(material[0].rgb,(scatterHash(key)*2.0-1.0)*material[0].w)*(1.0+(scatterHash(key+vec3u(0,0,1u))*2.0-1.0)*material[1].w);' +
  (clusters
    ? 'let cell=floor(p/material[3].w);let away=p-(cell+0.5)*material[3].w;' +
      'tint*=1.0+(scatterHash(bitcast<vec3u>(vec3i(cell))+key*31u)*2.0-1.0)*material[1].w;' +
      'let bent=normalize(n+away*(0.5/max(length(away),1e-6)));'
    : '');
/**
 * Lit vertex stage: `fade` writes the LOD fade varying, `blades` the root shade and the ground-normal varying, `tint`
 * the `variation` colour and `clusters` the cluster shade and normal. Without `tint` and `clusters` the text is the
 * original, byte for byte.
 */
const pbrVertex = (fade: boolean, blades: boolean, tint = false, clusters = false, translucent = false) =>
  windShader +
  poseShader +
  (tint ? lookShader : '') +
  `
struct ScatterInstance {position:vec4f,rotation:vec4f}
@group(1) @binding(0) var<storage,read> instances:array<ScatterInstance>;
@group(1) @binding(1) var<uniform> material:array<vec4f,6>;
@vertex fn vertex(@location(0) p:vec3f,@location(1) n:vec3f,@builtin(instance_index) index:u32)->Output {
 let data=instances[index];${tint ? lookCode(clusters) : ''}let pose=scatterPose(p,${clusters ? 'bent' : 'n'},data.position,data.rotation,material[3],material[4],frame.eye.xyz,material[2],material[5].y);
 var o:Output;o.position=pose.world;o.clip=frame.camera*vec4f(o.position,1);o.normal=pose.normal;
 o.color=${tint ? 'tint' : 'material[0].rgb'}${blades ? '*pose.shade' : ''};o.material=vec4f(material[1].xyz,1);${fade ? 'o.lodFade=data.rotation.zw;' : ''}${blades ? 'o.ground=pose.ground;' : ''}${translucent ? 'o.transl=material[5].x;' : ''}return o;
}
`;
// Depth only, for one shadow cascade: the colour pass's pose and wind (frame values 16-19 and 68-79), the light's
// matrix in place of the camera's. Each LOD ring's culled instances are drawn with that ring's mesh.
const shadowCode =
  windShader +
  poseShader +
  `
struct ShadowFrame {light:mat4x4f,eye:vec4f,wind:vec4f,ground:vec4f,blade:vec4f}
struct Instance {position:vec4f,rotation:vec4f}
@group(0) @binding(0) var<uniform> frame:ShadowFrame;
@group(0) @binding(1) var<storage,read> instances:array<Instance>;
@vertex fn vertex(@location(0) p:vec3f,@location(1) n:vec3f,@builtin(instance_index) index:u32)->@builtin(position) @invariant vec4f {
 let data=instances[index];
 return frame.light*vec4f(scatterPose(p,n,data.position,data.rotation,frame.ground,frame.blade,frame.eye.xyz,frame.wind,frame.eye.w).world,1);
}
`;
// The same, drawing only the instances the cascade's list names (see `shadowCullCode`).
const shadowListCode = shadowCode
  .replace('@vertex', '@group(0) @binding(2) var<storage,read> list:array<u32>;\n@vertex')
  .replace('instances[index]', 'instances[list[index]]');
// Per shadow cascade and LOD ring: the camera-culled instances that can reach the cascade, and their draw counts. A posed
// instance stays inside a sphere around its root of the distribute pass's radius per unit scale (frame value 35: the
// meshes' reach, doubled for wind, widened for blades) times its scale. A sphere wholly outside one of the six clip
// planes of a cascade's light matrix (rows w + x, w - x, w + y, w - y, z and w - z) clips away entirely there, so
// leaving it out keeps the cascade's depth. The radius is padded for float32 rounding; order is free in a depth pass.
// u.size: (cascades, radius); u.lists: each ring's offset in a cascade's list and the cascade stride.
const shadowCullCode = `
struct Cull {light:array<mat4x4f,4>,lists:vec4u,size:vec4f}
@group(0) @binding(0) var<uniform> u:Cull;
@group(0) @binding(1) var<storage,read> counts:array<u32,15>;
@group(0) @binding(2) var<storage,read> near:array<vec4f>;
@group(0) @binding(3) var<storage,read> middle:array<vec4f>;
@group(0) @binding(4) var<storage,read> far:array<vec4f>;
@group(0) @binding(5) var<storage,read_write> lists:array<u32>;
@group(0) @binding(6) var<storage,read_write> commands:array<atomic<u32>>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
 let ring=id.y;let i=id.x;if(i>=counts[ring*5u+1u]){return;}
 var p:vec4f;if(ring==0u){p=near[i*2u];}else if(ring==1u){p=middle[i*2u];}else{p=far[i*2u];}
 let r=u.size.y*p.w;let radius=r+1e-5*(length(p.xyz)+r);
 for(var c=0u;c<u32(u.size.x);c++){
  let m=transpose(u.light[c]);var planes=array(m[3]+m[0],m[3]-m[0],m[3]+m[1],m[3]-m[1],m[2],m[3]-m[2]);var k=0u;
  while(k<6u&&dot(planes[k].xyz,p.xyz)+planes[k].w>=-radius*length(planes[k].xyz)){k++;}
  if(k==6u){lists[c*u.lists.w+u.lists[ring]+atomicAdd(&commands[(c*3u+ring)*5u+1u],1u)]=i;}
 }
}`;
/** The depth-only pipeline of a shadow vertex shader (24-byte core vertices). */
function shadowDepth(d: GPUDevice, code: string, uvs = false): GPURenderPipeline {
  const module = d.createShaderModule({ code });
  return d.createRenderPipeline({
    layout: 'auto',
    vertex: {
      module,
      entryPoint: 'vertex',
      buffers: [
        {
          arrayStride: uvs ? 32 : 24,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32x3' },
            ...(uvs ? [{ shaderLocation: 2, offset: 24, format: 'float32x2' as const }] : []),
          ],
        },
      ],
    },
    ...(code.includes('@fragment') ? { fragment: { module, entryPoint: 'fragment', targets: [] } } : {}),
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less-equal' },
  });
}
/** Whether the frame carries the world-rectangle fields (follow offsets and bounds). */
const extended = (o: ScatterOptions) => !!(o.bounds || o.follow || o.densityMap || o.inner);

function validateWorld(o: ScatterOptions): void {
  const b = o.bounds;
  if (
    b !== undefined &&
    (!Array.isArray(b) || b.length !== 4 || !b.every(Number.isFinite) || b[2] <= b[0] || b[3] <= b[1])
  )
    throw new RangeError('Scatter bounds must be a world rectangle [minX, minZ, maxX, maxZ] with max above min');
  if (o.densityMap !== undefined && typeof o.densityMap !== 'function')
    throw new TypeError('Scatter densityMap must be a function returning a GPUTexture');
  if (o.densityMap && !b) throw new RangeError('Scatter densityMap needs bounds: the world rectangle it covers');
  if (o.follow && o.heightmap && !b)
    throw new RangeError('Scatter follow with a heightmap needs bounds: the rectangle it covers');
}

/**
 * The distribute shader for a set of options. Without bounds, densityMap, follow, inner and paths it is the original
 * text, byte for byte; each option rewrites only its own part.
 */
export function scatterCullShader(o: ScatterOptions): string {
  const code = optionShader(o);
  return o.paths?.length ? code.replace(PLANES, PATHS + PLANES) : code;
}

// Ground paths (GAP-FILM-LOOK): segments (a, b) and their half width follow the rectangles in the exclusions buffer,
// two entries each, and their count is ids.w >> 8; only a scatter with paths carries the loop. The test is the point
// to segment distance (C. Ericson, "Real-Time Collision Detection", 2005, 5.1.2) against half width plus radius.
const PLANES = ' for(var j=0u;j<6u;j++){if(dot(frame.planes[j].xyz,p)+frame.planes[j].w < -radius){return;}}',
  PATHS = ` for(var j=0u;j<(frame.ids.w>>8u);j++){
  let at=u32(frame.eye.w)+2u*j;let s=exclusions[at];let keep=exclusions[at+1u].x+radius;
  let ab=s.zw-s.xy;let ap=p.xz-s.xy;let o=ap-ab*clamp(dot(ap,ab)/max(dot(ab,ab),1e-20),0.0,1.0);
  if(dot(o,o)<=keep*keep){return;}
 }
`;

function optionShader(o: ScatterOptions): string {
  if (!extended(o)) return cull;
  let code = cull.replace('pixel:vec4f}', 'pixel:vec4f,offset:vec4f,bounds:vec4f}');
  if (o.follow)
    // Random numbers from the world cell (grid cell plus the camera's cell offset), not the instance index.
    code = code
      .replace(
        'let i=id.x;if(i>=frame.ids.x||hash(i*7u+1u)>frame.rules.w){return;}',
        'let i=id.x;if(i>=frame.ids.x){return;}let key=(bitcast<u32>(i32(i%frame.ids.z)+i32(frame.offset.x))*0x9e3779b1u)^(bitcast<u32>(i32(i/frame.ids.z)+i32(frame.offset.y))*0x85ebca77u);if(hash(key*7u+1u)>frame.rules.w){return;}',
      )
      .replaceAll('hash(i*7u+', 'hash(key*7u+');
  if (o.bounds) {
    // Height and normal read the textures over the world rectangle at the instance's world position.
    code = code
      .replace(
        'let texel=uv*vec2f(size)-0.5;',
        'let world=vec2f((uv.x-0.5)*frame.area.x+frame.area.z,(uv.y-0.5)*frame.area.y+frame.area.w);let texel=(world-frame.bounds.xy)/(frame.bounds.zw-frame.bounds.xy)*vec2f(size)-0.5;',
      )
      .replace('*f32(size.x)/frame.area.x', '*f32(size.x)/(frame.bounds.z-frame.bounds.x)')
      .replace('*f32(size.y)/frame.area.y', '*f32(size.y)/(frame.bounds.w-frame.bounds.y)');
  }
  if (o.densityMap)
    code = code
      .replace(
        '@group(0) @binding(6) var<storage,read> exclusions:array<vec4f>;',
        '@group(0) @binding(6) var<storage,read> exclusions:array<vec4f>;\n@group(0) @binding(7) var densityMap:texture_2d<f32>;',
      )
      .replace(
        ' for(var j=0u;j<u32(frame.eye.w);j++){',
        ` let dm=(p.xz-frame.bounds.xy)/(frame.bounds.zw-frame.bounds.xy);if(any(dm<vec2f(0.0))||any(dm>=vec2f(1.0))){return;}\n if(hash(${o.follow ? 'key' : 'i'}*7u+6u)>=textureLoad(densityMap,vec2i(dm*vec2f(textureDimensions(densityMap))),0).r){return;}\n for(var j=0u;j<u32(frame.eye.w);j++){`,
      );
  if (o.inner)
    // Slot 7 of the instance's hashes is its own (slots 1 to 6 are placement); offset.z is inner, offset.w the band.
    code = code.replace(
      `if(${outsideLod('d', 'frame.lod.z')}){return;}`,
      `if(${outsideLod('d', 'frame.lod.z')}||d<frame.offset.z+frame.offset.w*hash(${o.follow ? 'key' : 'i'}*7u+7u)){return;}`,
    );
  return code;
}

const coreNormal = 'let n=normalize(i.normal)*select(-1.0,1.0,facing);';
let serial = 0;
/**
 * GPU-distributed ground cover: seeded, stratified placement under density, height and slope rules, compute-culled
 * every frame into three distance LOD rings drawn with indexed indirect draws. Pass one Geometry or one per ring
 * (near, middle, far). `Scatter.attach(engine, geometry, options)`; WebGPU only.
 * @throws RangeError when an option is out of range (constructor) or the buffers exceed device limits (attach);
 * TypeError when `material` is not a core PbrMaterial or `blades` or `variation` is not an object.
 * @throws MargoError `'unsupported'` on a WebGL engine, `'disposed'` after `dispose()`, `'state'` during a frame when
 * the heightmap is not a sampleable height texture.
 */
export class Scatter implements EnginePlugin {
  readonly name = 'scatter:' + ++serial;
  protected engine?: Engine;
  protected uniform?: GPUBuffer;
  protected instances: GPUBuffer[] = [];
  private vertices: GPUBuffer[] = [];
  private indices: GPUBuffer[] = [];
  protected commands?: GPUBuffer;
  protected fallback?: GPUTexture;
  protected compute?: GPUComputePipeline;
  private pipelines = new Map<string, GPURenderPipeline>();
  protected readonly values: Float32Array;
  /** The cull reach before the wind allowance (the meshes' reach, widened for blades); `values[35]` is this, doubled while a wind is set. */
  protected reach = 0;
  protected readonly meta: Uint32Array;
  protected readonly geometries: readonly Geometry[];
  #disposed = false;
  /** True after `dispose()` (a `Shadows` then drops this caster). */
  get disposed(): boolean {
    return this.#disposed;
  }
  readonly count: number;
  private readonly materialValues = new Float32Array(24);
  private seconds = 0;
  private windClock = 0;
  protected terrain?: GPUTexture;
  protected computeGroup?: GPUBindGroup;
  private readonly renderGroups = new Map<GPURenderPipeline, GPUBindGroup[]>();
  private exclusionBuffer?: GPUBuffer;
  private readonly exclusionValues: Float32Array;
  private pbrUniform?: GPUBuffer;
  private materialUniform?: GPUBuffer;
  /** `textures`: each ring's uvs, the cut-off, the mip chains (kept for a device restore) and the uploaded maps. */
  private readonly uvs?: Float32Array[];
  private readonly cut: number = 0;
  private chains?: { base: MipChain; normal: MipChain; orm: MipChain };
  private maps?: { textures: GPUTexture[]; groups: Map<GPURenderPipeline, GPUBindGroup>; sampler: GPUSampler };
  private readonly pbrValues = new Float32Array(32);
  private pbrShader = '';
  // Core's frame state before any plugin patches it, read by a pass at the lowest order.
  private readonly base: { shader: string; format: string; descriptor?: GPURenderPipelineDescriptor } = {
    shader: '',
    format: '',
  };
  private pbrBindings: GPUBindGroupEntry[] = [];
  private readonly pbrGroups = new Map<GPURenderPipeline, GPUBindGroup>();
  private readonly presentation = overlayDepthPass();
  private readonly attachment = this.presentation.colorAttachments[0];
  private readonly depthAttachment = this.presentation.depthStencilAttachment;
  /** The options it was built with, after its preset: read by `applyScatterSettings` (which rows apply). */
  readonly options: ScatterOptions;
  private shadowPipeline?: GPURenderPipeline;
  /** Per cascade: its uniform (light matrix and pose values) and one bind group per LOD ring. */
  private shadowUniforms: GPUBuffer[] = [];
  private readonly shadowGroups: GPUBindGroup[][] = [];
  private readonly shadowValues = new Float32Array(32);
  /**
   * Per-cascade culling (`prepareShadow`): the ring buffers and cascade count its lists were made for, the lists and
   * indirect draws (none when too large to bind), the draw bind groups, and the frame's encoder once it culled.
   */
  private cascadeCull?: {
    rings: GPUBuffer[];
    cascades: number;
    lists?: GPUBuffer;
    commands?: GPUBuffer;
    group?: GPUBindGroup;
    draws: GPUBindGroup[][];
    threads: number;
    encoder?: GPUCommandEncoder;
  };
  private cullPipeline?: GPUComputePipeline;
  private listPipeline?: GPURenderPipeline;
  private cullUniform?: GPUBuffer;
  /** Four light matrices, then each ring's list offset and the cascade stride (u32), then cascades and radius. */
  private readonly cullValues = new Float32Array(72);
  private readonly listOffsets = new Uint32Array(this.cullValues.buffer, 256, 4);
  /** On the WebGL2 layer, once loaded: the kernels as point draws on the GPU and draws without a read-back (./compat.js). */
  private route?: import('./compat.js').ScatterRoute;
  /** Whether any instance can fade between LOD meshes: shaders keep the dither `discard` only then. */
  private readonly fade: boolean;
  /** `blades.translucency`, read from the material uniform once the lit shader has the stage (0: the shader as it was). */
  private translucency = 0;
  /** The cull reach before `blades.widen` widens it, and the last LOD distance the blades widen toward. */
  private bladeReach = 0;
  private lodEnd = 1;
  /** `variation` hue and value; both 0 (and no `clusters`) keep the original lit vertex stage. */
  private tint: readonly [number, number];
  constructor(geometry: Geometry | readonly [Geometry, Geometry, Geometry], input: ScatterOptions = {}) {
    this.options = preset('scatter', input);
    const options = this.options;
    // The world-rectangle options extend the frame by two vec4s (follow offsets, bounds) after the pixel footprint (80).
    this.values = new Float32Array(extended(options) ? 92 : 84);
    this.meta = new Uint32Array(this.values.buffer);
    this.geometries = geometry instanceof Geometry ? [geometry, geometry, geometry] : [...geometry];
    const {
      count = 10000,
      area = [50, 50],
      center = [0, 0, 0],
      density = 1,
      minHeight = -10000,
      maxHeight = 10000,
      maxSlope = 45,
      scale = [0.7, 1.3],
      lod = [25, 60, 120],
      lodFade = 2,
      seed = 1,
      color = [0.12, 0.35, 0.08],
      alignToGround = 0,
      sink = 0,
      edgeShrink = 0,
      inner = 0,
      innerFade = 0,
    } = options;
    if (
      this.geometries.length !== 3 ||
      this.geometries.some((g) => !(g instanceof Geometry)) ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > 1000000 ||
      area.length !== 2 ||
      area.some((v) => !Number.isFinite(v) || v <= 0 || v > 100000) ||
      center.length !== 3 ||
      center.some((v) => !Number.isFinite(Math.fround(v))) ||
      ![density, minHeight, maxHeight, maxSlope].every(Number.isFinite) ||
      density < 0 ||
      density > 1 ||
      minHeight > maxHeight ||
      maxSlope < 0 ||
      maxSlope > 90 ||
      scale.length !== 2 ||
      scale.some((v) => !Number.isFinite(v) || v <= 0 || v > 100) ||
      scale[0] > scale[1] ||
      lod.length !== 3 ||
      Array.from(lod).some(
        (v, i) =>
          !Number.isFinite(v) ||
          Math.fround(v) < 2 ** -126 ||
          v > 100000 ||
          (i > 0 && Math.fround(v) <= Math.fround(lod[i - 1])),
      ) ||
      !Number.isInteger(seed) ||
      seed < 0 ||
      seed > 0xffffffff ||
      color.length !== 3 ||
      color.some((v) => !Number.isFinite(v) || v < 0 || v > 1) ||
      (options.heightmap !== undefined && typeof options.heightmap !== 'function')
    )
      throw new RangeError(
        'Invalid scatter rules; check density 0-1, minHeight <= maxHeight, maxSlope 0-90, scale [min, max] up to 100, three positive normal f32 lod distances increasing after upload, an integer seed, color 0-1 and a heightmap function.',
      );
    if (options.material !== undefined && !(options.material instanceof PbrMaterial))
      throw new TypeError('Expected a PBR scatter material');
    if (options.textures !== undefined) {
      if (!options.material)
        throw new RangeError('Scatter textures shade through a material; pass material: new PbrMaterial()');
      this.uvs = checkTextures(
        options.textures,
        this.geometries.map((g) => g.vertices.length / 6),
      );
      this.cut = cutoffOf(options.textures);
    }
    if (!Number.isFinite(lodFade) || lodFade < 0 || lodFade > 100000)
      throw new RangeError('Invalid scatter LOD fade; set lodFade to a finite number from 0 to 100000.');
    if (
      ![alignToGround, sink].every(Number.isFinite) ||
      alignToGround < 0 ||
      alignToGround > 1 ||
      sink < 0 ||
      sink > 100000
    )
      throw new RangeError('Scatter alignToGround must be 0-1 and sink a distance from 0 to 100000');
    if (!Number.isFinite(edgeShrink) || edgeShrink < 0 || edgeShrink > 100000)
      throw new RangeError('Scatter edgeShrink must be a distance from 0 to 100000');
    if (!Number.isFinite(inner) || inner < 0 || inner >= lod[2] || !Number.isFinite(innerFade) || innerFade < 0)
      throw new RangeError('Scatter inner must be a distance from 0 up to below the last lod, innerFade 0 or more');
    if (options.wind) validateWind(options.wind);
    validateWorld(options);
    if (options.bounds) this.values.set(options.bounds, 88);
    if (inner) this.values.set([inner, innerFade], 86);
    const exclusions = options.exclusions ?? [],
      segments = pathSegments(options.paths ?? []);
    validateExclusions(exclusions);
    this.exclusionValues = new Float32Array(Math.max(1, exclusions.length + 2 * segments.length) * 4);
    for (let i = 0; i < exclusions.length; i++) this.exclusionValues.set(exclusions[i], i * 4);
    for (let i = 0; i < segments.length; i++) {
      const at = (exclusions.length + 2 * i) * 4;
      this.exclusionValues.set(segments[i].slice(0, 4), at);
      this.exclusionValues[at + 4] = segments[i][4];
    }
    this.values[19] = exclusions.length; // eye.w holds the fixed exclusion count.
    this.count = count;
    this.values.set(
      [
        area[0],
        area[1],
        center[0],
        center[2],
        minHeight,
        maxHeight,
        Math.cos((maxSlope * Math.PI) / 180),
        density,
        scale[0],
        scale[1],
        center[1],
        0,
        ...lod,
        Math.max(...this.geometries.map((g) => g.bounds[3] + Math.hypot(g.bounds[0], g.bounds[1], g.bounds[2]))),
      ],
      20,
    );
    this.values[31] = Math.min(lodFade, 2 * lod[0], lod[1] - lod[0], 2 * (lod[2] - lod[1]));
    this.meta.set(
      [
        count,
        seed,
        Math.ceil(Math.sqrt((count * area[0]) / area[1])),
        +(this.geometries[0] !== this.geometries[1]) + 2 * +(this.geometries[1] !== this.geometries[2]),
      ],
      36,
    );
    this.meta[39] |= segments.length << 8; // ids.w: ring fade bits 0 and 1, path segment count above them
    this.values.set(color, 40);
    this.values[72] = alignToGround;
    this.values[73] = sink;
    this.values[74] = Math.min(edgeShrink, lod[2]);
    const { blades } = options;
    if (blades !== undefined) {
      if (typeof blades !== 'object' || blades === null)
        throw new TypeError('Scatter blades must be an options object');
      const { rootShade = 0.5, widen = 1, translucency = 0 } = blades;
      if (
        ![rootShade, widen, translucency].every(Number.isFinite) ||
        rootShade < 0 ||
        rootShade > 1 ||
        widen < 0 ||
        widen > 10 ||
        translucency < 0 ||
        translucency > 1
      )
        throw new RangeError('Scatter blades need rootShade 0-1 and widen 0-10, and translucency 0-1');
      this.translucency = translucency;
      this.lodEnd = lod[2];
      this.bladeReach = this.values[35];
      let top = 0;
      for (const g of this.geometries)
        for (let i = 1; i < g.vertices.length; i += 6) top = Math.max(top, g.vertices[i]);
      if (!(top > 0)) throw new RangeError('Scatter blades need meshes that rise above their local origin (the root)');
      this.values.set([rootShade, widen / lod[2], 1 / top, 1 / lod[2]], 76);
      this.values[35] *= 1 + widen; // cull bounds include the widest blades
    }
    this.reach = this.values[35];
    this.values[35] = this.reach * (options.wind ? 2 : 1); // applyReach, which a subclass overrides, is not callable before its fields exist
    const states = options.states;
    if (
      states !== undefined &&
      (typeof states?.poseCode !== 'function' ||
        typeof states.entries !== 'function' ||
        typeof states.update !== 'function')
    )
      throw new TypeError('Scatter states must be a source from PlantStates.plant() in @margoengine/scatter/states');
    const { variation, clusters = 0 } = options;
    if (variation !== undefined && (typeof variation !== 'object' || variation === null))
      throw new TypeError('Scatter variation must be an options object; pass { hue, value }');
    const { hue = 0, value = 0 } = variation ?? {};
    if (![hue, value].every(Number.isFinite) || hue < 0 || hue > 0.5 || value < 0 || value > 1)
      throw new RangeError('Scatter variation needs hue 0-0.5 and value 0-1; pass numbers in those ranges');
    if (!Number.isFinite(clusters) || clusters < 0 || clusters > 100000)
      throw new RangeError('Scatter clusters must be a cell size from 0 to 100000; pass 0 to turn it off');
    if ((hue > 0 || value > 0 || clusters > 0) && !options.material)
      throw new RangeError('Scatter variation and clusters shade through a material; pass material: new PbrMaterial()');
    this.tint = [hue, value];
    this.values[75] = clusters; // ground.w: read only by the clusters vertex code
    // Compute emits fading instances only for a nonzero width between rings that use different meshes.
    this.fade = this.values[31] > 0 && (this.meta[39] & 3) !== 0;
  }
  static attach(
    engine: EngineKernel,
    geometry: Geometry | readonly [Geometry, Geometry, Geometry],
    options: ScatterOptions = {},
  ): Scatter {
    const effect = new Scatter(geometry, options);
    engineRuntime(engine).use(effect);
    return effect;
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        (this.disposed
          ? 'Scatter is disposed; create a new Scatter'
          : 'Scatter requires WebGPU; attach a new Scatter to a WebGPU engine') +
          '; see https://margoengine.com/errors#scatter',
      );
    const d = engine.gpu;
    this.engine = engine;
    if (
      Math.max(this.ringCapacity() * 32, this.exclusionValues.byteLength) >
        Math.min(d.limits.maxStorageBufferBindingSize, d.limits.maxBufferSize) ||
      Math.ceil(this.count / 64) > d.limits.maxComputeWorkgroupsPerDimension
    )
      throw new RangeError('Scatter exceeds GPU limits; reduce the instance count or the number of exclusions.');
    this.uniform = d.createBuffer({
      size: this.values.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.exclusionBuffer = d.createBuffer({
      size: this.exclusionValues.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    d.queue.writeBuffer(this.exclusionBuffer, 0, this.exclusionValues as Float32Array<ArrayBuffer>);
    if (this.options.material) {
      this.pbrUniform = d.createBuffer({ size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.materialUniform = d.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.materialValues.set(this.options.material.data);
    }
    // Readable (COPY_SRC) so a test or tool can read how many instances each ring drew.
    this.commands = d.createBuffer({
      size: 60,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    const commands = new Uint32Array(15);
    for (let i = 0; i < 3; i++) {
      const g = this.geometries[i];
      commands[i * 5] = g.indices.length;
      const data = this.uvs ? interleave(g.vertices, this.uvs[i]) : g.vertices,
        v = d.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      this.vertices.push(v);
      const index = d.createBuffer({
        size: g.indices.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
      this.indices.push(index);
      d.queue.writeBuffer(v, 0, data as Float32Array<ArrayBuffer>);
      d.queue.writeBuffer(index, 0, g.indices as Uint32Array<ArrayBuffer>);
      this.instances.push(d.createBuffer({ size: this.ringCapacity() * 32, usage: GPUBufferUsage.STORAGE }));
    }
    d.queue.writeBuffer(this.commands, 0, commands);
    if (this.options.textures) {
      const chains = (this.chains ??= chainsOf(this.options.textures));
      this.maps = {
        textures: [
          uploadChain(d, chains.base, 'rgba8unorm-srgb'),
          uploadChain(d, chains.normal, 'rgba8unorm'),
          uploadChain(d, chains.orm, 'rgba8unorm'),
        ],
        groups: new Map(),
        sampler: d.createSampler({
          addressModeU: 'repeat',
          addressModeV: 'repeat',
          magFilter: 'linear',
          minFilter: 'linear',
          mipmapFilter: 'linear',
          maxAnisotropy: 8,
        }),
      };
    }
    this.fallback = d.createTexture({
      size: [1, 1],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    d.queue.writeTexture({ texture: this.fallback }, new Float32Array(1), { bytesPerRow: 4 }, [1, 1]);
    this.compute = compute(d, candidateShader(this.cullCode()));
    // ScatterTiles keeps the layer's generic tiers: its rings grow and its records are its own.
    const uniform = this.uniform;
    // A textured Scatter draws through the layer's generic tiers, as ScatterTiles does (the route's shadow stage has no uvs),
    // and so does one with states (the route's stages bind no pose entries).
    if (this.constructor === Scatter && !this.uvs && !this.options.states)
      loadCompatRoute(d, () => import('./compat.js'))?.then(({ ScatterRoute }) => {
        if (this.uniform !== uniform) return;
        this.route = new ScatterRoute({
          device: d,
          cull: this.cullCode(),
          count: this.count,
          capacity: this.ringCapacity(),
          uniform,
          rings: this.instances,
          commands: this.commands!,
          exclusions: this.exclusionBuffer!,
          vertices: this.vertices,
          indices: this.indices,
          indexCounts: this.geometries.map((g) => g.indices.length),
          values: this.values,
          shadowCode,
          shadowListCode,
          shadowDepth,
        });
        this.pipelines.clear();
        this.renderGroups.clear();
        this.pbrGroups.clear();
      });
  }
  /**
   * Sets the cull reach for the wind now in `options.wind`: a bent instance reaches twice as far, so the reach doubles
   * while any wind is set. It is read every frame, so a wind given after construction (a weather drive writes one)
   * widens the culling the same way a wind passed to the constructor does.
   */
  protected applyReach(): void {
    this.values[35] = this.reach * (this.options.wind ? 2 : 1);
  }
  /** Called when this Scatter's own reach changed (a blade `widen`); a Scatter that shares its culling updates the sharer too. */
  protected reachChanged(): void {
    this.applyReach();
  }
  /** Fraction of candidates kept, 0-1; read every frame, so it can change while drawing (a settings slider keys it). */
  get density(): number {
    return this.options.density ?? 1;
  }
  set density(value: number) {
    if (typeof value !== 'number' || !(value >= 0 && value <= 1))
      throw new RangeError('Scatter density must be a number from 0 to 1');
    this.options.density = value;
    this.values[27] = value;
  }
  /** Diffuse colour (linear RGB 0-1) when no `material` is given; read every frame. */
  get color(): readonly [number, number, number] {
    return this.options.color ?? [0.12, 0.35, 0.08];
  }
  set color(value: readonly [number, number, number]) {
    if (!Array.isArray(value) || value.length !== 3 || !value.every((v) => typeof v === 'number' && v >= 0 && v <= 1))
      throw new RangeError('Scatter color must be three numbers from 0 to 1');
    this.options.color = [value[0], value[1], value[2]];
    this.values.set(value, 40);
  }
  /** The rooted wind `[x, z, strength]` or `[x, z, strength, speed]`, or undefined for none; read every frame, as a weather drive writes it. */
  get wind(): ScatterWind | undefined {
    return this.options.wind;
  }
  set wind(value: ScatterWind | undefined) {
    if (value !== undefined) validateWind(value);
    this.options.wind =
      value && (value.length === 4 ? [value[0], value[1], value[2], value[3]] : [value[0], value[1], value[2]]);
  }
  /** Albedo lost at the blade root, 0-1 (`blades.rootShade`); read every frame. Throws when built without `blades`. */
  get rootShade(): number {
    return this.values[76];
  }
  set rootShade(value: number) {
    if (this.options.blades === undefined)
      throw new MargoError('state', 'Scatter rootShade needs a scatter built with the blades option');
    if (typeof value !== 'number' || !(value >= 0 && value <= 1))
      throw new RangeError('Scatter rootShade must be a number from 0 to 1');
    this.options.blades = { ...this.options.blades, rootShade: value };
    this.values[76] = value;
  }
  /** Blade width at the last LOD distance as a fraction, 0-10 (`blades.widen`); read every frame, and it widens the cull reach with it. Throws when built without `blades`. */
  get widen(): number {
    return this.options.blades?.widen ?? 1;
  }
  set widen(value: number) {
    if (this.options.blades === undefined)
      throw new MargoError('state', 'Scatter widen needs a scatter built with the blades option');
    if (typeof value !== 'number' || !(value >= 0 && value <= 10))
      throw new RangeError('Scatter widen must be a number from 0 to 10');
    this.options.blades = { ...this.options.blades, widen: value };
    this.values[77] = value / this.lodEnd;
    this.reach = this.bladeReach * (1 + value);
    this.reachChanged();
  }
  /**
   * Sunlight through the blades, 0-1 (`blades.translucency`); read every frame while it stays above 0. Moving it off 0 (or
   * back to 0) picks another lit pipeline, built once on the next frame. Throws when built without `blades`.
   */
  get translucencyAmount(): number {
    return this.translucency;
  }
  set translucencyAmount(value: number) {
    if (this.options.blades === undefined)
      throw new MargoError('state', 'Scatter translucency needs a scatter built with the blades option');
    if (typeof value !== 'number' || !(value >= 0 && value <= 1))
      throw new RangeError('Scatter translucency must be a number from 0 to 1');
    this.options.blades = { ...this.options.blades, translucency: value };
    this.translucency = value;
  }
  /** Hue turn of `variation`, 0-0.5 (a turn of up to this either way). Needs a `material`; turning it on from 0 picks another pipeline. */
  get variationHue(): number {
    return this.tint[0];
  }
  set variationHue(value: number) {
    this.setTint(value, this.tint[1]);
  }
  /** Brightness change of `variation`, 0-1 (also the strength of `clusters`). Needs a `material`; turning it on from 0 picks another pipeline. */
  get variationValue(): number {
    return this.tint[1];
  }
  set variationValue(value: number) {
    this.setTint(this.tint[0], value);
  }
  private setTint(hue: number, value: number): void {
    if (
      typeof hue !== 'number' ||
      typeof value !== 'number' ||
      !(hue >= 0 && hue <= 0.5) ||
      !(value >= 0 && value <= 1)
    )
      throw new RangeError('Scatter variation needs hue 0-0.5 and value 0-1; pass numbers in those ranges');
    if ((hue > 0 || value > 0) && !this.options.material)
      throw new MargoError(
        'state',
        'Scatter variation shades through a material; build the Scatter with material: new PbrMaterial()',
      );
    this.tint = [hue, value];
    this.options.variation = { ...this.options.variation, hue, value };
  }
  /** Leaf-cluster cell size in mesh units, 0 (off) to 100000 (`clusters`). Needs a `material`; turning it on from 0 picks another pipeline. */
  get clusters(): number {
    return this.values[75];
  }
  set clusters(value: number) {
    if (typeof value !== 'number' || !(value >= 0 && value <= 100000))
      throw new RangeError('Scatter clusters must be a cell size from 0 to 100000; pass 0 to turn it off');
    if (value > 0 && !this.options.material)
      throw new MargoError(
        'state',
        'Scatter clusters shade through a material; build the Scatter with material: new PbrMaterial()',
      );
    this.options.clusters = value;
    this.values[75] = value;
  }
  /** Seconds on the wind clock: the sum of the deltas given to `advanceTime` (each frame update runs it). */
  get time(): number {
    return this.seconds;
  }
  /**
   * Moves the wind clock by `delta` seconds without drawing: all of a frame update. `seek` from
   * `@margoengine/cutscene/seek` replays these steps, so every plant sways where a continuous run has it.
   */
  advanceTime(delta: number): void {
    if (!Number.isFinite(delta) || delta < 0)
      throw new RangeError('Invalid scatter delta; pass a finite frame time of 0 or more.');
    this.seconds += delta;
    const wind = this.options.wind;
    this.windClock += wind?.length === 4 ? delta * windClockRate(wind[3]) : delta;
  }
  /**
   * Seconds of wind motion so far: the clock the shaders read. It runs with `time` while the wind has no speed or one up
   * to Beaufort 3, and faster in a stronger wind (`windClockRate`), so a storm thrashes the plants.
   */
  get windTime(): number {
    return this.windClock;
  }
  onPreUpdate(delta: number): void {
    this.advanceTime(delta);
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name + ':base',
      order: -Number.MAX_VALUE,
      execute: (c) => {
        if (c.backend !== 'webgpu') return;
        const base = this.base;
        base.shader = c.shader;
        base.format = c.format;
        base.descriptor = c.descriptor;
      },
    });
    graph.add({
      name: this.name + ':distribute',
      order: -10,
      execute: (c) => {
        if (c.backend !== 'webgpu') return;
        const terrain = this.options.heightmap?.() ?? this.fallback!;
        if (!heightFormats.includes(terrain.format) || !(terrain.usage & GPUTextureUsage.TEXTURE_BINDING))
          throw new MargoError(
            'state',
            'Scatter needs a sampleable floating-height texture; return one from options.heightmap',
          );
        this.applyReach();
        this.values.fill(0, 68, 71);
        if (this.options.wind) {
          const wind = this.options.wind,
            length = validateWind(wind);
          this.values[68] = wind[0] / length;
          this.values[69] = wind[1] / length;
          this.values[70] = wind[2];
        }
        this.values[71] = this.windClock;
        if (this.options.follow) this.followCamera(c.camera.position);
        this.options.states?.update(c);
        this.beforeDistribute(c, terrain);
        this.values.set(c.camera.matrix);
        this.values.set(c.camera.position, 16);
        this.values.set(c.camera.planes, 44);
        this.values[43] = +linearHdr(c.format);
        this.values[80] = pixelFootprint(c.camera.matrix, c.view?.viewport[3] ?? c.height);
        c.device.queue.writeBuffer(this.uniform!, 0, this.values as Float32Array<ArrayBuffer>);
        this.cull(c, terrain);
      },
    });
    graph.add({
      name: this.name + ':lod',
      order: 1.5,
      execute: (c) => {
        if (c.backend === 'webgpu') this.draw(c);
      },
    });
  }
  /**
   * Records the distribute (cull) pass, in candidate order (./order.js): each candidate's Instance and ring flags at
   * its own index, then the rings compacted and their draw counts set (the tiles entry shares it).
   */
  protected cull(c: ScatterPassContext, terrain: GPUTexture): void {
    const density = this.options.densityMap ? (this.options.densityMap() ?? this.fallback!) : undefined;
    if (this.route) return this.route.cull(c.encoder, terrain, density);
    const n = this.dispatched();
    if (this.ordered?.n !== n) {
      this.ordered?.destroy();
      this.ordered = new OrderedCull(c.device, n);
      this.computeGroup = undefined;
    }
    const o = this.ordered;
    if (this.terrain !== terrain || this.densityTexture !== density || this.extraChanged || !this.computeGroup) {
      const resources: (GPUBufferBinding | GPUTextureView)[] = [
        { buffer: this.exclusionBuffer! },
        ...(density ? [density.createView()] : []),
        ...this.extraEntries(),
      ];
      this.computeGroup = c.device.createBindGroup({
        layout: this.compute!.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniform! } },
          { binding: 1, resource: terrain.createView() },
          { binding: 2, resource: { buffer: o.candidates } },
          { binding: 3, resource: { buffer: o.flags } },
          ...resources.map((resource, k) => ({ binding: 6 + k, resource })),
        ],
      });
      this.terrain = terrain;
      this.densityTexture = density;
      this.extraChanged = false;
    }
    const pass = c.encoder.beginComputePass();
    pass.setPipeline(this.compute!);
    pass.setBindGroup(0, this.computeGroup);
    pass.dispatchWorkgroups(Math.ceil(n / 64));
    o.encode(pass, this.instances, this.commands!);
    pass.end();
  }
  /** The ordered cull's candidates, flags and slots (made for the threads of the distribute pass). */
  protected ordered?: OrderedCull;

  /** Call after replacing `instances`: the bind groups that read them are made again. */
  protected instancesChanged(): void {
    this.renderGroups.clear();
    this.shadowGroups.length = 0;
    this.computeGroup = undefined;
  }

  /** The distribute (cull) shader: the stratified grid, with the world-rectangle variants when they are set. */
  protected cullCode(): string {
    return scatterCullShader(this.options);
  }

  /** Extra compute bindings after the built-in ones (the tiles entry adds its records). */
  protected extraEntries(): ({ buffer: GPUBuffer } | GPUTextureView)[] {
    return [];
  }

  /** Set when `extraEntries` changed and the compute bind group must be made again. */
  protected extraChanged = false;
  private densityTexture?: GPUTexture;

  /** Threads of the distribute pass. */
  protected dispatched(): number {
    return this.count;
  }

  /**
   * Every vertex stage that poses instances (colour and shadow), before its module is made: the interact entry adds
   * its bend here, reading what `poseEntries` binds from `binding` on in bind group `group`.
   */
  protected poseCode(code: string, _group: number, _binding: number): string {
    return this.options.states?.poseCode(code, _group, _binding) ?? code;
  }

  /** Bindings after the built-in ones of each posing vertex stage's instance group (see `poseCode`). */
  protected poseEntries(): { buffer: GPUBuffer }[] {
    return this.options.states?.entries(this.engine!.gpu!) ?? [];
  }

  /** Runs before the frame values are uploaded (the tiles entry uploads new tiles here). */
  protected beforeDistribute(_c: ScatterPassContext, _terrain: GPUTexture): void {}

  /** Moves `center` to the camera in whole grid cells and stores the cell offset for the world-cell hashes. */
  private followCamera(eye: ArrayLike<number>): void {
    const columns = this.meta[38],
      rows = Math.ceil(this.count / columns),
      cellX = this.values[20] / columns,
      cellZ = this.values[21] / rows,
      ox = Math.floor(eye[0] / cellX) - Math.floor(columns / 2),
      oz = Math.floor(eye[2] / cellZ) - Math.floor(rows / 2);
    this.values[22] = (ox + columns / 2) * cellX;
    this.values[23] = (oz + rows / 2) * cellZ;
    this.values[84] = ox;
    this.values[85] = oz;
  }

  /**
   * The colour pipeline, its instance groups per ring and its lighting group for one `part` of a ring: 'opaque', or
   * 'cover' blended by each vertex's coverage and writing no depth (undefined when the stage cannot carry it; see
   * `coverCode`), or the two halves of a split ring, 'body' (opaque) and 'tip' (covered), marked `splitDeclaration`.
   * `depth` makes a covered part's coverage-depth stage instead: the same pose, writing depth and no colour where the
   * coverage passes the pose's threshold (`coverCode` with `depth`), drawn after every blended part.
   */
  private colourPipeline(
    c: ScatterPassContext,
    key: string,
    lit: boolean,
    culled: boolean,
    own: boolean,
    part: 'opaque' | 'cover' | 'body' | 'tip',
    depth = false,
  ): { pipeline: GPURenderPipeline; groups: GPUBindGroup[]; lighting?: GPUBindGroup } | undefined {
    const cover = part === 'cover' || part === 'tip',
      blend = cover && !depth,
      id = key + (part === 'opaque' ? '' : ':' + part) + (depth ? ':depth' : '');
    let pipeline = this.pipelines.get(id);
    if (!pipeline) {
      const blades = this.values[78] > 0,
        clusters = this.values[75] > 0,
        translucent = blades && this.translucency > 0,
        vertex = pbrVertex(this.fade, blades, this.looks(), clusters, translucent);
      let code = !lit ? (this.fade ? renderCode : solidCode) : c.shader.replace(/struct Input \{[^}]+\}/, '');
      if (lit) {
        // After core's varyings and any a patch added to its Output (terrain's mesh id): 4 and 5 on a plain shader.
        const at = freeLocation(/struct Output \{[^}]+\}/.exec(code)?.[0] ?? '');
        code = code
          .replace(
            '@location(3) material:vec4f',
            '@location(3) material:vec4f' +
              (this.fade ? `,@location(${at}) @interpolate(flat) lodFade:vec2f` : '') +
              (blades ? `,@location(${at + 1}) ${centroid} ground:vec4f` : '') +
              (translucent ? `,@location(${at + 2}) @interpolate(flat) transl:f32` : ''),
          )
          // Blades shade core's colour from root to tip, and clusters change it from vertex to vertex: like the ground
          // weight, read inside the triangle (see `centroid`). Read at a pixel centre outside a thin triangle, a
          // clustered colour extrapolated past its vertices and went negative (dark specks on far canopies).
          .replace('@location(2) color:vec3f', `@location(2) ${blades || clusters ? centroid + ' ' : ''}color:vec3f`)
          .replace(
            /@vertex fn vertex\([\s\S]*?(?=@fragment)/,
            c.shader.includes('var<uniform> taaCamera:')
              ? vertex.replace('o.clip=frame.camera*', 'o.clip=taaCamera*')
              : vertex,
          );
        if (this.fade)
          code =
            code.replace(/(@fragment fn fragment[^{]+\{)/, '$1\n if(!lodVisible(i.clip.xy,i.lodFade)){discard;}') +
            fadeCode;
        if (this.uvs) code = texturedVertex(code, at + 3);
        if (blades || clusters) code = positiveColor(code);
        // Blades bend core's shading normal after its back-face flip, so both sides of a blade share the ground term.
        if (blades)
          code = code.replace(
            coreNormal,
            'let n=normalize(mix(normalize(i.normal)*select(-1.0,1.0,facing),i.ground.xyz,i.ground.w));',
          );
        // Translucent blades add the sun seen through them, from the blade's own normal (before the ground blend).
        if (translucent)
          code =
            translucencyShader +
            code.replace(
              /let linear=([^;]+);/,
              `let linear=$1+foliageTranslucency(normalize(i.normal)*select(-1.0,1.0,facing),v,l,1.0,i.transl)*i.color*frame.radiance.xyz*frame.light.w;`,
            );
      }
      if (lit && this.uvs) code = texturedFragment(code, this.cut, coreNormal);
      if (cover) {
        const covered = coverCode(
          code,
          lit,
          lit ? freeLocation(/struct Output \{[^}]+\}/.exec(code)?.[0] ?? '') : 0,
          depth,
        );
        if (!covered) return undefined;
        code = covered;
      }
      if (part === 'body' || part === 'tip') code = splitDeclaration + code;
      code = this.poseCode(code, lit ? 1 : 0, 2);
      const module = c.device.createShaderModule({ code: this.route ? this.route.vertex(code, lit) : code });
      pipeline = c.device.createRenderPipeline({
        layout: 'auto',
        vertex: {
          module,
          entryPoint: 'vertex',
          buffers: [
            {
              arrayStride: this.uvs ? 32 : 24,
              attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x3' },
                { shaderLocation: 1, offset: 12, format: 'float32x3' },
                ...(this.uvs ? [{ shaderLocation: 2, offset: 24, format: 'float32x2' as const }] : []),
              ],
            },
          ],
        },
        fragment: {
          module,
          entryPoint: 'fragment',
          targets: [{ format: c.format, ...(blend ? { blend: coverBlend } : {}), ...(depth ? { writeMask: 0 } : {}) }],
          ...(own ? { constants: { C: 1 } } : {}),
        },
        ...(culled ? { primitive: { cullMode: 'back' as const } } : {}),
        multisample: c.descriptor.multisample,
        depthStencil: {
          format: c.descriptor.depthStencil!.format,
          depthWriteEnabled: !blend,
          depthCompare: 'greater-equal',
        },
      });
      this.pipelines.set(id, pipeline);
    }
    let groups = this.renderGroups.get(pipeline);
    if (!groups) {
      groups = this.colourInstances().map((buffer, ring) => {
        const count = this.route ? [this.route.ringCount(ring)] : [];
        return lit
          ? c.device.createBindGroup({
              layout: pipeline!.getBindGroupLayout(1),
              entries: [{ buffer }, { buffer: this.materialUniform! }, ...count, ...this.poseEntries()].map(
                (resource, binding) => ({
                  binding,
                  resource,
                }),
              ),
            })
          : group(c.device, pipeline!, [{ buffer: this.uniform! }, { buffer }, ...count, ...this.poseEntries()]);
      });
      this.renderGroups.set(pipeline, groups);
    }
    let lighting = this.pbrGroups.get(pipeline);
    if (lit && !lighting) {
      lighting = c.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: this.pbrUniform! } }, ...c.bindings],
      });
      this.pbrGroups.set(pipeline, lighting);
    }
    return { pipeline: pipeline!, groups, lighting };
  }
  private draw(c: ScatterPassContext): void {
    const lit = !!this.options.material;
    if (lit) {
      this.materialValues.set(this.options.material!.data);
      // The material's alpha and spare slot, which the lit vertex stage does not read: `variation` hue and value.
      if (this.looks()) [this.materialValues[3], this.materialValues[7]] = this.tint;
      this.materialValues.set(this.values.subarray(68, 80), 8); // wind, ground fit, blades, clusters
      this.materialValues[20] = this.translucency; // read by the translucent shader only
      this.materialValues[21] = this.values[80]; // the pixel footprint, material[5].y
      c.device.queue.writeBuffer(this.materialUniform!, 0, this.materialValues as Float32Array<ArrayBuffer>);
      if (this.pbrShader !== c.shader) {
        this.pipelines.clear();
        this.renderGroups.clear();
        this.pbrGroups.clear();
        this.pbrShader = c.shader;
      }
      if (!sameBindings(this.pbrBindings, c.bindings)) {
        this.pbrGroups.clear();
        this.pbrBindings = snapshotBindings(c.bindings);
      }
      this.pbrValues.set(c.camera.matrix);
      this.pbrValues.set(c.camera.position, 16);
      unitLight(this.pbrValues, 20, this.engine!.lighting.direction);
      this.pbrValues.set(this.engine!.lighting.radiance, 24);
      this.pbrValues.fill(1, 28, 31);
      if (this.engine!.lighting.ambient) this.pbrValues.set(this.engine!.lighting.ambient, 28);
      c.device.queue.writeBuffer(this.pbrUniform!, 0, this.pbrValues as Float32Array<ArrayBuffer>);
    }
    // Without the fade, single-sided materials cull back faces in the rasterizer. Override C=1 (which compiles out
    // core's back-face discard) is set only where core sets it, on its own back-culled pipeline: core's shader, format
    // and descriptor unpatched and no extra bindings. Otherwise core draws with C false, and so does this: the two
    // specializations of one shader can round apart on Metal (culling's c89c0186c; known-bugs.md). Toggling
    // `doubleSided` later picks the other cached pipeline.
    const solid = lit && !this.fade && c.shader.includes('override C='),
      culled = solid && this.options.material!.data[6] < 0.5,
      base = this.base,
      own =
        culled &&
        !c.bindings.length &&
        c.shader === base.shader &&
        c.format === base.format &&
        c.descriptor === base.descriptor;
    const key =
      c.format +
      ':' +
      c.descriptor.multisample?.count +
      ':' +
      c.descriptor.depthStencil!.format +
      (culled ? ':culled' : '') +
      (own ? ':own' : '') +
      this.stageKey();
    const parts = [0, 1, 2].map((i) => (this.drawsRing(i) ? this.coverRing(i) : undefined)),
      opaque = this.colourPipeline(c, key, lit, culled, own, 'opaque')!,
      cover = parts.includes('cover') ? this.colourPipeline(c, key, lit, culled, own, 'cover') : undefined,
      tip = parts.includes('split') ? this.colourPipeline(c, key, lit, culled, own, 'tip') : undefined,
      body = tip && this.colourPipeline(c, key, lit, culled, own, 'body')!,
      coverDepth = cover && this.colourPipeline(c, key, lit, culled, own, 'cover', true),
      tipDepth = tip && this.colourPipeline(c, key, lit, culled, own, 'tip', true);
    // Opaque parts first, near to far, writing depth; then the covered parts far to near, blended over them; then the
    // covered parts' depth where they cover (KB-SCENES-DUNE-GTAO1), after all the blending, so no blade's depth hides a
    // blade behind it that blends later, and ambient occlusion, depth of field and later meshes see the grass. A stage
    // that cannot carry coverage (see `coverCode`) draws its rings opaque.
    const draws: [number, NonNullable<typeof cover>][] = [];
    for (let i = 0; i < 3; i++) {
      const part = parts[i];
      if (part === undefined) continue;
      if (part === 'split' && body) draws.push([i, body]);
      else if (!(part === 'cover' && cover)) draws.push([i, opaque]);
    }
    for (let i = 2; i >= 0; i--) {
      if (parts[i] === 'cover' && cover) draws.push([i, cover]);
      else if (parts[i] === 'split' && tip) draws.push([i, tip]);
    }
    for (let i = 2; i >= 0; i--) {
      if (parts[i] === 'cover' && coverDepth) draws.push([i, coverDepth]);
      else if (parts[i] === 'split' && tipDepth) draws.push([i, tipDepth]);
    }
    this.attachment.view = c.color;
    this.depthAttachment.view = c.depth;
    const pass = c.encoder.beginRenderPass(this.presentation);
    applyView(pass, c);
    let current: typeof opaque | undefined;
    for (const [i, use] of draws) {
      if (use !== current) {
        current = use;
        pass.setPipeline(use.pipeline);
        if (lit) pass.setBindGroup(0, use.lighting!);
        if (this.maps) pass.setBindGroup(2, this.mapGroup(c.device, use.pipeline, 2, 3));
      }
      pass.setBindGroup(lit ? 1 : 0, use.groups[i]);
      pass.setVertexBuffer(0, this.vertices[i]);
      pass.setIndexBuffer(this.indices[i], 'uint32');
      if (this.route) pass.drawIndexed(this.geometries[i].indices.length, this.ringCapacity());
      else pass.drawIndexedIndirect(this.colourCommands(), i * 20);
    }
    pass.end();
    this.drawn(c);
  }
  /**
   * How the colour pass draws LOD ring `ring` (default 'opaque'). 'cover' draws it with partial coverage: blended over
   * what is drawn by the alpha its pose gives in `scatterCover`, writing no depth while it blends, so blades thinner
   * than a pixel add their share of colour instead of whole pixels. 'split' draws it twice, both stages marked
   * `splitDeclaration`: an opaque one writing depth (the pose draws there only what its covered stage covers fully),
   * then the covered one over it. Covered parts draw after the opaque ones and after core's meshes (the ground), far
   * rings first; after them a depth-only pass writes each covered part's depth where its coverage passes the pose's
   * threshold (`scatterCover.w`, see `coverCode`), so screen-space ambient occlusion and later meshes see it.
   */
  protected coverRing(_ring: number): 'opaque' | 'cover' | 'split' {
    return 'opaque';
  }
  /** Colour-only rings; optional occlusion keeps the shadow rings untouched. */
  protected colourInstances(): GPUBuffer[] {
    return this.instances;
  }
  protected colourCommands(): GPUBuffer {
    return this.commands!;
  }
  /** Whether the colour pass draws LOD ring `ring` (0 near, 1 middle, 2 far) with its mesh; a subclass that draws a ring its own way returns false (the shadow passes still draw it). */
  protected drawsRing(_ring: number): boolean {
    return true;
  }
  /** Runs after the colour pass each frame, to record a ring a subclass draws its own way (see `drawsRing`). */
  protected drawn(_c: ScatterPassContext): void {}
  /**
   * Culls this frame's instances per shadow cascade on the GPU, before the cascades draw: `Shadows` calls it once per
   * frame with every cascade's matrix. Each cascade then draws, per LOD ring, only the instances whose posed bounds reach
   * its light box; the others would clip away there, so the shadow map is the same. Without this call in the frame (a
   * caller that only uses `drawShadow`), every cascade draws every camera-culled instance.
   */
  prepareShadow({
    context,
    matrices,
    cascades,
  }: {
    context: ScatterPassContext;
    matrices: Float32Array;
    cascades: number;
  }): void {
    if (this.disposed || !this.commands) return;
    if (this.route) return this.route.prepareShadow(context.encoder, matrices, cascades, this.values[35]);
    const d = context.device,
      rings = this.instances,
      o = this.listOffsets;
    let cull = this.cascadeCull;
    // Made again for another cascade count or new ring buffers (a ScatterTiles ring grew or shrank).
    if (
      cull?.cascades !== cascades ||
      rings[0] !== cull.rings[0] ||
      rings[1] !== cull.rings[1] ||
      rings[2] !== cull.rings[2]
    ) {
      cull?.lists?.destroy();
      cull?.commands?.destroy();
      // Each ring's list 256-byte aligned, so a draw binds its own range.
      const sizes = rings.map((b) => Math.ceil(b.size / 2048) * 64),
        stride = sizes[0] + sizes[1] + sizes[2],
        bytes = cascades * stride * 4,
        commands = new Uint32Array(cascades * 15);
      cull = this.cascadeCull = { rings: [...rings], cascades, draws: [], threads: Math.max(...sizes) };
      // Lists the GPU cannot bind leave every cascade drawing every camera-culled instance.
      if (bytes > Math.min(d.limits.maxStorageBufferBindingSize, d.limits.maxBufferSize)) return;
      cull.lists = d.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE });
      for (let i = 0; i < cascades * 3; i++) commands[i * 5] = this.geometries[i % 3].indices.length;
      cull.commands = d.createBuffer({
        size: commands.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      });
      d.queue.writeBuffer(cull.commands, 0, commands);
      o.set([0, sizes[0], sizes[0] + sizes[1], stride]);
    }
    cull.encoder = undefined;
    if (!cull.lists) return;
    const v = this.cullValues;
    this.cullPipeline ??= compute(d, shadowCullCode);
    this.cullUniform ??= d.createBuffer({
      size: v.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    cull.group ??= group(d, this.cullPipeline, [
      { buffer: this.cullUniform },
      { buffer: this.commands },
      ...rings.map((buffer) => ({ buffer })),
      { buffer: cull.lists },
      { buffer: cull.commands! },
    ]);
    for (let i = 0; i < cascades * 16; i++) v[i] = matrices[i];
    v[68] = cascades;
    v[69] = this.values[35];
    d.queue.writeBuffer(this.cullUniform, 0, v as Float32Array<ArrayBuffer>);
    for (let i = 0; i < cascades * 3; i++) context.encoder.clearBuffer(cull.commands!, i * 20 + 4, 4);
    dispatch(context, this.cullPipeline, cull.group, Math.ceil(cull.threads / 64), 3);
    cull.encoder = context.encoder;
  }
  /**
   * Draws this frame's culled instances into one shadow cascade, depth only, with the colour pass's pose, ground fit
   * and wind: `shadows.add(scatter)` (`@margoengine/shadows`) makes a scatter cast. The instances are the ones culled
   * against the camera this frame, so an instance outside the view casts no shadow onto ground inside it; after
   * `prepareShadow` in the same frame, only those that reach this cascade.
   */
  drawShadow({
    context,
    pass,
    matrix,
    cascade,
  }: {
    context: ScatterPassContext;
    pass: GPURenderPassEncoder;
    matrix: Float32Array;
    cascade: number;
  }): void {
    if (this.disposed || !this.commands) return;
    if (this.route) return this.route.drawShadow(context.encoder, pass, matrix, cascade);
    const d = context.device,
      cull = this.cascadeCull,
      culled = !!cull && context.encoder === cull.encoder && cascade < cull.cascades,
      pipeline = culled
        ? (this.listPipeline ??= shadowDepth(d, this.poseCode(this.shadowText(shadowListCode), 0, 3), !!this.uvs))
        : (this.shadowPipeline ??= shadowDepth(d, this.poseCode(this.shadowText(shadowCode), 0, 2), !!this.uvs));
    // One uniform per cascade: every cascade's pass is recorded before the queue writes reach the GPU.
    const uniform = (this.shadowUniforms[cascade] ??= d.createBuffer({
      size: 128,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    }));
    const o = this.listOffsets,
      groups = culled
        ? (cull!.draws[cascade] ??= this.instances.map((buffer, ring) =>
            group(d, pipeline, [
              { buffer: uniform },
              { buffer },
              { buffer: cull!.lists!, offset: (cascade * o[3] + o[ring]) * 4, size: (o[ring + 1] - o[ring]) * 4 },
              ...this.poseEntries(),
            ]),
          ))
        : (this.shadowGroups[cascade] ??= this.instances.map((buffer) =>
            group(d, pipeline, [{ buffer: uniform }, { buffer }, ...this.poseEntries()]),
          ));
    const values = this.shadowValues;
    values.set(matrix);
    values.set(this.values.subarray(16, 20), 16); // the eye: blades widen with camera distance, as drawn
    values[19] = this.values[80]; // eye.w: the camera's pixel footprint, so blades floor their width as drawn
    values.set(this.values.subarray(68, 80), 20); // wind and time, ground fit, blades
    d.queue.writeBuffer(uniform, 0, values as Float32Array<ArrayBuffer>);
    pass.setPipeline(pipeline);
    if (this.maps && this.cut > 0) pass.setBindGroup(1, this.mapGroup(d, pipeline, 1, 1));
    for (let i = 0; i < 3; i++) {
      pass.setBindGroup(0, groups[i]);
      pass.setVertexBuffer(0, this.vertices[i]);
      pass.setIndexBuffer(this.indices[i], 'uint32');
      if (culled) pass.drawIndexedIndirect(cull!.commands!, (cascade * 3 + i) * 20);
      else pass.drawIndexedIndirect(this.commands, i * 20);
    }
  }
  /** A shadow vertex stage for `textures`: uvs in and, with a cut-out, a fragment stage dropping cut texels. */
  private shadowText(code: string): string {
    if (!this.uvs) return code;
    return this.cut > 0
      ? texturedShadow(code, this.cut)
      : code.replace('@location(1) n:vec3f,', '@location(1) n:vec3f,@location(2) uv:vec2f,');
  }
  /** The bind group `at` of the maps for `pipeline`: the sampler and the first `maps` maps (3 in colour, 1 in shadow). */
  private mapGroup(d: GPUDevice, pipeline: GPURenderPipeline, at: number, maps: number): GPUBindGroup {
    const m = this.maps!,
      made = m.groups.get(pipeline);
    if (made) return made;
    const group = d.createBindGroup({
      layout: pipeline.getBindGroupLayout(at),
      entries: [m.sampler, ...m.textures.slice(0, maps).map((t) => t.createView())].map((resource, binding) => ({
        binding,
        resource,
      })),
    });
    m.groups.set(pipeline, group);
    return group;
  }
  /** The lit stages now on (variation, clusters, translucency), as a pipeline key suffix: turning one on or off picks another pipeline. */
  private stageKey(): string {
    return (
      (this.looks() ? ':look' + (this.values[75] > 0 ? 'c' : '') : '') +
      (this.translucency > 0 && this.values[78] > 0 ? ':transl' : '')
    );
  }
  /** Whether `variation` or `clusters` changes the lit vertex stage. */
  private looks(): boolean {
    return this.tint[0] > 0 || this.tint[1] > 0 || this.values[75] > 0;
  }
  /** Instances each LOD ring can hold: every candidate for the grid. */
  protected ringCapacity(): number {
    return this.count;
  }

  protected release(): void {
    this.route?.destroy();
    this.route = undefined;
    for (const b of [...this.instances, ...this.vertices, ...this.indices]) b.destroy();
    this.instances = [];
    this.vertices = [];
    this.indices = [];
    this.exclusionBuffer?.destroy();
    this.exclusionBuffer = undefined;
    this.uniform?.destroy();
    this.commands?.destroy();
    this.fallback?.destroy();
    this.pbrUniform?.destroy();
    this.materialUniform?.destroy();
    this.pbrUniform = this.materialUniform = undefined;
    for (const t of this.maps?.textures ?? []) t.destroy();
    this.maps = undefined;
    this.pbrShader = '';
    this.pbrBindings.length = 0;
    this.pbrGroups.clear();
    this.uniform = this.commands = undefined;
    this.fallback = undefined;
    this.compute = undefined;
    this.ordered?.destroy();
    this.ordered = undefined;
    this.pipelines.clear();
    this.terrain = undefined;
    this.computeGroup = undefined;
    this.renderGroups.clear();
    for (const b of this.shadowUniforms) b.destroy();
    this.shadowUniforms = [];
    this.shadowGroups.length = 0;
    this.shadowPipeline = undefined;
    this.cascadeCull?.lists?.destroy();
    this.cascadeCull?.commands?.destroy();
    this.cullUniform?.destroy();
    this.cascadeCull = this.cullUniform = this.cullPipeline = this.listPipeline = undefined;
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
