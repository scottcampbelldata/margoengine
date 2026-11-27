// The corpus rule for modules whose `enable` names an extension the WebGL2 layer does not map (all but f16): the
// layer refuses each one with its coded compatibility error naming the extension, and the corpus tests count them
// per name. The packages build these modules only when the device offers the feature (compute's subgroup kernels
// on `subgroups`, packages/compute/src/context.ts; materials' clip planes on `clip-distances`,
// packages/materials/src/built-material.ts), and the layer offers neither, so in use they never reach it; the corpus
// holds them because the real-GPU recordings ran on devices that do. A count above the recorded one fails: a new
// module behind an unmapped extension needs its reason recorded here.
import assert from 'node:assert/strict';

/**
 * The recorded refusals per extension name, per test: the compute planner counts modules with compute entry points
 * (compute.test.js), the GLSL corpus check counts render pipelines plus vertex and fragment entry points it
 * translates (glsl-corpus-browser.mjs), the draw check counts the render pipelines it creates (corpus-draw-browser.mjs).
 */
export const RECORDED_UNMAPPED_ENABLES = {
  compute: { subgroups: 23 },
  glsl: { clip_distances: 18 },
  draw: { clip_distances: 4 },
};

/**
 * Compute kernels sized past WebGPU's default 256 invocations per workgroup. compute tunes its kernels to the
 * device's maxComputeInvocationsPerWorkgroup (packages/compute/src/context.ts requests the adapter's), the
 * recordings ran on adapters that grant 512 and 1024, and the layer's device offers 256 (src/device/device.ts), so
 * on the layer compute builds its 256 versions; createComputePipeline and the planner refuse the larger ones by
 * WebGPU's limits.
 */
export const RECORDED_OVER_INVOCATIONS = { compute: 12 };

/** The first extension a checked module enables that the layer does not map, or undefined. */
export function unmappedEnable(module) {
  return module.enables.find((name) => name !== 'f16');
}

/** Asserts that `error` is the layer's coded refusal of `enable <name>;`. */
export function assertEnableRefusal(error, name, what) {
  assert.equal(error?.code, 'unsupported', `${what}: expected the coded refusal of 'enable ${name};', got ${error}`);
  assert.ok(
    String(error.message).includes(`'enable ${name};'`),
    `${what}: the refusal must name 'enable ${name};', got ${error.message}`,
  );
  assert.match(String(error.message), /errors#compatibility-layer/, `${what}: the refusal carries its help link`);
}

/** Asserts that every counted name was recorded and none passes its recorded count. */
export function assertUnmappedCounts(counts, recorded, what) {
  for (const [name, n] of Object.entries(counts)) {
    assert.ok(name in recorded, `${what}: ${n} refusals of 'enable ${name};', which no recorded count covers`);
    assert.ok(
      n <= recorded[name],
      `${what}: ${n} refusals of 'enable ${name};', more than the recorded ${recorded[name]}`,
    );
  }
}

/**
 * Recorded render pipelines past WebGL2's texture units, by module key, with their cause. A pipeline of any other
 * module refused for its units fails the corpus checks.
 */
export const RECORDED_OVER_UNITS = {
  // khronos-gallery's extended glTF material with all 8 extension maps, recorded on WebGPU with its five base maps
  // apart: 16 sampled textures (WebGPU's limit) and the group-2 storage data texture take 19 layer units (each shadow
  // map compared and loaded is two). On the layer gltf/pbr asks the device first (compatTextureUnits) and composes
  // the material with its base maps packed into one array, 4 units fewer; scripts/compat-units-gpu-check.js --compat
  // draws that material on the layer.
  '7ba63815075dd8da': 'gltf/pbr packs this material on the layer',
};

/** True when `error` is the layer's coded refusal of a pipeline past its texture units (errors#texture-units). */
export function isUnitsRefusal(error) {
  return (
    error?.code === 'unsupported' &&
    /texture units/.test(String(error.message)) &&
    /errors#texture-units/.test(String(error.message))
  );
}

/** Asserts that every pipeline refused for its units (`[module key, what]`) belongs to a recorded module. */
export function assertOverUnits(refused, what) {
  for (const [key, id] of refused)
    assert.ok(
      key in RECORDED_OVER_UNITS,
      `${what}: ${id} is refused for its texture units, and no recorded cause covers it`,
    );
}
