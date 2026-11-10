// Groups of packages that share a contract, for the packaging checks (tests/packaging-bundles.test.js, integration J5,
// docs/integration-packaging.md). An app that composes a group from the READMEs imports its packages in any order;
// each group is bundled with its packages imported forward and backward, and both must build and run the same.
const m = (names) => names.map((name) => `@margoengine/${name}`);

export const CONTRACT_GROUPS = [
  // engine.use plugins that add passes to the frame graph and share its targets.
  { name: 'render passes', packages: m(['shadows', 'taa', 'oit', 'clustered', 'culling', 'lod', 'post', 'dof', 'quality', 'pixel', 'tonemap', 'toon']) },
  // scene.use content that adds its own batches to a scene.
  { name: 'scene content', packages: m(['scatter', 'sprites', 'splats', 'lines', 'points', 'text', 'labels', 'lighting2d', 'tilemap']) },
  // Overlays and tools that read the canvas, picking and input.
  { name: 'tools and input', packages: m(['stats', 'inspector', 'selection', 'html', 'viewcube', 'cameras', 'controls', 'input', 'ui']) },
  // Clips, skeletons and timelines over the same meshes.
  { name: 'animation', packages: m(['animation', 'animator', 'mixer', 'tween', 'rigging', 'kinematics-constraints', 'cinematic', 'cutscene']) },
  // Loaders and exporters over the shared glTF scene and texture formats.
  { name: 'assets', packages: m(['gltf', 'gltf-pro', 'loaders', 'exporters', 'decoders', 'usdz', 'fbx', 'blender', 'cache']) },
  // Materials, shading and the environment they light against.
  { name: 'materials and environment', packages: m(['materials', 'shader', 'sky', 'environment', 'water', 'weather', 'terrain', 'scenery']) },
  // The stage facade and the packages that drive whole scenes.
  { name: 'stage', packages: m(['stage', 'staging', 'scene', 'transitions', 'save']) },
  // Game logic over shared entities and messages.
  { name: 'gameplay', packages: m(['ecs', 'behavior', 'fsm', 'net', 'netcode', 'navmesh', 'worker']) },
  // Voxel worlds and the generators that fill them.
  { name: 'voxel', packages: m(['voxel', 'voxel-edit', 'voxel-net', 'voxel-pathtracer', 'wfc', 'procedural', 'biomes', 'road']) },
];

/** Packages in no group, with the reason; physics is on hold and sciviz is still being built (work list 5). */
export const LEFT_OUT = {
  '@margoengine/physics': 'physics on hold',
  '@margoengine/physics2d': 'physics on hold',
  '@margoengine/ragdoll': 'physics on hold',
  '@margoengine/sciviz': 'sciviz batches 175, 176, 178',
};
