// Beam caustics shared by every refracting surface: water/caustics feeds its waves through it, post/caustics any mesh.
// A grid of surface triangles is refracted by Snell's law at each corner's normal and traced down as a beam to each of
// several horizontal depth slices, where its flux, divided by the area it lands on, is rasterized as a flux vector
// (the intensity law of geometrical optics: irradiance follows the inverse area change of a ray bundle; Born and Wolf,
// Principles of Optics, 7th ed., section 3.1). A beam that collapses below a texel keeps its flux in a one-texel box.
// Receivers read the slices at their height and take the flux through their own normal. Sources: M. Watt,
// "Light-Water Interaction using Backward Beam Tracing", SIGGRAPH 1990, https://doi.org/10.1145/97880.97919, and
// T. Nishita and E. Nakamae, "Method of Displaying Optical Effects within Water using Accumulation Buffer", SIGGRAPH
// 1994, https://doi.org/10.1145/192161.192261 (refracted beams); M. Ernst, T. Akenine-Moller and H. W. Jensen,
// "Interactive Rendering of Caustics using Interpolated Warped Volumes", Graphics Interface 2005 (beams between depth
// slices); docs/clean-room.md W15 and "Shared caustics". Papers read as text; no code.
import { fullscreen } from '../../shared/gpu.js';
import { displayShader } from '../../shared/display.js';

/** A refracting surface as the beam shaders read it: WGSL that hands out the corners of its triangles. */
export interface CausticSurfaceShader {
  /** WGSL before everything else: the surface's own group(0) bindings and functions. */
  readonly prelude: string;
  /** Declarations after the settings uniform in group(1); binding 1 is the surface's. */
  readonly bindings: string;
  /**
   * Body of `fn causticSample(id:u32)->Sample` (`struct Sample {position:vec3f,normal:vec3f,base:vec2f}`): corner
   * `id % 3` of triangle `id / 3`, in world space, with `base` the surface point's horizontal place.
   */
  readonly sample: string;
  /** Statements opening `fn drySample(base:vec2f)->bool`, returning true where no light enters. */
  readonly dry: string;
  /** Triangles the beam pass draws, six vertices each. */
  readonly triangles: number;
}

/** Receiver mask of the projection: extra group(0) declarations and statements that `return vec3f(0);` to skip a pixel. */
export interface CausticMask {
  readonly bindings: string;
  readonly test: string;
}

/** The first 20 vectors keep the camera contract water's SurfaceCapture shares: u[4..7] inverse camera, u[14] view. */
const frame = `@group(0) @binding(0) var<uniform> u:array<vec4f,24>;
fn inverseCamera()->mat4x4f{return mat4x4f(u[4],u[5],u[6],u[7]);}
fn world(pixel:vec2f,z:f32)->vec3f{
 let q=inverseCamera()*vec4f((pixel-u[14].xy)/u[14].zw*vec2f(2,-2)+vec2f(-1,1),z,1);
 return q.xyz/q.w;
}`;

const head = (surface: CausticSurfaceShader, shadows: string) =>
  surface.prelude +
  `
@group(1) @binding(0) var<uniform> caustic:array<vec4f,24>;
${surface.bindings}
${shadows}
struct Sample {position:vec3f,normal:vec3f,base:vec2f}
fn causticSample(id:u32)->Sample {
 ${surface.sample}
}
fn drySample(base:vec2f)->bool {${surface.dry}return false;}
fn fresnel(cosine:f32,eta:f32)->f32 {
 let t=sqrt(max(0.0,1.0-eta*eta*(1.0-cosine*cosine)));
 let s=(eta*cosine-t)/max(0.000001,eta*cosine+t);
 let p=(cosine-eta*t)/max(0.000001,cosine+eta*t);return (s*s+p*p)*0.5;
}
`;

