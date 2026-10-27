import { usePass, type EffectClass, type TAAProps } from './composer.js';
import { optionalPeer } from './optional.js';

export type { TAAProps } from './composer.js';

const loadTAA = () =>
  optionalPeer('@margoengine/taa', () => import('@margoengine/taa')).then((api) => api.TAA as unknown as EffectClass);

/** The taa component. */
export function TAA({ onReady, onError, ...options }: TAAProps) {
  usePass('taa', loadTAA, options, { onReady, onError });
  return null;
}
