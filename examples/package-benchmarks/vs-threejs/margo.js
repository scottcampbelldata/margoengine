// Margo side of the vs-three.js benchmark. Core meshes are instanced automatically (one draw per geometry), so there is
// one Margo variant per scene; the defaults (WebGPU, 4x MSAA on desktop, DPR 1 here) are what an app gets.
import {Engine, PbrMaterial, box} from '@margoengine/core';
import {engineRuntime} from '@margoengine/core/extension';
import {run, params} from './harness.js';
import {LIGHT, PALETTE, CAD_MATERIALS, boxes, cad, HELMET, sky} from './scenes.js';

// Box and CAD materials are single-sided (doubleSided:false), like three's default FrontSide: the parts are closed
// solids, and core's default double-sided material would shade back faces three never draws (a fairness fix; see
// docs/whitepaper/boxes-vs-threejs.md). Core still rasterizes back faces and discards them in the shader.
// Diagnostics only (?diag=a+b): patch what core sends to the GPU, without changing core, to isolate one cause at a
// time. Never part of a published variant.
//   double     core's default material (doubleSided:true)
//   cull       pipeline cullMode 'back' + the shader's discard line removed (what scratch/core-backface-cull does)
//   plugin     the same as cull, done by a package: an engine plugin's pass rewrites the main pass's shader/descriptor
//   pass       an empty plugin pass (what any added pass costs: core then keeps MSAA buffers and resolves separately)
//   nodiscard  the discard line removed, cullMode none (is the discard instruction itself the cost?)
//   nostencil  depth32float instead of depth32float-stencil8
//   flat       fragment shader returns the vertex colour (vertex + raster cost only)
//   msaa1      1 sample (core's light tier)
const diag = new Set(params.diag);
const discard = 'if(!facing&&i.material.z<0.5){discard;}';
if (diag.has('msaa1')) globalThis.margoLow = 1;
if (diag.has('nostencil')) {
  const request = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = function(d = {}) {return request.call(this, {...d, requiredFeatures: (d.requiredFeatures ?? []).filter(f => f !== 'depth32float-stencil8')});};
}
if (diag.has('cull') || diag.has('nodiscard') || diag.has('flat')) {
  const module = GPUDevice.prototype.createShaderModule;
  GPUDevice.prototype.createShaderModule = function(d) {
    let code = d.code;
    if (code.includes(discard)) code = diag.has('flat') ? code.replace(/@fragment fn fragment[\s\S]*$/, '@fragment fn fragment(i:Output)->@location(0) vec4f {return vec4f(i.color,1);}') : code.replace(discard, '');
    return module.call(this, {...d, code});
  };
  if (diag.has('cull')) {
    const create = GPUDevice.prototype.createRenderPipelineAsync;
    GPUDevice.prototype.createRenderPipelineAsync = function(d) {return create.call(this, {...d, primitive: {...d.primitive, cullMode: 'back'}});};
  }
}
const sided = {doubleSided: diag.has('double')};
// Package-side culling: every frame, before core's main pass, swap in the culled shader and descriptor (core builds and
// caches that pipeline variant). Adding any pass makes core keep MSAA buffers and resolve in an extra pass.
const cullPlugin = () => {
  let shader, descriptor;
  return {name: 'diag-cull', setup() {}, registerPasses: graph => graph.add({name: 'diag-cull', order: -1, execute(c) {
    if (c.backend !== 'webgpu') return;
    shader ??= c.shader.replace(discard, '');descriptor ??= {...c.descriptor, primitive: {...c.descriptor.primitive, cullMode: 'back'}};
    if (diag.has('plugin')) {c.shader = shader;c.descriptor = descriptor;}
  }})};
};

const sceneSamples = () => globalThis.margoLow || /Mobi|Android/.test(navigator.userAgent) ? 1 : 4; // packages/core/src/quality.ts

async function engineFor(canvas, camera, capacity, marks) {
  const s = performance.now();
  const engine = await Engine.create(canvas, {backend: 'webgpu', capacity, camera: {fov: camera.fov, near: camera.near, far: camera.far, position: camera.at(0), target: camera.target}});
  marks.createMs = +(performance.now() - s).toFixed(1);
  const {lighting} = engineRuntime(engine);
  lighting.direction.set([...LIGHT.direction, LIGHT.intensity]);lighting.radiance.set([1, 1, 1, LIGHT.ambient]);
  if (diag.has('plugin') || diag.has('pass')) engine.use(cullPlugin());
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
    const geometry = box(def.size, def.size, def.size), materials = PALETTE.map(color => new PbrMaterial({color, ...def.material, ...sided}));
    const meshes = def.items.map(b => engine.createMesh().setGeometry(geometry).setMaterial(materials[b.color]).setPosition(b.position).setRotation(b.rotation));
    marks.buildMs = +(performance.now() - s).toFixed(1);
    const moving = Math.round(n * move);
    return app(engine, t => {for (let i = 0; i < moving; i++) meshes[i].rotation.y = def.items[i].rotation[1] + t;}, {camera: def.camera});
  }
  if (scene === 'cad') {
    const def = await cad(n), engine = await engineFor(canvas, def.camera, def.nodes.length + 8, marks);let s = performance.now();
    const {toGeometry} = await import('@margoengine/geometry');
    const geometries = Object.fromEntries(Object.entries(def.shapes).map(([k, v]) => [k, toGeometry(v)])), materials = Object.fromEntries(Object.entries(CAD_MATERIALS).map(([k, v]) => [k, new PbrMaterial({...v, ...sided})]));
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