// Shader notes (kept here so the shipped shader carries no comment text):
// beamVertex: the three corners come from one call in a loop, not three calls: a shader compiler inlines every call,
// and each copy of a wave surface costs the WebGL2 layer's D3D compiler about a second and a half
// (KB-WATER-SURFCOMPILE1). The field is extended through slices above an entry point; receivers are masked against
// the drawn interface, and dropping these virtual samples would fade valid near-surface light toward zero. A triangle
// that collapses below a texel (a line or point focus) is drawn as a pixel-aligned box normalised by its full area:
// flooring the denominator alone leaves a collapsed primitive with no coverage.
/** The beam pass: `beamVertex` (instance = depth slice) and `beamFragment` writing red, green and blue flux vectors. */
export function causticBeams(surface: CausticSurfaceShader, shadows: string): string {
  return (
    head(surface, shadows) +
    `struct Beam {
 @builtin(position) clip:vec4f,@location(0) source:vec3f,@location(1) normal:vec3f,
 @location(2) @interpolate(flat) direction:vec3f,@location(3) @interpolate(flat) flux:f32,
 @location(4) @interpolate(flat) distance:f32,@location(5) base:vec2f
}
@group(1) @binding(2) var<storage,read> range:array<f32>;
@vertex fn beamVertex(@builtin(vertex_index) id:u32,@builtin(instance_index) layer:u32)->Beam {
 let triangle=id/6u*3u;var samples:array<Sample,3>;
 for(var k=0u;k<3u;k++){samples[k]=causticSample(triangle+k);}
 let a=samples[0];let b=samples[1];let c=samples[2];let level=mix(caustic[20].x,caustic[20].y,f32(layer)/(caustic[20].z-1.0));
 let light=caustic[12].xyz;let eta=1.0/caustic[21].x;
 var destinations:array<vec3f,3>;var direction=vec3f(0);var transmission=0.0;var distance=0.0;var valid=light.y>0.0;
 for(var i=0u;i<3u;i++){
  let n=normalize(samples[i].normal);let cosine=max(0.0,dot(n,light));
  let ray=refract(-light,n,eta);let path=(level-samples[i].position.y)/min(-0.000001,ray.y);
  valid=valid&&cosine>0.0&&ray.y<0.0&&!drySample(samples[i].base);
  destinations[i]=samples[i].position+ray*path;
  direction+=ray/3.0;transmission+=(1.0-fresnel(cosine,eta))/3.0;distance+=max(0.0,path)/3.0;
 }
 let area=abs(cross(destinations[1]-destinations[0],destinations[2]-destinations[0]).y);
 let source=abs(dot(cross(b.position-a.position,c.position-a.position),light));
 let texel=2.0*caustic[12].w/caustic[21].y;
 let corner=array<u32,6>(0u,1u,2u,0u,2u,2u)[id%6u];
 let chosen=samples[corner];let position=destinations[corner];
 var clip=vec4f((position.xz-caustic[8].xz)/caustic[12].w*vec2f(1,-1),0,1);var denominator=area;
 if(area<texel*texel){
  let p=(destinations[0].xz-caustic[8].xz)/texel+caustic[21].y*0.5;
  let q=(destinations[1].xz-caustic[8].xz)/texel+caustic[21].y*0.5;
  let r=(destinations[2].xz-caustic[8].xz)/texel+caustic[21].y*0.5;
  let low=floor(min(p,min(q,r)));let high=max(low+1.0,ceil(max(p,max(q,r))));
  let corners=array<vec2f,6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1));
  clip=vec4f(mix(low,high,corners[id%6u])/caustic[21].y*vec2f(2,-2)+vec2f(-1,1),0,1);
  denominator=2.0*(high.x-low.x)*(high.y-low.y)*texel*texel;
 }
 let density=select(0.0,source*transmission/denominator,valid)/range[0];
 return Beam(clip,chosen.position,chosen.normal,direction,density,distance,chosen.base);
}

struct Flux { @location(0) red:vec4f,@location(1) green:vec4f,@location(2) blue:vec4f }
@fragment fn beamFragment(v:Beam)->Flux {
 if(drySample(v.base)){discard;}
 let visibility=${shadows ? 'shadowLit(vec3f(1),v.source+normalize(v.normal)*0.01,normalize(v.normal))' : '1.0'};
 let vector=-v.direction/max(0.000001,-v.direction.y)*v.flux*visibility;
 let attenuation=exp(-caustic[22].rgb*v.distance);
 return Flux(vec4f(vector*attenuation.r,0),vec4f(vector*attenuation.g,0),vec4f(vector*attenuation.b,0));
}`
  );
}

/** Chunks the flux bound is summed in. */
export const causticPartials = 512;
/**
 * The flux bound: a conservative total keeps every additive half-float flux component representable, and the projection
 * multiplies the same scale back. Three kernels with no workgroup memory or barrier (per-triangle weights, 512 chunk
 * sums, then the scale), so the WebGL2 layer runs them on the GPU.
 */
export function causticRange(surface: CausticSurfaceShader): string {
  const count = surface.triangles;
  const chunk = Math.ceil(count / causticPartials);
  return (
    head(surface, '') +
    `
@group(1) @binding(2) var<storage,read_write> range:array<f32>;
@group(1) @binding(3) var<storage,read_write> weights:array<f32>;
@group(1) @binding(4) var<storage,read_write> partials:array<f32>;
@compute @workgroup_size(64) fn measure(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=${count}u){return;}
 var weight=0.0;
 var samples:array<Sample,3>;for(var k=0u;k<3u;k++){samples[k]=causticSample(id.x*3u+k);}
 let a=samples[0];let b=samples[1];let c=samples[2];
 let eta=1.0/caustic[21].x;let light=caustic[12].xyz;
 let na=normalize(a.normal);let nb=normalize(b.normal);let nc=normalize(c.normal);
 let ra=refract(-light,na,eta);let rb=refract(-light,nb,eta);let rc=refract(-light,nc,eta);
 let direction=(ra+rb+rc)/3.0;
 let texel=2.0*caustic[12].w/caustic[21].y;
 if(light.y>0.0&&min(dot(na,light),min(dot(nb,light),dot(nc,light)))>0.0&&max(ra.y,max(rb.y,rc.y))<0.0&&!drySample(a.base)&&!drySample(b.base)&&!drySample(c.base)){
  weight=abs(dot(cross(b.position-a.position,c.position-a.position),light))/(texel*texel*max(0.000001,-direction.y));
 }
 weights[id.x]=weight;
}
@compute @workgroup_size(64) fn chunks(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=${causticPartials}u){return;}
 var sum=0.0;
 for(var i=0u;i<${chunk}u;i++){let j=id.x*${chunk}u+i;if(j<${count}u){sum+=weights[j];}}
 partials[id.x]=sum;
}
@compute @workgroup_size(1) fn reduce(){
 var sum=0.0;for(var i=0u;i<${causticPartials}u;i++){sum+=partials[i];}
 range[0]=max(1.0,sum/32752.0);
}`
  );
}

