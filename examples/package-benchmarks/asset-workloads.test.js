import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createWorkload as loaders} from './loaders.js';
import {createWorkload as exporters} from './exporters.js';
import {createWorkload as usdz} from './usdz-export.js';
import {createWorkload as fbx, fixtureGeometry} from './fbx.js';
import {createWorkload as ifc} from './ifc.js';
import {createWorkload as decoders} from './decoders.js';
import {assetWorkload, displayGeometry, geometryData} from './asset-scene.js';
import {parseOFF} from '../../packages/loaders/dist/index.js';
import validator from 'gltf-validator';

const options = {fetch: async url => new Response(await readFile(url), {status: 200})};
const drain = () => new Promise(resolve => setImmediate(resolve));
const advance = async workload => {for (let i = 0; i < 11; i++) workload.step(0.1); await drain();};
const triangle = {kind: 'mesh', positions: new Float32Array([0,0,0,1,0,0,0,1,0]), indices: new Uint32Array([0,1,2])};
const verify = workload => {
  assert.equal(workload.geometries.length, 1); const geometry = workload.geometries[0];
  assert.ok(geometry.indices.length > 0 && geometry.indices.length % 3 === 0); assert.ok([...geometry.vertices].every(Number.isFinite));
  assert.equal(workload.details().completedJobs, 1); assert.equal(workload.details().jobError, null);
};

test('Draco fixture demo rejects Node without workers instead of publishing fake decoded geometry', async () => {
  await assert.rejects(decoders(1, options), /SSR/);
});

test('Loaders demo renders actual dolphin topology and repeats real bounded parses', async () => {
  const w = await loaders(1, options); try {verify(w); assert.equal(w.details().verticesPerModel, 855); assert.equal(w.details().trianglesPerModel, 1689);
    const before = w.geometries[0]; await advance(w); assert.equal(w.details().completedJobs, 2); assert.notEqual(w.geometries[0], before);
    assert.deepEqual(w.geometries[0].indices, before.indices);
  } finally {w.dispose();} assert.equal(w.geometries, null);
});

test('Exporter demo previews emitted PLY topology and produces a validated real knight GLB', async () => {
  const w = await exporters(1, options); try {verify(w); assert.equal(w.geometries[0].indices.length / 3, 1000);
    for (const key of ['glbBytes', 'plyBytes', 'stlBytes', 'objCharacters']) assert.ok(w.details()[key] > 0);
    const report = await validator.validateBytes(w.snapshot); assert.equal(report.issues.numErrors, 0, JSON.stringify(report.issues));
    assert.equal(w.details().stlBytes, 84 + 1000 * 50); await advance(w); assert.equal(w.details().batches, 2);
  } finally {w.dispose();}
});

test('Standalone USDZ demo round-trips actual aligned archive and knight surface topology', async () => {
  const w = await usdz(1, options); try {verify(w); assert.equal(w.geometries[0].indices.length / 3, 1000);
    const view = new DataView(w.snapshot.buffer, w.snapshot.byteOffset, w.snapshot.byteLength);
    assert.equal(view.getUint32(0, true), 0x04034b50); assert.equal((30 + view.getUint16(26, true) + view.getUint16(28, true)) % 64, 0);
    assert.ok(w.details().outputBytes > 1000); await advance(w); assert.equal(w.details().completedJobs, 2);
  } finally {w.dispose();}
});

test('FBX demo conversion preserves the existing triangle and validates its actual output', async () => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'FileReader');
  globalThis.FileReader = class {async readAsArrayBuffer(blob) {this.result = await blob.arrayBuffer(); this.onloadend?.();}};
  let w; try {w = await fbx(1, options); verify(w); assert.equal(w.details().verticesPerModel, 3); assert.equal(w.details().trianglesPerModel, 1);
    const {convertFBX} = await import('../../packages/fbx/dist/index.js'), output = await convertFBX(new Uint8Array(await readFile(new URL('./fixtures/triangle.fbx', import.meta.url))));
    const parsed = fixtureGeometry(output); assert.deepEqual([...parsed.positions], [0,0,0,1,0,0,0,1,0]);
    const report = await validator.validateBytes(new Uint8Array(output)); assert.equal(report.issues.numErrors, 0);
  } finally {w?.dispose(); if (prior) Object.defineProperty(globalThis, 'FileReader', prior); else delete globalThis.FileReader;}
});

test('IFC demo uses real Wasm, preserves BIM identifiers and closes parser ownership', async () => {
  const w = await ifc(1, options); try {verify(w); assert.equal(w.details().schema, 'IFC4'); assert.equal(w.details().trianglesPerModel, 12);
    assert.equal(w.products[0].expressID, 25); assert.equal(w.products[0].name, 'Test wall'); assert.equal(w.products[0].globalId, '1kTvXnbbzCWw8lcMd1dR4o');
    w.details().sourceExtentsMeters.toSorted((a,b)=>a-b).forEach((value, index) => assert.ok(Math.abs(value - [0.2,3,4][index]) < 1e-5));
    assert.equal(w.api.IsModelOpen(0), false); await advance(w); assert.equal(w.details().completedJobs, 2);
  } finally {w.dispose();} w.dispose(); assert.equal(w.api.wasmModule, undefined);
});

test('Asset batching prevents overlap, cancels paused results and rejects late page ownership', async () => {
  let complete, cleanup = 0, calls = 0; const w = await assetWorkload(1, () => ++calls === 1 ? displayGeometry(triangle) : new Promise(resolve => {complete = resolve;}), 'test', {cleanup: () => cleanup++});
  await advance(w); assert.equal(w.details().pending, true); const prior = w.geometries[0]; await advance(w); assert.equal(calls, 2, 'Pending batch overlapped');
  w.pause(); complete(displayGeometry(triangle)); await drain(); assert.equal(w.geometries[0], prior); assert.equal(w.details().completedJobs, 1);
  w.dispose(); w.dispose(); assert.equal(cleanup, 1);
  const controller = new AbortController(); let late;
  const pending = assetWorkload(1, () => new Promise(resolve => {late = resolve;}), 'test', {signal: controller.signal, cleanup: () => cleanup++});
  controller.abort(new Error('Page closed')); late(displayGeometry(triangle)); await assert.rejects(pending, /Page closed/); assert.equal(cleanup, 2);
});

test('Asset display normalization preserves source arrays and topology; counts stay bounded', async () => {
  const source = new Uint8Array(await readFile(new URL('../../packages/loaders/tests/fixtures/decimated-knight.off', import.meta.url))), loaded = parseOFF(source), before = loaded.positions.slice();
  const data = geometryData(displayGeometry(loaded)); assert.deepEqual(loaded.positions, before); assert.equal(data.indices.length, loaded.indices.length);
  assert.equal(data.positions.length / 3, 502); assert.ok(Math.max(...data.positions) <= 0.901 && Math.min(...data.positions) >= -0.901);
  await assert.rejects(assetWorkload(0, () => null, 'invalid'), /count/); await assert.rejects(assetWorkload(10, () => null, 'invalid'), /count/);
});
