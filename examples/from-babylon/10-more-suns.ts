// Babylon.js, in words: several DirectionalLights in one scene, each with its own direction, intensity and its own
// ShadowGenerator.
//
// Margo: core's own light is one sun. `DirectionalLights` (clustered/directional) adds up to 16 more, four of them
// shadowed by `LocalShadows`. Their `direction` is the way the light TRAVELS (Babylon's convention), unlike
// `engine.scene.lighting.direction`, which points toward the light. Here the core sun is switched off (strength 0) and
// two coloured suns do all the lighting.
import { createStage } from 'margoengine';
import { Clustered } from 'margoengine/clustered';
import { DirectionalLights } from 'margoengine/clustered/directional';
import { LocalShadows } from 'margoengine/clustered/shadows';
import { fail, status } from './common';

const stage = await createStage('#scene', { camera: { position: [5, 4, 7], target: [0, 0.8, 0] } }).catch(fail);
const engine = stage.engine;
const floor = stage.box({ size: [14, 0.2, 14], position: [0, -0.1, 0], color: '#cfcfc8' });
const cube = stage.box({ position: [-1.2, 0.5, 0], color: '#d9824c' });
const ball = stage.sphere({ radius: 0.6, position: [1.2, 0.6, 0], color: '#84d6bd', roughness: 0.3 });

engine.scene.lighting.direction.set([0, 1, 0, 0]); // the core sun, off
engine.scene.lighting.radiance.set([1, 1, 1, 0.1]); // a little ambient

const lights = Clustered.attach(engine);
const shadows = LocalShadows.attach(engine, { lights, resolution: 2048 });
const suns = DirectionalLights.attach(engine, { lights });
suns.setLights([
  { direction: [1, -2, -1], color: [1, 0.85, 0.7], intensity: 3, castShadow: true, shadow: { bounds: { min: [-7, 0, -7], max: [7, 3, 7] } } },
  { direction: [-1, -1.5, 0.5], color: [0.5, 0.7, 1], intensity: 1.5, castShadow: true, shadow: { bounds: { min: [-7, 0, -7], max: [7, 3, 7] } } },
]);
for (const mesh of [floor, cube, ball]) shadows.add(mesh);

status.textContent = 'Two shadowed directional lights, a warm one and a cool one.';
window.addEventListener('pagehide', () => stage.dispose(), { once: true });