/**
 * The projection onto receivers: each pixel's world point from the depth, its normal from the nearer depth neighbour on
 * each axis (so it never crosses a silhouette), the slices interpolated at its height, and the flux through that normal
 * times the pixel's own colour. `composite` false returns only the added light (for additive blending, as water does);
 * true returns the colour with it, display-encoded when `encode`.
 */
export function causticProject(
  shadows: string,
  { mask, composite = false, encode = false }: { mask?: CausticMask; composite?: boolean; encode?: boolean } = {},
): string {
  return (
    fullscreen +
    (encode ? displayShader : '') +
    frame +
    `
@group(0) @binding(1) var opaque:texture_2d<f32>;
@group(0) @binding(2) var depth:texture_depth_2d;
@group(0) @binding(3) var red:texture_2d_array<f32>;
@group(0) @binding(4) var green:texture_2d_array<f32>;
@group(0) @binding(5) var blue:texture_2d_array<f32>;
${mask?.bindings ?? ''}
@group(0) @binding(7) var linear:sampler;
@group(0) @binding(8) var<storage,read> range:array<f32>;
${shadows}
fn flux(map:texture_2d_array<f32>,uv:vec2f,layer:f32)->vec3f {
 let lo=i32(floor(layer));let hi=min(lo+1,i32(u[20].z)-1);
 return mix(textureSampleLevel(map,linear,uv,lo,0).xyz,textureSampleLevel(map,linear,uv,hi,0).xyz,fract(layer));
}
fn causticLight(at:vec2f,color:vec3f)->vec3f {
 let pixel=vec2i(at);let z=textureLoad(depth,pixel,0);
 if(z<=0.0||u[20].w==0.0){return vec3f(0);}
 let p=world(at,z);let uv=(p.xz-u[8].xz)/(2.0*u[12].w)+0.5;
 if(any(uv<vec2f(0))||any(uv>=vec2f(1))||p.y<u[20].x||p.y>u[20].y){return vec3f(0);}
 ${mask?.test ?? ''}
 let low=vec2i(u[14].xy);let high=vec2i(u[14].xy+u[14].zw)-1;
 let left=max(pixel-vec2i(1,0),low);let right=min(pixel+vec2i(1,0),high);
 let up=max(pixel-vec2i(0,1),low);let down=min(pixel+vec2i(0,1),high);
 let zl=textureLoad(depth,left,0);let zr=textureLoad(depth,right,0);let zu=textureLoad(depth,up,0);let zd=textureLoad(depth,down,0);
 let px=select(left,right,abs(zr-z)<=abs(zl-z));let py=select(up,down,abs(zd-z)<=abs(zu-z));
 let dx=(world(vec2f(px)+0.5,textureLoad(depth,px,0))-p)*f32(px.x-pixel.x);
 let dy=(world(vec2f(py)+0.5,textureLoad(depth,py,0))-p)*f32(py.y-pixel.y);
 let crossNormal=cross(dy,dx);let size=length(crossNormal);if(size==0.0){return vec3f(0);}
 let normal=crossNormal/size;let layer=(p.y-u[20].x)/(u[20].y-u[20].x)*(u[20].z-1.0);
 let illumination=max(vec3f(0),vec3f(dot(normal,flux(red,uv,layer)),dot(normal,flux(green,uv,layer)),dot(normal,flux(blue,uv,layer))));
 let visibility=${shadows ? 'shadowLit(vec3f(1),p,normal)' : '1.0'};
 return color*illumination*range[0]*u[13].rgb*u[13].w*u[23].rgb*u[20].w*visibility;
}
@fragment fn fragment(@builtin(position) at:vec4f)->@location(0) vec4f {
 let color=textureLoad(opaque,vec2i(at.xy),0);
 ${
   composite
     ? `let lit=color.rgb+causticLight(at.xy,color.rgb);return vec4f(${encode ? 'toDisplay(lit)' : 'lit'},color.a);`
     : 'return vec4f(causticLight(at.xy,color.rgb),0);'
 }
}`
  );
}

/** Copies the stage input to its output (display-encoded when `encode`). */
export const causticCopy = (encode: boolean) =>
  fullscreen +
  (encode ? displayShader : '') +
  `
@group(0) @binding(0) var image:texture_2d<f32>;
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f{
 let color=textureLoad(image,vec2i(p.xy),0);return vec4f(${encode ? 'toDisplay(color.rgb)' : 'color.rgb'},color.a);
}`;
