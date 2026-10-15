// CPU-side precision of core's float32 path for parts far from the origin, and the FloatingOrigin rebase cost.
// Run after npm run build:packages:  node examples/package-benchmarks/large-coordinates.mjs [--cost] [--json=file]
// Precision: real core (kernel world matrices, Camera.matrix) on a fake WebGPU device; the vertex shader is emulated
// in float32 (Math.fround after every operation) and compared with a float64 projection, in pixels of a 640x360 view.
// Each stage is also rounded alone (the rest float64) to show where precision is lost. --cost times rebases of
// 10k/50k placed roots (timing: run node scripts/quiet-gate.mjs first).
import {writeFileSync} from 'node:fs';
import {EngineKernel, Geometry, PbrMaterial, box} from '../../packages/core/dist/index.js';
import {FloatingOrigin} from '../../packages/cameras/dist/origin.js';
import {DISTANCES, ROTATION, BOLTS, FRAMES, CAMERA, WIDTH, HEIGHT, cameraOffset, position, flange} from './large-coordinates-scene.js';

const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const f = Math.fround;

export function fakeGPU() {
  const context = {configure() {}, unconfigure() {}, getCurrentTexture: () => ({createView: () => ({})})};
  const canvas = {width: WIDTH, height: HEIGHT, clientWidth: WIDTH, clientHeight: HEIGHT, getContext: () => context};
  const resource = descriptor => Object.assign({destroy() {}}, descriptor);
  const stats = {uploadBytes: 0};
  const device = {features: new Set(), limits: {maxBufferSize: 2 ** 30}, lost: new Promise(() => {}), addEventListener() {}, destroy() {},
    queue: {writeBuffer(buffer, offset, data, start = 0, size) {stats.uploadBytes += (size ?? data.length - start) * (data.BYTES_PER_ELEMENT ?? 1);}, submit() {}},
    createShaderModule: d => d, createBindGroup: () => ({}), createBuffer: resource,
    createTexture: d => Object.assign(resource(d), {createView: () => ({})}),
    async createRenderPipelineAsync() {return {getBindGroupLayout: () => ({})};}, createRenderPipeline: () => ({getBindGroupLayout: () => ({})}),
    createCommandEncoder: () => ({beginRenderPass: () => ({setPipeline() {}, setBindGroup() {}, setVertexBuffer() {}, setIndexBuffer() {}, drawIndexed() {}, end() {}}), finish: () => ({})})};
  Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {userAgent: '', gpu: {requestAdapter: async () => ({features: new Set(), requestDevice: async () => device}), getPreferredCanvasFormat: () => 'bgra8unorm'}}});
  globalThis.GPUBufferUsage = {UNIFORM: 1, COPY_DST: 2, VERTEX: 4, STORAGE: 8, INDEX: 16, INDIRECT: 32, COPY_SRC: 64, MAP_READ: 128};
  globalThis.GPUTextureUsage = {RENDER_ATTACHMENT: 1, COPY_SRC: 2};
  return {canvas, stats};
}

// Column-major 4x4 helpers in float64.
const mul = (a, b) => {const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return o;};
const translation = t => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2], 1];
function euler([x, y, z]) { // core's XYZ euler -> quaternion -> matrix, in float64
  const sx = Math.sin(x / 2), cx = Math.cos(x / 2), sy = Math.sin(y / 2), cy = Math.cos(y / 2), sz = Math.sin(z / 2), cz = Math.cos(z / 2);
  const qx = sx * cy * cz + cx * sy * sz, qy = cx * sy * cz - sx * cy * sz, qz = cx * cy * sz + sx * sy * cz, qw = cx * cy * cz - sx * sy * sz;
  return [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy + qw * qz), 2 * (qx * qz - qw * qy), 0, 2 * (qx * qy - qw * qz), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz + qw * qx), 0, 2 * (qx * qz + qw * qy), 2 * (qy * qz - qw * qx), 1 - 2 * (qx * qx + qy * qy), 0, 0, 0, 0, 1];
}
// m * [v, 1]; `round` rounds after every multiply and add (float32 GPU arithmetic) when set.
const apply = (m, v, round = x => x) => [0, 1, 2, 3].map(r => round(round(round(round(m[r] * v[0]) + round(m[4 + r] * v[1])) + round(m[8 + r] * v[2])) + m[12 + r]));
const screen = c => [(c[0] / c[3] * 0.5 + 0.5) * WIDTH, (0.5 - c[1] / c[3] * 0.5) * HEIGHT];
// Core's private float64 view and projection (name-mangled in dist; declared in that order).
const viewProjection = camera => {const [view, projection] = Object.values(camera).filter(v => v instanceof Float64Array); return mul(Array.from(projection), Array.from(view));};

