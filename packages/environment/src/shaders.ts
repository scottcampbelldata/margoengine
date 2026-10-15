// WGSL for environment processing and the background pass.
// Cube face convention (WebGPU/D3D/GL): layers +X, -X, +Y, -Y, +Z, -Z; within a face u grows to the right
// and v grows down the texel rows, both in -1..1.
// Equirect convention: u = 0.5 + atan2(d.x, -d.z) / 2PI (image center faces -Z, +X is right of center),
// v = acos(d.y) / PI (row 0 is straight up, +Y).

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

export const equirectToCube = common + /* wgsl */ `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var destination: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(3) var<uniform> params: vec4u; // size, supersampling
@compute @workgroup_size(8, 8, 1) fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = params.x;
  if (id.x >= size || id.y >= size) { return; }
  let n = params.y;
  var sum = vec3f(0.0);
  for (var j = 0u; j < n; j++) {
    for (var i = 0u; i < n; i++) {
      let uv = (vec2f(id.xy) + (vec2f(f32(i), f32(j)) + 0.5) / f32(n)) / f32(size) * 2.0 - 1.0;
      sum += textureSampleLevel(source, linearSampler, equirectUv(normalize(faceDirection(id.z, uv))), 0.0).rgb;
    }
  }
  textureStore(destination, id.xy, id.z, vec4f(sum / f32(n * n), 1.0));
}
`;

export const downsample = /* wgsl */ `
@group(0) @binding(0) var source: texture_2d_array<f32>;
@group(0) @binding(1) var destination: texture_storage_2d_array<rgba16float, write>;
@compute @workgroup_size(8, 8, 1) fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(destination).x;
  if (id.x >= size || id.y >= size) { return; }
  let p = id.xy * 2u;
  let c = textureLoad(source, p, id.z, 0) + textureLoad(source, p + vec2u(1u, 0u), id.z, 0)
        + textureLoad(source, p + vec2u(0u, 1u), id.z, 0) + textureLoad(source, p + vec2u(1u, 1u), id.z, 0);
  textureStore(destination, id.xy, id.z, vec4f(c.rgb * 0.25, 1.0));
}
`;

// Karis split-sum specular prefilter with N = V = R, rendered one face and mip at a time. Each sample reads
// the source mip whose texel solid angle matches the sample's solid angle (GPU Gems 3 ch. 20 filtered
// importance sampling), which removes fireflies from small bright sources at low sample counts.
export const prefilter = common + /* wgsl */ `
struct Params { roughness: f32, sourceSize: f32, samples: u32, lod0: f32, face: u32, size: f32 }
@group(0) @binding(0) var source: texture_cube<f32>;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var<uniform> params: Params;
@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  return vec4f(vec2f(f32((index << 1u) & 2u), f32(index & 2u)) * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fragmentMain(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let uv = position.xy / params.size * 2.0 - 1.0;
  let n = normalize(faceDirection(params.face, uv));
  var color = vec3f(0.0);
  if (params.roughness <= 0.0) {
    color = textureSampleLevel(source, linearSampler, n, params.lod0).rgb;
  } else {
    let up = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), abs(n.z) < 0.999);
    let t = normalize(cross(up, n));
    let b = cross(n, t);
    let alpha = params.roughness * params.roughness;
    let a2 = alpha * alpha;
    let texelSolidAngle = 4.0 * PI / (6.0 * params.sourceSize * params.sourceSize);
    var weight = 0.0;
    for (var i = 0u; i < params.samples; i++) {
      let hl = importanceGGX(hammersley(i, params.samples), alpha);
      let h = t * hl.x + b * hl.y + n * hl.z;
      let l = 2.0 * hl.z * h - n;
      let nl = dot(n, l);
      if (nl > 0.0) {
        let q = hl.z * hl.z * (a2 - 1.0) + 1.0;
        let pdf = a2 / (PI * q * q) * 0.25; // D * NdotH / (4 VdotH) with V = N
        let sampleSolidAngle = 1.0 / (f32(params.samples) * pdf + 1e-6);
        let lod = max(0.5 * log2(sampleSolidAngle / texelSolidAngle) + 1.0, params.lod0);
        color += textureSampleLevel(source, linearSampler, l, lod).rgb * nl;
        weight += nl;
      }
    }
    color /= max(weight, 1e-6);
  }
  return vec4f(color, 1.0);
}
`;

