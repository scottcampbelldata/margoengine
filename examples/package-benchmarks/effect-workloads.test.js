import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {Camera} from '../../packages/core/dist/index.js';
import {optionalGPU} from '../../tests/support/optional-gpu.js';
import {createWorkload as points} from './points.js';
import {createWorkload as toon} from './toon.js';
import {createWorkload as transitions} from './transitions.js';
import {assetWorkload, displayGeometry} from './asset-scene.js';

const options = {fetch: async url => new Response(await readFile(url), {status: 200})};
async function mount(t, factory) {
  const dom = new JSDOM('<canvas width="800" height="600"></canvas><section></section>'), h = optionalGPU(), canvas = dom.window.document.querySelector('canvas'), parent = dom.window.document.querySelector('section');
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'GPUShaderStage'); globalThis.GPUShaderStage = {VERTEX: 1, FRAGMENT: 2};
  h.engine.canvas = canvas; Object.defineProperties(canvas, {clientWidth: {value: 800}, clientHeight: {value: 600}}); canvas.getBoundingClientRect = () => ({left: 0, top: 0, width: 800, height: 600});
  h.engine.gpu.createBindGroupLayout = descriptor => descriptor; h.engine.gpu.createPipelineLayout = descriptor => descriptor;
  const camera = new Camera({position: [0, 5, 8], target: [0, 1, 0], near: 0.1, far: 100, fov: 45}); camera.update(800 / 600, true); h.context.camera = h.engine.camera = camera;
  const w = await factory(2, options); w.step(0);
  const meshes = Array.from({length: 2}, (_, id) => {
    const matrix = h.engine.store.matrices.subarray(id * 16, id * 16 + 16); matrix.set([1,0,0,0,0,1,0,0,0,0,1,0,...w.points.subarray(id * 4, id * 4 + 3),1]);
    const mesh = {id, matrix, setGeometry(geometry) {this.geometry = geometry; return this;}, setMaterial(material) {this.material = material; return this;}}; h.engine.meshes.set(id, mesh); return mesh;
  });
  t.after(() => {w.dispose(); h.cleanup(); dom.window.close(); if (saved) Object.defineProperty(globalThis, 'GPUShaderStage', saved); else delete globalThis.GPUShaderStage;});
  w.mount({engine: h.engine, meshes, parent, render: h.frame}); h.frame(); return {...h, w, meshes, dom, parent};
}

test('Points demo updates real bounded PCD ranges, draws sprites, picks, toggles EDL and releases package ownership', async t => {
  const h = await mount(t, points), {w} = h, cloud = w.clouds[0], arrays = w.points, positions = cloud.positions, before = positions.slice();
  assert.equal(w.details().inputPoints, 794); assert.equal(w.details().pointDraws, 794); assert.equal(w.details().sprites, 2);
  w.step(0.1); h.frame(); assert.equal(w.points, arrays); assert.equal(cloud.positions, positions); assert.notDeepEqual(positions.subarray(0, 96), before.subarray(0, 96)); assert.deepEqual(positions.subarray(96), before.subarray(96));
  assert.ok(w.details().uploadBytes > 0); const hit = w.interaction(); assert.ok(hit);
  h.engine.canvas.dispatchEvent(new h.dom.window.MouseEvent('click', {clientX: hit.pointX, clientY: hit.pointY})); assert.ok(Number.isInteger(w.details().lastPickedIndex));
  h.parent.querySelector('[data-ui-edl]').click(); assert.equal(cloud.material.edl, true);
  const frames = w.details().frames; w.dispose(); w.step(0.1); assert.equal(w.details().frames, frames); assert.equal(cloud.attachedMesh, null); assert.equal(h.engine.hasPlugin('points'), false); assert.equal(h.parent.children.length, 0); assert.ok(h.resources.every(resource => resource.destroyed));
});

test('Specific Toon package shades actual dolphin surfaces and toggles its inverted-hull pass without background parses', async t => {
  const h = await mount(t, toon), initial = h.meshes[0].geometry;
  assert.equal(initial.indices.length / 3, 1689); assert.equal(h.engine.hasPlugin('toon'), true); assert.ok(h.pipelines.some(pipeline => pipeline.primitive?.cullMode === 'front'));
  for (let i = 0; i < 22; i++) h.w.step(0.1); await Promise.resolve(); assert.equal(h.meshes[0].geometry, initial);
  h.parent.querySelector('[data-ui-toon]').click(); assert.equal(h.w.details().enabled, false); assert.equal(h.engine.hasPlugin('toon'), false);
  h.parent.querySelector('[data-ui-toon]').click(); assert.equal(h.w.details().enabled, true); assert.equal(h.engine.hasPlugin('toon'), true);
  h.w.dispose(); assert.equal(h.engine.hasPlugin('toon'), false); assert.ok(h.resources.every(resource => resource.destroyed)); assert.equal(h.parent.children.length, 0);
});

test('Transitions factory changes actual model geometry, captures once, preserves paused progress and cycles all four composites', async t => {
  const h = await mount(t, transitions), initial = h.meshes[0].geometry;
  assert.equal(initial.indices.length / 3, 1000); assert.equal(h.w.details().progress, 1);
  h.context.delta = 0; h.parent.querySelector('[data-ui-transition]').click(); assert.equal(h.w.details().scene, 'dolphins'); assert.equal(h.w.details().progress, 0); assert.equal(h.meshes[0].geometry.indices.length / 3, 1689);
  const copies = h.counts.copies; h.frame(); assert.equal(h.counts.copies, copies); assert.equal(h.w.details().progress, 0);
  h.context.delta = 0.1; for (let i = 0; i < 8; i++) h.frame(); assert.equal(h.w.details().progress, 1);
  for (const kind of ['dissolve', 'radial', 'chromatic']) {h.context.delta = 0; h.parent.querySelector('[data-ui-transition]').click(); assert.equal(h.w.details().transitionKind, kind);}
  assert.equal(h.counts.copies, copies + 3); h.w.dispose(); assert.equal(h.engine.hasPlugin('transitions'), false); assert.ok(h.resources.every(resource => resource.destroyed)); assert.equal(h.parent.children.length, 0);
});

test('Static visual scenes reuse their complete geometry and cancel optional package ownership on lifecycle abort', async () => {
  const geometry = displayGeometry({kind: 'mesh', positions: new Float32Array([0,0,0,1,0,0,0,1,0]), indices: new Uint32Array([0,1,2])}), controller = new AbortController(); let loads = 0, closed = 0;
  const w = await assetWorkload(1, () => {loads++; return geometry;}, 'static', {repeat: false, signal: controller.signal, cleanup: () => closed++});
  for (let i = 0; i < 100; i++) w.step(0.1); await Promise.resolve(); assert.equal(loads, 1); assert.equal(w.geometries[0], geometry);
  controller.abort(); assert.equal(w.geometries, null); w.dispose(); assert.equal(closed, 1);
  for (const factory of [points, toon, transitions]) {await assert.rejects(factory(0, options), /count/); await assert.rejects(factory(10, options), /count/);}
});
