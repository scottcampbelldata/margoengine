import { ditherWGSL } from '../../shared/screen-door.js';
import { MargoError } from '@margoengine/math/errors';
import { fogWgsl } from '../../shared/fog.js';
import { surfaceEntry } from '../../shared/pass.js';

/** Flag bits of `Cloud.flags.x`, shared by the plugin and the point shader. */
export const FLAG = {
  colors: 1,
  sizes: 2,
  world: 4,
  round: 8,
  map: 16,
  sphere: 32,
  direct: 64,
  srgbColors: 128,
  floatColors: 256,
} as const;

/** WGSL: the colour of point `p`, from `colors` (as RGBA8 or float32) in linear, for shaders with `has` and `colors`. */
export const pointColorWgsl: string = /* wgsl */ `
fn pointColor(p:u32)->vec4f{
  var c:vec4f;
  if(has(${FLAG.floatColors}u)){
    let q=p*4u;
    c=vec4f(bitcast<f32>(colors[q]),bitcast<f32>(colors[q+1u]),bitcast<f32>(colors[q+2u]),bitcast<f32>(colors[q+3u]));
  } else {c=unpack4x8unorm(colors[p]);}
  return vec4f(select(c.rgb,toLinear(c.rgb),has(${FLAG.srgbColors}u)),c.a);
}
`;

/**
 * Bytes of the shared frame uniform, the per-cloud uniform and the per-batch sprite uniform. Both per-draw uniforms end
 * with 6 clipping planes: the cloud's at byte 128 (count in `flags.y`), the batch's at byte 96 (count in `params.w`).
 */
export const FRAME_BYTES = 144,
  CLOUD_BYTES = 224,
  SPRITE_BYTES = 192;

/** The frame uniform at group 0 with colour helpers and the quad corners, shared by the point, sprite and surfel shaders. */
export const frameWgsl: string = /* wgsl */ `
struct Frame{viewProj:mat4x4f,viewport:vec4f,depth:vec4f,right:vec4f,up:vec4f,back:vec4f}
@group(0) @binding(0) var<uniform> frame:Frame;
fn toLinear(c:vec3f)->vec3f{return select(pow((c+0.055)/1.055,vec3f(2.4)),c/12.92,c<=vec3f(0.04045));}
// viewport.w is 1 when the target needs sRGB encoding in the shader (a non -srgb canvas format).
fn encode(c:vec4f)->vec4f{
  if(frame.viewport.w<0.5){return c;}
  let l=max(c.rgb,vec3f(0.0));
  return vec4f(select(1.055*pow(l,vec3f(1.0/2.4))-0.055,l*12.92,l<=vec3f(0.0031308)),c.a);
}
// Quad corners as a 4-vertex triangle strip per instance.
const CORNERS=array<vec2f,4>(vec2f(-1.0,-1.0),vec2f(1.0,-1.0),vec2f(-1.0,1.0),vec2f(1.0,1.0));
`;