// Projects the cube onto the 9 real L2 spherical harmonics with exact per-texel solid angles, reduced in
// one 64-thread workgroup. Output: result[0..8] = irradiance / PI coefficients (diffuse ready),
// result[16..24] = radiance coefficients.
export const sphericalHarmonics = common + /* wgsl */ `
@group(0) @binding(0) var source: texture_2d_array<f32>;
@group(0) @binding(1) var<storage, read_write> result: array<vec4f, 32>;
var<workgroup> partial: array<vec4f, 576>; // 64 threads x 9 coefficients
// atan(xy / r) rather than atan2: r > 0, and atan2(-0.0, r) returns PI on some implementations.
fn areaElement(x: f32, y: f32) -> f32 { return atan(x * y / sqrt(x * x + y * y + 1.0)); }
@compute @workgroup_size(64) fn main(@builtin(local_invocation_index) li: u32) {
  let size = textureDimensions(source).x;
  let faceTexels = size * size;
  let inv = 1.0 / f32(size);
  var acc: array<vec3f, 9>;
  for (var i = li; i < faceTexels * 6u; i += 64u) {
    let face = i / faceTexels;
    let rem = i % faceTexels;
    let x = rem % size;
    let y = rem / size;
    let u0 = f32(x) * 2.0 * inv - 1.0;
    let v0 = f32(y) * 2.0 * inv - 1.0;
    let u1 = u0 + 2.0 * inv;
    let v1 = v0 + 2.0 * inv;
    let solidAngle = areaElement(u0, v0) - areaElement(u0, v1) - areaElement(u1, v0) + areaElement(u1, v1);
    let d = normalize(faceDirection(face, vec2f(u0 + inv, v0 + inv)));
    let c = textureLoad(source, vec2u(x, y), face, 0).rgb * solidAngle;
    acc[0] += c * 0.282094792;
    acc[1] += c * (0.488602512 * d.y);
    acc[2] += c * (0.488602512 * d.z);
    acc[3] += c * (0.488602512 * d.x);
    acc[4] += c * (1.092548431 * d.x * d.y);
    acc[5] += c * (1.092548431 * d.y * d.z);
    acc[6] += c * (0.315391565 * (3.0 * d.z * d.z - 1.0));
    acc[7] += c * (1.092548431 * d.x * d.z);
    acc[8] += c * (0.546274215 * (d.x * d.x - d.y * d.y));
  }
  for (var k = 0u; k < 9u; k++) { partial[li * 9u + k] = vec4f(acc[k], 0.0); }
  workgroupBarrier();
  for (var stride = 32u; stride > 0u; stride >>= 1u) {
    if (li < stride) {
      for (var k = 0u; k < 9u; k++) { partial[li * 9u + k] += partial[(li + stride) * 9u + k]; }
    }
    workgroupBarrier();
  }
  if (li == 0u) {
    for (var k = 0u; k < 9u; k++) {
      let band = select(select(0.25, 2.0 / 3.0, k < 4u), 1.0, k == 0u);
      result[k] = vec4f(partial[k].xyz * band, 0.0);
      result[16u + k] = vec4f(partial[k].xyz, 0.0);
    }
  }
}
`;

// Split-sum environment BRDF: x = NdotV, y = perceptual roughness (texel centers), output (scale, bias)
// so that specular = prefiltered * (F0 * scale + bias). Uses the same GGX D and separable Smith-GGX G as core.
// Written as size x size f16 pairs into a storage buffer (not a texture): IBL then binds one sampled texture.
export const brdfLut = common + /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> destination: array<u32>;
@group(0) @binding(1) var<uniform> params: vec4u; // samples, size
fn smithG1(x: f32, a2: f32) -> f32 { return 2.0 * x / (x + sqrt(a2 + (1.0 - a2) * x * x)); }
@compute @workgroup_size(8, 8, 1) fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = params.y;
  if (id.x >= size || id.y >= size) { return; }
  let nv = (f32(id.x) + 0.5) / f32(size);
  let roughness = (f32(id.y) + 0.5) / f32(size);
  let alpha = roughness * roughness;
  let a2 = alpha * alpha;
  let v = vec3f(sqrt(1.0 - nv * nv), 0.0, nv);
  var scale = 0.0;
  var bias = 0.0;
  let samples = params.x;
  for (var i = 0u; i < samples; i++) {
    let h = importanceGGX(hammersley(i, samples), alpha);
    let vh = clamp(dot(v, h), 0.0, 1.0);
    let l = 2.0 * vh * h - v;
    if (l.z > 0.0 && vh > 0.0) {
      let g = smithG1(nv, a2) * smithG1(l.z, a2);
      let visibility = g * vh / (h.z * nv);
      let fc = pow(1.0 - vh, 5.0);
      scale += (1.0 - fc) * visibility;
      bias += fc * visibility;
    }
  }
  destination[id.y * size + id.x] = pack2x16float(vec2f(scale, bias) / f32(samples));
}
`;

// Full-screen background at reversed-Z depth 0, so the 'greater-equal' test only passes where the depth
// buffer still holds its cleared value. Output matches core: Reinhard then sRGB encode into the canvas
// format, or linear radiance when the destination is an HDR rgba16float buffer (outputHdr).
export const background = common + /* wgsl */ `
struct Uniforms { inverseViewProjection: mat4x4f, eye: vec4f, params: vec4f, mode: vec4u }
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var equirect: texture_2d<f32>;
@group(0) @binding(3) var cube: texture_cube<f32>;
@group(0) @binding(4) var specular: texture_cube<f32>;
override outputHdr: bool = false;
struct Varyings { @builtin(position) position: vec4f, @location(0) ndc: vec2f }
@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> Varyings {
  let p = vec2f(f32((index << 1u) & 2u), f32(index & 2u)) * 2.0 - 1.0;
  var out: Varyings;
  out.position = vec4f(p, 0.0, 1.0);
  out.ndc = p;
  return out;
}
@fragment fn fragmentMain(v: Varyings) -> @location(0) vec4f {
  let world = u.inverseViewProjection * vec4f(v.ndc, 0.5, 1.0);
  let ray = normalize(world.xyz / world.w - u.eye.xyz);
  let c = u.params.y;
  let s = u.params.z;
  let d = vec3f(c * ray.x - s * ray.z, ray.y, s * ray.x + c * ray.z);
  var color: vec3f;
  if (u.mode.x == 0u) {
    color = textureSampleLevel(equirect, linearSampler, equirectUv(d), 0.0).rgb;
  } else if (u.mode.x == 1u) {
    color = textureSampleLevel(cube, linearSampler, d, 0.0).rgb;
  } else {
    color = textureSampleLevel(specular, linearSampler, d, u.params.w).rgb;
  }
  color *= u.params.x;
  if (outputHdr) { return vec4f(color, 1.0); }
  let mapped = color / (1.0 + color);
  return vec4f(select(mapped * 12.92, 1.055 * pow(mapped, vec3f(1.0 / 2.4)) - 0.055, mapped >= vec3f(0.0031308)), 1.0);
}
`;
