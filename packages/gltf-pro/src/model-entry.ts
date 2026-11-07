// @margoengine/gltf-pro/model: the model classes without the road to the Draco and Basis decoders, for packages and apps
// that draw or build models and load no compressed file. A bundler reading this entry copies no Wasm.
export {
  GLTFAsset,
  PBRDrawRun,
  PBRModel,
  closeImages,
  parseGLTF,
  parsePreparedPBR,
  textureCoordinates,
  textureTransform,
} from './model.js';
export type * from './model.js';
