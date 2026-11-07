// The node maths of tools/blender-addon/tests/blender_bake.py, checked texel by texel against a baked .margo: shared
// by tests/bake.test.js (the committed Blender 5.2.3 fixture) and scripts/modern-blender-tests.js (a fresh bake when
// MARGO_BLENDER is set).
import { decodePNG } from '../../../tests/support/png.js';

/** sRGB-encoded 8-bit value to linear (IEC 61966-2-1). */
export const linear = (code) => {
  const c = code / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/**
 * Bounds from the maths, per channel. Cycles bakes each texel from jittered samples inside the film filter's
 * 1.5-pixel footprint, so a sample sits at most 0.75 texel from the texel centre; the planes' channels change by at
 * most 1 per unit of u or v, so the bake can differ from the centre value by 0.75 / size. On top of that the 8-bit
 * PNG rounds by half a code: 0.5 / 255 for the linear metallic-roughness channels, and for the sRGB base colour half
 * a code times the steepest slope of the sRGB decode (2.4 / 1.055 / 255 per code, at code 255).
 */
export function bakeBounds(size) {
  const sample = 0.75 / size,
    code = (0.5 * 2.4) / 1.055 / 255;
  return { color: sample + code, linear: sample + 0.5 / 255, constant: code };
}

/**
 * The largest difference per channel between the asset's baked "Procedural" material and its node maths at each texel
 * centre (Base Color = (u, v, 0.25), Roughness = 0.25 + 0.5 u, Metallic = v), and the "Painted" Diffuse BSDF's baked
 * albedo against its colour (0.2, 0.5, 0.8), a constant that only the rounding bound applies to. Texel (x, y) of a PNG (top row first) holds u = (x + 0.5) / size and
 * v = 1 - (y + 0.5) / size: the exporter writes rows top-down and V flipped, as glTF samples them.
 */
export async function bakeErrors(asset) {
  const materials = asset.document.materials,
    image = async (slot) => {
      const texture = asset.document.textures[slot.index];
      return decodePNG(asset.images[texture.source]);
    };
  const procedural = materials.find((m) => m.name === 'Procedural'),
    painted = materials.find((m) => m.name === 'Painted');
  const base = await image(procedural.pbrMetallicRoughness.baseColorTexture),
    packed = await image(procedural.pbrMetallicRoughness.metallicRoughnessTexture),
    albedo = await image(painted.pbrMetallicRoughness.baseColorTexture),
    paintedPacked = await image(painted.pbrMetallicRoughness.metallicRoughnessTexture);
  const size = base.width,
    errors = { r: 0, g: 0, b: 0, roughness: 0, metallic: 0, occlusion: 0, painted: 0, paintedRoughness: 0 };
  const worse = (key, value) => (errors[key] = Math.max(errors[key], Math.abs(value)));
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size,
        v = 1 - (y + 0.5) / size,
        i = (y * size + x) * 4;
      worse('r', linear(base.data[i]) - u);
      worse('g', linear(base.data[i + 1]) - v);
      worse('b', linear(base.data[i + 2]) - 0.25);
      worse('occlusion', packed.data[i] / 255);
      worse('roughness', packed.data[i + 1] / 255 - (0.25 + 0.5 * u));
      worse('metallic', packed.data[i + 2] / 255 - v);
      for (const [c, want] of [0.2, 0.5, 0.8].entries()) worse('painted', linear(albedo.data[i + c]) - want);
      worse('paintedRoughness', paintedPacked.data[i + 1] / 255 - 1);
    }
  return { size, errors, bounds: bakeBounds(size) };
}
