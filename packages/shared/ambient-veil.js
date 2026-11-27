// What is blended over a scene capture, for effects that take ambient light back out of it (SSAO, GTAO). Their ambient
// replay holds the light of the surface that owns each pixel's depth. A strip blended over it with alpha a leaves only
// 1 - a of that surface in the picture, so taking all of that light out of the pixel took more than it held, down to
// black (KB-SCENES-GRASSBLACK1). A veil draws its coverage over the replay target, scaling the light there by 1 - a.
// The set sits on the device under a registered symbol, because each package bundles its own copy of this file.
//
// Covered depth (KB-SCATTER-AOFRINGE1): a covered strip writes depth where a hash of its coverage passes, so most of
// such a pixel's colour is still the surface under it. An effect that wants that surface (`wantUnder`) is told, by
// `markCover` from the strip's owner, that this frame's covered depth is held back until after its `under` pass, so it
// can keep the depth and ambient light of the surface under the strips before that depth lands.
const key = /* @__PURE__ */ Symbol.for('margoengine.ambientVeils');
const under = /* @__PURE__ */ Symbol.for('margoengine.ambientUnder');
const marked = /* @__PURE__ */ Symbol.for('margoengine.ambientCover');

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
 * Draws every veil of `context.device` over `context.color`, a target of `format`, against `context.depth`, except
 * those in `skip`; adds each veil that drew to `drew`. A veil that drew nothing into this frame's view does nothing.
 */
export function drawAmbientVeils(context, format, skip, drew) {
  const veils = context.device[key];
  if (veils?.size) for (const veil of veils) if (!skip?.has(veil) && veil.veil(context, format)) drew?.add(veil);
}

/** Registers an effect that reads the surface under covered strips on `device`; returns the remover. */
export function wantUnder(device) {
  device[under] = (device[under] ?? 0) + 1;
  let left = false;
  return () => {
    if (!left) device[under]--;
    left = true;
  };
}

/** True while an effect on `device` reads the surface under covered strips (`wantUnder`). */
export function underWanted(device) {
  return device[under] > 0;
}

/** Marks that this frame's view (`context`) holds its covered depth back until after the effects' `under` pass. */
export function markCover(context) {
  const mark = (context.device[marked] ??= {});
  mark.encoder = context.encoder;
  mark.view = context.view;
  mark.depth = context.depth;
}

/** True when `markCover` was called for this frame's view of `context`. */
export function coverMarked(context) {
  const mark = context.device[marked];
  return !!mark && mark.encoder === context.encoder && mark.view === context.view && mark.depth === context.depth;
}
