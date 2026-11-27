// What is blended over a scene capture, for effects that take ambient light back out of it (SSAO, GTAO). Their ambient
// replay holds the light of the surface that owns each pixel's depth. A strip blended over it with alpha a leaves only
// 1 - a of that surface in the picture, so taking all of that light out of the pixel took more than it held, down to
// black (KB-SCENES-GRASSBLACK1). A veil draws its coverage over the replay target, scaling the light there by 1 - a.
// The set sits on the device under a registered symbol, because each package bundles its own copy of this file.
const key = /* @__PURE__ */ Symbol.for('margoengine.ambientVeils');

/** Adds `veil` to `device`'s ambient veils; returns the remover. */
export function addAmbientVeil(device, veil) {
  if (!device[key]) device[key] = new Set();
  const veils = device[key];
  veils.add(veil);
  return () => {
    veils.delete(veil);
  };
}

/**
 * Draws every veil of `context.device` over `context.color`, a target of `format`, against `context.depth`. A veil that
 * drew nothing into this frame's view does nothing.
 */
export function drawAmbientVeils(context, format) {
  const veils = context.device[key];
  if (veils?.size) for (const veil of veils) veil.veil(context, format);
}
