import { fault, rangeError, typeError } from '../../shared/errors.js';
import { videoMaterial, type VideoMaterialFeature } from './material.js';

/** Equirectangular eye packing. The left eye occupies the first (left or top) rectangle. */
export type VideoDomeLayout = 'mono' | 'stereo-left-right' | 'stereo-top-bottom';
/** Projection onto the inside of sphereGeometry, centred at the camera. */
export interface VideoDomeOptions {
  /** Source packing. Default 'mono'. */
  layout?: VideoDomeLayout;
  /** Screen eye, or the eye selected by an XR view. Default 'left'. */
  eye?: 'left' | 'right';
  /** Horizontal field of the source in degrees. Default 360. 180 leaves the rear hemisphere black. */
  angle?: 180 | 360;
}

/**
 * Video on an inward sphere: image centre faces -Z, right +X, top +Y.
 * Use an unlit back-sided material and sphereGeometry. Each eye clamps half a texel inside its rectangle.
 * Source playback and lifetime remain caller-owned. Rendering uses videoMaterial's WebGPU path (including full compat).
 */
export function videoDomeMaterial(
  source: HTMLVideoElement | VideoFrame,
  options: VideoDomeOptions = {},
): VideoMaterialFeature {
  const { layout = 'mono', eye = 'left', angle = 360 } = options;
  if (!['mono', 'stereo-left-right', 'stereo-top-bottom'].includes(layout))
    throw typeError('Unknown dome layout; pass mono, stereo-left-right or stereo-top-bottom', 'arguments');
  if (eye !== 'left' && eye !== 'right') throw typeError('Unknown dome eye; pass left or right', 'arguments');
  if (angle !== 180 && angle !== 360) throw rangeError('Unknown dome angle; pass 180 or 360', 'arguments');
  const horizontal = layout === 'stereo-left-right',
    vertical = layout === 'stereo-top-bottom',
    right = eye === 'right',
    base = videoMaterial(source, { flipY: false });
  return {
    ...base,
    bindings(device, owner) {
      const w = 'videoWidth' in source ? source.videoWidth : source.displayWidth,
        h = 'videoHeight' in source ? source.videoHeight : source.displayHeight;
      if ((horizontal && w === 1) || (vertical && h === 1))
        throw rangeError(
          'Stereo dome needs a pixel for each eye; pass at least two pixels along the packing axis',
          'arguments',
        );
      return base.bindings(device, owner);
    },
    shader(code, group) {
      const out = base.shader(code, group),
        anchor = 'margoVideoSampler,i.uv.xy)';
      if (!out.includes(anchor)) throw fault('unsupported', 'Dome sample hook missing; use matching video entries');
      // A black rear hemisphere matches half-dome video even with a nonblack scene background.
      const mask = angle === 180 ? 'if(margoDomeP.x<0.25 || margoDomeP.x>0.75){s.base=vec4f(0,0,0,1);}else{' : '';
      return (
        `fn margoDomeUV(p:vec2f)->vec2f {
 let origin=vec2f(${horizontal && right ? '0.5' : '0.0'},${vertical && right ? '0.5' : '0.0'});
 let span=vec2f(${horizontal ? '0.5' : '1.0'},${vertical ? '0.5' : '1.0'});
 let border=0.5/vec2f(textureDimensions(margoVideo));
 return clamp(origin+vec2f(${angle === 180 ? '(p.x-0.25)*2.0' : 'p.x'},p.y)*span,origin+border,origin+span-border);
}
` +
        out
          .replace(
            'let margoVideoColor=',
            `let margoDomeP=vec2f(fract(0.25-i.uv.x),1.0-i.uv.y);\n${mask}let margoVideoColor=`,
          )
          .replace(anchor, 'margoVideoSampler,margoDomeUV(margoDomeP))')
          .replace(
            's.base*=vec4f(margoVideoLinear(margoVideoColor.rgb),margoVideoColor.a);',
            's.base*=vec4f(margoVideoLinear(margoVideoColor.rgb),margoVideoColor.a);' + (angle === 180 ? '}' : ''),
          )
      );
    },
  };
}
