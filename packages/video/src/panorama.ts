import { fault, rangeError, typeError } from '../../shared/errors.js';
import { videoMaterial, type VideoMaterialFeature } from './material.js';

/** Equirectangular packing, with each eye spanning 360 by 180 degrees. */
export type Video360Layout = 'mono' | 'stereo-left-right';
/** Options for an equirectangular sphere material. */
export interface Video360Options {
  /** One full panorama, or left and right panoramas side by side. Default 'mono'. */
  layout?: Video360Layout;
  /** Eye shown on screen for a stereo source. Default 'left'; ignored for mono. */
  eye?: 'left' | 'right';
}
const layoutOf = (layout: Video360Layout = 'mono'): Video360Layout => {
  if (layout !== 'mono' && layout !== 'stereo-left-right')
    throw typeError('Unknown panorama layout; pass mono or stereo-left-right', 'arguments');
  return layout;
};

/**
 * External video for the inside of geometry's sphereGeometry, using UV0.
 * The image centre faces -Z, right faces +X and top faces +Y. Use an unlit back-sided material.
 * Stereo sampling clamps inside the selected eye, including its half-texel border.
 * Source ownership and WebGPU-only rendering follow videoMaterial.
 */
export function video360Material(
  source: HTMLVideoElement | VideoFrame,
  options: Video360Options = {},
): VideoMaterialFeature {
  const layout = layoutOf(options.layout),
    eye = options.eye ?? 'left';
  if (eye !== 'left' && eye !== 'right') throw typeError('Unknown panorama eye; pass left or right', 'arguments');
  const base = videoMaterial(source, { flipY: false }),
    stereo = layout !== 'mono',
    scale = stereo ? '0.5' : '1.0',
    offset = stereo && eye === 'right' ? '0.5' : '0.0';
  return {
    ...base,
    bindings(device, owner) {
      const width = 'videoWidth' in source ? source.videoWidth : source.displayWidth;
      if (stereo && width === 1)
        throw rangeError(
          'Stereo panorama has no pixel for each eye; pass a source at least two pixels wide',
          'arguments',
        );
      return base.bindings(device, owner);
    },
    shader(code, group) {
      const out = base.shader(code, group),
        anchor = 'margoVideoSampler,i.uv.xy)';
      if (!out.includes(anchor)) throw fault('unsupported', 'Panorama sample hook missing; use matching video entries');
      return (
        `fn margoPanoramaUV(uv:vec2f)->vec2f {
  let origin=vec2f(${offset},0.0); let span=vec2f(${scale},1.0);
  let border=0.5/vec2f(textureDimensions(margoVideo));
  let p=vec2f(fract(0.25-uv.x),1.0-uv.y);
  return clamp(origin+p*span,origin+border,origin+span-border);
}
` + out.replace(anchor, 'margoVideoSampler,margoPanoramaUV(i.uv.xy))')
      );
    },
  };
}

/** Options for the existing XRMediaBinding equirectangular layer route. */
export interface Video360LayerOptions {
  /** Source packing. Default 'mono'. The XR compositor chooses each eye. */
  layout?: Video360Layout;
  /** Sphere radius in metres; 0 is at infinity. Default 0. */
  radius?: number;
}

/**
 * Adds a 360 video through an existing XRLayers instance, reusing its native XRMediaBinding path.
 * Needs the browser's XR media layers support; XRLayers reports unsupported otherwise.
 * The returned XRPanel owns layer disposal; the caller owns video playback.
 */
export function video360Layer<Layer>(
  layers: {
    video(source: HTMLVideoElement, options: { shape: 'equirect'; layout: Video360Layout; radius: number }): Layer;
  },
  source: HTMLVideoElement,
  options: Video360LayerOptions = {},
): Layer {
  const layout = layoutOf(options.layout),
    radius = options.radius ?? 0;
  if (!Number.isFinite(radius) || radius < 0)
    throw rangeError('Panorama radius is invalid; pass a finite nonnegative radius', 'arguments');
  return layers.video(source, { shape: 'equirect', layout, radius });
}
