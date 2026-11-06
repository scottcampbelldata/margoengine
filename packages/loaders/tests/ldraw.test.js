// parseLDraw: line types, colour inheritance, sub-files, MPD packs, BFC winding, units, limits and refusals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLDraw, resolveFromURL } from '../dist/ldraw.js';
import { LoaderError } from '../dist/common.js';

const file = { units: 'file' };
const near = (actual, expected) => {
  assert.equal(actual.length, expected.length);
  [...actual].forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-6, `${[...actual]} against ${expected}`));
};
const refuses = (promise, code) =>
  assert.rejects(promise, (error) => error instanceof LoaderError && error.format === 'LDraw' && error.code === code);
/** A resolver over a table of library paths; every other path rejects, as a failed fetch does. */
const library = (files, asked = []) => async (path) => {
  asked.push(path);
  if (path in files) return files[path];
  throw new Error(`no ${path}`);
};
const normal = (model, t) => {
  const p = (k) => [...model.positions.subarray(model.indices[t * 3 + k] * 3, model.indices[t * 3 + k] * 3 + 3)],
    [a, b, c] = [p(0), p(1), p(2)],
    u = b.map((v, i) => v - a[i]),
    w = c.map((v, i) => v - a[i]);
  return [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
};

test('triangles and quads make a mesh with a group per colour', async () => {
  const model = await parseLDraw(
    '0 A small model\n0 BFC CERTIFY CCW\n3 4 0 0 0 1 0 0 0 1 0\n4 1 0 0 0 1 0 0 1 1 0 0 1 0\n3 4 2 0 0 3 0 0 2 1 0\n',
    file,
  );
  assert.equal(model.name, 'A small model');
  assert.equal(model.indices.length, 12);
  assert.deepEqual(
    model.groups.map(({ start, count, name, objectId }) => [start, count, name, objectId]),
    [
      [0, 6, 'Red', '4'],
      [6, 6, 'Blue', '1'],
    ],
  );
  near(model.groups[0].color, [0xc9 / 255, 0x1a / 255, 9 / 255, 1]);
  assert.deepEqual(model.palette.map((c) => c.code), [4, 1]);
});

test('edge and conditional lines come back apart, and edges: false drops them', async () => {
  const text = '2 24 0 0 0 1 0 0\n5 24 0 0 0 1 0 0 0 1 0 0 -1 0\n3 4 0 0 0 1 0 0 0 1 0\n';
  const model = await parseLDraw(text, file);
  near(model.lines, [0, 0, 0, 1, 0, 0]);
  assert.equal(model.lineColors.length, 6);
  assert.equal(model.conditionalLines.length, 12);
  const bare = await parseLDraw(text, { ...file, edges: false });
  assert.equal(bare.lines.length + bare.conditionalLines.length, 0);
  assert.equal(bare.indices.length, 6);
});

test('colour 16 takes the reference colour, 24 its edge, through two levels', async () => {
  const resolve = library({
    'parts/a.dat': '1 16 0 0 0 1 0 0 0 1 0 0 0 1 b.dat\n',
    'parts/b.dat': '0 BFC CERTIFY\n3 16 0 0 0 1 0 0 0 1 0\n2 24 0 0 0 1 0 0\n',
  });
  const model = await parseLDraw('1 14 0 0 0 1 0 0 0 1 0 0 0 1 a.dat\n', { ...file, resolve });
  assert.equal(model.groups[0].objectId, '14');
  near(model.lineColors.subarray(0, 3), [0.2, 0.2, 0.2]);
  const plain = await parseLDraw('0 BFC CERTIFY\n3 16 0 0 0 1 0 0 0 1 0\n', { ...file, color: 2 });
  assert.equal(plain.groups[0].objectId, '2');
});

test('direct colours, file colours and LDConfig fill the palette; an unknown code warns', async () => {
  const model = await parseLDraw(
    `0 !COLOUR Lime CODE 300 VALUE #00FF00 EDGE 0 ALPHA 128
0 BFC CERTIFY
3 ${0x2ff0000} 0 0 0 1 0 0 0 1 0
3 300 0 0 0 1 0 0 0 1 0
3 999 0 0 0 1 0 0 0 1 0
`,
    file,
  );
  const [direct, lime, unknown] = model.groups;
  near(direct.color, [1, 0, 0, 1]);
  assert.equal(lime.name, 'Lime');
  near(lime.color, [0, 1, 0, 128 / 255]);
  assert.equal(unknown.objectId, '7');
  assert.match(model.warnings[0], /colour 999/);
  const resolve = library({ 'LDConfig.ldr': '0 !COLOUR Mine CODE 4 VALUE #010203 EDGE #000000\n' });
  const configured = await parseLDraw('3 4 0 0 0 1 0 0 0 1 0\n', { ...file, resolve });
  assert.equal(configured.groups[0].name, 'Mine');
  const given = await parseLDraw('3 4 0 0 0 1 0 0 0 1 0\n', {
    ...file,
    config: '0 !COLOUR Given CODE 4 VALUE #010203 EDGE #000000\n',
  });
  assert.equal(given.groups[0].name, 'Given');
});

test('references search the library, fold case and back slashes, and read each file once', async () => {
  const asked = [];
  const resolve = library({ 'p/s/stud.dat': '0 BFC CERTIFY\n3 16 0 0 0 1 0 0 0 1 0\n' }, asked);
  const model = await parseLDraw(
    '1 4 0 0 0 1 0 0 0 1 0 0 0 1 S\\STUD.DAT\n1 4 5 0 0 1 0 0 0 1 0 0 0 1 s/stud.dat\n',
    { ...file, resolve },
  );
  assert.equal(model.indices.length, 6);
  assert.equal(asked.filter((path) => path === 'p/s/stud.dat').length, 1);
  assert.deepEqual(model.missing, []);
});

test('a reference places its part by the row matrix and moves through parents', async () => {
  const resolve = library({ 'a.dat': '1 16 0 0 1 1 0 0 0 1 0 0 0 1 b.dat\n', 'b.dat': '2 4 1 0 0 2 0 0\n' });
  const model = await parseLDraw('1 4 10 0 0 0 -1 0 1 0 0 0 0 1 a.dat\n', { ...file, resolve });
  near(model.lines, [10, 1, 1, 10, 2, 1]);
});

test('a missing part is listed, the rest of the model still loads, and no resolver loads the file alone', async () => {
  const text = '3 4 0 0 0 1 0 0 0 1 0\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 gone.dat\n';
  assert.deepEqual((await parseLDraw(text, { ...file, resolve: library({}) })).missing, ['gone.dat']);
  const alone = await parseLDraw(text, file);
  assert.deepEqual(alone.missing, ['gone.dat']);
  assert.equal(alone.indices.length, 6);
});

test('resolveFromURL reads a hosted library: search paths, a 404, the base with or without its slash, and the signal', async () => {
  const library = {
      'https://cdn.example.test/ldraw/LDConfig.ldr': '0 !COLOUR Red CODE 4 VALUE #C91A09 EDGE #333333\n',
      'https://cdn.example.test/ldraw/parts/plate.dat': '3 16 0 0 0 10 0 0 0 0 10\n',
    },
    asked = [],
    signal = new AbortController().signal,
    fetch = async (url, init) => {
      asked.push(String(url));
      assert.equal(init.signal, signal);
      const body = library[String(url)];
      return new Response(body ?? 'gone', { status: body === undefined ? 404 : 200 });
    };
  for (const base of ['https://cdn.example.test/ldraw', 'https://cdn.example.test/ldraw/', new URL('https://cdn.example.test/ldraw/')]) {
    asked.length = 0;
    const model = await parseLDraw('1 4 0 0 0 1 0 0 0 1 0 0 0 1 plate.dat\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 absent.dat\n', {
      resolve: resolveFromURL(base, { fetch, signal }),
    });
    assert.equal(model.groups.length, 1);
    assert.equal(model.groups[0].name, 'Red');
    assert.deepEqual(model.missing, ['absent.dat']);
    assert.ok(asked.includes('https://cdn.example.test/ldraw/parts/plate.dat'));
    assert.equal(asked.filter((url) => url.endsWith('plate.dat')).length, 2, 'the folder before it, then parts/');
  }
});

test('an abort during a hosted read stops the parse', async () => {
  const controller = new AbortController(),
    fetch = async () => {
      controller.abort();
      throw new DOMException('Aborted', 'AbortError');
    };
  await assert.rejects(
    parseLDraw('1 4 0 0 0 1 0 0 0 1 0 0 0 1 plate.dat\n', {
      resolve: resolveFromURL('https://cdn.example.test/ldraw/', { fetch, signal: controller.signal }),
      signal: controller.signal,
    }),
    { code: 'aborted' },
  );
});

test('an MPD pack finds its own files first and draws the first one', async () => {
  const asked = [];
  const model = await parseLDraw(
    `0 FILE main.ldr
0 Main model
1 4 0 0 0 1 0 0 0 1 0 0 0 1 Sub.ldr
0 NOFILE
0 FILE sub.ldr
0 BFC CERTIFY
3 16 0 0 0 1 0 0 0 1 0
0 NOFILE
0 FILE other.ldr
3 1 0 0 0 1 0 0 0 1 0
0 !DATA picture.png
0 !: iVBORw0KGgo=
`,
    { ...file, resolve: library({}, asked) },
  );
  assert.equal(model.name, 'Main model');
  assert.deepEqual(model.groups.map((g) => g.objectId), ['4']);
  assert.equal(model.indices.length, 3);
  assert.ok(!asked.some((path) => path.includes('sub.ldr')));
});

test('BFC: certified winding is kept, CW reverses, a mirror and INVERTNEXT flip, and uncertified is two sided', async () => {
  const z = async (text, options = {}) => normal(await parseLDraw(text, { ...file, ...options }), 0)[2];
  const face = '3 4 0 0 0 1 0 0 0 1 0\n';
  assert.ok((await z(`0 BFC CERTIFY CCW\n${face}`)) > 0);
  assert.ok((await z(`0 BFC CERTIFY CW\n${face}`)) < 0);
  const resolve = library({ 'f.dat': `0 BFC CERTIFY CCW\n${face}` });
  assert.ok((await z('1 4 0 0 0 1 0 0 0 1 0 0 0 1 f.dat\n', { resolve })) > 0);
  // A mirror turns the corners over and the flip turns them back, so the face still looks along +z.
  assert.ok((await z('1 4 0 0 0 -1 0 0 0 1 0 0 0 1 f.dat\n', { resolve })) > 0);
  assert.ok((await z('0 BFC INVERTNEXT\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 f.dat\n', { resolve })) < 0);
  assert.ok((await z('0 BFC INVERTNEXT\n1 4 0 0 0 -1 0 0 0 1 0 0 0 1 f.dat\n', { resolve })) < 0);
  const open = await parseLDraw(face, file);
  assert.equal(open.indices.length, 6);
  assert.ok(normal(open, 0)[2] * normal(open, 1)[2] < 0);
  const noclip = await parseLDraw(`0 BFC CERTIFY\n0 BFC NOCLIP\n${face}0 BFC CLIP\n${face}`, file);
  assert.equal(noclip.indices.length, 9);
});

test('by default the model is in metres with Y up, and the winding survives the turn', async () => {
  const model = await parseLDraw('0 BFC CERTIFY\n3 4 0 -24 0 20 -24 0 0 -24 20\n');
  near(model.positions, [0, 0.0096, 0, 0.008, 0.0096, 0, 0, 0.0096, -0.008]);
  assert.ok(normal(model, 0)[1] > 0, 'a face looking up in LDraw, along -Y, looks up along +Y after the turn');
  const inFile = await parseLDraw('0 BFC CERTIFY\n3 4 0 -24 0 20 -24 0 0 -24 20\n', file);
  assert.ok(normal(inFile, 0)[1] < 0);
});

test('a loop, a deep chain and a doubling chain stop with named errors', async () => {
  const loop = library({ 'a.dat': '1 4 0 0 0 1 0 0 0 1 0 0 0 1 b.dat\n', 'b.dat': '1 4 0 0 0 1 0 0 0 1 0 0 0 1 a.dat\n' });
  await refuses(parseLDraw('1 4 0 0 0 1 0 0 0 1 0 0 0 1 a.dat\n', { resolve: loop }), 'syntax');
  const twice = (next) => `1 4 0 0 0 1 0 0 0 1 0 0 0 1 ${next}\n`.repeat(2);
  const files = {};
  for (let i = 0; i < 30; i++) files[`f${i}.dat`] = twice(`f${i + 1}.dat`);
  files['f30.dat'] = '';
  await refuses(parseLDraw(twice('f0.dat'), { resolve: library(files), maxInstances: 1000 }), 'limit');
  await refuses(parseLDraw(twice('f0.dat'), { resolve: library(files), maxDepth: 3 }), 'limit');
});

test('limits and bad lines are named errors', async () => {
  const tri = '3 4 0 0 0 1 0 0 0 1 0\n';
  await refuses(parseLDraw(tri, { maxVertices: 2 }), 'limit');
  await refuses(parseLDraw(tri, { maxTriangles: 1 }), 'limit');
  await refuses(parseLDraw('2 4 0 0 0 1 0 0\n', { maxVertices: 1 }), 'limit');
  await refuses(parseLDraw('3 4 0 0 0 1 0\n'), 'syntax');
  await refuses(parseLDraw('3 4 0 0 0 1 0 0 0 1 x\n'), 'syntax');
  await refuses(parseLDraw('3 red 0 0 0 1 0 0 0 1 0\n'), 'syntax');
  await refuses(parseLDraw('1 4 0 0 0 1 0 0 0 1 0 0 0 1\n'), 'syntax');
  await refuses(parseLDraw('0 !COLOUR Bad CODE x VALUE #000000\n'), 'syntax');
  await refuses(parseLDraw(tri, { units: 'feet' }), 'range');
  await refuses(parseLDraw(tri, { color: 16 }), 'range');
  await refuses(parseLDraw(tri, { color: 24 }), 'range');
  await refuses(parseLDraw(tri, { maxDepth: -1 }), 'range');
  await refuses(parseLDraw(tri, { maxInstances: 0.5 }), 'range');
  const controller = new AbortController();
  controller.abort();
  await refuses(parseLDraw(tri, { signal: controller.signal }), 'aborted');
});

test('an abort during loading stops the search', async () => {
  const controller = new AbortController();
  const resolve = async () => {
    controller.abort();
    throw new Error('offline');
  };
  await refuses(parseLDraw('1 4 0 0 0 1 0 0 0 1 0 0 0 1 a.dat\n', { resolve, signal: controller.signal }), 'aborted');
});

test('other line types warn and texture maps are named once', async () => {
  const model = await parseLDraw('7 what\n0 !TEXMAP START PLANAR\n0 !: 3 4 0 0 0 1 0 0 0 1 0\n3 4 0 0 0 1 0 0 0 1 0\n', file);
  assert.equal(model.indices.length, 6);
  assert.deepEqual(model.warnings, ['line type 7 is not part of LDraw', 'texture maps are not read']);
});
