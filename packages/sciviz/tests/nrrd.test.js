import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { loadNRRD, nrrdGrid, nrrdTransform, volumeFromNRRD } from '@margoengine/sciviz/nrrd';

const fixture = (name) => readFileSync(new URL(`../../loaders/tests/fixtures/${name}`, import.meta.url));
const text = (s) => new TextEncoder().encode(s);

// Serves fixed files by path, counting the requests, on a free local port.
async function serve(files) {
  const hits = [];
  const server = createServer((request, response) => {
    hits.push(request.url);
    const body = files[request.url];
    if (body === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, hits, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('a real pynrrd volume reads from bytes and from a URL into the same samples', async () => {
  const bytes = fixture('volume-raw.nrrd'),
    fromBytes = await loadNRRD(bytes);
  assert.deepEqual(fromBytes.dims, [24, 16, 8]);
  assert.equal(fromBytes.data.length, 24 * 16 * 8);
  const server = await serve({ '/scans/head.nrrd': bytes });
  try {
    const fromUrl = await loadNRRD(`${server.base}/scans/head.nrrd`);
    assert.deepEqual([...fromUrl.data], [...fromBytes.data]);
  } finally {
    await server.close();
  }
});

test('a detached .nhdr fetches its data file next to the header', async () => {
  const header = text(
      'NRRD0004\ntype: ushort\ndimension: 3\nsizes: 2 2 2\nspacings: 1 1 3\nencoding: raw\nendian: little\ndata file: ./raw/body.raw\n',
    ),
    body = new Uint8Array(new Uint16Array([0, 1, 2, 3, 4, 5, 6, 700]).buffer);
  const server = await serve({ '/ct/scan.nhdr': header, '/ct/raw/body.raw': body });
  try {
    const volume = await loadNRRD(new URL(`${server.base}/ct/scan.nhdr`));
    assert.deepEqual([...volume.data], [0, 1, 2, 3, 4, 5, 6, 700]);
    assert.deepEqual(server.hits, ['/ct/scan.nhdr', '/ct/raw/body.raw']);
    const grid = nrrdGrid(volume);
    assert.deepEqual(grid.bounds, [0, 1, 0, 1, 0, 3]);
    assert.deepEqual(grid.range, [0, 700]);
    assert.ok(grid.data instanceof Uint16Array, 'one scalar volume keeps the file type');
  } finally {
    await server.close();
  }
});

test('a missing file is a coded error naming the status, and an abort stops the fetch', async () => {
  const server = await serve({});
  try {
    await assert.rejects(loadNRRD(`${server.base}/none.nrrd`), (error) => /404/.test(error.message));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(loadNRRD(`${server.base}/none.nrrd`, { signal: controller.signal }), { name: 'AbortError' });
  } finally {
    await server.close();
  }
  await assert.rejects(loadNRRD(42), TypeError);
});

test('nrrdGrid picks a frame of a series and a component or the magnitude of a voxel', async () => {
  // Two components per voxel, 2 x 1 x 1 voxels, two time steps: (3,4) (0,1) | (6,8) (5,12).
  const header =
    'NRRD0004\ntype: float\ndimension: 4\nsizes: 2 2 1 2\nkinds: vector space space time\nencoding: ascii\n\n';
  const volume = await loadNRRD(text(`${header}3 4 0 1 6 8 5 12\n`));
  assert.equal(volume.components, 2);
  assert.equal(volume.frames, 2);
  assert.deepEqual([...nrrdGrid(volume).data], [3, 0]);
  assert.deepEqual([...nrrdGrid(volume, { component: 1 }).data], [4, 1]);
  assert.deepEqual([...nrrdGrid(volume, { frame: 1, component: 'magnitude' }).data], [10, 13]);
  assert.throws(() => nrrdGrid(volume, { frame: 2 }), RangeError);
  assert.throws(() => nrrdGrid(volume, { component: 2 }), RangeError);
  // A series of scalar volumes slices without a copy.
  const series = await loadNRRD(
    text('NRRD0004\ntype: short\ndimension: 2\nsizes: 2 3\nkinds: space time\nencoding: ascii\n\n1 2 3 4 5 6\n'),
  );
  const last = nrrdGrid(series, { frame: 2 });
  assert.deepEqual([...last.data], [5, 6]);
  assert.equal(last.data.buffer, series.data.buffer);
});

test('volumeFromNRRD hands the grid, true bounds and range to fig.volume', async () => {
  const calls = [];
  const figure = { volume: (data, options) => (calls.push({ data, options }), { kind: 'volume' }) };
  const header =
    'NRRD0004\ntype: uchar\ndimension: 3\nsizes: 2 2 2\nspace: RAS\nspace directions: (0.5,0,0) (0,0.5,0) (0,0,2)\nencoding: ascii\n\n';
  const result = await volumeFromNRRD(figure, text(`${header}0 10 20 30 40 50 60 70\n`), { colormap: 'magma' });
  assert.equal(result.layer.kind, 'volume');
  assert.deepEqual(calls[0].options.dims, [2, 2, 2]);
  assert.deepEqual(calls[0].options.bounds, [0, 0.5, 0, 0.5, 0, 2]);
  assert.deepEqual(calls[0].options.range, [0, 70]);
  assert.equal(calls[0].options.colormap, 'magma');
  assert.equal(calls[0].data.length, 8);
});

test('nrrdGrid range is the smallest and largest finite sample', async () => {
  const header = 'NRRD0004\ntype: float\ndimension: 1\nsizes: 5\nencoding: ascii\n\n';
  assert.deepEqual(nrrdGrid(await loadNRRD(text(`${header}1 inf 3 -inf nan\n`))).range, [1, 3]);
  assert.deepEqual(nrrdGrid(await loadNRRD(text(`${header}inf -inf nan inf nan\n`))).range, [0, 0]);
});

test('volumeFromNRRD places the volume by the file orientation, and orientation: false keeps index order', async () => {
  // A left-posterior-superior scan turned a quarter about z: voxel x runs along +y by 2, voxel y along -x by 3.
  const header = [
      'NRRD0005',
      'type: uint8',
      'dimension: 3',
      'sizes: 2 3 2',
      'space: left-posterior-superior',
      'space directions: (0,2,0) (-3,0,0) (0,0,4)',
      'space origin: (10,20,30)',
      'encoding: ascii',
    ].join('\n'),
    bytes = text(`${header}\n\n0 1 2 3 4 5 6 7 8 9 10 11\n`),
    calls = [],
    figure = { volume: (data, options) => (calls.push(options), { data }) };
  const volume = await loadNRRD(bytes);
  assert.deepEqual(volume.bounds, [0, 2, 0, 6, 0, 4]);
  const transform = nrrdTransform(volume);
  // Voxel (i, j, k) sits at box (2i, 3j, 4k) and in space at (10 - 3j, 20 + 2i, 30 + 4k).
  for (const [i, j, k] of [
    [0, 0, 0],
    [1, 0, 0],
    [0, 2, 0],
    [1, 2, 1],
  ]) {
    const p = [2 * i, 3 * j, 4 * k, 1];
    assert.deepEqual(
      [0, 1, 2].map((r) => p.reduce((sum, v, c) => sum + transform[c * 4 + r] * v, 0)),
      [10 - 3 * j, 20 + 2 * i, 30 + 4 * k],
    );
  }
  await volumeFromNRRD(figure, bytes);
  await volumeFromNRRD(figure, bytes, { orientation: false });
  await volumeFromNRRD(figure, bytes, { bounds: [0, 1, 0, 1, 0, 1] });
  assert.deepEqual(
    calls.map((c) => c.transform),
    [transform, undefined, undefined],
  );
  // Plain positive spacings need no transform; a negative one flips its axis.
  const flat = (spacings) =>
    text(
      `NRRD0004\ntype: uint8\ndimension: 3\nsizes: 2 2 2\nspacings: ${spacings}\nencoding: ascii\n\n0 1 2 3 4 5 6 7\n`,
    );
  assert.equal(nrrdTransform(await loadNRRD(flat('1 2 3'))), undefined);
  assert.deepEqual(nrrdTransform(await loadNRRD(flat('1 -2 3'))), [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const blocks = await loadNRRD(
    text('NRRD0004\ntype: block\nblock size: 2\ndimension: 3\nsizes: 1 1 1\nencoding: raw\n\nab'),
  );
  assert.throws(() => nrrdGrid(blocks), /2 opaque bytes per sample/);
});
