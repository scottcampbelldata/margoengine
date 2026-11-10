import type { PBRModel } from '@margoengine/gltf-pro';
import { textureCoordinates, type TextureTransform } from '@margoengine/gltf-pro/coordinates';
import type { ClearcoatTexture } from './index.js';
import type { GLTFTexture, GLTFSampler, GLTFTextureInfo } from '../../shared/gltf.js';
import { generateMipmaps } from '../../shared/mipmaps.js';
import { MargoError } from '@margoengine/math/errors';

declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number; RENDER_ATTACHMENT: number };

export interface TextureInfo {
  index: number;
  texCoord?: 0 | 1 | 2 | 3;
  scale?: number;
  transform?: TextureTransform;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new TypeError(`Invalid clearcoat ${label}; pass a whole number of 0 or more.`);
  return value;
}
function record<T extends object>(value: unknown, label: string): T {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError(`Invalid clearcoat ${label}; pass an object.`);
  return value as T;
}
function entry<T extends object>(values: readonly T[] | undefined, index: unknown, label: string): T {
  const id = integer(index, label);
  if (!Array.isArray(values))
    throw new TypeError(`Missing clearcoat ${label}; add it to the glTF document or remove the reference.`);
  return record<T>(values[id], label);
}
function samplerDefinition(model: PBRModel, texture: GLTFTexture): GLTFSampler {
  const sampler: GLTFSampler =
    texture.sampler === undefined ? {} : entry<GLTFSampler>(model.asset.doc.samplers, texture.sampler, 'sampler');
  if (
    (sampler.magFilter !== undefined && ![9728, 9729].includes(sampler.magFilter)) ||
    (sampler.minFilter !== undefined && ![9728, 9729, 9984, 9985, 9986, 9987].includes(sampler.minFilter))
  )
    throw new TypeError(
      'Invalid clearcoat texture filter; use a glTF magFilter of 9728 or 9729 and a minFilter of 9728, 9729 or 9984 to 9987.',
    );
  for (const value of [sampler.wrapS, sampler.wrapT])
    if (value !== undefined && ![10497, 33071, 33648].includes(value))
      throw new TypeError('Invalid clearcoat texture wrapping; use a glTF wrap mode of 10497, 33071 or 33648.');
  return sampler;
}

/** Validate glTF texture metadata without allocating any GPU resources. */
export function validateTextureInfo(value: unknown, model: PBRModel): TextureInfo {
  const info = record<GLTFTextureInfo & { transform?: TextureTransform }>(value, 'texture info'),
    index = integer(info.index, 'texture index');
  const transform = info.transform === undefined ? info.extensions?.KHR_texture_transform : info.transform;
  const { texCoord } = textureCoordinates({
    texCoord: info.texCoord,
    extensions: { KHR_texture_transform: transform },
  });
  if (info.scale !== undefined && (typeof info.scale !== 'number' || !Number.isFinite(Math.fround(info.scale))))
    throw new TypeError('Invalid clearcoat normal scale; pass a finite number that fits float32.');
  const texture = entry<GLTFTexture>(model.asset.doc.textures, index, 'texture');
  model.image(integer(texture.extensions?.KHR_texture_basisu?.source ?? texture.source, 'image source'));
  samplerDefinition(model, texture);
  return {
    index,
    texCoord,
    scale: info.scale ?? 1,
    ...(transform !== undefined ? { transform: transform as TextureTransform } : {}),
  };
}

interface ImageTexture {
  texture: GPUTexture;
  view: GPUTextureView;
  levels: number;
  mipsReady: boolean;
  format: GPUTextureFormat;
}

/** Owns extension GPU resources while borrowing the model's retained decoded images. */
export class MaterialTextures {
  private readonly images = new Map<string, ImageTexture>();
  private readonly samplers = new Map<number, GPUSampler>();
  private readonly owned = new Set<GPUTexture>();
  private readonly mipPipelines = new Map<unknown, unknown>();
  private disposed = false;
  constructor(
    private readonly model: PBRModel,
    private readonly device: GPUDevice,
  ) {}

