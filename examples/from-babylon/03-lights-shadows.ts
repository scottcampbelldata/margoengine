// Babylon.js, in words: a HemisphericLight for the ambient fill, a DirectionalLight with a direction and intensity, a
// PointLight with a range; a ShadowGenerator on the directional light with addShadowCaster(mesh) and
// receiveShadows = true on the ground, plus blur or PCF settings on the generator.
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

// DirectionalLight: direction. Margo gives the direction TOWARD the light (Babylon gives where the light travels),
// so a Babylon direction (1, -2, -1) is [-1, 2, 1] here. The last number is the intensity.
const light = engine.scene.lighting;
light.direction.set([-4, 5, 3, 3]);
light.radiance.set([1, 0.93, 0.82, 0.15]); // sun colour (linear rgb) and the ambient strength (HemisphericLight.intensity)

// ShadowGenerator + addShadowCaster. Core meshes receive shadows without any flag.
const shadows = Shadows.attach(engine, { resolution: 2048 });
shadows.add(cube);
shadows.add(ball);
shadows.add(floor, { castShadow: false }); // the floor only receives

// PointLight: a coloured lamp that circles the scene. `range` is in metres.
const lamps = Clustered.attach(engine);
let time = 0;
stage.onTick((delta) => {
  time += delta;
  lamps.setLights([{ position: [Math.cos(time) * 2.5, 1.2, Math.sin(time) * 2.5], range: 8, color: [1, 0.3, 0.2], intensity: 12 }]);
});
status.textContent = 'One sun with shadows and one moving point light.';
window.addEventListener('pagehide', () => stage.dispose(), { once: true });
