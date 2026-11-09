import { fault, rangeError, typeError } from '../../shared/errors.js';
import { videoMaterial, type VideoMaterialFeature, type VideoMaterialOptions } from './material.js';

/** Packing of a colour image and an equal-sized grayscale alpha image. */
export interface StackedAlphaOptions extends VideoMaterialOptions {
  /** Colour above alpha, or colour left of alpha. Default 'top-bottom'. */
  layout?: 'top-bottom' | 'left-right';
}

/** RGB distance keying options; all colours are normalized sRGB values. */
export interface ChromaKeyOptions extends VideoMaterialOptions {
  /** Key colour in sRGB, each channel 0..1. Default [0,1,0] (green). */
  color?: readonly [number, number, number];
  /** RGB distance below which alpha is zero, 0..sqrt(3). Default 0.15. */
  threshold?: number;
  /** Smooth transition width in RGB distance, positive and at most sqrt(3). Default 0.1. */
  softness?: number;
}

const alphaHook = ',margoVideoColor.a);';
const checkHook = (code: string): void => {
  if (!code.includes(alphaHook))
    throw fault('unsupported', 'Video alpha hook missing; use matching video and materials entries');
};

/**
 * Multiply material alpha by the raw red channel of a stacked grayscale mask.
 * Colour is straight (unassociated), top/left; mask is bottom/right. Each half clamps to its own texel centres.
 * Use a transparent material or alphaTest. WebGPU only; source ownership follows videoMaterial.
 */
export function stackedAlphaMaterial(
  source: HTMLVideoElement | VideoFrame,
  options: StackedAlphaOptions = {},
): VideoMaterialFeature {
  const layout = options.layout ?? 'top-bottom';
  if (layout !== 'top-bottom' && layout !== 'left-right')
    throw typeError('Unknown alpha packing; pass top-bottom or left-right', 'arguments');
  const base = videoMaterial(source, options),
    vertical = layout === 'top-bottom';
  return {
    ...base,
    bindings(device, owner) {
      const size =
        'videoWidth' in source
          ? vertical
            ? source.videoHeight
            : source.videoWidth
          : vertical
            ? source.displayHeight
            : source.displayWidth;
      if (size && (size < 2 || size % 2 !== 0))
        throw rangeError('Stacked alpha needs two equal pixel halves; use an even packed dimension', 'arguments');
      return base.bindings(device, owner);
    },
    shader(code, group) {
      const out = base.shader(code, group);
      checkHook(out);
      const sample = /let margoVideoColor=textureSampleBaseClampToEdge\(margoVideo,margoVideoSampler,([^;]+)\);/;
      if (!sample.test(out))
        throw fault('unsupported', 'Stacked video sample hook missing; use matching video entries');
      const span = vertical ? 'vec2f(1,0.5)' : 'vec2f(0.5,1)',
        offset = vertical ? 'vec2f(0,0.5)' : 'vec2f(0.5,0)';
      return out
        .replace(
          sample,
          (_, uv: string) => `let margoAlphaBorder=0.5/vec2f(textureDimensions(margoVideo));
  let margoAlphaSpan=${span};
  let margoAlphaUV=clamp((${uv})*margoAlphaSpan,margoAlphaBorder,margoAlphaSpan-margoAlphaBorder);
  let margoVideoColor=textureSampleBaseClampToEdge(margoVideo,margoVideoSampler,margoAlphaUV);
  let margoStackAlpha=textureSampleBaseClampToEdge(margoVideo,margoVideoSampler,margoAlphaUV+${offset}).r;`,
        )
        .replace(alphaHook, ',margoVideoColor.a*margoStackAlpha);');
    },
  };
}

/**
 * Key a caller-owned video by sRGB Euclidean distance, with a smooth alpha edge.
 * No despill or foreground colour reconstruction. Use transparent or alphaTest; WebGPU only.
 */
export function chromaKeyMaterial(
  source: HTMLVideoElement | VideoFrame,
  options: ChromaKeyOptions = {},
): VideoMaterialFeature {
  const color = options.color ?? [0, 1, 0],
    threshold = options.threshold ?? 0.15,
    softness = options.softness ?? 0.1;
  if (color.length !== 3 || [0, 1, 2].some((i) => !Number.isFinite(color[i]) || color[i]! < 0 || color[i]! > 1))
    throw rangeError('Chroma key colour is invalid; pass three sRGB channels in 0..1', 'arguments');
  if (
    !Number.isFinite(threshold) ||
    threshold < 0 ||
    threshold > Math.sqrt(3) ||
    !Number.isFinite(softness) ||
    softness <= 0 ||
    softness > Math.sqrt(3) ||
    Math.fround(threshold + softness) <= Math.fround(threshold)
  )
    throw rangeError(
      'Chroma key edge is invalid; use threshold 0..sqrt(3) and positive float32-resolvable softness',
      'arguments',
    );
  // Copy values into WGSL now; mutating the caller's options cannot change a compiled variant.
  const key = `vec3f(${color.join(',')})`,
    low = Math.fround(threshold),
    high = Math.fround(threshold + softness);
  const base = videoMaterial(source, options);
  return {
    ...base,
    shader(code, group) {
      const out = base.shader(code, group);
      checkHook(out);
      return out.replace(
        alphaHook,
        `,margoVideoColor.a*smoothstep(${low},${high},distance(margoVideoColor.rgb,${key})));`,
      );
    },
  };
}
