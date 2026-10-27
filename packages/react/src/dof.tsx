import { usePass, type EffectClass, type DepthOfFieldProps } from './composer.js';
import { optionalPeer } from './optional.js';

export type { DepthOfFieldProps } from './composer.js';

const loadDOF = () =>
  optionalPeer('@margoengine/dof', () => import('@margoengine/dof')).then((api) => api.DOF as unknown as EffectClass);

/** The depth of field component. */
export function DepthOfField({ onReady, onError, ...options }: DepthOfFieldProps) {
  usePass('dof', loadDOF, options, { onReady, onError });
  return null;
}
