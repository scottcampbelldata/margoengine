// Clean room: periodic lattice interpolation and structural tiling from the
// procedural-noise survey and Lefebvre/Poulin rectangular model. No source port.
export const textureShader = /* wgsl */ `
struct Params {
  size: vec2u, kind: u32, seed: u32,
  repeat: vec2f, detail: f32, grout: f32,
  color: vec4f, secondary: vec4f,
  offset: vec2f, stagger: f32, padding: f32,
}
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var outputImage: texture_storage_2d<rgba8unorm, write>;
fn hash(cell: vec2u) -> f32 {
  var h = (cell.x * 1597334677u) ^ (cell.y * 3812015801u) ^ p.seed;
  h = (h ^ (h >> 16u)) * 2246822519u;
  h = (h ^ (h >> 13u)) * 3266489917u;
  return f32((h ^ (h >> 16u)) >> 8u) / 16777215.0;
}
fn noise(uv: vec2f, period: u32) -> f32 {
  let q = uv * f32(period); let cell = vec2u(floor(q));
  let f = fract(q); let t = f*f*f*(f*(f*6.0-15.0)+10.0);
  let a = hash(cell % vec2u(period));
  let b = hash((cell+vec2u(1u,0u)) % vec2u(period));
  let c = hash((cell+vec2u(0u,1u)) % vec2u(period));
  let d = hash((cell+vec2u(1u,1u)) % vec2u(period));
  return mix(mix(a,b,t.x),mix(c,d,t.x),t.y);
}
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if any(id.xy >= p.size) { return; }
  let uv = fract((vec2f(id.xy)+0.5)/vec2f(p.size)+p.offset);
  let n = (noise(uv,4u)*8.0+noise(uv,8u)*4.0+noise(uv,16u)*2.0+noise(uv,32u))/15.0;
  var value = n;
  if p.kind == 1u || p.kind == 2u {
    let row = u32(floor(uv.y*p.repeat.y));
    let shift = select(0.0,f32(row%2u)*p.stagger,p.kind==1u);
    let local = fract(uv*p.repeat+vec2f(shift,0.0));
    let edge = min(local,1.0-local);
    let solid = select(0.0,1.0,all(edge >= vec2f(p.grout)));
    value = solid * (1.0-p.detail*(1.0-n));
  } else if p.kind == 3u {
    // Wavy longitudinal bands on a torus; not a biological volumetric wood model.
    let ring = 0.5+0.5*cos(6.28318530718*(uv.x*p.repeat.x+p.detail*n));
    value = 0.2+0.8*ring;
  } else if p.kind == 4u {
    value = smoothstep(0.35-p.detail*0.2,0.65+p.detail*0.2,n);
  }
  textureStore(outputImage,vec2i(id.xy),vec4f(mix(p.secondary.rgb,p.color.rgb,value),1.0));
}
`;
