import { fault } from '../../shared/errors.js';

/** Sampling options for `videoMaterial`. */
export interface VideoMaterialOptions {
  /** Mesh UV set. Default 0. */
  texCoord?: 0 | 1;
  /** Match Texture's image orientation, with image row zero at v=1. Default true. */
  flipY?: boolean;
}

/** A structural `MaterialFeature`, assignable to any `Material.features` list. */
export interface VideoMaterialFeature {
  /** One external video base-colour source per material. */
  readonly name: string;
  /** Adds the external texture sample to the standard mesh surface. */
  shader(code: string, group: number): string;
  /** Imports a fresh external texture in the drawing task; retains no frame. */
  bindings(device: GPUDevice, owner: object): GPUBindGroupEntry[];
}

/**
 * Multiplies a mesh material's base colour and alpha by a caller-owned video frame, without a JS-side texture upload.
 * Assign through `Material.features`. The caller starts playback and keeps the source ready until the draw finishes.
 * WebGL2 is refused with `unsupported`; browser/platform copies are outside this API's control.
 */
export function videoMaterial(
  source: HTMLVideoElement | VideoFrame,
  options: VideoMaterialOptions = {},
): VideoMaterialFeature {
  const isVideo = typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement,
    isFrame = typeof VideoFrame !== 'undefined' && source instanceof VideoFrame;
  if (!isVideo && !isFrame)
    throw new TypeError('videoMaterial needs an HTMLVideoElement or VideoFrame; pass a live video source');
  const coord = options.texCoord ?? 0;
  if (coord !== 0 && coord !== 1) throw new RangeError('videoMaterial texCoord must be 0 or 1; select a mesh UV set');
  if (options.flipY !== undefined && typeof options.flipY !== 'boolean')
    throw new TypeError('videoMaterial flipY must be true or false; pass a boolean');
  const coords = `i.uv.${coord ? 'zw' : 'xy'}`,
    sampleUV = options.flipY === false ? coords : `vec2f(${coords}.x,1.0-${coords}.y)`;
  const samplers = new WeakMap<GPUDevice, GPUSampler>(),
    shaders = new Map<string, string>();
  return {
    name: 'videoMaterial',
    shader(code, group) {
      const key = group + ':' + code,
        cached = shaders.get(key);
      if (cached !== undefined) return cached;
      const head = 'fn surface(i:Out,front:bool)->Surface {';
      if (!code.includes(head))
        throw fault('unsupported', 'Video material surface missing; use matching materials and gltf-pro versions');
      const start = code.indexOf(head),
        tail = code.slice(start),
        base = /s\.base=[^;]+;/;
      if (!base.test(tail))
        throw fault('unsupported', 'Video material base colour missing; use a standard mesh Material');
      const declarations = `@group(${group}) @binding(250) var margoVideo:texture_external;
@group(${group}) @binding(251) var margoVideoSampler:sampler;
fn margoVideoLinear(c:vec3f)->vec3f {
  return select(c/12.92,pow((max(c,vec3f(0))+0.055)/1.055,vec3f(2.4)),c>vec3f(0.04045));
}
`;
      const sample = `let margoVideoColor=textureSampleBaseClampToEdge(margoVideo,margoVideoSampler,${sampleUV});
  s.base*=vec4f(margoVideoLinear(margoVideoColor.rgb),margoVideoColor.a);`;
      const out = declarations + code.slice(0, start) + tail.replace(base, (line) => line + '\n  ' + sample);
      // Feature variants change infrequently; do not retain an unbounded shader history.
      if (shaders.size >= 64) shaders.clear();
      shaders.set(key, out);
      return out;
    },
    bindings(device, owner) {
      if (('backend' in owner && owner.backend !== 'webgpu') || !device.importExternalTexture)
        throw fault('unsupported', 'Video materials require WebGPU; select a WebGPU engine');
      if (
        (isVideo && (!(source as HTMLVideoElement).videoWidth || (source as HTMLVideoElement).readyState < 2)) ||
        (isFrame && !(source as VideoFrame).displayWidth)
      )
        throw fault('state', 'Video material source has no frame; wait for loadeddata or pass an open VideoFrame');
      let sampler = samplers.get(device);
      if (!sampler) {
        sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
        samplers.set(device, sampler);
      }
      return [
        { binding: 250, resource: device.importExternalTexture({ source, colorSpace: 'srgb' }) },
        { binding: 251, resource: sampler },
      ];
    },
  };
}
