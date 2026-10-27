import { createStage } from 'margoengine';
import { boxGeometry, planeGeometry, sphereGeometry } from 'margoengine/geometry';
import { PbrMaterial, Texture, createMesh } from 'margoengine/materials';
import { Picking, Selection } from 'margoengine/selection';
import { Shadows } from 'margoengine/shadows';

const status = document.querySelector('#status')!;
if (!('gpu' in navigator)) {
  status.textContent = 'This browser has no WebGPU, which this scene needs. See "Browser support" in the README.';
  throw new Error('WebGPU unavailable');
}

// A 64 x 64 checkerboard painted in code, so the example needs no image file.
const pixels = new Uint8Array(64 * 64 * 4);
for (let y = 0; y < 64; y++)
  for (let x = 0; x < 64; x++) {
    const light = ((x >> 3) + (y >> 3)) % 2 === 0;
    pixels.set(light ? [235, 235, 225, 255] : [70, 90, 110, 255], (y * 64 + x) * 4);
  }
const checker = new Texture({ data: pixels, width: 64, height: 64 }, { wrapS: 'repeat', wrapT: 'repeat' });

// The stage mounts a canvas in #scene, adds orbit/pan/zoom with the mouse and starts the render loop.
const stage = await createStage('#scene', { camera: { position: [4, 3, 6], target: [0, 0.6, 0] } });
const engine = stage.engine;

// Three lit, textured meshes. The default sun comes from the upper right.
const floor = new PbrMaterial({ map: checker });
floor.setUVTransform({ scale: [6, 6] }); // repeat the texture 6 times across the floor
const ground = createMesh(engine, planeGeometry(12, 12), floor);
ground.root.setRotation([-Math.PI / 2, 0, 0]); // planes face +z; lay it flat
const crate = createMesh(engine, boxGeometry(1, 1, 1), new PbrMaterial({ map: checker, roughness: 0.6 }));
crate.root.setPosition([-1, 0.5, 0]);
const ball = createMesh(engine, sphereGeometry(0.6, 48, 24), new PbrMaterial({ color: '#84d6bd', roughness: 0.25 }));
ball.root.setPosition([1, 0.6, 0]);

// Shadows: tell the shadow package which meshes cast and receive.
const shadows = Shadows.attach(engine, { resolution: 2048 });
for (const mesh of [ground, crate, ball]) shadows.add(mesh);

// Click a mesh to outline it; click empty space to clear.
const picking = Picking.attach(engine);
const outline = Selection.attach(engine, { color: [1, 0.6, 0] });
const names = new Map<unknown, string>([
  [crate, 'crate'],
  [ball, 'ball'],
]);
let pressed = [0, 0];
let busy = false; // one pick can wait at a time
engine.canvas.addEventListener('pointerdown', (event) => {
  pressed = [event.clientX, event.clientY];
});
engine.canvas.addEventListener('click', async (event) => {
  const moved = Math.hypot(event.clientX - pressed[0], event.clientY - pressed[1]);
  if (busy || moved > 4) return; // ignore the end of an orbit drag
  busy = true;
  const hit = await picking.pick(event.offsetX, event.offsetY);
  busy = false;
  const name = hit?.model ? names.get(hit.model) : undefined;
  outline.set(name && hit ? [hit.mesh] : []);
  status.textContent = name ? `Picked the ${name}.` : 'Click the crate or the ball.';
});

stage.onTick((delta) => {
  crate.root.rotation.y += delta * 0.5;
});
window.addEventListener('pagehide', () => stage.dispose(), { once: true });
