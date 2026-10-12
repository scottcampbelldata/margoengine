export const terrainVertex=/* wgsl */`
struct Frame {camera:mat4x4f,eye:vec4f,light:vec4f,radiance:vec4f,grid:vec4f,offset:vec4f,map:vec4f,heights:vec4f}
struct Layer {heightSlope:vec4f,params:vec4f}
@group(0) @binding(0) var<uniform> frame:Frame;
@group(0) @binding(1) var heightMap:texture_2d<f32>;
@group(0) @binding(2) var normalMap:texture_2d<f32>;
@group(0) @binding(3) var terrainLayers:texture_2d_array<f32>;
@group(0) @binding(4) var terrainSampler:sampler;
@group(0) @binding(5) var<storage,read> layerRules:array<Layer>;
fn height(position:vec2f)->f32 {
  let dimensions=vec2i(textureDimensions(heightMap));let uv=clamp((position-frame.map.xy)/frame.map.zw,vec2f(0),vec2f(1));let pixel=uv*vec2f(dimensions-vec2i(1));let lo=vec2i(floor(pixel));let hi=min(lo+vec2i(1),dimensions-vec2i(1));let t=fract(pixel);
  let a=mix(textureLoad(heightMap,lo,0).r,textureLoad(heightMap,vec2i(hi.x,lo.y),0).r,t.x);let b=mix(textureLoad(heightMap,vec2i(lo.x,hi.y),0).r,textureLoad(heightMap,hi,0).r,t.x);
  return mix(a,b,t.y)*frame.heights.x+frame.heights.y;
}
struct Output {@builtin(position) clip:vec4f,@location(0) position:vec3f,@location(1) normal:vec3f,@location(2) color:vec3f,@location(3) material:vec4f}
@vertex fn vertex(@location(0) grid:vec2f)->Output {
  let edge=max(abs(grid.x),abs(grid.y));let morph=clamp((edge-frame.grid.w*0.5+2)/2,0.0,1.0);
  let aligned=mix(grid,round(grid*0.5)*2,morph);let inner=clamp((frame.grid.w*0.5-edge)/(frame.grid.w*0.25),0.0,1.0);
  let xz=frame.grid.xy+aligned*frame.grid.z+frame.offset.xy*inner;let position=vec3f(xz.x,height(xz),xz.y);
  let step=frame.map.zw/max(vec2f(textureDimensions(heightMap))-1,vec2f(1));
  var normal=normalize(vec3f((height(xz-vec2f(step.x,0))-height(xz+vec2f(step.x,0)))/(2*step.x),1,(height(xz-vec2f(0,step.y))-height(xz+vec2f(0,step.y)))/(2*step.y)));
  if(frame.offset.w>0.5){let dimensions=vec2i(textureDimensions(normalMap));let uv=clamp((xz-frame.map.xy)/frame.map.zw,vec2f(0),vec2f(1));let sampled=textureLoad(normalMap,min(vec2i(uv*vec2f(dimensions)),dimensions-vec2i(1)),0).xyz*2-1;if(dot(sampled,sampled)>0.00001){normal=normalize(sampled);}}
  var o:Output;o.position=position;o.clip=frame.camera*vec4f(position,1);o.normal=normal;o.color=vec3f(1);o.material=vec4f(0.9,0,1,1);return o;
}
`;
export const terrainFragment=/* wgsl */`
fn terrainColor(position:vec3f,normal:vec3f)->vec3f {
  let slope=1-clamp(normal.y,0.0,1.0);let axes=pow(abs(normal),vec3f(8));let projection=axes/max(axes.x+axes.y+axes.z,0.00001);let dx=dpdx(position);let dy=dpdy(position);var color=vec3f(0);var total=0.0;var fallback=vec3f(0);
  for(var layer=0u;layer<u32(frame.heights.z);layer++){
    let rule=layerRules[layer];let hs=rule.heightSlope;let scale=rule.params.x;let p=position*scale;
    let x=textureSampleGrad(terrainLayers,terrainSampler,p.zy,i32(layer),dx.zy*scale,dy.zy*scale).rgb;
    let y=textureSampleGrad(terrainLayers,terrainSampler,p.xz,i32(layer),dx.xz*scale,dy.xz*scale).rgb;
    let z=textureSampleGrad(terrainLayers,terrainSampler,p.xy,i32(layer),dx.xy*scale,dy.xy*scale).rgb;
    let sample=x*projection.x+y*projection.y+z*projection.z;if(layer==0){fallback=sample;}
    let h=rule.params.y;let s=rule.params.z;
    let weight=smoothstep(hs.x-h,hs.x+h,position.y)*(1-smoothstep(hs.y-h,hs.y+h,position.y))*smoothstep(hs.z-s,hs.z+s,slope)*(1-smoothstep(hs.w-s,hs.w+s,slope));
    color+=sample*weight;total+=weight;
  }
  return select(fallback,color/max(total,0.00001),total>0.00001);
}
@fragment fn fragment(i:Output)->@location(0) vec4f {
  let n=normalize(i.normal);let base=terrainColor(i.position,n);let v=normalize(frame.eye.xyz-i.position);let l=normalize(frame.light.xyz);let h=(v+l)/max(length(v+l),0.0001);
  let nl=clamp(dot(n,l),0.0,1.0);let nv=clamp(dot(n,v),0.0001,1.0);let nh=clamp(dot(n,h),0.0,1.0);let vh=clamp(dot(v,h),0.0,1.0);let a=i.material.x*i.material.x;let a2=a*a;
  let d=a2/(3.14159265*pow(nh*nh*(a2-1)+1,2.0));let g=2*nv/(nv+sqrt(a2+(1-a2)*nv*nv))*2*nl/max(nl+sqrt(a2+(1-a2)*nl*nl),0.0001);let fresnel=vec3f(0.04)+vec3f(0.96)*pow(1-vh,5.0);
  let direct=((1-fresnel)*base/3.14159265+d*g*fresnel/max(4*nl*nv,0.0001))*nl;
  let linear=direct*frame.radiance.xyz*frame.light.w+base*frame.radiance.w;
  if(frame.heights.w>0.5){return vec4f(linear,1);}
  let mapped=linear/(1+linear);return vec4f(select(mapped*12.92,1.055*pow(mapped,vec3f(1.0/2.4))-0.055,mapped>=vec3f(0.0031308)),1);
}`;
