@group(0) @binding(0) var image: texture_2d<f32>;
@vertex fn vertex(@builtin(vertex_index) id:u32) -> @builtin(position) vec4f {
  let x=f32((id<<1u)&2u);let y=f32(id&2u);
  return vec4f(x*2-1,1-y*2,0,1);
}
@fragment fn fragment(@builtin(position) p:vec4f) -> @location(0) vec4f {
  let hdr=textureLoad(image,vec2i(p.xy),0).rgb;
  let mapped=clamp((hdr*(2.51*hdr+.03))/(hdr*(2.43*hdr+.59)+.14),vec3f(0),vec3f(1));
  let srgb=select(mapped*12.92,1.055*pow(mapped,vec3f(1.0/2.4))-.055,mapped>vec3f(.0031308));
  return vec4f(srgb,1);
}
