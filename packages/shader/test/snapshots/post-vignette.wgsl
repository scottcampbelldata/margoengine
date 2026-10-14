
struct Vertex { @builtin(position) position:vec4f,@location(0) uv:vec2f }
@vertex fn vertex(@builtin(vertex_index) index:u32)->Vertex {
 let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[index];
 return Vertex(vec4f(p,0,1),vec2f(p.x*0.5+0.5,0.5-p.y*0.5));
}
@group(0) @binding(0) var ndi0:texture_2d<f32>;
struct NdUniforms {
  amount:f32,
}
@group(0) @binding(1) var<uniform> ndu:NdUniforms;
@fragment fn fragment(v:Vertex)->@location(0) vec4f {
  return vec4f(textureLoad(ndi0, vec2i(v.position.xy), 0).xyz * (smoothstep(0.8, 0.2, length(v.uv - 0.5)) * ndu.amount), 1.0);
}
