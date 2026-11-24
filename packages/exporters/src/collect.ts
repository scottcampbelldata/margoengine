// The scene walk every exporter shares, for writers that live in their own package (`@margoengine/fbx/export`).
export { collect, polygons, textureFiles } from './scene.js';
export { cameraDefinition, lightDefinition } from './scene-metadata.js';
export type { CameraData, LightData, ExportSource, ExportNode, ExportScene, Geo, Mat, Node, SceneOptions, TextureData } from './scene.js';
