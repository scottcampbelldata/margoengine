// CPU mirrors for the probe checks: 8-bit sRGB of each path's tone curve, and the roughness the shaders receive.
import { pbrNeutral } from '../../../packages/shared/display.js';

export const srgb = (c) =>
  Math.round(255 * Math.min(1, Math.max(0, c >= 0.0031308 ? 1.055 * c ** (1 / 2.4) - 0.055 : c * 12.92)));
// Core (`let mapped=pbrNeutral(max(linear,vec3f(0)))`, since b4675ba36) and gltf-pro both end with Khronos PBR Neutral
// (packages/shared/display.js) and the exact sRGB encoding.
const neutral = (rgb) => pbrNeutral(rgb.map((c) => Math.max(c, 0))).map(srgb);
export const output = { core: neutral, materials: neutral };
// Core's PbrMaterial and the materials package clamp roughness to at least 0.045 and upload it as float32.
export const materialRoughness = (r) => Math.fround(Math.max(0.045, r));