// Orthographic cameras (frame.depth.w): info.y is 1 + distance from the near plane instead of the view distance, and
// sphere depth is linear in it. The EDL pass shades linear depth steps times params.z when params.z > 0.
/** Point cloud shader: one instanced quad per point, read from storage buffers through the shuffled slot order. */
export const pointShader: string =
  frameWgsl +
  ditherWGSL +
  /* wgsl */ `
struct Cloud{model:mat4x4f,color:vec4f,size:vec4f,flags:vec4u,pad:vec4f,planes:array<vec4f,6>}
@group(1) @binding(0) var<uniform> cloud:Cloud;
@group(1) @binding(1) var<storage,read> positions:array<f32>;
@group(1) @binding(2) var<storage,read> colors:array<u32>;
@group(1) @binding(3) var<storage,read> sizes:array<f32>;
@group(1) @binding(4) var<storage,read> order:array<u32>;
@group(1) @binding(5) var map:texture_2d<f32>;
@group(1) @binding(6) var mapSampler:sampler;
struct VOut{
  @builtin(position) clip:vec4f,
  @location(0) color:vec4f,
  @location(1) quad:vec2f,
  @location(2) @interpolate(flat) info:vec4f,
  @location(3) @interpolate(flat) center:vec3f,
}
fn has(bit:u32)->bool{return (cloud.flags.x&bit)!=0u;}
${pointColorWgsl}
@vertex fn vertex(@builtin(vertex_index) vi:u32,@builtin(instance_index) slot:u32)->VOut{
  var out:VOut;
  var p=slot;
  if(!has(${FLAG.direct}u)){p=order[slot];}
  let world=cloud.model*vec4f(positions[p*3u],positions[p*3u+1u],positions[p*3u+2u],1.0);
  var clip=frame.viewProj*world;
  if(!(clip.w>1e-6)){out.clip=vec4f(0.0,0.0,-1.0,1.0);return out;}
  var size=cloud.size.x;
  if(has(${FLAG.sizes}u)){size*=sizes[p];}
  var px=select(size,size*frame.viewport.z/clip.w,has(${FLAG.world}u));
  px=clamp(px,cloud.size.y,cloud.size.z);
  let radius=0.5*px;
  // Round points get one extra pixel of quad for the antialiased edge.
  let extent=radius+select(0.0,1.0,has(${FLAG.round}u)||has(${FLAG.sphere}u));
  let corner=CORNERS[vi];
  clip=vec4f(clip.xy+corner*extent*2.0/frame.viewport.xy*clip.w,clip.zw);
  var color=cloud.color;
  if(has(${FLAG.colors}u)){color*=pointColor(p);}
  out.clip=clip;out.color=color;out.quad=corner*extent;
  out.info=vec4f(radius,select(clip.w,1.0+(1.0-clip.z)/frame.depth.y,frame.depth.w>0.5),radius*clip.w/frame.viewport.z,0.0);
  out.center=world.xyz;
  return out;
}

struct Surface{color:vec4f,nz:f32}
fn surface(i:VOut)->Surface{
  if(cloud.flags.z!=0u||cloud.flags.w!=1065353216u){let fade=(f32(margoDitherRank(i.clip.xy))+0.5)/16.0;
  if(fade<bitcast<f32>(cloud.flags.z)||fade>=bitcast<f32>(cloud.flags.w)){discard;}}
  let r=max(i.info.x,1e-4);
  let uv=vec2f(0.5+0.5*i.quad.x/r,0.5-0.5*i.quad.y/r);
  // The map spans the point's diameter: one mip per halving of texels per pixel. A map without mips stays at level 0.
  let dims=vec2f(textureDimensions(map));
  let texel=textureSampleLevel(map,mapSampler,clamp(uv,vec2f(0.0),vec2f(1.0)),max(log2(max(dims.x,dims.y)/(2.0*r)),0.0));
  var color=i.color;
  if(has(${FLAG.map}u)){color*=texel;}
  if(color.a<cloud.size.w){discard;}
  var s:Surface;s.nz=1.0;
  if(has(${FLAG.round}u)||has(${FLAG.sphere}u)){
    let d=length(i.quad);
    let coverage=clamp(r+0.5-d,0.0,1.0);
    if(coverage<=0.0){discard;}
    color.a*=coverage;
    if(has(${FLAG.sphere}u)){
      let n2=i.quad/r;
      s.nz=sqrt(max(1.0-dot(n2,n2),0.0));
      let n=frame.right.xyz*n2.x+frame.up.xyz*n2.y+frame.back.xyz*s.nz;
      let l=normalize(frame.right.xyz*-0.35+frame.up.xyz*0.45+frame.back.xyz*0.82);
      color=vec4f(color.rgb*(0.3+0.7*max(dot(n,l),0.0)),color.a);
    }
  } else if(any(abs(i.quad)>vec2f(r))){discard;}
  // Clipping planes (flags.y & 0xffff of them; bit 16: cut only behind every plane), tested at this fragment's world point: the centre moved across the camera-facing
  // disc by the quad offset (info.z / info.x world units per pixel), and out to the sphere surface for sphere shading.
  let clipCount=cloud.flags.y&0xffffu;
  if(clipCount>0u){
    let wp=i.center+(frame.right.xyz*i.quad.x+frame.up.xyz*i.quad.y)*(i.info.z/r)
      +frame.back.xyz*select(0.0,s.nz*i.info.z,has(${FLAG.sphere}u));
    var clipBehind=0u;
    for(var p=0u;p<clipCount;p++){if(dot(cloud.planes[p].xyz,wp)+cloud.planes[p].w<0.0){clipBehind++;}}
    if(select(clipBehind>0u,clipBehind==clipCount,(cloud.flags.y&65536u)!=0u)){discard;}
  }
  s.color=encode(color);
  return s;
}
// Reversed-Z depth of view distance w for this projection: ndc = -A + B / w, or linear when orthographic.
fn sphereDepth(i:VOut,nz:f32)->f32{
  let w=max(i.info.y-i.info.z*nz,frame.depth.z);
  return clamp(select(-frame.depth.x+frame.depth.y/w,1.0-(w-1.0)*frame.depth.y,frame.depth.w>0.5),0.0,1.0);
}
struct EdlOut{@location(0) color:vec4f,@location(1) depth:f32}
struct SphereOut{@location(0) color:vec4f,@builtin(frag_depth) depth:f32}
struct SphereEdlOut{@location(0) color:vec4f,@location(1) edl:f32,@builtin(frag_depth) depth:f32}
@fragment fn fragment(i:VOut)->@location(0) vec4f{return surface(i).color;}
@fragment fn fragmentEdl(i:VOut)->EdlOut{let s=surface(i);return EdlOut(s.color,i.info.y);}
@fragment fn fragmentSphere(i:VOut)->SphereOut{let s=surface(i);return SphereOut(s.color,sphereDepth(i,s.nz));}
@fragment fn fragmentSphereEdl(i:VOut)->SphereEdlOut{
  let s=surface(i);
  return SphereEdlOut(s.color,max(i.info.y-i.info.z*s.nz,frame.depth.z),sphereDepth(i,s.nz));
}
`;

