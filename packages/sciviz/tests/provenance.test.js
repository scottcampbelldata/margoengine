import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { JSDOM } from 'jsdom';
import { Camera } from '@margoengine/core';
import { recordedResources } from '@margoengine/sciviz/spec';
import {
  Figure,
  captureProvenance,
  validateProvenance,
  embedPNGProvenance,
  readPNGProvenance,
  embedSVGProvenance,
  readSVGProvenance,
  exportProvenancePDF,
  withProvenance,
} from '@margoengine/sciviz/provenance';
import { pngParts } from '../../shared/png.js';
import { parseTTF } from '@margoengine/loaders/font';

const engine = () => ({ camera: new Camera(), backend: 'webgpu', use() {}, onFrame: () => () => {} });
const codec = {
  create(fig, [value]) {
    return fig.addLayer({
      bounds: [0, 2, 0, 2, 0, 2],
      visible: true,
      value,
      setModel() {},
      update(next) {
        this.value = next;
      },
      dispose() {},
    });
  },
  snapshot: (object) => object.value,
  restore: (object, value) => {
    object.value = value;
  },
};
test('trace preserves successful intermediate mutations and removed resources as executable calls', async () => {
  const fig = await Figure.attach(engine(), { axes: false });
  const first = await fig.recipe('test:layer', [new Float32Array([1, 2, 3])], codec);
  first.update(new Float32Array([2, 3, 4]));
  first.update(new Float32Array([3, 4, 5]));
  first.visible = false;
  fig.remove(first);
  await fig.recipe('test:layer', [new Float32Array([8, 9, 10])], codec);
  const trace = await fig.trace();
  assert.equal((trace.match(/\["update"\]/g) ?? []).length, 2);
  assert.match(trace, /\["remove"\]/);
  assert.match(trace, /\["visible"\]/);
  await mkdir('test-results/sciviz-provenance', { recursive: true });
  const file = resolve(`test-results/sciviz-provenance/trace-${process.pid}.mjs`);
  await writeFile(file, trace);
  const module = await import(pathToFileURL(file).href);
  const replay = await module.default({}, { engine: engine(), codecs: { 'test:layer': codec } });
  assert.deepEqual(await replay.toJSON(), await fig.toJSON());
  await replay.recipe('test:layer', [new Float32Array([11, 12, 13])], codec);
  const identities = [...recordedResources(replay).values()];
  assert.deepEqual(identities, ['r1', 'r2']);
  replay.dispose();
  fig.dispose();
  await unlink(file);
});
test('provenance includes hashed arrays, portable state, actual build versions and explicit unavailable identity', async () => {
  const fig = await Figure.attach(engine(), { axes: false });
  await fig.recipe('test:layer', [new Float32Array([1, 2, 3])], codec);
  const record = await fig.provenance({ packages: { application: '4.2.1' } });
  assert.equal(record.spec.version, 1);
  assert.ok(record.data.length > 0);
  assert.equal(record.packages.application, '4.2.1');
  assert.equal(
    record.packages['@margoengine/sciviz'],
    JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version,
  );
  assert.equal(record.gpu.backend, 'webgpu');
  assert.equal(record.gpu.vendor, 'unavailable');
  await validateProvenance(record);
  await assert.rejects(validateProvenance({ ...record, createdAt: 'changed' }), /hash mismatch/);
  await assert.rejects(fig.trace({ signal: AbortSignal.abort(new Error('cancelled')) }), /cancelled/);
  fig.dispose();
});
test('recording bounds release retained history and fail explicitly while the figure remains usable', async () => {
  const { Figure: Portable } = await import('@margoengine/sciviz/spec');
  const fig = await withProvenance(Portable.attach(engine(), { axes: false }), { maxCalls: 1 });
  const layer = await fig.recipe('test:layer', [new Float32Array([1, 2])], codec);
  layer.update(new Float32Array([3, 4]));
  await assert.rejects(fig.trace(), /recording bound/);
  assert.deepEqual(Array.from(layer.value), [3, 4]);
  assert.equal((await fig.toJSON()).layers.length, 1);
  fig.dispose();
  const small = await withProvenance(Portable.attach(engine(), { axes: false }), { maxTraceBytes: 100 });
  await small.recipe('test:layer', [new Float32Array(100)], codec);
  await assert.rejects(small.trace(), /recording bound/);
  small.dispose();
});
test('PNG iTXt is UTF-8, compressed, idempotent and preserves all original image bytes', async () => {
  const fig = await Figure.attach(engine(), { axes: false });
  const record = await captureProvenance(fig, { packages: { label: 'Δ MRI 🧠' } });
  const png = new Blob(pngParts(1, 1, 6, deflateSync(new Uint8Array([0, 200, 100, 50, 255]))), { type: 'image/png' });
  const first = await embedPNGProvenance(png, record),
    second = await embedPNGProvenance(first, record);
  assert.deepEqual(new Uint8Array(await first.arrayBuffer()), new Uint8Array(await second.arrayBuffer()));
  assert.deepEqual(await readPNGProvenance(first), record);
  const original = new Uint8Array(await png.arrayBuffer()),
    result = new Uint8Array(await first.arrayBuffer());
  assert.deepEqual(result.subarray(0, original.length - 12), original.subarray(0, original.length - 12));
  assert.equal(await readPNGProvenance(png), undefined);
  const corrupt = result.slice();
  corrupt[20] ^= 1;
  await assert.rejects(readPNGProvenance(corrupt), /CRC/);
  await assert.rejects(readPNGProvenance(result.subarray(0, result.length - 1)), /Truncated|length/);
  await assert.rejects(embedPNGProvenance(png, record, { maxBytes: 100 }), /maxBytes/);
  await assert.rejects(readPNGProvenance(first, { signal: AbortSignal.abort(new Error('cancelled')) }), /cancelled/);
  fig.dispose();
});
test('SVG keeps unrelated metadata and escapes arbitrary JSON without creating markup', async () => {
  const env = new JSDOM();
  globalThis.DOMParser = env.window.DOMParser;
  globalThis.XMLSerializer = env.window.XMLSerializer;
  const fig = await Figure.attach(engine(), { axes: false });
  const record = await captureProvenance(fig, { packages: { label: '</metadata><script>bad()</script> & Δ' } });
  const source =
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><metadata id="other">keep</metadata><rect width="20" height="20"/></svg>';
  const svg = embedSVGProvenance(embedSVGProvenance(source, record), record);
  assert.deepEqual(readSVGProvenance(svg), record);
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
  assert.equal(parsed.querySelector('#other').textContent, 'keep');
  assert.equal(parsed.querySelectorAll('script').length, 0);
  assert.equal(parsed.getElementsByTagNameNS('urn:margoengine:provenance:1', 'provenance').length, 1);
  fig.dispose();
  env.window.close();
});
test('PDF information contains full spec, data hashes and environment as Unicode JSON', async () => {
  const env = new JSDOM();
  globalThis.DOMParser = env.window.DOMParser;
  globalThis.XMLSerializer = env.window.XMLSerializer;
  const font = parseTTF(
    readFileSync(new URL('../../../examples/assets/sciviz/publication/DejaVuSerif.ttf', import.meta.url)),
  );
  const fig = await Figure.attach(engine(), { axes: false });
  fig.toSVG = async () =>
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>';
  const pdf = Buffer.from(await (await exportProvenancePDF(fig, { font, title: 'MRI Δ' })).arrayBuffer()).toString(
    'latin1',
  );
  const hex = pdf.match(/\/MargoProvenance <FEFF([A-Fa-f0-9]+)>/)[1];
  let text = '';
  for (let i = 0; i < hex.length; i += 4) text += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  const record = JSON.parse(text);
  await validateProvenance(record);
  assert.equal(record.spec.version, 1);
  assert.ok(record.packages['@margoengine/sciviz']);
  assert.ok(record.browser.userAgent);
  fig.dispose();
  env.window.close();
});
