// PlayCanvas, in words: a `StandardMaterial` with `useMetalness = true`, a `diffuse` colour (or `diffuseMap`),
// `metalness`, `gloss` (1 is smooth), `diffuseMapTiling` for repeats, then `material.update()`. A `render` component's
// material slot takes it. Textures are `Asset`s of type 'texture'.
//
// Margo: a geometry (`@margoengine/geometry`) plus a `PbrMaterial` (`@margoengine/materials`) on a mesh. Margo's number
// is roughness, not gloss: roughness = 1 - gloss. Textured materials need the materials package; plain colours work in
// core alone. `Texture` takes raw pixels, so this example paints its own checkerboard; `loadTexture(url)` loads a file.
import { createStage } from 'margoengine';
import { sphereGeometry, torusKnotGeometry } from 'margoengine/geometry';
import { PbrMaterial, Texture, createMesh } from 'margoengine/materials';
import { fail, status } from './common';

const stage = await createStage('#scene', { camera: { position: [0, 1.5, 5], target: [0, 0.8, 0] } }).catch(fail);
const engine = stage.engine;

// A 64 x 64 checkerboard (PlayCanvas: a texture asset, or a pc.Texture filled by hand).
const pixels = new Uint8Array(64 * 64 * 4);
for (let y = 0; y < 64; y++)
  for (let x = 0; x < 64; x++) {
    const light = ((x >> 3) + (y >> 3)) % 2 === 0;
    pixels.set(light ? [240, 230, 210, 255] : [60, 80, 120, 255], (y * 64 + x) * 4);
  }
const checker = new Texture({ data: pixels, width: 64, height: 64 }, { wrapS: 'repeat', wrapT: 'repeat' });

// diffuseMap, metalness = 0, gloss = 0.6 -> roughness 0.4
const textured = new PbrMaterial({ map: checker, metalness: 0, roughness: 0.4 });
textured.setUVTransform({ scale: [4, 2] }); // diffuseMapTiling
const ball = createMesh(engine, sphereGeometry(0.8, 64, 32), textured);
ball.root.setPosition([-1.2, 0.8, 0]);

// diffuse as a colour, metalness = 1, gloss = 0.75. Hex strings are sRGB.
const knot = createMesh(engine, torusKnotGeometry(0.55, 0.18, 160, 20), new PbrMaterial({ color: '#d4a64a', metalness: 1, roughness: 0.25 }));
knot.root.setPosition([1.4, 0.9, 0]);

// A metal reflects its surroundings; PlayCanvas's `scene.envAtlas` is `Environment.attach` here (see the guide).
stage.box({ size: [8, 0.1, 8], position: [0, -0.05, 0], color: '#d8d8cf' });
engine.scene.lighting.direction.set([-3, 5, 4, 3]);

stage.onTick((delta) => {
  ball.root.rotation.y += delta * 0.6; // entity.rotate(0, k * dt, 0), but radians, not degrees
  knot.root.rotation.y -= delta * 0.4;
});
status.textContent = 'A textured PBR sphere and a gold PBR torus knot.';
window.addEventListener('pagehide', () => stage.dispose(), { once: true });
