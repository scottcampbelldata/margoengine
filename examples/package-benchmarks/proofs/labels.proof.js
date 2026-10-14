// Proof for @margoengine/labels: a label's transform text is formatted and compared again only when one of the
// numbers it is built from (rounded pixel position, distance scale, anchor) changed since the last frame.
// Run: node examples/package-benchmarks/proofs/labels.proof.js
import assert from 'node:assert/strict';
import {Camera} from '@margoengine/core';
import {fakeEngine} from '../../../packages/labels/tests/fake-dom.js';
import {versions, time, record} from './compare.js';

const ref = 'f05414a', {baseline, candidate} = await versions('labels', ref);
const noise = seed => {let s = seed >>> 0; return () => ((s = Math.imul(s ^ s >>> 15, s | 1) + 0x6d2b79f5 >>> 0) / 4294967296);};

// A scene of `count` labels over a 1280 x 720 canvas: half follow meshes (local or world offsets), half sit at fixed
// world positions; a third scale with distance, some use custom anchors, some an occlusion hook.
function scene(module, count, backend = 'webgpu') {
  const engine = fakeEngine(Camera, {width: 1280, height: 720, backend, capacity: count + 1, camera: {position: [0, 6, 30], target: [0, 0, 0]}}), next = noise(count);
  const renderer = new module.LabelRenderer(); renderer.setup(engine); renderer.registerPasses(engine.graph);
  const labels = [], meshes = [];
  for (let i = 0; i < count; i++) {
    const position = [(next() - 0.5) * 40, (next() - 0.5) * 16, (next() - 0.5) * 40], element = engine.document.createElement('div');
    const options = {anchor: i % 5 === 0 ? [0, 1] : undefined, distanceScale: i % 3 === 0 ? 20 : i % 7 === 0 ? {reference: 15, min: 0.5, max: 2} : undefined, sort: i % 11 !== 0, frustumCulling: i % 13 !== 0,
      occlude: i % 9 === 0 ? (_label, info) => info.depth > 0.9975 : undefined};
    if (i % 2) {const mesh = engine.createMesh(position); meshes.push(mesh); labels.push(renderer.add(element, {...options, mesh, offset: [0, 1.5, 0], offsetSpace: i % 4 === 1 ? 'world' : 'local'}));}
    else labels.push(renderer.add(element, {...options, position}));
  }
  return {engine, renderer, labels, meshes};
}

// Same DOM first: after every frame of a scripted session, each element's style values and its count of style writes
// (the fake DOM counts every assignment) and the renderer's own write counter must match the baseline.
function session(module, backend) {
  const {engine, renderer, labels, meshes} = scene(module, 120, backend), log = [], elements = [...labels.map(label => label.element)];
  const panel = renderer.add3D(engine.document.createElement('div'), {position: [0, 2, 0], pixelScale: 0.02}); elements.push(panel.element);
  for (let frame = 0; frame < 240; frame++) {
    // Orbit for 60 frames, rest for 40, creep by sub-pixel steps, then jump: rounding boundaries and repeats are both hit.
    if (frame < 60) engine.camera.position = [30 * Math.sin(frame / 30), 6, 30 * Math.cos(frame / 30)];
    else if (frame >= 100 && frame < 160) engine.camera.position = [engine.camera.position[0] + 1e-4, 6, engine.camera.position[2]];
    else if (frame === 200) engine.camera.position = [0, 40, 1];
    if (frame % 3 === 0) for (let i = 0; i < meshes.length; i += 6) engine.move(meshes[i], [10 * Math.sin(frame / 20 + i), i % 5, 10 * Math.cos(frame / 17 + i)]);
    if (frame === 70) {labels[4].visible = false; engine.store.hidden[meshes[2].id] = 1; labels[6].anchor = [1, 0]; labels[8].anchor[0] = 0.25;}
    if (frame === 75) {labels[4].visible = true; engine.store.hidden[meshes[2].id] = 0; labels[10].distanceScale = 12; labels[12].distanceScale = null; labels[14].setOffset([0, 3, 0]);}
    if (frame === 80) {labels[16].remove(); labels[18].setPosition([1, 2, 3]); labels[20].anchor = [NaN, 0.5]; labels[22].distanceScale = {reference: 0, max: 0};}
    if (frame === 85) {const added = renderer.add(engine.document.createElement('div'), {position: [2, 2, 2], distanceScale: 25}); labels.push(added); elements.push(added.element);}
    if (frame === 90) labels[24].element.style.transform = 'none';
    engine.frame();
    log.push(renderer.writes, ...elements.flatMap(element => [element.styleWrites, element.style.transform, element.style.display, element.style.zIndex]));
    log.push(...labels.slice(0, 30).flatMap(label => [label.onScreen, label.distance, label.screen.x, label.screen.y]));
  }
  renderer.dispose();
  return log;
}
for (const backend of ['webgpu', 'webgl2']) assert.deepStrictEqual(session(candidate, backend), session(baseline, backend));

const cases = [];
for (const [name, animate] of [
  // 300 annotations in a viewer while the user reads: nothing moves, which is most frames of an inspection tool.
  ['300 labels, camera at rest', () => {}],
  // The same scene with 12 labels riding moving objects (vehicles, characters).
  ['300 labels, 12 following moving meshes', ({engine, meshes}, frame) => {for (let i = 0; i < 12; i++) engine.move(meshes[i * 10], [10 * Math.sin(frame / 20 + i), i % 5, 10 * Math.cos(frame / 17 + i)]);}],
]) {
  const frames = 120, make = module => {
    const built = scene(module, 300); built.engine.frame();
    return () => {for (let frame = 0; frame < frames; frame++) {animate(built, frame); built.engine.frame();}};
  };
  cases.push({case: name, frames, ...time(make(baseline), make(candidate))});
}
await record('labels', ref, cases, 'The gain is on frames where labels keep their pixel position. With the camera orbiting every transform is rewritten and six runs of that case measured 0.77x to 1.13x (median about 1.0), so it is not recorded as a case.');
