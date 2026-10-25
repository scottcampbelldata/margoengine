// Models a flange with @margoengine/brep, writes it to STEP, reads the STEP back, meshes the exact geometry and draws
// it with the stage. Everything runs in the page; no CAD server or Wasm CAD kernel is involved.
import { createStage, Geometry } from 'margoengine';
import { model, parseSTEP, tessellateSTEP } from '@margoengine/brep';
import { roundedFlange } from './brep/flange.js';

const status = document.querySelector<HTMLParagraphElement>('#status')!,
  canvas = document.querySelector<HTMLCanvasElement>('#viewport')!;

const stage = await createStage(canvas, {
  camera: { position: [0.075, 0.065, 0.09], target: [0, 0.013, 0], fov: 35, near: 0.001, far: 10 },
  onError: (error) => (status.textContent = String(error)),
});
const scene = stage.engine.scene;
scene.background = '#2b3139';
scene.lighting.radiance.set([1.35, 1.3, 1.25, 0.4]);
window.addEventListener('pagehide', () => stage.dispose(), { once: true });

const started = performance.now(),
  step = parseSTEP(model.bodiesToSTEP([roundedFlange()])),
  meshes = tessellateSTEP(step, { relativeDeflection: 0.0004, angle: 0.25 });
let triangles = 0;
for (const mesh of meshes) {
  const positions = mesh.positions.map((v) => v * mesh.unit);
  // The modeler's Z is up; the stage's Y is up.
  const yUp = (a: Float32Array) => {
    const out = new Float32Array(a.length);
    for (let i = 0; i < a.length; i += 3) [out[i], out[i + 1], out[i + 2]] = [a[i], a[i + 2], -a[i + 1]];
    return out;
  };
  stage.mesh(new Geometry(yUp(positions), yUp(mesh.normals), mesh.indices), {
    color: '#c3c9d0',
    metalness: 0.3,
    roughness: 0.4,
    name: 'flange',
  });
  triangles += mesh.indices.length / 3;
}
status.textContent = `${step.bodies[0].faces.length} faces, ${triangles} triangles, modeled and meshed in ${Math.round(performance.now() - started)} ms`;
