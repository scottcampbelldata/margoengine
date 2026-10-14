
struct Vertex { @builtin(position) position:vec4f,@location(0) uv:vec2f }
@vertex fn vertex(@builtin(vertex_index) index:u32)->Vertex {
 let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[index];
 return Vertex(vec4f(p,0,1),vec2f(p.x*0.5+0.5,0.5-p.y*0.5));
}
@group(0) @binding(0) var ndi0:texture_2d<f32>;
@group(0) @binding(1) var nds1:sampler;
fn luminance(p0:vec3f) -> f32 {
  return dot(p0, vec3f(0.2126, 0.7152, 0.0722));
}
fn fade(t: f32) -> f32 { return t * t * (3.0 - 2.0 * t); }
@fragment fn fragment(v:Vertex)->@location(0) vec4f {
  var nd0 = vec3f(0.0);
  for (var nd1 = 0i; nd1 < 4i; nd1++) {
    nd0 = nd0 + textureSampleLevel(ndi0, nds1, v.uv + vec2f(f32(nd1) * 0.002, 0.0), 0.0).xyz;
  }
  let nd2 = nd0 / 4.0;
  let nd3 = luminance(nd2);
  return vec4f(select(mix(vec3f(nd3), nd2, vec3f(fade(v.uv.x))), nd2, nd3 > 0.5), 1.0);
}
