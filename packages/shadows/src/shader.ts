const f32 = Math.fround;
// Preserve the shader's Float32 spiral; generate direction/radius once, not per shaded pixel.
const shadowOffsets = [16, 32]
  .map((count) => {
    const values = Array.from({ length: count }, (_, j) => {
      const angle = f32(j * f32(2.39996323)),
        radius = f32(Math.sqrt((j + 0.5) / count));
      return `vec2f(${f32(f32(Math.cos(angle)) * radius)},${f32(f32(Math.sin(angle)) * radius)})`;
    });
    return `const shadowDisk${count}=array<vec2f,${count}>(${values.join(',')});\n`;
  })
  .join('');
// Compare on the receiver plane; cover comparison-sampler subtexel footprints.
// Directional lights use angular size and orthographic depth separation.
export function shadowSampling(group: number): string {
  return (
    shadowOffsets +
    /* wgsl */ `
struct ShadowFrame {matrices:array<mat4x4f,4>,view:mat4x4f,splits:vec4f,ranges:vec4f,settings:vec4f}
@group(${group}) @binding(1) var<uniform> shadowFrame:ShadowFrame;
@group(${group}) @binding(2) var shadowMap:texture_depth_2d_array;
@group(${group}) @binding(3) var shadowSampler:sampler_comparison;
fn shadowVisibility(position:vec3f,normal:vec3f)->f32 {
  let depth=-(shadowFrame.view*vec4f(position,1)).z;
  if(depth>shadowFrame.splits.w){return 1;}
  let cascade=u32(depth>shadowFrame.splits.x)+u32(depth>shadowFrame.splits.y)+u32(depth>shadowFrame.splits.z);
  let projected=shadowFrame.matrices[cascade]*vec4f(position+normalize(normal)*shadowFrame.settings.z,1);
  let uv=projected.xy*vec2f(0.5,-0.5)+0.5;var reference=projected.z-shadowFrame.settings.y;
  if(any(uv<vec2f(0))||any(uv>vec2f(1))||reference<=0||reference>=1){return 1;}
  let dimensions=vec2f(textureDimensions(shadowMap));let texel=1.0/dimensions;
  let matrix=shadowFrame.matrices[cascade];let rowX=vec3f(matrix[0].x,matrix[1].x,matrix[2].x);let rowY=vec3f(matrix[0].y,matrix[1].y,matrix[2].y);let rowZ=vec3f(matrix[0].z,matrix[1].z,matrix[2].z);
  let lightNormal=vec3f(dot(normal,normalize(rowX)),dot(normal,normalize(rowY)),dot(normal,normalize(rowZ)));var slope=vec2f(0);
  if(abs(lightNormal.z)>0.001){slope=clamp(vec2f(-lightNormal.x,lightNormal.y)*2*length(rowZ)/(length(rowX)*lightNormal.z),vec2f(-2),vec2f(2));}
  reference-=dot(abs(slope),texel)*0.5;
  let search=max(texel.x,shadowFrame.settings.x*reference*shadowFrame.ranges[cascade]*length(rowX)*0.5);
  var blockers=0.0;var sum=0.0;
  for(var j=0u;j<16u;j++){
    let offset=shadowDisk16[j]*search;
    let coord=vec2i((uv+offset)*dimensions);
    if(any(coord<vec2i(0))||any(coord>=vec2i(dimensions))){continue;}
    let d=textureLoad(shadowMap,coord,i32(cascade),0);
    let receiverOffset=(vec2f(coord)+0.5)*texel-uv;
    if(d<reference+dot(receiverOffset,slope)){sum+=d-dot(receiverOffset,slope);blockers+=1;}
  }
  if(blockers==0){return 1;}
  let blocker=sum/blockers;
  let penumbra=shadowFrame.settings.x*(reference-blocker)*shadowFrame.ranges[cascade]*length(rowX)*0.5;
  let radius=clamp(penumbra,texel.x,0.1);var visibility=0.0;
  for(var j=0u;j<32u;j++){
    let offset=shadowDisk32[j]*radius;
    let coord=uv+offset;
    if(any(coord<vec2f(0))||any(coord>vec2f(1))){visibility+=1;}else{visibility+=textureSampleCompareLevel(shadowMap,shadowSampler,coord,i32(cascade),reference+dot(offset,slope));}
  }
  return visibility/32.0;
}
fn shadowLit(direct:vec3f,position:vec3f,normal:vec3f)->vec3f {if(all(direct==vec3f(0))){return direct;}return direct*shadowVisibility(position,normal);}
`
  );
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