/** Sprite shader: camera-facing instanced quads. */
export const spriteShader: string =
  frameWgsl +
  /* wgsl */ `
struct Batch{model:mat4x4f,color:vec4f,params:vec4f,planes:array<vec4f,6>}
@group(1) @binding(0) var<uniform> batch:Batch;
@group(1) @binding(1) var<storage,read> sprites:array<vec4f>;
@group(1) @binding(2) var map:texture_2d<f32>;
@group(1) @binding(3) var mapSampler:sampler;
struct VOut{@builtin(position) clip:vec4f,@location(0) color:vec4f,@location(1) uv:vec2f,@location(2) world:vec3f}

@vertex fn vertex(@builtin(vertex_index) vi:u32,@builtin(instance_index) ii:u32)->VOut{
  var out:VOut;
  let a=sprites[ii*4u];let b=sprites[ii*4u+1u];let rect=sprites[ii*4u+2u];let tint=sprites[ii*4u+3u];
  let q=CORNERS[vi]*0.5+0.5;
  let angle=a.w+batch.params.x;
  let local=(q-b.zw)*b.xy;
  let offset=vec2f(local.x*cos(angle)-local.y*sin(angle),local.x*sin(angle)+local.y*cos(angle));
  var world=batch.model*vec4f(a.xyz,1.0);
  var clip:vec4f;
  // World point of this corner: on the quad for world-sized sprites, the centre for pixel-sized ones.
  var wp=world.xyz;
  if(batch.params.z>0.5){
    clip=frame.viewProj*world;
    clip=vec4f(clip.xy+offset*2.0/frame.viewport.xy*clip.w,clip.zw);
  } else {
    wp=world.xyz+frame.right.xyz*offset.x+frame.up.xyz*offset.y;
    clip=frame.viewProj*vec4f(wp,1.0);
  }
  out.clip=clip;out.world=wp;
  out.uv=mix(rect.xy,rect.zw,vec2f(q.x,1.0-q.y));
  out.color=batch.color*tint;
  return out;
}
@fragment fn fragment(i:VOut)->@location(0) vec4f{
  // The texel footprint of this pixel, for sprites in any atlas rectangle. A map without mips stays at level 0.
  let dims=vec2f(textureDimensions(map));
  let dx=dpdx(i.uv)*dims;let dy=dpdy(i.uv)*dims;
  let texel=textureSampleLevel(map,mapSampler,i.uv,max(0.5*log2(max(max(dot(dx,dx),dot(dy,dy)),1e-12)),0.0));
  let color=i.color*texel;
  if(color.a<batch.params.y||color.a<=0.0){discard;}
  // Clipping planes (abs(params.w) of them; negative: cut only behind every plane) at this fragment's world point.
  let clipCount=u32(abs(batch.params.w));var clipBehind=0u;
  for(var p=0u;p<clipCount;p++){if(dot(batch.planes[p].xyz,i.world)+batch.planes[p].w<0.0){clipBehind++;}}
  if(clipCount>0u&&select(clipBehind>0u,clipBehind==clipCount,batch.params.w<0.0)){discard;}
  return encode(color);
}
`;