const geometry = flange(), vertices = [];
for (let i = 0; i < geometry.positions.length; i += 3) vertices.push(geometry.positions.slice(i, i + 3).map(f));
const boltVertices = []; {const b = box(0.001, 0.001, 0.001).vertices; for (let i = 0; i < b.length; i += 6) boltVertices.push([b[i], b[i + 1], b[i + 2]]);}

/** Pixel error per stage for one distance; mode 'core' (positions as is) or 'origin' (FloatingOrigin). */
async function precision(distance, mode) {
  const {canvas} = fakeGPU();
  const engine = await EngineKernel.create(canvas, {capacity: 16, backend: 'webgpu', camera: {...CAMERA}});
  try {
    const material = new PbrMaterial({color: '#c0c0c0'}), root = engine.createMesh().setGeometry(new Geometry(geometry.positions, geometry.normals, geometry.indices)).setMaterial(material).setRotation(ROTATION);
    const bolts = BOLTS.map(p => engine.createMesh(root).setGeometry(box(0.001, 0.001, 0.001)).setMaterial(material).setPosition(p));
    const world = position(distance), origin = mode === 'core' ? null : FloatingOrigin.attach(engine);
    if (origin) origin.place(root, world); else root.setPosition(world);
    // 'origin-edge': worst case of the default threshold, the origin 0.99 x ratio x 50 mm (49.5 m) from the camera.
    if (mode === 'origin-edge') {origin.lookAt(world.map((v, i) => v + cameraOffset(0)[i]), world); origin.rebase(world.map((v, i) => v - 0.99 * origin.ratio * 0.05 * [0.6, 0, 0.8][i]));}
    const stages = {kernel: [], viewProjection: [], worldPosition: [], clip: [], all: []}, eye = [];
    let previous = null, jitter = 0;
    for (let k = 0; k < FRAMES; k++) {
      const offset = cameraOffset(k), cam = world.map((v, i) => v + offset[i]);
      if (origin) origin.lookAt(cam, world); else {engine.camera.position = cam; engine.camera.target = world;}
      engine.render();
      const o = origin ? origin.origin : [0, 0, 0], local = world.map((v, i) => v - o[i]);
      const vp64 = viewProjection(engine.camera), vp32 = engine.camera.matrix, rootModel = mul(translation(local), euler(ROTATION));
      const parts = [[root, rootModel, vertices], ...bolts.map((b, i) => [b, mul(rootModel, translation(BOLTS[i])), boltVertices])];
      const errors = [], max = {kernel: 0, viewProjection: 0, worldPosition: 0, clip: 0};
      for (const [mesh, model64, verts] of parts) for (const v of verts) {
        const exact = screen(apply(vp64, apply(model64, v))), px = s => Math.hypot(s[0] - exact[0], s[1] - exact[1]);
        max.kernel = Math.max(max.kernel, px(screen(apply(vp64, apply(mesh.matrix, v)))));
        max.viewProjection = Math.max(max.viewProjection, px(screen(apply(vp32, apply(model64, v)))));
        max.worldPosition = Math.max(max.worldPosition, px(screen(apply(vp64, apply(model64, v).map(f)))));
        max.clip = Math.max(max.clip, px(screen(apply(vp64, apply(model64, v)).map(f))));
        const gpu = screen(apply(vp32, apply(mesh.matrix, v, f), f));
        errors.push([gpu[0] - exact[0], gpu[1] - exact[1]]);
      }
      for (const key in max) stages[key].push(max[key]);
      stages.all.push(Math.max(...errors.map(e => Math.hypot(...e))));
      if (previous) jitter = Math.max(jitter, ...errors.map((e, i) => Math.hypot(e[0] - previous[i][0], e[1] - previous[i][1])));
      previous = errors;
      // Lighting: frame.eye is camera.position in float32; angle of the eye error seen from the flange (degrees).
      const p = engine.camera.position, e32 = p.map(f);
      eye.push(Math.atan2(Math.hypot(...p.map((v, i) => e32[i] - v)), Math.hypot(...offset)) * 180 / Math.PI);
    }
    const worst = a => Math.max(...a);
    return {distance, mode, maxErrorPx: Object.fromEntries(Object.entries(stages).map(([k, v]) => [k, worst(v)])), jitterPx: jitter, eyeAngleDeg: worst(eye), rebases: origin?.rebases ?? 0};
  } finally {engine.dispose();}
}

