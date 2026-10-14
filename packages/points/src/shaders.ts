/** Flag bits of `Cloud.flags.x`, shared by the plugin and the point shader. */
export const FLAG = {colors: 1, sizes: 2, world: 4, round: 8, map: 16, sphere: 32, direct: 64, srgbColors: 128} as const;

/** Bytes of the shared frame uniform, the per-cloud uniform and the per-batch sprite uniform. */
export const FRAME_BYTES = 144, CLOUD_BYTES = 128, SPRITE_BYTES = 96;

const common = /* wgsl */ `
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
export const pointShader: string = common + /* wgsl */ `
struct Cloud{model:mat4x4f,color:vec4f,size:vec4f,flags:vec4u,pad:vec4f}
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
}
fn has(bit:u32)->bool{return (cloud.flags.x&bit)!=0u;}

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
  if(has(${FLAG.colors}u)){
    let c=unpack4x8unorm(colors[p]);
    color*=vec4f(select(c.rgb,toLinear(c.rgb),has(${FLAG.srgbColors}u)),c.a);
  }
  out.clip=clip;out.color=color;out.quad=corner*extent;
  out.info=vec4f(radius,select(clip.w,1.0+(1.0-clip.z)/frame.depth.y,frame.depth.w>0.5),radius*clip.w/frame.viewport.z,0.0);
  return out;
}

struct Surface{color:vec4f,nz:f32}
fn surface(i:VOut)->Surface{
  let r=max(i.info.x,1e-4);
  let uv=vec2f(0.5+0.5*i.quad.x/r,0.5-0.5*i.quad.y/r);
  let texel=textureSampleLevel(map,mapSampler,clamp(uv,vec2f(0.0),vec2f(1.0)),0.0);
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
export const spriteShader: string = common + /* wgsl */ `
struct Batch{model:mat4x4f,color:vec4f,params:vec4f}
@group(1) @binding(0) var<uniform> batch:Batch;
@group(1) @binding(1) var<storage,read> sprites:array<vec4f>;
@group(1) @binding(2) var map:texture_2d<f32>;
@group(1) @binding(3) var mapSampler:sampler;
struct VOut{@builtin(position) clip:vec4f,@location(0) color:vec4f,@location(1) uv:vec2f}

@vertex fn vertex(@builtin(vertex_index) vi:u32,@builtin(instance_index) ii:u32)->VOut{
  var out:VOut;
  let a=sprites[ii*4u];let b=sprites[ii*4u+1u];let rect=sprites[ii*4u+2u];let tint=sprites[ii*4u+3u];
  let q=CORNERS[vi]*0.5+0.5;
  let angle=a.w+batch.params.x;
  let local=(q-b.zw)*b.xy;
  let offset=vec2f(local.x*cos(angle)-local.y*sin(angle),local.x*sin(angle)+local.y*cos(angle));
  var world=batch.model*vec4f(a.xyz,1.0);
  var clip:vec4f;
  if(batch.params.z>0.5){
    clip=frame.viewProj*world;
    clip=vec4f(clip.xy+offset*2.0/frame.viewport.xy*clip.w,clip.zw);
  } else {
    clip=frame.viewProj*vec4f(world.xyz+frame.right.xyz*offset.x+frame.up.xyz*offset.y,1.0);
  }
  out.clip=clip;
  out.uv=mix(rect.xy,rect.zw,vec2f(q.x,1.0-q.y));
  out.color=batch.color*tint;
  return out;
}
@fragment fn fragment(i:VOut)->@location(0) vec4f{
  let texel=textureSampleLevel(map,mapSampler,i.uv,0.0);
  let color=i.color*texel;
  if(color.a<batch.params.y||color.a<=0.0){discard;}
  return encode(color);
}
`;

/** Eye-dome lighting: multiplies the color by a shade from log-depth differences to 8 neighbors. */
export const edlShader: string = /* wgsl */ `
@group(0) @binding(0) var depths:texture_2d<f32>;
@group(0) @binding(1) var<uniform> params:vec4f;
@vertex fn vertex(@builtin(vertex_index) vi:u32)->@builtin(position) vec4f{
  let p=vec2f(f32((vi<<1u)&2u),f32(vi&2u));
  return vec4f(p*2.0-1.0,0.0,1.0);
}
@fragment fn fragment(@builtin(position) position:vec4f)->@location(0) vec4f{
  let size=vec2i(textureDimensions(depths));
  let p=vec2i(position.xy);
  let center=textureLoad(depths,p,0).r;
  if(center<=0.0){discard;}
  let lc=log2(center);
  var sum=0.0;
  for(var k=0;k<8;k++){
    let angle=f32(k)*0.78539816;
    let q=clamp(p+vec2i(round(vec2f(cos(angle),sin(angle))*params.y)),vec2i(0),size-1);
    let n=textureLoad(depths,q,0).r;
    if(n>0.0){sum+=max(0.0,select(lc-log2(n),(center-n)*params.z,params.z>0.0));}
  }
  let shade=exp(-sum/8.0*300.0*params.x);
  return vec4f(shade,shade,shade,1.0);
}
`;
