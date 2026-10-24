// WGSL helpers shared by the environment bakes: cube faces, equirect lookup, Hammersley points and GGX importance
// samples. Kept apart from shaders.ts so entries that need only these (probes) do not bundle the other shaders.
export const common = /* wgsl */ `
const PI = 3.141592653589793;
fn faceDirection(face: u32, uv: vec2f) -> vec3f {
  var d = vec3f(-uv.x, -uv.y, -1.0);
  if (face == 0u) { d = vec3f(1.0, -uv.y, -uv.x); }
  else if (face == 1u) { d = vec3f(-1.0, -uv.y, uv.x); }
  else if (face == 2u) { d = vec3f(uv.x, 1.0, uv.y); }
  else if (face == 3u) { d = vec3f(uv.x, -1.0, -uv.y); }
  else if (face == 4u) { d = vec3f(uv.x, -uv.y, 1.0); }
  return d;
}
// Zero arguments are replaced by +0.0 because some implementations return PI for atan2(-0.0, x > 0).
fn equirectUv(d: vec3f) -> vec2f {
  let x = select(d.x, 0.0, d.x == 0.0);
  let z = select(-d.z, 0.0, d.z == 0.0);
  return vec2f(0.5 + atan2(x, z) / (2.0 * PI), acos(clamp(d.y, -1.0, 1.0)) / PI);
}
fn hammersley(i: u32, n: u32) -> vec2f {
  return vec2f(f32(i) / f32(n), f32(reverseBits(i)) * 2.3283064365386963e-10);
}
// GGX normal distribution sample in tangent space (z = normal), alpha = roughness^2.
fn importanceGGX(xi: vec2f, alpha: f32) -> vec3f {
  let phi = 2.0 * PI * xi.x;
  let cosTheta = sqrt((1.0 - xi.y) / (1.0 + (alpha * alpha - 1.0) * xi.y));
  let sinTheta = sqrt(max(1.0 - cosTheta * cosTheta, 0.0));
  return vec3f(sinTheta * cos(phi), sinTheta * sin(phi), cosTheta);
}
`;