// Scene fog (PointsPlugin.setFog), patched into copies so the shaders above stay unchanged. Points take the fog of their
// centre (flat per point); sprites of each fragment's world position (the `world` varying the clipping planes use).
// Alpha-blended colours fade toward the fog colour, additive ones toward no contribution (fog hides a glow rather than
// painting it in the fog colour). Both mix in linear, before the shaders' own sRGB encoding.
const fogEdits = {
  point: [
    [
      '@location(2) @interpolate(flat) info:vec4f,',
      '@location(2) @interpolate(flat) info:vec4f,@location(4) @interpolate(flat) fog:f32,',
    ],
    [
      'out.clip=clip;out.color=color;out.quad=corner*extent;',
      'out.clip=clip;out.color=color;out.quad=corner*extent;out.fog=fogAmount(world.xyz);',
    ],
    ['s.color=encode(color);', 's.color=encode(fogged(color,i.fog));'],
  ],
  sprite: [['return encode(color);', 'return encode(fogged(color,fogAmount(i.world)));']],
} as const;
const spriteHead = '@fragment fn fragment(i:VOut)->@location(0) vec4f{';
/**
 * The point or sprite shader (fogged when `additive` is given: whether it blends additively) with its colour feeding a
 * transparency hook whose `declarations` sit at group 3. The fragment's position w is 1 / clip w, the view depth of a
 * perspective camera; an orthographic one counts it from the near plane.
 */
export function surfaceShader(kind: 'point' | 'sprite', declarations: string, additive?: boolean): string {
  let code = additive === undefined ? (kind === 'point' ? pointShader : spriteShader) : foggedShader(kind, additive);
  if (kind === 'sprite') {
    if (code.split(spriteHead).length !== 2)
      throw new MargoError('unsupported', 'Sprite transparency needs the shader it was written for; update its edit');
    code = code.replace(spriteHead, 'fn margoShade(i:VOut)->vec4f{');
  }
  return (
    declarations +
    code +
    'fn margoViewDepth(p:vec4f)->f32{return select(1.0/p.w,frame.right.w+(1.0-p.z)/frame.depth.y,frame.depth.w>0.5);}\n' +
    surfaceEntry(
      declarations,
      'i:VOut',
      kind === 'point' ? 'surface(i).color' : 'margoShade(i)',
      'i.clip',
      'margoViewDepth(i.clip)',
    )
  );
}
/**
 * A depth as the four bytes of its float, for a target at the compatibility level: r32float cannot be multisampled
 * there and rgba8unorm can. No blending or resolve touches these targets, so the bytes come back exact.
 */
export const depthPacking: string = /* wgsl */ `
fn packDepth(d:f32)->vec4f{
  let b=bitcast<u32>(d);
  return vec4f(f32(b&255u),f32((b>>8u)&255u),f32((b>>16u)&255u),f32(b>>24u))/255.0;
}
fn unpackDepth(c:vec4f)->f32{
  let b=vec4u(round(c*255.0));
  return bitcast<f32>(b.x|(b.y<<8u)|(b.z<<16u)|(b.w<<24u));
}
`;

/** `code` with each edit made once; a shader that no longer holds the text is a bug here, not a missed edit. */
export function edited(code: string, edits: readonly (readonly [string, string])[]): string {
  let out = code;
  for (const [from, to] of edits) {
    if (out.split(from).length !== 2)
      throw new MargoError('unsupported', `Points needs the shaders it was written for; no ${from} to edit.`);
    out = out.replace(from, to);
  }
  return out;
}

