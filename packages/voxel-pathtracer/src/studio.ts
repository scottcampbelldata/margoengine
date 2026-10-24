// @margoengine/voxel-pathtracer/studio: helpers for editors around the tracer, outside the root entry: lighting
// presets, a preview sample budget and material builders.
export { type LightingPreset, studioPreset, studioPresets } from './presets.js';
export { PreviewBudget } from './preview.js';
export { blend, diffuse, emit, glass, materialBuilders, media, metal, paletteFromMaterials } from './materials.js';
