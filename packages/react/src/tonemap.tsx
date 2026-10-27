import { usePass, type EffectClass, type TonemapProps } from './composer.js';
import { optionalPeer } from './optional.js';

export type { TonemapProps } from './composer.js';

const loadTonemap = () =>
  optionalPeer('@margoengine/tonemap', () => import('@margoengine/tonemap')).then(
    (api) => api.Tonemap as unknown as EffectClass,
  );

/** The tonemap component. */
export function Tonemap({ onReady, onError, lut, ...options }: TonemapProps) {
  usePass('tonemap', loadTonemap, options, { onReady, onError }, lut);
  return null;
}
