// Babylon.js, in words: import @babylonjs/loaders, then SceneLoader.ImportMeshAsync (or AppendAsync, or
// LoadAssetContainerAsync) with a root URL and file name. The result holds the meshes, skeletons and animation groups,
// and the glTF root node is a TransformNode named __root__ that carries the handedness flip. Then you scale the root
// and call scene.createDefaultCameraOrLight or point the camera at the meshes yourself.
//
// Margo: `loadGLTF(engine, url)` fetches, decodes and adds the model, and resolves with a `PBRModel`. There is no
// handedness root to unwrap: glTF's right-handed Y-up space is Margo's space. Pass an AbortSignal to cancel the load.
import { createStage } from 'margoengine';
import { loadGLTF } from 'margoengine/gltf/pbr';
import { Shadows } from 'margoengine/shadows';
import { fail, status } from './common';

const stage = await createStage('#scene', { camera: { position: [0, 1.2, 3], target: [0, 0.5, 0] } }).catch(fail);
const engine = stage.engine;
const cancel = new AbortController(); // cancel.abort() stops a load that is no longer wanted
status.textContent = 'Loading the helmet...';
const model = await loadGLTF(engine, '/examples/assets/flight-helmet.glb', { signal: cancel.signal }).catch(fail);

model.root.setPosition([0, -model.bounds[1], 0]); // stand it on y = 0; bounds are [minX, minY, minZ, maxX, maxY, maxZ]
const b = model.bounds;
engine.camera.fitToBoundingBox([b[0], b[1], b[2]], [b[3], b[4], b[5]]); // like framing with camera.zoomOn(meshes)

const floor = stage.box({ size: [6, 0.1, 6], position: [0, -0.05, 0], color: '#d4d4cc' });
const shadows = Shadows.attach(engine, { resolution: 2048 });
shadows.add(model);
shadows.add(floor, { castShadow: false });

status.textContent = `Loaded ${model.nodes.length} nodes. Drag to look around.`;
window.addEventListener('pagehide', () => stage.dispose(), { once: true }); // frees the model too
