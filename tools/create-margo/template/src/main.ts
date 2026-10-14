import {Engine, PbrMaterial, box} from '@margoengine/core';
import {cylinderGeometry, sphereGeometry, torusKnotGeometry, toGeometry} from '@margoengine/geometry';
import {Environment, EnvironmentBackground, EnvironmentLighting} from '@margoengine/environment';
import {OrbitControls} from '@margoengine/controls';
import {Stats} from '@margoengine/stats';
import {applyQualityTier, paceEngine, watchQuality} from '@margoengine/quality';

// A small procedural studio (sky gradient, dark floor, two soft boxes) used for image-based lighting.
// For a real HDR: Environment.create(engine, await loadEnvironmentImage('/studio.hdr')).
function studio(width = 128, height = 64) {
  const data = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const up = Math.cos(Math.PI * (y + 0.5) / height); // 1 straight up, -1 straight down
    for (let x = 0; x < width; x++) {
      const u = x / width, softbox = up > 0.3 && up < 0.75 && (Math.abs(u - 0.2) < 0.06 || Math.abs(u - 0.65) < 0.04);
      const sky = up > 0 ? 0.25 + 0.75 * up : 0.08;
      const light = softbox ? 8 : 0;
      data.set([sky * 0.85 + light, sky * 0.92 + light, sky + light, 1], (y * width + x) * 4);
    }
  }
  return {width, height, data};
}

async function start() {
  applyQualityTier(); // before Engine.create: picks MSAA and pixel ratio for this device

  const canvas = document.querySelector('canvas')!;
  const engine = await Engine.create(canvas, {camera: {position: [0, 2.6, 6.2], target: [0, 0.6, 0], fov: 45}});
  paceEngine(engine); // steady ~60 FPS on the light tier, even on 120 Hz screens

  const environment = await Environment.create(engine, studio());
  engine.use(environment);
  engine.use(new EnvironmentLighting(environment));
  engine.use(new EnvironmentBackground(environment, {blur: 0.5, exposure: 0.45}));

  const knot = engine.createMesh()
    .setGeometry(toGeometry(torusKnotGeometry(0.55, 0.18, 160, 24)))
    .setMaterial(new PbrMaterial({color: '#e8b04a', metalness: 1, roughness: 0.25}));
  knot.position.set(0, 0.9, 0);
  engine.createMesh()
    .setGeometry(toGeometry(sphereGeometry(0.6, 48, 24)))
    .setMaterial(new PbrMaterial({color: '#84d6bd', roughness: 0.35}))
    .position.set(-2, 0.6, 0);
  engine.createMesh()
    .setGeometry(box(1, 1, 1))
    .setMaterial(new PbrMaterial({color: '#f2f2f2', roughness: 0.6}))
    .position.set(2, 0.5, 0);
  engine.createMesh()
    .setGeometry(toGeometry(cylinderGeometry(3, 3, 0.1, 96)))
    .setMaterial(new PbrMaterial({color: '#2a303a', roughness: 0.8}))
    .position.set(0, -0.05, 0);

  const orbit = new OrbitControls(engine); // left drag orbits, right drag pans, wheel zooms
  orbit.enableDamping = true;
  Stats.attach(engine); // FPS and frame-time overlay; remove for production

  engine.onFrame((_, delta) => { knot.rotation.y += delta * 0.6; });
  engine.start();
  watchQuality(); // measures the GPU once and remembers the best tier for the next visit
}

start().catch(error => {
  document.querySelector('#error')!.textContent = `Could not start: ${error instanceof Error ? error.message : error}`;
});
