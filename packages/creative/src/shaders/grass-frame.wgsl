struct Frame {
  camera: mat4x4f,
  planes: array<vec4f, 6>,
  eye: vec4f,
  light: vec4f,
  radiance: vec4f,
  wind: vec4f,
  field: vec4f,
  settings: vec4f,
  right: vec4f,
  up: vec4f,
}
struct Blade {
  posX: f32, posY: f32, posZ: f32,
  rotationY: f32, scale: f32, stiffness: f32,
}
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<storage, read> blades: array<Blade>;

fn gust(root: vec2f) -> f32 {
  let p = root * 0.08 + frame.field.w * frame.wind.z * vec2f(0.45, 0.2);
  return 0.5 + 0.25 * sin(p.x * 2.1 + sin(p.y * 1.7)) + 0.25 * sin(p.y * 3.1 - p.x * 0.8);
}
fn displayColor(linear: vec3f) -> vec3f {
  if (frame.settings.z > 0.5) { return linear; }
  let mapped = linear / (linear + 1.0);
  return pow(mapped, vec3f(1.0 / 2.2));
}
