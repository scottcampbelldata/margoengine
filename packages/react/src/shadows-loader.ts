import type { ShadowsLoader } from './internal.js';
import { optionalPeer } from './optional.js';

/** Imports `@margoengine/shadows` for the Canvas (`<Shadows>`, `<ContactShadows>`). */
export const loadShadows: ShadowsLoader = () =>
  optionalPeer('@margoengine/shadows', () => import('@margoengine/shadows'));
