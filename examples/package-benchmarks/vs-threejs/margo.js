// Margo side of the vs-three.js benchmark; the defaults (WebGPU, 4x MSAA on desktop, DPR 1 here) are what an app gets.
// Three ways to draw the box and CAD scenes, paired with three.js like for like (README "What is compared"):
//   mode=mesh       one core mesh per object (core batches them into one draw per geometry)   <-> three Mesh per object
//   mode=instanced  @margoengine/materials createInstancedMesh, one per shape, per-instance tint <-> three InstancedMesh
//   mode=culled     @margoengine/culling CulledInstances (GPU frustum culling, indirect draws)  <-> three InstancedMesh
import {Engine, PbrMaterial, box} from '@margoengine/core';
import {engineRuntime} from '@margoengine/core/extension';
import {run, params} from './harness.js';
import {LIGHT, PALETTE, CAD_MATERIALS, boxes, cad, HELMET, sky} from './scenes.js';

// Box and CAD materials are single-sided (doubleSided:false), like three's default FrontSide: the parts are closed
// solids, and core's default double-sided material would shade back faces three never draws (a fairness fix; see
// docs/whitepaper/boxes-vs-threejs.md). Since 4be71f5 core draws such batches with a back-culled pipeline without the discard.
// Diagnostics only (?diag=a+b): patch what core sends to the GPU, without changing core, to isolate one cause at a
// time. Never part of a published variant.
//   double     core's default material (doubleSided:true)
//   nocull     core before 4be71f5: its back-culled pipeline is created with cull none and the discard (same pixels)
//   cull       pipeline cullMode 'back' + the shader's discard line removed on every core pipeline
//   plugin     the same as cull, done by a package: an engine plugin's pass rewrites the main pass's shader/descriptor
//   pass       an empty plugin pass (what any added pass costs: core then keeps MSAA buffers and resolves separately)
//   nodiscard  the discard line removed, cullMode none (is the discard instruction itself the cost?)
//   nostencil  depth32float instead of depth32float-stencil8
//   flat       fragment shader returns the vertex colour (vertex + raster cost only)
//   msaa1      1 sample (core's light tier)
const diag = new Set(params.diag);
const discard = /if\((!C&&)?!facing&&i\.material\.z<0\.5\)\{discard;\}/; // core's text before and since 4be71f5
if (diag.has('msaa1')) globalThis.margoLow = 1;
if (diag.has('nostencil')) {
  const request = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = function(d = {}) {return request.call(this, {...d, requiredFeatures: (d.requiredFeatures ?? []).filter(f => f !== 'depth32float-stencil8')});};
}
if (diag.has('cull') || diag.has('nodiscard') || diag.has('flat')) {
  const module = GPUDevice.prototype.createShaderModule;
  GPUDevice.prototype.createShaderModule = function(d) {
    let code = d.code;
    if (discard.test(code)) code = diag.has('flat') ? code.replace(/@fragment fn fragment[\s\S]*$/, '@fragment fn fragment(i:Output)->@location(0) vec4f {return vec4f(i.color,1);}') : code.replace(discard, '');
    return module.call(this, {...d, code});
  };
}
if (diag.has('nocull')) {
  const create = GPUDevice.prototype.createRenderPipelineAsync;
  GPUDevice.prototype.createRenderPipelineAsync = function(d) {return create.call(this, d.primitive?.cullMode === 'back' ? {...d, primitive: {...d.primitive, cullMode: 'none'}, fragment: {...d.fragment, constants: {}}} : d);};
}
if (diag.has('cull')) {
  const create = GPUDevice.prototype.createRenderPipelineAsync;
  GPUDevice.prototype.createRenderPipelineAsync = function(d) {return create.call(this, {...d, primitive: {...d.primitive, cullMode: 'back'}});};
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
  info: () => extra.draws ? {drawCalls: extra.draws, note: `${extra.draws} instanced draws, not counted by core`} : {drawCalls: engine.stats.drawCalls, note: 'core batches only (gltf-pro, IBL, shadow passes not counted)'},
});
const linear = hex => [1, 3, 5].map(i => {const v = parseInt(hex.slice(i, i + 2), 16) / 255;return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;});
// Column-major world matrix from position + Euler XYZ (as core's setRotation and three's Object3D), times the parent's;
// per-frame updates pass a scratch matrix (three's side reuses one too).
async function composer() {
  const {Matrix4, Euler, Quaternion, Vector3} = await import('@margoengine/math'), one = new Vector3(1, 1, 1), q = new Quaternion(), e = new Euler(), p = new Vector3();
  return (position, rotation, parent, m = new Matrix4()) => {m.compose(p.set(...position), q.setFromEuler(e.set(...rotation)), one);return parent ? m.premultiply(parent) : m;};
}
// Instanced variants. shapes: [{data (geometry data), geometry (core Geometry), material options, worlds: Matrix4[], tints?}].
// Returns the per-frame matrix setter for moving instances (shape, index, matrix) and the draw count.
async function instanced(engine, mode, shapes) {
  if (mode === 'instanced') {
    const {createInstancedMesh, Material} = await import('@margoengine/materials');
    const meshes = shapes.map(({data, material, worlds, tints}) => {
      const mesh = createInstancedMesh(engine, data, new Material({...material, ...sided}), worlds.length);
      worlds.forEach((w, i) => {mesh.instances.setMatrixAt(i, w.elements);if (tints) mesh.instances.setColorAt(i, tints[i]);});return mesh;
    });
    return {set: (shape, i, m) => meshes[shape].instances.setMatrixAt(i, m.elements), draws: meshes.length};
  }
  const {CulledInstances} = await import('@margoengine/culling');
  const parts = CulledInstances.attach(engine, shapes.map(({geometry, material, worlds}) => {
    const transforms = new Float32Array(worlds.length * 16);worlds.forEach((w, i) => transforms.set(w.elements, i * 16));
    return {geometry, material: new PbrMaterial({...material, ...sided}), transforms};
  }));
  return {set: (shape, i, m) => parts.setTransform(shape, i, m.elements), draws: shapes.length};
}

