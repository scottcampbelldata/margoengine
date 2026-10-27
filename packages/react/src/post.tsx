import {
  usePass,
  type EffectClass,
  type BloomProps,
  type SSAOProps,
  type GTAOProps,
  type SSRProps,
  type SSGIProps,
  type MotionBlurProps,
  type LensFlareProps,
  type SMAAProps,
  type FXAAProps,
  type GlitchProps,
  type AfterimageProps,
} from './composer.js';
import { optionalPeer } from './optional.js';

export {
  EffectComposer,
  type EffectComposerProps,
  type BloomProps,
  type SSAOProps,
  type GTAOProps,
  type SSRProps,
  type SSGIProps,
  type MotionBlurProps,
  type LensFlareProps,
  type SMAAProps,
  type FXAAProps,
  type GlitchProps,
  type AfterimageProps,
} from './composer.js';
export { DepthTexture, SceneTargets, type DepthTextureProps, type SceneTargetsProps } from './post-targets.js';

const loadBloom = () =>
  optionalPeer('@margoengine/post/bloom', () => import('@margoengine/post/bloom')).then(
    (api) => api.Bloom as unknown as EffectClass,
  );
const loadSSAO = () =>
  optionalPeer('@margoengine/post/ssao', () => import('@margoengine/post/ssao')).then(
    (api) => api.SSAO as unknown as EffectClass,
  );
const loadGTAO = () =>
  optionalPeer('@margoengine/post/gtao', () => import('@margoengine/post/gtao')).then(
    (api) => api.GTAO as unknown as EffectClass,
  );
const loadSSR = () =>
  optionalPeer('@margoengine/post/ssr', () => import('@margoengine/post/ssr')).then(
    (api) => api.SSR as unknown as EffectClass,
  );
const loadSSGI = () =>
  optionalPeer('@margoengine/post/ssgi', () => import('@margoengine/post/ssgi')).then(
    (api) => api.SSGI as unknown as EffectClass,
  );
const loadMotionBlur = () =>
  optionalPeer('@margoengine/post/motion-blur', () => import('@margoengine/post/motion-blur')).then(
    (api) => api.MotionBlur as unknown as EffectClass,
  );
const loadLensFlare = () =>
  optionalPeer('@margoengine/post/lens-flare', () => import('@margoengine/post/lens-flare')).then(
    (api) => api.LensFlare as unknown as EffectClass,
  );
const loadSMAA = () =>
  optionalPeer('@margoengine/post/smaa', () => import('@margoengine/post/smaa')).then(
    (api) => api.SMAA as unknown as EffectClass,
  );
const loadFXAA = () =>
  optionalPeer('@margoengine/post/fxaa', () => import('@margoengine/post/fxaa')).then(
    (api) => api.FXAA as unknown as EffectClass,
  );
const loadGlitch = () =>
  optionalPeer('@margoengine/post/glitch', () => import('@margoengine/post/glitch')).then(
    (api) => api.Glitch as unknown as EffectClass,
  );
const loadAfterimage = () =>
  optionalPeer('@margoengine/post/afterimage', () => import('@margoengine/post/afterimage')).then(
    (api) => api.Afterimage as unknown as EffectClass,
  );

/** The bloom component. */
export function Bloom({ onReady, onError, ...options }: BloomProps) {
  usePass('bloom', loadBloom, options, { onReady, onError });
  return null;
}
/** The ssao component. */
export function SSAO({ onReady, onError, ...options }: SSAOProps) {
  usePass('ssao', loadSSAO, options, { onReady, onError });
  return null;
}
/** Ground-truth ambient occlusion: SSAO's options plus GTAO's own. Use it or `<SSAO>`, not both. */
export function GTAO({ onReady, onError, ...options }: GTAOProps) {
  usePass('gtao', loadGTAO, options, { onReady, onError });
  return null;
}
/** Screen-space reflections on the Canvas's PBR models (`Model`, `Gltf`). */
export function SSR({ onReady, onError, ...options }: SSRProps) {
  usePass('ssr', loadSSR, options, { onReady, onError });
  return null;
}
/** Screen-space indirect light (one bounce) on the Canvas's PBR models. */
export function SSGI({ onReady, onError, ...options }: SSGIProps) {
  usePass('ssgi', loadSSGI, options, { onReady, onError });
  return null;
}
/** Motion blur from per-pixel motion vectors: by default those of a `<TAA>` in the same composer. */
export function MotionBlur({ onReady, onError, ...options }: MotionBlurProps) {
  usePass('motionBlur', loadMotionBlur, options, { onReady, onError });
  return null;
}
/** Lens flare from the sun and bright lights. */
export function LensFlare({ onReady, onError, ...options }: LensFlareProps) {
  usePass('lensFlare', loadLensFlare, options, { onReady, onError });
  return null;
}
/** Morphological anti-aliasing on the final image. */
export function SMAA({ onReady, onError, ...options }: SMAAProps) {
  usePass('smaa', loadSMAA, options, { onReady, onError });
  return null;
}
/** Fast approximate anti-aliasing on the final image. */
export function FXAA({ onReady, onError }: FXAAProps) {
  usePass('fxaa', loadFXAA, {}, { onReady, onError });
  return null;
}
/** Digital glitch on the final image. */
export function Glitch({ onReady, onError, ...options }: GlitchProps) {
  usePass('glitch', loadGlitch, options, { onReady, onError });
  return null;
}
/** Afterimage: each frame fades into the next. */
export function Afterimage({ onReady, onError, ...options }: AfterimageProps) {
  usePass('afterimage', loadAfterimage, options, { onReady, onError });
  return null;
}
