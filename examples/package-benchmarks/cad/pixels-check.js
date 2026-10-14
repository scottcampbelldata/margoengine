// Browser side of pixels-check.mjs: engine A renders incrementally (reused instances, patched matrices, partial uploads);
// window.check.reference() rebuilds A's current scene in a fresh engine B (full kernel tick, collection and upload).
import {Engine, PbrMaterial} from '../../../packages/core/dist/index.js';
import {buildAssembly} from './assembly.js';

const camera = {fov: 45, near: 0.05, far: 50, position: [1.3, 1.1, 1.6], target: [0, 0, 0]}, keys = ['x', 'y', 'z', 'qx', 'qy', 'qz', 'qw', 'sx', 'sy', 'sz'];
let a, assembly, step = 0;const errors = [];
const draw = async engine => {engine.render();await engine.gpu.queue.onSubmittedWorkDone();};
async function setup() {
  a = await Engine.create(document.getElementById('a'), {capacity: 512, camera});a.gpu.addEventListener('uncapturederror', e => errors.push(e.error.message));
  assembly = buildAssembly(a, 8);await draw(a);await draw(a);return {parts: assembly.parts.length};
}
// One step: every 10th part moves (a different tenth each step), one module turns (moves its children), plus one edit.
async function advance() {
  step++;const {parts, groups} = assembly, live = parts.filter(p => a.meshes.get(p.id) === p);
  live.forEach((p, i) => {if (i % 10 === step % 10) p.position.y += 0.004;});
  const modules = groups.filter(g => g.name === 'module');modules[step % modules.length].rotation.y += 0.2;
  const edit = [
    () => {},
    () => {live[5].visible = false;},
    () => {live[5].visible = true;live[7].setParent(modules[0]);},
    () => {live[9].material.data[0] = 0.9;},
    () => {live[11].dispose();},
    () => {const m = a.createMesh(modules[1]).setGeometry(assembly.geometries.bolt).setMaterial(new PbrMaterial({color: '#ff3000'})).setPosition([0, 0.05, 0]);m.name = 'added';parts.push(m);},
    () => {live[13].scale.set(1.5, 1.5, 1.5);},
    () => {live[15].material = new PbrMaterial({color: '#00ff40'});},
    () => {groups[0].position.x += 0.05;},
    async () => {await a.pick(240, 160);},
    () => {live[17].setGeometry(assembly.geometries.nut);},
  ][step % 11];
  await edit();await draw(a);return {step, full: a.collected};
}
async function reference() {
  const b = await Engine.create(document.getElementById('b'), {capacity: 512, camera}), copies = new Map();
  b.gpu.addEventListener('uncapturederror', e => errors.push(e.error.message));
  for (const mesh of a.meshes.values()) {
    const copy = b.createMesh();copies.set(mesh.id, copy);for (const key of keys) b.store.transforms[key][copy.id] = a.store.transforms[key][mesh.id];
    if (mesh.geometry) copy.setGeometry(mesh.geometry);copy.setMaterial(mesh.material);b.store.hidden[copy.id] = a.store.hidden[mesh.id];
  }
  for (const mesh of a.meshes.values()) {const parent = a.store.parents[mesh.id];if (parent !== -1) copies.get(mesh.id).setParent(copies.get(parent));}
  await draw(b);window.referenceEngine = b;return {visible: [a.stats.visible, b.stats.visible]};
}
const redraw = () => draw(a);
const release = () => {window.referenceEngine?.dispose();window.referenceEngine = null;};
window.check = {setup, advance, reference, release, redraw, errors};window.ready = true;