run(async (canvas, {scene, n, move, mode}, marks) => {
  if (scene !== 'helmet' && mode !== 'mesh') {
    const def = scene === 'boxes' ? boxes(n) : await cad(n), engine = await engineFor(canvas, def.camera, 64, marks), s = performance.now(), at = await composer();let shapes, update = () => {};
    if (scene === 'boxes') {
      // materials: one InstancedMesh with a per-instance tint (as three's setColorAt); culling: one batch per colour.
      const data = (await import('@margoengine/geometry')).boxGeometry(def.size, def.size, def.size), geometry = box(def.size, def.size, def.size), slots = PALETTE.map(() => 0);
      shapes = mode === 'instanced' ? [{data, material: {color: '#ffffff', ...def.material}, worlds: [], tints: []}] : PALETTE.map(color => ({geometry, material: {color, ...def.material}, worlds: []}));
      const where = def.items.map(b => {const shape = mode === 'instanced' ? 0 : b.color, list = shapes[shape];list.worlds.push(at(b.position, b.rotation));list.tints?.push(linear(PALETTE[b.color]));return [shape, slots[shape]++];});
      const moving = Math.round(n * move), set = await instanced(engine, mode, shapes), scratch = new (await import('@margoengine/math')).Matrix4();
      update = t => {for (let i = 0; i < moving; i++) {const b = def.items[i];set.set(...where[i], at(b.position, [0, b.rotation[1] + t, 0], null, scratch));}};
      marks.buildMs = +(performance.now() - s).toFixed(1);
      return app(engine, update, {camera: def.camera, draws: set.draws});
    }
    // CAD: the hierarchy's world matrices baked into one instanced draw per part shape, as three's instanced variant.
    const {toGeometry} = await import('@margoengine/geometry'), worlds = [], byShape = {};
    def.nodes.forEach((node, i) => {worlds.push(at(node.position, node.rotation, node.parent < 0 ? null : worlds[node.parent]));if (node.shape) (byShape[node.shape] ??= []).push(worlds[i]);});
    shapes = Object.entries(byShape).map(([k, list]) => ({data: def.shapes[k], geometry: mode === 'culled' ? toGeometry(def.shapes[k]) : null, material: CAD_MATERIALS[k], worlds: list}));
    const set = await instanced(engine, mode, shapes);marks.buildMs = +(performance.now() - s).toFixed(1);
    return app(engine, update, {camera: def.camera, draws: set.draws});
  }
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
