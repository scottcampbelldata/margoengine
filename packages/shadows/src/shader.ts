/**
 * How `Shadows` filters its depth map. `'soft'`: PCSS, penumbrae that widen with blocker distance and `lightSize`
 * (16 blocker reads and 32 comparison taps per lit pixel). `'pcf'`: four hardware comparison taps half a texel apart,
 * a smooth edge about three texels wide, no blocker search. `'hard'`: one hardware comparison tap (the sampler's own
 * 2x2 bilinear comparison), the cheapest edge.
 */
export type ShadowFilter = 'soft' | 'pcf' | 'hard';
// Each filter's last step, after the cascade lookup (layer) and receiver-plane bias shared by all three.
const filters: Record<ShadowFilter, string> = {
  // Taps follow a golden-angle (Vogel) spiral computed in the loop: tap j sits at radius sqrt((j+0.5)/n), turned one
  // golden angle (2.39996323 rad, shadowGolden) from tap j-1. No constant tables: drivers can place indexed constant
  // arrays in per-pixel scratch memory, which phone GPUs handle badly. Each pixel starts the spiral at its own angle
  // from interleaved gradient noise of its screen position (Jimenez 2014), so a penumbra shows fine noise instead of
  // the steps of one pattern shared by every pixel. No time term: the same view renders the same pixels every frame.
  soft: /* wgsl */ `
  let angle=noise.x*6.2831853;let turn=vec2f(cos(angle),sin(angle));
  let search=max(texel.x,shadowFrame.settings.x*reference*shadowFrame.ranges[layer]*length(rowX)*0.5);
  var blockers=0.0;var sum=0.0;var direction=turn;
  for(var j=0u;j<16u;j++){
    let offset=direction*sqrt((f32(j)+0.5)/16.0)*search;direction=shadowGolden*direction;
    let coord=vec2i((uv+offset)*dimensions);
    if(any(coord<vec2i(0))||any(coord>=vec2i(dimensions))){continue;}
    let d=textureLoad(shadowMap,coord,i32(layer),0);
    let receiverOffset=(vec2f(coord)+0.5)*texel-uv;
    if(d<reference+dot(receiverOffset,slope)){sum+=d-dot(receiverOffset,slope);blockers+=1;}
  }
  if(blockers==0){return 1;}
  let blocker=sum/blockers;
  let penumbra=shadowFrame.settings.x*(reference-blocker)*shadowFrame.ranges[layer]*length(rowX)*0.5;
  let radius=clamp(penumbra,texel.x,0.1);var visibility=0.0;direction=turn;
  for(var j=0u;j<32u;j++){
    let offset=direction*sqrt((f32(j)+0.5)/32.0)*radius;direction=shadowGolden*direction;
    let coord=uv+offset;
    if(any(coord<vec2f(0))||any(coord>vec2f(1))){visibility+=1;}else{visibility+=textureSampleCompareLevel(shadowMap,shadowSampler,coord,i32(layer),reference+dot(offset,slope));}
  }
  return visibility/32.0;`,
  // Each tap is the sampler's 2x2 bilinear comparison; four of them half a texel apart add up to a 3x3-texel
  // quadratic B-spline. Written out, not looped: no arrays, no blocker search, no transcendental per tap.
  pcf: /* wgsl */ `
  let h=texel*0.5;let tapLayer=i32(layer);let a=vec2f(h.x,-h.y);
  return (textureSampleCompareLevel(shadowMap,shadowSampler,uv-h,tapLayer,reference-dot(h,slope))+textureSampleCompareLevel(shadowMap,shadowSampler,uv+h,tapLayer,reference+dot(h,slope))+textureSampleCompareLevel(shadowMap,shadowSampler,uv-a,tapLayer,reference-dot(a,slope))+textureSampleCompareLevel(shadowMap,shadowSampler,uv+a,tapLayer,reference+dot(a,slope)))*0.25;`,
  hard: /* wgsl */ `
  return textureSampleCompareLevel(shadowMap,shadowSampler,uv,i32(layer),reference);`,
};
// Compare on the receiver plane; cover comparison-sampler subtexel footprints.
// Directional lights use angular size and orthographic depth separation.
// shadowNoise rebuilds the fragment's screen pixel from the camera view and settings.w (pixels per unit at depth 1), so
// it needs no fragment input: x is interleaved gradient noise of the pixel, y of the transposed pixel (a second pattern,
// uncorrelated with x). The last tenth of each cascade's depth range dithers into the next cascade (noise.y threshold):
// no hard seam where texel size changes, still one map lookup per tap; the next cascade's sphere holds the band. The
// last cascade (its split equals splits.w) and unused ones never switch. Comments stay out of the WGSL: they would ship.
export function shadowSampling(group: number, filter: ShadowFilter = 'soft'): string {
  return /* wgsl */ `
struct ShadowFrame {matrices:array<mat4x4f,4>,view:mat4x4f,splits:vec4f,ranges:vec4f,settings:vec4f}
@group(${group}) @binding(1) var<uniform> shadowFrame:ShadowFrame;
@group(${group}) @binding(2) var shadowMap:texture_depth_2d_array;
@group(${group}) @binding(3) var shadowSampler:sampler_comparison;
${filter === 'soft' ? 'const shadowGolden=mat2x2f(-0.737368878,0.675490294,-0.675490294,-0.737368878);\n' : ''}fn shadowNoise(position:vec3f)->vec2f {
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
  if(abs(lightNormal.z)>0.001){slope=clamp(vec2f(-lightNormal.x,lightNormal.y)*2*length(rowZ)/(length(rowX)*lightNormal.z),vec2f(-2),vec2f(2));}
  reference-=dot(abs(slope),texel)*0.5;${filters[filter]}
}
fn shadowLit(direct:vec3f,position:vec3f,normal:vec3f)->vec3f {if(all(direct==vec3f(0))){return direct;}return direct*shadowVisibility(position,normal);}
`;
}
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