/** `code`, a point shader, with its eye-dome depth output packed by {@link depthPacking}. */
export const packedDepthPoints = (code: string): string =>
  edited(code, [
    [
      'struct EdlOut{@location(0) color:vec4f,@location(1) depth:f32}',
      'struct EdlOut{@location(0) color:vec4f,@location(1) depth:vec4f}',
    ],
    ['@location(1) edl:f32,@builtin(frag_depth)', '@location(1) edl:vec4f,@builtin(frag_depth)'],
    ['return EdlOut(s.color,i.info.y);', 'return EdlOut(s.color,packDepth(i.info.y));'],
    [
      'return SphereEdlOut(s.color,max(i.info.y-i.info.z*s.nz,frame.depth.z),sphereDepth(i,s.nz));',
      'return SphereEdlOut(s.color,packDepth(max(i.info.y-i.info.z*s.nz,frame.depth.z)),sphereDepth(i,s.nz));',
    ],
  ]) + depthPacking;

/** The point (`kind` 'point') or sprite shader with scene fog at group 2, for normal or additive blending. */
export function foggedShader(kind: 'point' | 'sprite', additive: boolean): string {
  let code = kind === 'point' ? pointShader : spriteShader;
  for (const [from, to] of fogEdits[kind]) {
    if (code.split(from).length !== 2)
      throw new MargoError(
        'unsupported',
        'Points fog needs the shaders it was written for; update the fog edits with them',
      );
    code = code.replace(from, to);
  }
  return (
    code +
    fogWgsl(2, 0) +
    (additive
      ? 'fn fogged(c:vec4f,a:f32)->vec4f{return vec4f(c.rgb*(1.0-a),c.a);}'
      : 'fn fogged(c:vec4f,a:f32)->vec4f{return vec4f(mix(c.rgb,margoFog.color.rgb,a),c.a);}')
  );
}

/**
 * Eye-dome lighting pass (C. Boucheny, PhD thesis, Universite Joseph Fourier, 2009; Boucheny and Ribes, Kitware
 * Source Quarterly, 2011): a full-screen triangle whose output multiplies the scene colour. Each covered pixel compares
 * its depth with 8 neighbours on a ring of `params.y` pixels; neighbours nearer the viewer add their depth step,
 * measured in log2 units (perspective, `params.z` = 0) or as a linear step times `params.z` (orthographic). The shade
 * is `exp(-32 * params.x * mean step)`, so flat areas keep their colour and silhouettes darken.
 * Group 0: binding 0 the r32float depths (0 = no point), binding 1 `params` (strength, radius, orthographic scale, 0).
 */
export const edlShader: string = /* wgsl */ `
@group(0) @binding(0) var depths:texture_2d<f32>;
@group(0) @binding(1) var<uniform> params:vec4f;
// Ring directions 45 degrees apart.
const RING=array<vec2f,8>(vec2f(1.0,0.0),vec2f(0.70710678,0.70710678),vec2f(0.0,1.0),vec2f(-0.70710678,0.70710678),
  vec2f(-1.0,0.0),vec2f(-0.70710678,-0.70710678),vec2f(0.0,-1.0),vec2f(0.70710678,-0.70710678));
// Darkening per unit of mean log2 step at strength 1 (our choice): beside a straight edge 3 of the 8 neighbours lie on
// the near side, so a 5% depth step (log2 1.05 = 0.07) shades exp(-32 * 0.07 * 3 / 8) = 0.43, about half brightness,
// and a 1% step still reads (0.84).
const GAIN=32.0;
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{
  // Corners (-1,-1), (3,-1), (-1,3): one triangle covering the clip square.
  return vec4f(f32(i&1u)*4.0-1.0,f32(i>>1u)*4.0-1.0,0.0,1.0);
}
// How much nearer a neighbour at depth n is than the centre at depth c; background (0) neighbours give nothing.
fn nearer(c:f32,n:f32)->f32{
  if(n<=0.0){return 0.0;}
  if(params.z>0.0){return max(0.0,(c-n)*params.z);}
  return max(0.0,log2(c)-log2(n));
}
@fragment fn fragment(@builtin(position) position:vec4f)->@location(0) vec4f{
  let p=vec2i(position.xy);
  let c=textureLoad(depths,p,0).r;
  if(c<=0.0){discard;}
  let last=vec2i(textureDimensions(depths))-1;
  var sum=0.0;
  for(var k=0;k<8;k++){
    let q=clamp(p+vec2i(round(RING[k]*params.y)),vec2i(0),last);
    sum+=nearer(c,textureLoad(depths,q,0).r);
  }
  let shade=exp(-GAIN*params.x*sum/8.0);
  return vec4f(shade,shade,shade,1.0);
}
`;
