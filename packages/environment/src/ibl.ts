// What a PBR shader needs to light with an Environment: bindings, entries and WGSL helpers.
import type { Environment } from './environment.js';

declare const GPUShaderStage: { FRAGMENT: number };

/**
 * WGSL helpers for image-based lighting. Declare the five bindings yourself (any group and binding numbers),
 * paste this string into your module, and call `iblShade`. Expected declarations:
 *
 *   var iblSpecular: texture_cube<f32>;      // environment.specularView
 *   var iblSampler: sampler;                 // environment.sampler (filtering, clamp)
 *   var<storage, read> iblBrdf: array<u32>;  // environment.brdfLut (read by name: WGSL cannot pass it)
 *   var<uniform> iblSh: array<vec4f, 9>;     // environment.shBuffer, offset 0, size 144
 *   var<uniform> iblParams: vec4f;           // environment.paramsBuffer: cos(rot), sin(rot), maxLod, intensity
 */
export const IBL_WGSL = /* wgsl */ `
fn iblRotate(d: vec3f, params: vec4f) -> vec3f {
  return vec3f(params.x * d.x - params.y * d.z, d.y, params.y * d.x + params.x * d.z);
}
// Diffuse-ready irradiance / PI for a unit world normal (already rotated). Multiply by albedo.
fn iblIrradiance(sh: array<vec4f, 9>, n: vec3f) -> vec3f {
  return max(sh[0].rgb * 0.282094792
    + sh[1].rgb * (0.488602512 * n.y) + sh[2].rgb * (0.488602512 * n.z) + sh[3].rgb * (0.488602512 * n.x)
    + sh[4].rgb * (1.092548431 * n.x * n.y) + sh[5].rgb * (1.092548431 * n.y * n.z)
    + sh[6].rgb * (0.315391565 * (3.0 * n.z * n.z - 1.0)) + sh[7].rgb * (1.092548431 * n.x * n.z)
    + sh[8].rgb * (0.546274215 * (n.x * n.x - n.y * n.y)), vec3f(0.0));
}
// Prefiltered radiance for perceptual roughness (0..1) along a world direction (rotation applied here).
fn iblPrefiltered(specular: texture_cube<f32>, s: sampler, params: vec4f, r: vec3f, roughness: f32) -> vec3f {
  return textureSampleLevel(specular, s, iblRotate(r, params), clamp(roughness, 0.0, 1.0) * params.z).rgb;
}
// Split-sum scale and bias for F0: specular = prefiltered * (F0 * x + y). Bilinear, clamp to edge, like sampling the
// LUT as a texture; a buffer keeps IBL to one sampled texture (physical glTF + every light fits WebGPU's 16).
fn iblBrdfTerms(nv: f32, roughness: f32) -> vec2f {
  let n = i32(round(sqrt(f32(arrayLength(&iblBrdf)))));
  let p = clamp(vec2f(nv, roughness), vec2f(0.0), vec2f(1.0)) * f32(n) - 0.5;
  let a = vec2i(floor(p)); let t = p - floor(p);
  let lo = clamp(a, vec2i(0), vec2i(n - 1)); let hi = clamp(a + 1, vec2i(0), vec2i(n - 1));
  let lut = vec4i(lo.y * n + lo.x, lo.y * n + hi.x, hi.y * n + lo.x, hi.y * n + hi.x);
  return mix(mix(unpack2x16float(iblBrdf[lut.x]), unpack2x16float(iblBrdf[lut.y]), t.x),
             mix(unpack2x16float(iblBrdf[lut.z]), unpack2x16float(iblBrdf[lut.w]), t.x), t.y);
}
// Complete ambient term for a metallic-roughness material. n and v are unit world vectors (v points to the eye).
fn iblShade(specular: texture_cube<f32>, s: sampler, sh: array<vec4f, 9>, params: vec4f,
            n: vec3f, v: vec3f, baseColor: vec3f, metalness: f32, roughness: f32) -> vec3f {
  let nv = clamp(dot(n, v), 1e-4, 1.0);
  let f0 = mix(vec3f(0.04), baseColor, metalness);
  let ab = iblBrdfTerms(nv, roughness);
  let specularWeight = f0 * ab.x + ab.y;
  let radiance = iblPrefiltered(specular, s, params, reflect(-v, n), roughness);
  let diffuse = (1.0 - specularWeight) * (1.0 - metalness) * baseColor * iblIrradiance(sh, iblRotate(n, params));
  return (diffuse + radiance * specularWeight) * params.w;
}
`;

/** Bind group layout entries for the five IBL resources, numbered from `firstBinding`. */
export function iblLayoutEntries(firstBinding = 0, visibility?: number): GPUBindGroupLayoutEntry[] {
  const v = visibility ?? GPUShaderStage.FRAGMENT;
  return [
    { binding: firstBinding, visibility: v, texture: { sampleType: 'float', viewDimension: 'cube' } },
    { binding: firstBinding + 1, visibility: v, sampler: { type: 'filtering' } },
    { binding: firstBinding + 2, visibility: v, buffer: { type: 'read-only-storage' } },
    { binding: firstBinding + 3, visibility: v, buffer: { type: 'uniform', minBindingSize: 144 } },
    { binding: firstBinding + 4, visibility: v, buffer: { type: 'uniform', minBindingSize: 16 } },
  ];
}

/** Bind group entries matching `iblLayoutEntries`. Rebuild them when `environment.version` changes. */
export function iblBindGroupEntries(environment: Environment, firstBinding = 0): GPUBindGroupEntry[] {
  return [
    { binding: firstBinding, resource: environment.specularView },
    { binding: firstBinding + 1, resource: environment.sampler },
    { binding: firstBinding + 2, resource: { buffer: environment.brdfLut } },
    { binding: firstBinding + 3, resource: { buffer: environment.shBuffer, offset: 0, size: 144 } },
    { binding: firstBinding + 4, resource: { buffer: environment.paramsBuffer, offset: 0, size: 16 } },
  ];
}
