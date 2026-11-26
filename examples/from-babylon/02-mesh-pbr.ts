// Babylon.js, in words: MeshBuilder.CreateSphere makes a mesh; a PBRMaterial (or PBRMetallicRoughnessMaterial) gets an
// albedoColor or albedoTexture, metallic, roughness and a bumpTexture; mesh.material = material; mesh.position and
// mesh.rotation place it. Textures come from new Texture(url) or a DynamicTexture painted on a 2D canvas.
//
// Margo: a geometry (`@margoengine/geometry`) plus a `PbrMaterial` (`@margoengine/materials`) on a mesh. Textured
// materials need the materials package; plain colours work in core alone. `Texture` takes raw pixels, so this example
// paints its own checkerboard and needs no image file; `loadTexture(url)` loads a file.
import { createStage } from 'margoengine';
import { sphereGeometry, torusKnotGeometry } from 'margoengine/geometry';
import { PbrMaterial, Texture, createMesh } from 'margoengine/materials';
import { fail, status } from './common';

const stage = await createStage('#scene', { camera: { position: [0, 1.5, 5], target: [0, 0.8, 0] } }).catch(fail);
const engine = stage.engine;

// A 64 x 64 checkerboard (Babylon: DynamicTexture, or new Texture('checker.png')).
const pixels = new Uint8Array(64 * 64 * 4);
for (let y = 0; y < 64; y++)
  for (let x = 0; x < 64; x++) {
    const light = ((x >> 3) + (y >> 3)) % 2 === 0;
    pixels.set(light ? [240, 230, 210, 255] : [60, 80, 120, 255], (y * 64 + x) * 4);
  }
const checker = new Texture({ data: pixels, width: 64, height: 64 }, { wrapS: 'repeat', wrapT: 'repeat' });

// albedoTexture, metallic = 0, roughness = 0.4
const textured = new PbrMaterial({ map: checker, metalness: 0, roughness: 0.4 });
textured.setUVTransform({ scale: [4, 2] }); // texture.uScale / vScale
const ball = createMesh(engine, sphereGeometry(0.8, 64, 32), textured);
ball.root.setPosition([-1.2, 0.8, 0]);

// albedoColor, metallic = 1, roughness = 0.25; colours are '#rrggbb' sRGB strings.
const knot = createMesh(engine, torusKnotGeometry(0.55, 0.18, 160, 20), new PbrMaterial({ color: '#d4a64a', metalness: 1, roughness: 0.25 }));
knot.root.setPosition([1.4, 0.9, 0]);

// Without an environment a metal has nothing to reflect except the sun. Babylon's scene.environmentTexture is
// `Environment.attach` here; see docs/from-babylon.md, "Environment and sky".
stage.box({ size: [8, 0.1, 8], position: [0, -0.05, 0], color: '#d8d8cf' });
engine.scene.lighting.direction.set([-3, 5, 4, 3]);

stage.onTick((delta) => {
  ball.root.rotation.y += delta * 0.6; // mesh.rotation.y += ... (Euler XYZ, radians)
  knot.root.rotation.y -= delta * 0.4;
});
status.textContent = 'A textured PBR sphere and a gold PBR torus knot.';
window.addEventListener('pagehide', () => stage.dispose(), { once: true });
