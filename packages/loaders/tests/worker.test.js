// HANDOFF 1f.j: the USD worker (dist/workers/usd.js) returns the same LoadedGeometry as parseUSDZ / parseUSDA, byte for byte.
import test from 'node:test';
import assert from 'node:assert/strict';
import {exportUSDZ} from '@margoengine/exporters';
import {torusKnotGeometry, toGeometry} from '@margoengine/geometry';
import {parseUSDA, parseUSDZ} from '../dist/index.js';
import {parseUSDZInWorker} from '../dist/worker.js';
import {runParseWorker, assertSameBytes} from '../../../tests/support/parse-worker.js';

const worker = new URL('../dist/workers/usd.js', import.meta.url);
const stage = `#usda 1.0\n(metersPerUnit = 0.1 upAxis = "Z")\ndef Xform "Parent" {\n double3 xformOp:translate = (10,20,30)\n uniform token[] xformOpOrder = ["xformOp:translate"]\n def Mesh "Square" {\n point3f[] points = [(0,0,0),(1,0,0),(1,1,0),(0,1,0)]\n int[] faceVertexCounts = [4]\n int[] faceVertexIndices = [0,1,2,3]\n uniform token subdivisionScheme = "none"\n }\n}`;
test('worker-parsed USDZ and USDA equal parseUSDZ / parseUSDA', async () => {
  const archive = exportUSDZ({nodes: [{geometry: toGeometry(torusKnotGeometry(1, 0.3, 300, 40))}]});
  assertSameBytes(await runParseWorker(worker, {format: 'usdz', input: archive.slice().buffer, options: {}}), await parseUSDZ(archive.slice()));
  assertSameBytes(await runParseWorker(worker, {format: 'usda', input: stage, options: {units: 'file'}}), parseUSDA(stage, {units: 'file'}));
});
test('USD worker errors come back as LoaderError; without Worker the entry runs here', async () => {
  const reply = await runParseWorker(worker, {format: 'usda', input: stage, options: {maxVertices: 2}}).catch(error => error);
  assert.equal(reply.name, 'LoaderError'); assert.equal(reply.code, 'limit'); assert.equal(reply.format, 'USD');
  assert.equal(typeof Worker, 'undefined');
  assert.equal((await parseUSDZInWorker(exportUSDZ({nodes: [{geometry: toGeometry(torusKnotGeometry(1, 0.3, 8, 4))}]}))).indices.length, 8 * 4 * 6);
});
