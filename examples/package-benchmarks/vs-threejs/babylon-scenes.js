// Babylon.js side of the benchmark, cadfile scene only, shared by the WebGL2 and WebGPU entries. Imports follow
// Babylon's ES6 tree-shaking guidance (one deep import per class; registerBuiltInLoaders() imports a loader, and each
// glTF extension, only when a file needs it), so the page loads what an app built the recommended way loads.
//   mode=mesh   as loaded (ImportMeshAsync), world matrices frozen (as three's matrixAutoUpdate off)
//   mode=tuned  Babylon's documented settings for a big static scene on top: materials frozen, active meshes frozen
//               (no per-frame culling), pointer-move picking off, material dirty checks blocked; on WebGPU also
//               snapshot rendering in FAST mode through SnapshotRenderingHelper (the frame's draws are recorded into
//               render bundles once and replayed every frame). Setup runs before the first measured frame, so it
//               counts toward Babylon's load time.
import { Scene } from '@babylonjs/core/scene.js';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js';
import { ImageProcessingConfiguration } from '@babylonjs/core/Materials/imageProcessingConfiguration.js';
import { ImportMeshAsync } from '@babylonjs/core/Loading/sceneLoader.js';
import { SceneLoaderFlags } from '@babylonjs/core/Loading/sceneLoaderFlags.js';
import { SnapshotRenderingHelper } from '@babylonjs/core/Misc/snapshotRenderingHelper.js';
import { registerBuiltInLoaders } from '@babylonjs/loaders/dynamic.js';
import { LIGHT, CLEAR, cadFile } from './scenes.js';

export async function babylonScene(canvas, { scene: name, mode, url, bounds }, marks, engine, idle) {
  if (name !== 'cadfile') throw new Error(`the Babylon.js pages run the cadfile scene only, not ${name}`);
  registerBuiltInLoaders();
  SceneLoaderFlags.ShowLoadingScreen = false;
  const s = performance.now(),
    def = cadFile(bounds),
    cam = def.camera,
    scene = new Scene(engine);
  // The same frame as the other engines: right-handed like glTF (the loader adds no mirroring root), the clear colour
  // in display values, ACES tone mapping like gltf-pro and three's ACESFilmic.
  scene.useRightHandedSystem = true;
  scene.clearColor = new Color4(...CLEAR, 1);
  scene.imageProcessingConfiguration.toneMappingEnabled = true;
  scene.imageProcessingConfiguration.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
  const sun = new DirectionalLight('sun', new Vector3(...LIGHT.direction.map((v) => -v)), scene);
  sun.intensity = LIGHT.intensity;
  // Uniform ambient: a hemisphere light with equal sky and ground colours adds intensity x albedo, as Margo's ambient.
  const ambient = new HemisphericLight('ambient', new Vector3(0, 1, 0), scene);
  ambient.intensity = LIGHT.ambient;
  ambient.groundColor = new Color3(1, 1, 1);
  ambient.specular = new Color3(0, 0, 0);
  const camera = new FreeCamera('camera', new Vector3(...cam.at(0)), scene),
    target = new Vector3(...cam.target);
  camera.fov = (cam.fov * Math.PI) / 180; // vertical, as Margo's and three's
  camera.minZ = cam.near;
  camera.maxZ = cam.far;
  camera.setTarget(target);

  const { meshes } = await ImportMeshAsync(url, scene);
  for (const mesh of meshes) mesh.freezeWorldMatrix();
  const frame = () => {
    engine._drawCalls.fetchNewFrame(); // internal counter Babylon's SceneInstrumentation reads; reset per frame here
    engine.beginFrame();
    scene.render();
    engine.endFrame();
  };
  if (mode === 'tuned') {
    for (const material of scene.materials) material.freeze();
    scene.skipPointerMovePicking = true;
    scene.blockMaterialDirtyMechanism = true;
    await new Promise((resolve, reject) => scene.freezeActiveMeshes(false, resolve, reject));
    if (engine.isWebGPU) {
      const helper = new SnapshotRenderingHelper(scene);
      helper.enableSnapshotRendering();
      // The helper turns snapshot rendering on a few frames after the scene is ready; render until it has.
      for (let i = 0; i < 600 && !(helper.isReady && engine.snapshotRendering); i++) {
        frame();
        await idle();
      }
      if (!engine.snapshotRendering) throw new Error('Babylon snapshot rendering did not turn on within 600 frames');
    }
  }
  marks.buildMs = +(performance.now() - s).toFixed(1);

  let drawCalls = 0;
  return {
    render(t) {
      camera.position.set(...cam.at(t));
      camera.setTarget(target);
      frame();
      drawCalls = engine._drawCalls.current;
    },
    info: () => ({ drawCalls, note: "engine._drawCalls (Babylon's own count; a replayed snapshot reports its draws)" }),
  };
}
