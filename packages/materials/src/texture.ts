// @margoengine/materials/texture: Texture, CubeTexture and their loaders on their own, for code that samples images
// but draws no Material (video frames, ramps, custom passes). The same classes as the package root exports.
export {
  type RawImage,
  type EnvMapSource,
  type ImageSource,
  type CubeSource,
  type TextureSource,
  type Wrap,
  type Filter,
  type TextureOptions,
  type TextureRegion,
  Texture,
  type TextureLimits,
  loadTexture,
  type KTX2Transcoder,
  type KTX2LayerReader,
  loadKTX2Texture,
  type CubeTextureOptions,
  CubeTexture,
  loadCubeTexture,
} from './texture-core.js';
export type {
  CubeTarget,
  DataFormat,
  DataImage,
  TextureDimension,
  TranscodedMip,
  TranscodedTexture,
} from './texture-kinds.js';
