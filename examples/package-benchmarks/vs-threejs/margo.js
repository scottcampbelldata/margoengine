// Margo side of the vs-three.js benchmark. Core meshes are instanced automatically (one draw per geometry), so there is
// one Margo variant per scene; the defaults (WebGPU, 4x MSAA on desktop, DPR 1 here) are what an app gets.
import {Engine, PbrMaterial, box} from '@margoengine/core';
import {engineRuntime} from '@margoengine/core/extension';
import {run} from './harness.js';
import {LIGHT, PALETTE, CAD_MATERIALS, boxes, cad, HELMET, sky} from './scenes.js';

const sceneSamples = () => globalThis.margoLow || /Mobi|Android/.test(navigator.userAgent) ? 1 : 4; // packages/core/src/quality.ts

async function engineFor(canvas, camera, capacity, marks) {
  const s = performance.now();
  const engine = await Engine.create(canvas, {backend: 'webgpu', capacity, camera: {fov: camera.fov, near: camera.near, far: camera.far, position: camera.at(0), target: camera.target}});
  marks.createMs = +(performance.now() - s).toFixed(1);
  const {lighting} = engineRuntime(engine);
  lighting.direction.set([...LIGHT.direction, LIGHT.intensity]);lighting.radiance.set([1, 1, 1, LIGHT.ambient]);
  return engine;
}
const app = (engine, update, extra = {}) => ({
  samples: sceneSamples(),
  render(t) {update(t);engine.camera.position = extra.camera.at(t);engine.render();},
  idle: () => engine.gpu.queue.onSubmittedWorkDone(),
  info: () => ({drawCalls: engine.stats.drawCalls, note: 'core batches only (gltf-pro, IBL, shadow passes not counted)'}),
});

run(async (canvas, {scene, n, move}, marks) => {
  if (scene === 'boxes') {
    const def = boxes(n), engine = await engineFor(canvas, def.camera, n + 8, marks);let s = performance.now();
    const geometry = box(def.size, def.size, def.size), materials = PALETTE.map(color => new PbrMaterial({color, ...def.material}));
    const meshes = def.items.map(b => engine.createMesh().setGeometry(geometry).setMaterial(materials[b.color]).setPosition(b.position).setRotation(b.rotation));
    marks.buildMs = +(performance.now() - s).toFixed(1);
    const moving = Math.round(n * move);
    return app(engine, t => {for (let i = 0; i < moving; i++) meshes[i].rotation.y = def.items[i].rotation[1] + t;}, {camera: def.camera});
  }
  if (scene === 'cad') {
    const def = await cad(n), engine = await engineFor(canvas, def.camera, def.nodes.length + 8, marks);let s = performance.now();
    const {toGeometry} = await import('@margoengine/geometry');
    const geometries = Object.fromEntries(Object.entries(def.shapes).map(([k, v]) => [k, toGeometry(v)])), materials = Object.fromEntries(Object.entries(CAD_MATERIALS).map(([k, v]) => [k, new PbrMaterial(v)]));
    const meshes = [];
    for (const node of def.nodes) {
      const mesh = engine.createMesh(node.parent < 0 ? undefined : meshes[node.parent]).setPosition(node.position).setRotation(node.rotation);
      if (node.shape) mesh.setGeometry(geometries[node.shape]).setMaterial(materials[node.shape]);
      meshes.push(mesh);
    }
    marks.buildMs = +(performance.now() - s).toFixed(1);
    return app(engine, () => {}, {camera: def.camera});
  }
  if (scene === 'helmet') {
    const engine = await engineFor(canvas, HELMET.camera, 1024, marks);let s = performance.now();
    const [{loadGLTF}, {Environment, EnvironmentLighting}, {Shadows}] = await Promise.all([import('@margoengine/gltf-pro'), import('@margoengine/environment'), import('@margoengine/shadows')]);
    const f = HELMET.floor;engine.createMesh().setGeometry(box(...f.size)).setPosition(f.position).setMaterial(new PbrMaterial({color: f.color, roughness: f.roughness, metalness: f.metalness}));
    const model = await loadGLTF(engine, HELMET.url);
    const environment = await Environment.create(engine, sky());engine.use(environment);
    const ibl = new EnvironmentLighting(environment);engine.use(ibl);ibl.applyTo(model);
    const shadows = Shadows.attach(engine, {resolution: HELMET.shadow.resolution, distance: 10});shadows.add(model);
    marks.buildMs = +(performance.now() - s).toFixed(1);
    return app(engine, () => {}, {camera: HELMET.camera});
  }
  throw new Error(`unknown scene ${scene}`);
});
