struct Frame {
  camera: mat4x4f,
  light: mat4x4f,
  eye: vec4f,
  moon: vec4f,
  ambient: vec4f,
  fog: vec4f,
};
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var shadow: texture_depth_2d;
@group(0) @binding(2) var shadowSampler: sampler_comparison;
struct Vertex {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) m0: vec4f,
  @location(3) m1: vec4f,
  @location(4) m2: vec4f,
  @location(5) m3: vec4f,
  @location(6) color: vec4f,
  @location(7) material: vec4f,
};
struct Surface {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) color: vec3f,
  @location(3) emission: f32,
  @location(4) local: vec2f,
};
@vertex fn vertex(v: Vertex) -> Surface {
  let model=mat4x4f(v.m0,v.m1,v.m2,v.m3);
  let world=model*vec4f(v.position,1);
  let cofactor=mat3x3f(cross(v.m1.xyz,v.m2.xyz),cross(v.m2.xyz,v.m0.xyz),cross(v.m0.xyz,v.m1.xyz));
  var out: Surface;
  out.clip=frame.camera*world;out.world=world.xyz;
  out.normal=normalize(cofactor*v.normal);out.color=v.color.rgb;out.emission=v.material.x;
  out.local=v.position.xy;
  return out;
}
@vertex fn shadow_vertex(v: Vertex) -> @builtin(position) vec4f {
  return frame.light*mat4x4f(v.m0,v.m1,v.m2,v.m3)*vec4f(v.position,1);
}
@fragment fn fragment(v: Surface) -> @location(0) vec4f {
  let n=normalize(v.normal);
  let l=normalize(frame.moon.xyz);
  let diffuse=max(dot(n,l),0);
  let stepped=floor(diffuse*4.0)/4.0;
  let lightPosition=frame.light*vec4f(v.world+n*.04,1);
  let uv=lightPosition.xy*vec2f(.5,-.5)+.5;
  var visibility=1.0;
  if(all(uv>=vec2f(0)) && all(uv<=vec2f(1)) && lightPosition.z>=0 && lightPosition.z<=1) {
    visibility=textureSampleCompareLevel(shadow,shadowSampler,uv,lightPosition.z+.0006);
  }
  let eye=normalize(frame.eye.xyz-v.world);
  let rim=pow(1.0-max(dot(n,eye),0),4.0)*(.045+.135*diffuse);
  var color=v.color*(frame.ambient.rgb+vec3f(.76,.85,1)*(stepped*visibility+rim)*frame.moon.w);
  color+=v.color*v.emission*1.5;
  let distance=length(frame.eye.xyz-v.world);
  let density=frame.fog.w*(1.0+max(-v.world.y,0)*.065);
  let haze=1.0-exp(-distance*density);
  color=mix(color,frame.fog.rgb,haze);
  return vec4f(color,1);
}

@fragment fn lantern_fragment(v: Surface) -> @location(0) vec4f {
  let radiusSquared=dot(v.local*2.0,v.local*2.0);
  let falloff=max(0.0,1.0-radiusSquared);
  let density=frame.fog.w*(1.0+max(-v.world.y,0)*.065);
  let transmission=exp(-length(frame.eye.xyz-v.world)*density);
  return vec4f(v.color*v.emission*falloff*falloff*transmission,0);
}
