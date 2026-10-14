
struct Vertex { @builtin(position) position:vec4f,@location(0) uv:vec2f }
@vertex fn vertex(@builtin(vertex_index) index:u32)->Vertex {
 let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[index];
 return Vertex(vec4f(p,0,1),vec2f(p.x*0.5+0.5,0.5-p.y*0.5));
}
@group(0) @binding(0) var ndi0:texture_2d<f32>;
@group(0) @binding(1) var ndd1:texture_depth_2d;
fn aces(v:vec3f)->vec3f{let x=mat3x3f(vec3f(0.59719,0.076,0.0284),vec3f(0.35458,0.90834,0.13383),vec3f(0.04823,0.01566,0.83777))*v;return clamp(mat3x3f(vec3f(1.60475,-0.10208,-0.00327),vec3f(-0.53108,1.10813,-0.07276),vec3f(-0.07367,-0.00605,1.07602))*((x*(x+0.0245786)-0.000090537)/(x*(0.983729*x+0.432951)+0.238081)),vec3f(0),vec3f(1));}
@fragment fn fragment(v:Vertex)->@location(0) vec4f {
  let c = vec4f(mix(textureLoad(ndi0, vec2i(v.position.xy), 0).xyz, vec3f(0.6, 0.7, 0.8), vec3f(clamp(1.0 - (textureLoad(ndd1, vec2i(v.position.xy), 0) * 50.0), 0.0, 1.0))), 1.0);
  let x = aces(max(c.rgb, vec3f(0.0)) / 0.6);
  return vec4f(select(x * 12.92, 1.055 * pow(x, vec3f(1.0 / 2.4)) - 0.055, x >= vec3f(0.0031308)), c.a);
}
