// PlayCanvas, in words: an entity with a `light` component. Type 'directional' shines along the entity's -Y axis, so you
// rotate the entity to aim it; 'omni' and 'spot' have `range` and `intensity`; `castShadows = true` and
// `shadowResolution` turn shadows on; a mesh opts in with `castShadows` and `receiveShadows` on its render component.
// `app.scene.ambientLight` sets the ambient fill.
//
// Margo: one sun and an ambient term live on `engine.scene.lighting`. `Shadows.attach` makes the sun cast shadows; add
// each caster. Point and spot lights are `Clustered`; `setLights` replaces the whole list, so call it again to move a lamp.
import { createStage } from 'margoengine';
import { Clustered } from 'margoengine/clustered';
import { Shadows } from 'margoengine/shadows';
import { fail, status } from './common';

const stage = await createStage('#scene', { camera: { position: [5, 4, 7], target: [0, 0.8, 0] } }).catch(fail);
const engine = stage.engine;
const floor = stage.box({ size: [14, 0.2, 14], position: [0, -0.1, 0], color: '#cfcfc8' });
const cube = stage.box({ position: [-1.2, 0.5, 0], color: '#d9824c' });
const ball = stage.sphere({ radius: 0.6, position: [1.2, 0.6, 0], color: '#84d6bd', roughness: 0.3 });

// Directional light: Margo takes the direction TOWARD the light, the opposite of the way an entity's -Y axis points.
// The last number is the intensity.
const light = engine.scene.lighting;
light.direction.set([-4, 5, 3, 3]);
light.radiance.set([1, 0.93, 0.82, 0.15]); // sun colour (linear rgb) and the ambient strength (scene.ambientLight)

// castShadows + shadowResolution. Core meshes receive shadows without any flag.
const shadows = Shadows.attach(engine, { resolution: 2048 });
shadows.add(cube);
shadows.add(ball);
shadows.add(floor, { castShadow: false }); // receiveShadows only

// An 'omni' light: a coloured lamp that circles the scene. `range` is in metres.
const lamps = Clustered.attach(engine);
let time = 0;
stage.onTick((delta) => {
  time += delta;
  lamps.setLights([{ position: [Math.cos(time) * 2.5, 1.2, Math.sin(time) * 2.5], range: 8, color: [1, 0.3, 0.2], intensity: 12 }]);
});
status.textContent = 'One sun with shadows and one moving point light.';
window.addEventListener('pagehide', () => stage.dispose(), { once: true });
