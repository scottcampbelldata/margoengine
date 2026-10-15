// Browser side of cull-pixels.mjs: the same mixed scene and the same edits in core built from a reference commit
// (canvas a, before per-batch back-face culling) and today's core (canvas b). Single-sided closed boxes, open shells
// whose inner back faces face the camera, a mirrored instance, double-sided parts, a live doubleSided toggle and
// material assignment; each step records which cull mode core's own pass used per pipeline switch in today's core.
import * as before from '../../../test-results/core-ref/packages/core/dist/index.js';
import * as after from '../../../packages/core/dist/index.js';

const errors = [], modes = new WeakMap();let log = null;
for (const kind of ['createRenderPipeline', 'createRenderPipelineAsync']) {
  const create = GPUDevice.prototype[kind];
  GPUDevice.prototype[kind] = function(d) {
    const tag = p => {modes.set(p, (d.primitive?.cullMode ?? 'none') + (d.fragment?.constants?.C ? '/no-discard' : ''));return p;};
    const p = create.call(this, d);return p instanceof Promise ? p.then(tag) : tag(p);
  };
}
const setPipeline = GPURenderPassEncoder.prototype.setPipeline;
GPURenderPassEncoder.prototype.setPipeline = function(p) {log?.push(modes.get(p));return setPipeline.call(this, p);};

const camera = {fov: 45, near: 0.05, far: 40, position: [2.2, 1.6, 3.4], target: [0, 0, 0]};
// An open box: core's box without its +z face, so the inner faces of the other walls show through the opening.
const open = ({Geometry, box}, s) => {const g = box(s, s, s), v = g.vertices, p = [], n = [];for (let i = 0; i < v.length; i += 6) {p.push(v[i], v[i + 1], v[i + 2]);n.push(v[i + 3], v[i + 4], v[i + 5]);}return new Geometry(p, n, g.indices.slice(0, 30));};
async function scene(api, canvas) {
  const engine = await api.Engine.create(canvas, {capacity: 256, camera});engine.gpu.addEventListener('uncapturederror', e => errors.push(e.error.message));
  const {box, PbrMaterial} = api, g = {cube: box(0.3, 0.3, 0.3), slab: box(0.5, 0.12, 0.3), shell: open(api, 0.4), cup: open(api, 0.3)};
  const m = {red: new PbrMaterial({color: '#d04040', doubleSided: false}), blue: new PbrMaterial({color: '#40a0d0', roughness: 0.3, doubleSided: false}), green: new PbrMaterial({color: '#80c040', metalness: 0.5, doubleSided: false}), gold: new PbrMaterial({color: '#c0a040'})};
  const add = (geometry, material, position, rotation = [0, 0, 0], scale = [1, 1, 1]) => engine.createMesh().setGeometry(g[geometry]).setMaterial(m[material]).setPosition(position).setRotation(rotation).setScale(scale);
  const s = {engine, m, cubes: [], slabs: [], shells: [], cups: []};
  for (let i = 0; i < 20; i++) s.cubes.push(add('cube', i % 2 ? 'red' : 'blue', [(i % 5 - 2) * 0.55, -0.6, (Math.floor(i / 5) - 2) * 0.55], [0, i * 0.3, 0]));
  for (let i = 0; i < 6; i++) s.slabs.push(add('slab', 'green', [(i % 3 - 1) * 0.8, 0.1, (Math.floor(i / 3) - 0.5) * 0.9], [0.2 * i, 0.5, 0], i === 4 ? [-1, 1, 1] : [1, 1, 1]));
  for (let i = 0; i < 6; i++) s.shells.push(add('shell', i < 3 ? 'blue' : 'gold', [(i % 3 - 1) * 0.9, 0.8, (Math.floor(i / 3) - 0.5) * 1.0], [0.3, 0.4 + i * 0.5, 0]));
  for (let i = 0; i < 6; i++) s.cups.push(add('cup', 'red', [(i - 2.5) * 0.6, 1.5, -0.6], [0.6, i * 0.9, 0.2]));
  return s;
}
// Each edit runs on both scenes; the comment says what today's core should do with it.
const edits = [
  ['initial (cubes, cups culled; slabs mirrored, shells mixed)', () => {}],
  ['rotate 5 cubes (moved-matrix fast path)', s => {for (let i = 0; i < 5; i++) s.cubes[i].rotation.y += 0.4;}],
  ['mirror one cube (fast path: cube batch to cull none)', s => {s.cubes[3].scale.x = -1;}],
  ['un-mirror it (stays cull none until a full collection)', s => {s.cubes[3].scale.x = 1;}],
  ['hide a slab (full collection: cubes culled again)', s => {s.slabs[0].visible = false;}],
  ['red.set({doubleSided: true}) (cubes and cups to cull none)', s => {s.m.red.set({doubleSided: true});}],
  ['red.set({doubleSided: false})', s => {s.m.red.set({doubleSided: false});}],
  ['assign double-sided gold to one cup', s => {s.cups[0].setMaterial(s.m.gold);}],
  ['assign blue back', s => {s.cups[0].setMaterial(s.m.blue);}],
  ['un-mirror the slab, then green.set({roughness}) (slabs culled)', s => {s.slabs[4].scale.x = 1;s.m.green.set({roughness: 0.3});}],
  ['mirror the slab via setScale while hidden slab returns', s => {s.slabs[4].setScale([1, -1, 1]);s.slabs[0].visible = true;}],
  ['camera behind the scene, looking into the shells', s => {s.engine.camera.position = [-1.5, 2.6, -3.2];}],
  ['camera inside a cup row', s => {s.engine.camera.position = [0.4, 1.55, -0.2];}],
];
let a, b;
const draw = async engine => {engine.render();await engine.gpu.queue.onSubmittedWorkDone();};
window.check = {
  steps: edits.length, errors,
  async setup() {a = await scene(before, document.getElementById('a'));b = await scene(after, document.getElementById('b'));},
  async step(i) {
    const [label, edit] = edits[i];edit(a);edit(b);await draw(a.engine);log = [];await draw(b.engine);const used = log;log = null;
    return {label, pipelines: used, visible: [a.engine.stats.visible, b.engine.stats.visible]};
  },
};
window.ready = true;
