// PlayCanvas, in words: register an Asset of type 'container' with the glb's URL in `app.assets`, `app.assets.load`
// it, and when it is ready call `asset.resource.instantiateRenderEntity()` and add the entity to `app.root`. The asset
// registry keeps one copy and you instantiate it as often as you like. Then you scale and place the entity and aim the
// camera at it yourself.
//
// Margo: `loadGLTF(engine, url)` fetches, decodes and adds the model, and resolves with a `PBRModel`. There is no
// registry; keep the model in your own variable. glTF's right-handed Y-up space is Margo's space. Pass an AbortSignal
// to cancel the load.
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
engine.camera.fitToBoundingBox([b[0], b[1], b[2]], [b[3], b[4], b[5]]); // frame it, like focusing on an AABB

const floor = stage.box({ size: [6, 0.1, 6], position: [0, -0.05, 0], color: '#d4d4cc' });
const shadows = Shadows.attach(engine, { resolution: 2048 });
shadows.add(model);
shadows.add(floor, { castShadow: false });

status.textContent = `Loaded ${model.nodes.length} nodes. Drag to look around.`;
window.addEventListener('pagehide', () => stage.dispose(), { once: true }); // frees the model too
