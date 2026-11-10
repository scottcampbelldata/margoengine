import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { readInWorker } from '@margoengine/sciviz/workers';
import { loadNRRD } from '../dist/nrrd.js';
import { parseNIfTI, parseDICOM, openZarr } from '../dist/formats.js';
import { parseVtk, openVTK } from '../dist/vtk.js';
import { openNetCDF } from '../dist/netcdf.js';

function worker() {
  const raw = new Worker(new URL('./readers-node-worker.js', import.meta.url));
  const endpoint = new EventTarget();
  raw.on('message', (data) => endpoint.dispatchEvent(new MessageEvent('message', { data })));
  raw.on('error', () => endpoint.dispatchEvent(new Event('error')));
  endpoint.postMessage = (data, transfer) => raw.postMessage(data, transfer);
  endpoint.terminate = () => raw.terminate();
  return endpoint;
}
const file = async (name) => new Uint8Array(await readFile(new URL(name, import.meta.url)));
const options = { worker, timeout: 15000 };

test('real demo NRRD, NIfTI, DICOM and legacy VTK match direct readers exactly with moved inputs', {
  timeout: 60000,
}, async () => {
  const cases = [
    ['loadNRRD', '../../../examples/assets/sciviz/head.nrrd', loadNRRD],
    ['parseNIfTI', './fixtures/zstat1.nii.gz', parseNIfTI],
    ['parseDICOM', './fixtures/CT_small.dcm', parseDICOM],
    ['parseVtk', '../../../examples/assets/sciviz/wind.vtk', parseVtk],
  ];
  for (const [reader, path, direct] of cases) {
    const input = await file(path),
      expected = await direct(input);
    const events = [];
    using session = await readInWorker(reader, [input], {
      ...options,
      transfer: [input.buffer],
      onProgress: (event) => events.push(event),
    });
    assert.equal(input.byteLength, 0, 'input ownership moved to the worker');
    assert.deepEqual(session.value, expected, reader);
    assert.deepEqual(
      events.map((e) => e.phase),
      ['start', 'complete'],
    );
    assert.ok(events[0].bytes > 0 && events[1].bytes > 0);
  }
});

test('NetCDF and VTK XML retain lazy methods and caches across repeated transferred reads', {
  timeout: 30000,
}, async () => {
  const input = await file('../../../examples/assets/sciviz/wind-classic.nc');
  using expected = await openNetCDF(input);
  using session = await readInWorker('openNetCDF', [input], options);
  const variable = session.value.variables.uwnd;
  const first = await variable.read({ start: [0, 0, 0], count: [1, 2, 3] });
  assert.deepEqual(first, await expected.variables.uwnd.read({ start: [0, 0, 0], count: [1, 2, 3] }));
  assert.deepEqual(await variable.volume(), await expected.variables.uwnd.volume());
  assert.deepEqual(await variable.read(), await variable.read());
  const xml = await file('../../../examples/assets/sciviz/wind.vti');
  using vtk = await readInWorker('openVTK', [xml], options);
  using direct = await openVTK(xml);
  assert.deepEqual(await vtk.value.volume('uwnd'), await direct.volume('uwnd'));
  const array = vtk.value.dataset.pieces[0].pointData.uwnd;
  assert.deepEqual(await array.read(), await array.read(), 'transfer never detaches a cached lazy array');
  await vtk.value.dispose();
  await assert.rejects(vtk.value.volume('uwnd'));
});

test('Zarr store callbacks and detached NRRD resolvers stay callable across worker reads', {
  timeout: 30000,
}, async () => {
  const store = {
    '.zarray': JSON.stringify({
      zarr_format: 2,
      shape: [2],
      chunks: [2],
      dtype: '|u1',
      compressor: null,
      fill_value: 0,
      order: 'C',
      filters: null,
    }),
    '0': new Uint8Array([8, 13]),
  };
  const get = async (key, signal) => {
    signal?.throwIfAborted();
    const v = store[key];
    return typeof v === 'string' ? new TextEncoder().encode(v) : v;
  };
  using zarr = await readInWorker('openZarr', [get], options);
  const direct = await openZarr(get);
  assert.deepEqual(await zarr.value.read(), await direct.read());
  assert.deepEqual(await zarr.value.read(), await direct.read());
  assert.equal(store['0'].byteLength, 2, 'reverse callbacks preserve store ownership');
  const header = new TextEncoder().encode(
    'NRRD0005\ntype: uchar\ndimension: 3\nsizes: 2 1 1\nencoding: raw\ndata file: pixels.raw\n\n',
  );
  const data = new Uint8Array([3, 7]);
  using nrrd = await readInWorker(
    'loadNRRD',
    [
      header,
      {
        resolve: async (path) => {
          assert.equal(path, 'pixels.raw');
          return data;
        },
      },
    ],
    options,
  );
  assert.deepEqual([...nrrd.value.data], [3, 7]);
  assert.equal(data.byteLength, 2);
});

test('class-based FileSource reads preserve their owner and return independent transferred buffers', {
  timeout: 15000,
}, async () => {
  const data = await file('../../../examples/assets/sciviz/wind-classic.nc');
  class Source {
    constructor(bytes) {
      this.bytes = bytes;
    }
    async read(offset, length, signal) {
      signal?.throwIfAborted();
      return this.bytes.subarray(offset, offset + length);
    }
  }
  using session = await readInWorker('openNetCDF', [new Source(data)], options);
  using direct = await openNetCDF(data);
  assert.deepEqual(await session.value.variables.uwnd.read(), await direct.variables.uwnd.read());
  assert.ok(data.byteLength > 0);
});

test('pre-abort, running abort, deadlines, errors and disposal release dedicated workers', {
  timeout: 30000,
}, async () => {
  const pre = AbortSignal.abort(new Error('before'));
  let created = false;
  await assert.rejects(
    readInWorker('openZarr', [{}], {
      signal: pre,
      worker: () => {
        created = true;
        return worker();
      },
    }),
    /before/,
  );
  assert.equal(created, false);
  const controller = new AbortController();
  const entered = Promise.withResolvers();
  const result = readInWorker(
    'openZarr',
    [
      async (_key, signal) => {
        entered.resolve();
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        signal.throwIfAborted();
      },
    ],
    { ...options, signal: controller.signal },
  );
  await entered.promise;
  controller.abort(new Error('cancelled'));
  await assert.rejects(result, /cancelled/);
  await assert.rejects(readInWorker('openZarr', [async () => new Promise(() => {})], { ...options, timeout: 30 }), {
    code: 'timeout',
  });
  await assert.rejects(readInWorker('parseVtk', ['invalid'], options));
  using session = await readInWorker(
    'openZarr',
    [
      {
        '.zarray': JSON.stringify({
          zarr_format: 2,
          shape: [1],
          chunks: [1],
          dtype: '|u1',
          compressor: null,
          fill_value: 0,
          order: 'C',
          filters: null,
        }),
      },
    ],
    options,
  );
  session.dispose();
  session.dispose();
  assert.equal(session.disposed, true);
  await assert.rejects(session.value.read(), { code: 'state' });
});
