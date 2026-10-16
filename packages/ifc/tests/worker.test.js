// Launch gate 11a: web-ifc 0.0.78 loops forever inside its Wasm on some schema-invalid models, so untrusted IFC goes
// through parseIFCInWorker: one fresh worker per file, terminated at a deadline with a named error.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { LoaderError } from '@margoengine/loaders';
import { IfcAPI } from 'web-ifc';
import { parseIFC } from '../dist/index.js';
import { parseIFCInWorker } from '../dist/worker.js';

const require = createRequire(import.meta.url),
  wall = new Uint8Array(await readFile(new URL('./fixtures/wall.ifc', import.meta.url)));

/** Runs the built dist/workers/ifc.js in-process; importScripts loads Node's web-ifc build as the global WebIFC. */
async function inProcess(message) {
  const code = await readFile(new URL('../dist/workers/ifc.js', import.meta.url), 'utf8');
  let reply;
  const self = {
    importScripts: () => (self.WebIFC = require('web-ifc')),
    postMessage: (data) => (reply = data),
  };
  new Function('self', code)(self);
  await self.onmessage({ data: structuredClone(message) });
  return reply;
}

test('the IFC worker returns what parseIFC returns, and LoaderErrors by name', async () => {
  const api = new IfcAPI();
  await api.Init();
  const direct = parseIFC(api, wall),
    { result } = await inProcess({ data: wall.slice().buffer, webIfc: 'web-ifc-api-iife.js', options: {} });
  assert.deepEqual(result.products, direct.products);
  assert.deepEqual([...result.positions], [...direct.positions]);
  const bad = wall.slice();
  bad.set(new TextEncoder().encode('#1e9'), new TextDecoder().decode(wall).indexOf('#11,'));
  const { error } = await inProcess({ data: bad.buffer, webIfc: 'x.js', options: {} });
  assert.equal(error.name, 'LoaderError');
  assert.equal(error.code, 'syntax');
});

test('parseIFCInWorker terminates a worker that does not answer and rejects with a named error', async () => {
  const saved = globalThis.Worker,
    terminated = [];
  globalThis.Worker = class {
    postMessage() {} // web-ifc stuck in a loop: no reply ever comes
    terminate() {
      terminated.push(this);
    }
  };
  try {
    await assert.rejects(
      parseIFCInWorker(wall.slice(), { webIfc: 'https://app.test/web-ifc-api-iife.js', timeoutMs: 50 }),
      (e) => e instanceof LoaderError && e.code === 'limit' && /within 50 ms/.test(e.message),
    );
    assert.equal(terminated.length, 1);
    await assert.rejects(
      parseIFCInWorker(wall.slice(), { webIfc: 'https://app.test/x.js', timeoutMs: 0 }),
      (e) => e instanceof LoaderError && e.code === 'range',
    );
  } finally {
    globalThis.Worker = saved;
  }
  await assert.rejects(
    parseIFCInWorker(wall.slice(), { webIfc: 'https://app.test/x.js' }),
    (e) => e instanceof LoaderError && e.code === 'unsupported',
  );
});
