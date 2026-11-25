// The scene walk every exporter shares, for writers that live in their own package (`@margoengine/fbx/export`).
export { collect, drawables, polygons, polylines, textureFiles } from './scene.js';
export { cameraDefinition, lightDefinition } from './scene-metadata.js';
export type {
  CameraData,
  Drawable,
  LightData,
  ExportSource,
  ExportNode,
  ExportScene,
  Geo,
  Mat,
  Node,
  SceneOptions,
  TextureData,
} from './scene.js';
