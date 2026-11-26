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
  type PixelateProps,
  type DotScreenProps,
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
  type PixelateProps,
  type DotScreenProps,
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
const loadPixelate = () =>
  optionalPeer('@margoengine/post/pixelate', () => import('@margoengine/post/pixelate')).then(
    (api) => api.Pixelate as unknown as EffectClass,
  );
const loadDotScreen = () =>
  optionalPeer('@margoengine/post/halftone', () => import('@margoengine/post/halftone')).then(
    (api) => api.DotScreen as unknown as EffectClass,
  );
/**
 * Pixel-art downsample into square cells of `pixelSize` pixels (default 6), with depth silhouettes
 * (`depthEdgeStrength`, default 0.4) and normal creases (`normalEdgeStrength`, default 0.3). Every PBR model of the
 * Canvas joins its capture. An LDR stage after `<Tonemap>`.
 */
export function Pixelate({ onReady, onError, ...options }: PixelateProps) {
  usePass('pixelate', loadPixelate, options, { onReady, onError });
  return null;
}
/**
 * Monochrome dot screening: `cellSize` pixels per cell (default 8), `angle` in degrees (default 45), `shape`
 * (default 'dot'), `intensity` 0 to 1 (default 1). An LDR stage after `<Tonemap>`.
 */
export function DotScreen({ onReady, onError, ...options }: DotScreenProps) {
  usePass('dotScreen', loadDotScreen, options, { onReady, onError });
  return null;
}

/** Props of `<Vignette>`; each one is the option of `<Tonemap>` named in brackets. */
export interface VignetteProps {
  /** Corner darkening, 0 to 1 (`vignette`). Default 0.5. */
  amount?: number;
  /** Where the vignette starts, as a fraction of the corner distance, 0 to 1 (`vignetteRadius`). Tonemap's default is 0.5. */
  radius?: number;
  /** Width of the fall-off, as a fraction of the corner distance, 0 to 1 (`vignetteSoftness`). Tonemap's default is 0.5. */
  softness?: number;
  /** Linear Rec.709 colour, 0 to 1 per channel (`vignetteColor`). Tonemap's default is black. */
  color?: readonly [number, number, number];
  /** Centre as fractions of the view from the top left (`vignetteCenter`). Tonemap's default is [0.5, 0.5]. */
  center?: readonly [number, number];
  /** 0 stretches the vignette with the view, 1 makes it a circle (`vignetteRoundness`). Tonemap's default is 0. */
  roundness?: number;
  /** 'multiply' darkens or tints, 'opaque' blends toward `color` (`vignetteBlend`). Tonemap's default is 'multiply'. */
  blend?: 'multiply' | 'opaque';
}
/** Props of `<FilmGrain>`. */
export interface FilmGrainProps {
  /** Animated grain strength, 0 to 1 (`grain` of `<Tonemap>`), strongest in the mid-tones. Default 0.35. */
  amount?: number;
}
/** Props of `<ChromaticAberration>`. */
export interface ChromaticAberrationProps {
  /** Radial red and blue fringing, 0 to 1 (`chromaticAberration` of `<Tonemap>`); 1 shifts the channels by 2% of the view at its edge. Default 0.25. */
  amount?: number;
}
const defined = (values: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
// The composer loads the stage from the `<Tonemap>` these merge into; this loader is never called.
const loadTonemapStage = () => Promise.reject(new Error('Tonemap is loaded by <Tonemap>'));
/**
 * Darkens or tints the corners. It sets the vignette options of the composer's `<Tonemap>`, so it sits in the same
 * `<EffectComposer>` as one (without it the composer reports a coded error). An option it leaves unset keeps the
 * `<Tonemap>`'s value.
 */
export function Vignette({ amount = 0.5, radius, softness, color, center, roundness, blend }: VignetteProps) {
  usePass(
    'tonemap',
    loadTonemapStage,
    defined({
      vignette: amount,
      vignetteRadius: radius,
      vignetteSoftness: softness,
      vignetteColor: color,
      vignetteCenter: center,
      vignetteRoundness: roundness,
      vignetteBlend: blend,
    }),
    {},
    undefined,
    true,
  );
  return null;
}
/** Animated film grain. It sets `grain` of the composer's `<Tonemap>`, so it sits in the same `<EffectComposer>` as one. */
export function FilmGrain({ amount = 0.35 }: FilmGrainProps) {
  usePass('tonemap', loadTonemapStage, { grain: amount }, {}, undefined, true);
  return null;
}
/** Radial colour fringing. It sets `chromaticAberration` of the composer's `<Tonemap>`, so it sits in the same `<EffectComposer>` as one. */
export function ChromaticAberration({ amount = 0.25 }: ChromaticAberrationProps) {
  usePass('tonemap', loadTonemapStage, { chromaticAberration: amount }, {}, undefined, true);
  return null;
}
