// Clean-room equations and trade-offs: docs/clean-room.md, batch 171 LIC.
import { frameWGSL } from './render.js';

const bindings = /* wgsl */ `
struct Lic {
  model: mat4x4f, origin: vec4f, axisU: vec4f, axisV: vec4f,
  gridOrigin: vec4f, gridU: vec4f, gridV: vec4f, dualU: vec4f, dualV: vec4f,
  dims: vec4u, image: vec4u, style: vec4f, colour: vec4f
}
@group(1) @binding(0) var<uniform> lic: Lic;
`;

/** @internal One independent streamline convolution per image texel, retained between changes. */
export const licCompute = /* wgsl */ `${bindings}
@group(1) @binding(1) var<storage, read> field: array<vec4f>;
@group(1) @binding(2) var<storage, read_write> image: array<vec4f>;
fn missing(v: f32) -> bool { return (bitcast<u32>(v) & 0x7fffffffu) > 0x7f800000u; }
fn sampleField(uv: vec2f) -> vec4f {
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) { return vec4f(0.0, 0.0, 0.0, -1.0); }
  let p = lic.gridOrigin.xyz + uv.x * lic.gridU.xyz + uv.y * lic.gridV.xyz;
  if (any(p < vec3f(0.0)) || any(p > vec3f(1.0))) { return vec4f(0.0, 0.0, 0.0, -1.0); }
  let q = p * vec3f(lic.dims.xyz - vec3u(1u));
  let lo = min(vec3u(q), lic.dims.xyz - vec3u(1u));
  let hi = min(lo + vec3u(1u), lic.dims.xyz - vec3u(1u));
  let t = q - vec3f(lo);
  var sum = vec4f(0.0);
  for (var z = 0u; z < 2u; z++) {
    for (var y = 0u; y < 2u; y++) {
      for (var x = 0u; x < 2u; x++) {
        let weight = select(1.0 - t.x, t.x, x == 1u) * select(1.0 - t.y, t.y, y == 1u) * select(1.0 - t.z, t.z, z == 1u);
        if (weight > 0.0) {
          let at = select(lo, hi, vec3u(x, y, z) == vec3u(1u));
          let value = field[(at.z * lic.dims.y + at.y) * lic.dims.x + at.x];
          if (missing(value.w)) { return vec4f(0.0, 0.0, 0.0, -1.0); }
          sum += value * weight;
        }
      }
    }
  }
  let direction = vec2f(dot(sum.xyz, lic.dualU.xyz), dot(sum.xyz, lic.dualV.xyz)) * vec2f(lic.image.xy);
  let magnitude = length(direction);
  var velocity = vec2f(0.0);
  if (magnitude > 1e-20) { velocity = direction / magnitude / vec2f(lic.image.xy); }
  let scalar = select(length(sum.xyz) * lic.colour.x + lic.colour.y, sum.w, lic.dims.w == 1u);
  return vec4f(velocity, scalar, 1.0);
}
fn hash(p: vec2u) -> f32 {
  var h = (p.x * 1664525u + p.y * 1013904223u) ^ lic.image.w;
  h = (h ^ (h >> 16u)) * 2246822519u;
  h = (h ^ (h >> 13u)) * 3266489917u;
  h = h ^ (h >> 16u);
  return f32(h >> 8u) / 16777216.0;
}
fn noise(uv: vec2f) -> f32 {
  let q = clamp(uv * vec2f(lic.image.xy) - vec2f(0.5), vec2f(0.0), vec2f(lic.image.xy - vec2u(1u)));
  let lo = vec2u(q); let hi = min(lo + vec2u(1u), lic.image.xy - vec2u(1u));
  let t = fract(q);
  return mix(mix(hash(lo), hash(vec2u(hi.x, lo.y)), t.x), mix(hash(vec2u(lo.x, hi.y)), hash(hi), t.x), t.y);
}
fn weight(s: f32) -> f32 {
  if (lic.style.w < 0.5) { return 1.0; }
  let x = s / f32(lic.image.z + 1u);
  // Hann envelope and three ripples per full window. Signed phase moves downstream.
  return (0.5 + 0.5 * cos(3.141592653589793 * x)) * (0.5 + 0.5 * cos(9.42477796076938 * x + lic.style.z));
}
@compute @workgroup_size(8, 8) fn generate(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= lic.image.xy)) { return; }
  let at = id.y * lic.image.x + id.x;
  let uv = (vec2f(id.xy) + vec2f(0.5)) / vec2f(lic.image.xy);
  let first = sampleField(uv);
  if (first.w < 0.0) { image[at] = vec4f(0.0); return; }
  var total = noise(uv) * weight(0.0);
  var norm = weight(0.0);
  for (var side = 0u; side < 2u; side++) {
    let sign = select(-1.0, 1.0, side == 1u);
    var p = uv;
    for (var i = 1u; i <= lic.image.z; i++) {
      let a = sampleField(p);
      if (a.w < 0.0 || dot(a.xy, a.xy) == 0.0) { break; }
      let mid = sampleField(p + 0.5 * sign * lic.style.x * a.xy);
      if (mid.w < 0.0 || dot(mid.xy, mid.xy) == 0.0) { break; }
      p += sign * lic.style.x * mid.xy;
      if (sampleField(p).w < 0.0) { break; }
      let w = weight(sign * f32(i));
      total += noise(p) * w; norm += w;
    }
  }
  let average = select(noise(uv), total / max(norm, 1e-20), norm > 1e-20);
  image[at] = vec4f(clamp(0.5 + (average - 0.5) * lic.style.y, 0.0, 1.0), first.z, 1.0, 0.0);
}`;

/** @internal The generated LIC image is sampled on its physical slice, without view-dependent integration. */
export const licDraw = /* wgsl */ `${frameWGSL}${bindings}
@group(1) @binding(1) var<storage, read> image: array<vec4f>;
@group(1) @binding(2) var colours: texture_2d<f32>;
@group(1) @binding(3) var colourSampler: sampler;
struct Out { @builtin(position) clip: vec4f, @location(0) uv: vec2f }
@vertex fn vertex(@builtin(vertex_index) index: u32) -> Out {
  let u = select(0.0, 1.0, index == 1u || index == 2u || index == 4u);
  let v = select(0.0, 1.0, index == 2u || index == 4u || index == 5u);
  var out: Out; out.uv = vec2f(u, v);
  out.clip = frame.clip * lic.model * vec4f(lic.origin.xyz + u * lic.axisU.xyz + v * lic.axisV.xyz, 1.0);
  return out;
}
@fragment fn fragment(in: Out) -> @location(0) vec4f {
  let q = clamp(in.uv * vec2f(lic.image.xy) - vec2f(0.5), vec2f(0.0), vec2f(lic.image.xy - vec2u(1u)));
  let lo = vec2u(q); let hi = min(lo + vec2u(1u), lic.image.xy - vec2u(1u));
  let t = fract(q);
  let a = image[lo.y * lic.image.x + lo.x]; let b = image[lo.y * lic.image.x + hi.x];
  let c = image[hi.y * lic.image.x + lo.x]; let d = image[hi.y * lic.image.x + hi.x];
  let value = mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
  if (value.z < 0.999) { discard; }
  let colour = textureSampleLevel(colours, colourSampler, vec2f(clamp(value.y, 0.0, 1.0), 0.5), 0.0).rgb;
  let rgb = mix(vec3f(1.0), colour, lic.colour.w) * value.x;
  return vec4f(toOutput(rgb), lic.colour.z);
}`;