  resolve(value: TextureInfo, srgb = false): ClearcoatTexture {
    if (this.disposed)
      throw new MargoError('disposed', 'Material textures are disposed; create new MaterialTextures for a live model.');
    const info = validateTextureInfo(value, this.model),
      definition = entry<GLTFTexture>(this.model.asset.doc.textures, info.index, 'texture');
    const source = integer(definition.extensions?.KHR_texture_basisu?.source ?? definition.source, 'image source'),
      samplerDefinitionValue = samplerDefinition(this.model, definition);
    const usesMips = ![9728, 9729].includes(samplerDefinitionValue.minFilter!);
    const key = source + ':' + srgb,
      format: GPUTextureFormat = srgb ? 'rgba8unorm-srgb' : 'rgba8unorm';
    let imageTexture = this.images.get(key);
    if (!imageTexture) {
      const image = this.model.image(source),
        size = [image.width, image.height];
      if (size.some((n) => !Number.isSafeInteger(n) || n < 1 || n > this.device.limits.maxTextureDimension2D))
        throw new RangeError(
          'Clearcoat image exceeds device limit; resize the image to the GPU maxTextureDimension2D or less.',
        );
      // Reserve all levels so different samplers can share one image without replacing its view.
      const compressed = 'ktx2' in image || 'mipmaps' in image,
        levels =
          'ktx2' in image
            ? image.ktx2.mipmaps.length
            : 'mipmaps' in image
              ? image.mipmaps.length
              : Math.floor(Math.log2(Math.max(...size))) + 1;
      const texture = compressed
        ? this.model.uploadImage(source, this.device, srgb)
        : this.device.createTexture({
            size,
            format,
            mipLevelCount: levels,
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
          });
      this.owned.add(texture);
      if ('data' in image)
        this.device.queue.writeTexture({ texture }, image.data, { bytesPerRow: image.width * 4 }, size);
      else if (!('ktx2' in image) && !('mipmaps' in image))
        this.device.queue.copyExternalImageToTexture({ source: image }, { texture }, size);
      imageTexture = { texture, view: texture.createView(), levels, mipsReady: compressed || levels === 1, format };
      this.images.set(key, imageTexture);
    }
    if (usesMips && !imageTexture.mipsReady) this.generateMips(imageTexture);
    const samplerId = definition.sampler ?? -1;
    let sampler = this.samplers.get(samplerId);
    if (!sampler) {
      const wrap = (value: number | undefined): GPUAddressMode =>
        value === 33071 ? 'clamp-to-edge' : value === 33648 ? 'mirror-repeat' : 'repeat';
      const s = samplerDefinitionValue;
      sampler = this.device.createSampler({
        addressModeU: wrap(s.wrapS),
        addressModeV: wrap(s.wrapT),
        magFilter: s.magFilter === 9728 ? 'nearest' : 'linear',
        minFilter: [9728, 9984, 9986].includes(s.minFilter!) ? 'nearest' : 'linear',
        mipmapFilter: [9984, 9985].includes(s.minFilter!) ? 'nearest' : 'linear',
        lodMaxClamp: usesMips ? 32 : 0,
      });
      this.samplers.set(samplerId, sampler);
    }
    return { view: imageTexture.view, sampler, texCoord: info.texCoord, scale: info.scale, transform: info.transform };
  }

  private generateMips(image: ImageTexture): void {
    generateMipmaps(this.device, image.texture, image.levels, this.mipPipelines);
    image.mipsReady = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    let failure: unknown;
    for (const texture of this.owned)
      try {
        texture.destroy();
      } catch (error) {
        failure ??= error;
      }
    this.owned.clear();
    this.images.clear();
    this.samplers.clear();
    if (failure !== undefined) throw failure;
  }
}
