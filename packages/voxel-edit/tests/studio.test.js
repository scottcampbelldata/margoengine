import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { noiseFill, paletteUsage, suggestPalette } from '../dist/assist.js';
import { gridToExportSource } from '../dist/export.js';
import { VoxelHistory } from '../dist/history.js';
import { fetchLibrary, resolveLibraryUrl } from '../dist/library.js';

const grid = (size, values) => ({ size, voxels: Uint8Array.from(values) });

test('history undo and redo', () => {
  const a = grid([2, 1, 1], [1, 0]);
  const h = new VoxelHistory(a);
  assert.equal(h.canUndo, false);
  assert.equal(h.depth, 1);
  const b = grid([2, 1, 1], [1, 1]);
  h.push(b, 'paint');
  assert.equal(h.canUndo, true);
  assert.equal(h.label, 'paint');
  const undone = h.undo();
  assert.equal(undone.voxels[1], 0);
  assert.equal(h.canRedo, true);
  const redone = h.redo();
  assert.equal(redone.voxels[1], 1);
});

test('history drops redo branch on push', () => {
  const h = new VoxelHistory(grid([1, 1, 1], [1]));
  h.push(grid([1, 1, 1], [2]), 'a');
  h.push(grid([1, 1, 1], [3]), 'b');
  h.undo();
  h.push(grid([1, 1, 1], [4]), 'c');
  assert.equal(h.canRedo, false);
  assert.equal(h.current.voxels[0], 4);
  assert.equal(h.depth, 3);
});

test('history copies grids and enforces a retained byte budget', () => {
  const source = grid([1, 1, 1], [1]);
  const h = new VoxelHistory(source, { maxBytes: 2 });
  source.voxels[0] = 9;
  assert.equal(h.current.voxels[0], 1);
  h.current.voxels[0] = 4;
  assert.equal(h.current.voxels[0], 1);
  assert.throws(() => h.push(grid([2, 1, 1], [1, 1])), RangeError);
});

test('history keeps a byte total across redo-branch drops and depth trims', () => {
  const h = new VoxelHistory(grid([2, 1, 1], [1, 1]), { maxDepth: 2 });
  h.push(grid([3, 1, 1], [1, 1, 1]));
  assert.equal(h.bytes, 5);
  h.push(grid([1, 1, 1], [1]));
  assert.equal(h.bytes, 4);
  h.undo();
  h.push(grid([4, 1, 1], [1, 1, 1, 1]));
  assert.equal(h.depth, 2);
  assert.equal(h.bytes, 7);
  assert.throws(() => new VoxelHistory(grid([1, 1, 1], [1]), { maxCells: 0 }), RangeError);
  assert.throws(() => new VoxelHistory(grid([2, 1, 1], [1, 1]), { maxCells: 1 }), RangeError);
});

test('noiseFill is deterministic', () => {
  const a = noiseFill([4, 4, 4], { seed: 7, threshold: 0.5 });
  const b = noiseFill([4, 4, 4], { seed: 7, threshold: 0.5 });
  assert.deepEqual([...a.voxels], [...b.voxels]);
  assert.equal(a.size[0], 4);
  assert.ok(noiseFill([4, 4, 4], { threshold: 0, palette: 9 }).voxels.every((v) => v === 9));
  assert.ok(noiseFill([4, 4, 4], { threshold: 1 }).voxels.every((v) => v === 0));
  for (const options of [{ palette: 0 }, { palette: 256 }, { threshold: 2 }, { threshold: Number.NaN }, { seed: 1.5 }])
    assert.throws(() => noiseFill([2, 2, 2], options), RangeError);
});

test('suggestPalette returns contrasting colours', () => {
  const colors = suggestPalette(4, 1);
  assert.equal(colors.length, 4);
  assert.equal(colors[0].length, 3);
  // Linear sRGB: hsl(h, 0.6, 0.5) has a channel at 0.2 sRGB, about 0.033 linear, and one at 0.8, about 0.6.
  for (const c of colors) {
    assert.ok(Math.min(...c) < 0.04 && Math.max(...c) > 0.55 && Math.max(...c) < 0.65);
  }
});

test('paletteUsage counts cells', () => {
  const g = grid([2, 1, 1], [1, 1]);
  const counts = paletteUsage(g);
  assert.equal(counts[1], 2);
  assert.equal(counts[0], 0);
});

test('gridToExportSource meshes a filled cell', () => {
  const g = grid([1, 1, 1], [1]);
  const src = gridToExportSource(g, [{ index: 1, color: [1, 0, 0] }], { name: 'cube' });
  assert.equal(src.name, 'cube');
  assert.ok(src.mesh.positions.length > 0);
  assert.equal(src.nodes[0].primitives[0].material.color[0], 1);
});

test('a relative library index does not invent an origin', () => {
  assert.equal(resolveLibraryUrl('/library/index.json', 'tree.vox'), '/library/tree.vox');
  assert.equal(
    resolveLibraryUrl('https://assets.example/pack/index.json', 'tree.vox'),
    'https://assets.example/pack/tree.vox',
  );
  assert.equal(
    resolveLibraryUrl('/library/index.json', 'https://cdn.example/tree.vox'),
    'https://cdn.example/tree.vox',
  );
  assert.equal(
    resolveLibraryUrl('library/index.json', 'tree.vox', 'https://host.example/app/'),
    'https://host.example/app/library/tree.vox',
  );
  assert.equal(
    resolveLibraryUrl('library/index.json', '//cdn.example/tree.vox', 'https://host.example/app/'),
    'https://cdn.example/tree.vox',
  );
  assert.equal(resolveLibraryUrl('/library/index.json', '//cdn.example/tree.vox'), '//cdn.example/tree.vox');
});

test('fetchLibrary resolves assets against the response URL and enforces size and abort', async () => {
  const index = JSON.stringify({
    version: 1,
    assets: [{ id: 'tree', name: 'Tree', url: 'tree.vox', preview: '//cdn.example/tree.png' }],
  });
  const server = http.createServer((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, { Location: '/app/library/index.json' });
      res.end();
      return;
    }
    if (req.url === '/app/library/index.json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(index)) });
      res.end(index);
      return;
    }
    if (req.url === '/chunked') {
      const body = JSON.stringify({ version: 1, assets: [] });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' });
      res.write(body);
      res.end();
      return;
    }
    if (req.url === '/bad') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: 2, assets: [] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const library = await fetchLibrary(`${base}/start`);
    assert.equal(library.assets[0].url, `${base}/app/library/tree.vox`);
    assert.equal(library.assets[0].preview, 'http://cdn.example/tree.png');
    await assert.rejects(fetchLibrary(`${base}/start`, { maxBytes: 8 }), /over 8/);
    await assert.rejects(fetchLibrary(`${base}/chunked`, { maxBytes: 8 }), /is \d+ bytes, over 8/);
    await assert.rejects(fetchLibrary(`${base}/bad`), /version/);
    await assert.rejects(fetchLibrary(`${base}/missing`), { name: 'MargoError', code: 'failed' });
    await assert.rejects(fetchLibrary(`${base}/start`, { signal: AbortSignal.abort() }), /abort/i);
    const hung = http.createServer(() => {});
    await new Promise((resolve) => hung.listen(0, '127.0.0.1', resolve));
    const controller = new AbortController();
    const pending = fetchLibrary(`http://127.0.0.1:${hung.address().port}/start`, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, /abort/i);
    hung.close();
  } finally {
    server.close();
  }
});
