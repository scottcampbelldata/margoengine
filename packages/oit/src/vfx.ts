// Particles, splats and points in an order-independent pass. Each owns its shader and draw; this entry links it to a pass.
import { TransparentPass, type TransparentEffect } from './pass.js';

export type { TransparentEffect, TransparentPass };

/**
 * Draws an effect in an order-independent pass (`OIT`, `ExactOIT`, `MomentOIT`), with the models added to it: `VFX` from
 * `@margoengine/vfx`, `Splats` from `@margoengine/splats`, or a `PointsPlugin` from `@margoengine/points`, whose
 * transparent clouds and sprites go in. The effect leaves its own draw until the returned function is called, the effect
 * is disposed or the pass is.
 * @throws TypeError for anything that is not such an effect.
 * @throws MargoError `'disposed'` after the pass's `dispose()`, `'state'` before its `attach`.
 */
export function addEffect(oit: TransparentPass, effect: TransparentEffect): () => void {
  if (typeof effect?.setTransparency !== 'function' || typeof effect.drawTransparent !== 'function')
    throw new TypeError('addEffect needs a VFX, Splats or PointsPlugin');
  oit.ready();
  let release = oit.effects.get(effect);
  if (!release) {
    const forget = () => {
      if (oit.effects.get(effect) === release) oit.effects.delete(effect);
    };
    const restore = effect.setTransparency(oit, forget);
    release = () => {
      forget();
      restore();
    };
    oit.effects.set(effect, release);
  }
  return release;
}