/** Rebase cost for n placed roots (box parts spread over 2 km, 100 km from the origin). */
async function cost(n) {
  const {canvas, stats} = fakeGPU();
  const engine = await EngineKernel.create(canvas, {capacity: n + 1, backend: 'webgpu', camera: {...CAMERA}});
  try {
    const origin = FloatingOrigin.attach(engine), geometry = box(0.5, 0.5, 0.5), material = new PbrMaterial(), base = position(1e5), side = Math.ceil(Math.cbrt(n));
    for (let i = 0; i < n; i++) origin.place(engine.createMesh().setGeometry(geometry).setMaterial(material), [base[0] + (i % side) * 2000 / side, base[1] + (Math.floor(i / side) % side) * 2000 / side, base[2] + Math.floor(i / side / side) * 2000 / side]);
    origin.lookAt(base.map((v, i) => v + 1000 + [0, 0, 50][i]), base.map(v => v + 1000));
    const time = run => {const t = performance.now(); run(); return performance.now() - t;};
    for (let i = 0; i < 5; i++) engine.render();
    const runs = {staticFrame: [], rebaseCall: [], rebaseFrame: [], moveAllFrame: [], uploadBytes: 0};
    for (let r = 0; r < 15; r++) {
      runs.staticFrame.push(time(() => engine.render()));
      const target = origin.origin.map(v => v + 1); // a 1.7 m shift
      runs.rebaseCall.push(time(() => origin.rebase(target)));
      stats.uploadBytes = 0; runs.rebaseFrame.push(time(() => engine.render())); runs.uploadBytes = stats.uploadBytes;
      engine.render();
      // Baseline: every root moved through the public mesh API (what an app would pay without the plugin).
      stats.uploadBytes = 0; runs.moveAllFrame.push(time(() => {for (const mesh of engine.meshes.values()) mesh.position.x += 0.001; engine.render();})); runs.moveUploadBytes = stats.uploadBytes;
    }
    const median = a => [...a].sort((x, y) => x - y)[a.length >> 1];
    return {parts: n, visible: engine.stats.visible, medianMs: Object.fromEntries(Object.entries(runs).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, +median(v).toFixed(3)])), rebaseUploadBytes: runs.uploadBytes, moveUploadBytes: runs.moveUploadBytes};
  } finally {engine.dispose();}
}

const result = {precision: [], cost: []};
// NaN (JSON null, printed 'collapsed'): projected vertices reached w <= 0, the part folded through the eye.
const show = v => Number.isNaN(v) ? 'collapsed' : v.toPrecision(3);
for (const mode of ['core', 'origin', 'origin-edge']) for (const distance of DISTANCES) {
  const r = await precision(distance, mode); result.precision.push(r);
  console.log(`${mode.padEnd(11)} ${String(distance).padStart(8)} m  error px: ${Object.entries(r.maxErrorPx).map(([k, v]) => `${k} ${show(v)}`).join(', ')}; jitter ${show(r.jitterPx)} px; eye ${r.eyeAngleDeg.toPrecision(3)}°; rebases ${r.rebases}`);
}
if (args.cost) for (const n of [10_000, 50_000]) {const r = await cost(n); result.cost.push(r); console.log(JSON.stringify(r));}
if (args.json) writeFileSync(args.json, JSON.stringify(result, null, 2) + '\n');
