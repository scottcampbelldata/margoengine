// Babylon.js, in words: SceneLoader.Append (or ImportMeshAsync) on a .babylon file brings in its meshes, materials,
// lights, cameras and clear colour, with the file's left-handed numbers used as they are.
//
// Margo: `parseBabylon` reads the file into plain data and mirrors it into Margo's right-handed space (the default,
// `rightHanded: true`); nothing is added to the engine until you ask. `flattenBabylon` bakes each mesh's parents and
// placement into one geometry with a group per mesh, and `createMeshes` turns the groups into engine meshes. The camera,
// the sun and the clear colour are in the parsed data, and you apply them yourself. Skeletons, particle systems, sounds,
// LODs and post processes in a .babylon file are not turned into engine objects: see docs/from-babylon.md.
import { createStage } from 'margoengine';
import { createMeshes } from '@margoengine/loaders';
import { flattenBabylon, parseBabylon } from '@margoengine/loaders/babylon';
import { Shadows } from 'margoengine/shadows';
import { fail, status } from './common';

const text = await (await fetch('/examples/from-babylon/scene.babylon')).text();
const scene = parseBabylon(text); // throws a LoaderError with a code on a bad file
const camera = scene.cameras.find((c) => c.id === scene.activeCameraId) ?? scene.cameras[0];

const stage = await createStage('#scene', {
  background: scene.clearColor ? rgbToHex(scene.clearColor) : undefined,
  camera: camera ? { position: camera.position, target: camera.target, fov: (camera.fov * 180) / Math.PI } : undefined,
}).catch(fail);
const engine = stage.engine;

const sun = scene.lights.find((light) => light.kind === 'directional');
if (sun?.direction) {
  const [x, y, z] = sun.direction; // Babylon's direction is where the light travels; Margo's points toward the light
  engine.scene.lighting.direction.set([-x, -y, -z, 3 * sun.intensity]);
}

const loaded = createMeshes(engine, flattenBabylon(scene), { roughness: 0.8, doubleSided: false });
const shadows = Shadows.attach(engine, { resolution: 2048 });
for (const mesh of loaded.meshes) shadows.add(mesh, { castShadow: mesh.name !== 'ground' });

status.textContent = `${scene.meshes.length} meshes, ${scene.materials.length} materials${scene.warnings.length ? `, ${scene.warnings.length} warnings` : ''}. Drag to orbit.`;
window.addEventListener(
  'pagehide',
  () => {
    loaded.dispose();
    stage.dispose();
  },
  { once: true },
);

// Babylon's clear colour is shown as it is written, so it reads as sRGB 0..1; createStage wants a hex string.
function rgbToHex(rgb: readonly number[]): string {
  return '#' + rgb.slice(0, 3).map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
}
