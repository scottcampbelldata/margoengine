import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createShareURL,
  readShareURL,
  inlineShareData,
  exportStandalone,
  applyShareView,
  connectEmbed,
  serveEmbed,
} from '@margoengine/sciviz/share';
import { Figure, specHash, encodeFigureValue, loadSpecData } from '@margoengine/sciviz/spec';
import { Camera } from '@margoengine/core';
import { readFileSync } from 'node:fs';

test('all Margo runtime imports are declared so isolated builds and package build ordering include them', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const sources = ['share.ts', 'share-embed.ts'];
  for (const name of sources) {
    const source = readFileSync(new URL('../src/' + name, import.meta.url), 'utf8');
    for (const match of source.matchAll(/['"](@margoengine\/[^/'"]+)(?:\/[^'"]*)?['"]/g)) {
      assert.ok(match[1] === manifest.name || manifest.dependencies?.[match[1]] || manifest.peerDependencies?.[match[1]], `Missing runtime dependency ${match[1]}`);
    }
  }
});

const camera = { position: [2, 2, 3], target: [0, 0, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 };
const empty = () => ({
  version: 1,
  options: {},
  camera,
  limits: [0, 1, 0, 1],
  dragMode: 'orbit',
  resources: [],
  layers: [],
});
test('compressed fragment round trips unicode data, camera and exact time step', async () => {
  const spec = {
    ...empty(),
    annotations: 'MRI <tag> 🧠',
    time: { times: [0, 3], index: 0, frames: [empty(), empty()] },
  };
  const view = { camera: { ...camera, position: [4, 5, 6] }, timeIndex: 1 };
  const url = await createShareURL(spec, 'https://example.test/view?keep=1#old', { view });
  assert.match(url, /^https:\/\/example.test\/view\?keep=1#margo=[\w-]+$/);
  assert.deepEqual(await readShareURL(url), { version: 1, spec, view });
  assert.deepEqual(await readShareURL(new URL(url).hash), await readShareURL(url));
  await assert.rejects(createShareURL(spec, 'https://example.test', { maxURLLength: 10 }), /maxURLLength/);
  await assert.rejects(createShareURL(spec, 'https://example.test', { view: { timeIndex: 2 } }), /timeIndex/);
  await assert.rejects(readShareURL('#margo=A'), /fragment/);
  await assert.rejects(readShareURL(url, { maxBytes: 10 }), /maxBytes|base64/i);
  await assert.rejects(
    createShareURL(spec, 'https://example.test', { signal: AbortSignal.abort(new Error('cancelled')) }),
    /cancelled/,
  );
});
test('decompression is bounded after inflation rather than only on compressed bytes', async () => {
  const spec = { ...empty(), annotations: 'x'.repeat(100000) };
  const url = await createShareURL(spec, 'https://example.test');
  assert.ok(url.length < 1500);
  await assert.rejects(readShareURL(url, { maxBytes: 1500 }), /maxBytes/);
});
test('repeated frame arrays are dictionary-packed and reconstruct the original hashed spec', async () => {
  const array = await encodeFigureValue(new Float32Array(30000).map((_, i) => Math.sin(i)));
  const spec = {
    ...empty(),
    annotations: array,
    time: {
      times: [0, 1],
      index: 0,
      frames: [
        { ...empty(), annotations: array },
        { ...empty(), annotations: array },
      ],
    },
  };
  const url = await createShareURL(spec, 'https://example.test');
  const single = await createShareURL({ ...empty(), annotations: array }, 'https://example.test');
  assert.ok(url.length < single.length + 500);
  assert.deepEqual((await readShareURL(url)).spec, spec);
});
test('inlining rehashes nested timeline specs after changing their pinned data', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const frame = {
    ...empty(),
    annotations: {
      $url: {
        url: 'data:application/octet-stream;base64,AQID',
        sha256: await specHash(bytes),
        dtype: 'Uint8Array',
        length: 3,
      },
    },
  };
  frame.sha256 = await specHash(new TextEncoder().encode(JSON.stringify(frame)));
  const result = await inlineShareData({ ...empty(), time: { times: [0], index: 0, frames: [frame] } });
  const { sha256, ...body } = result.time.frames[0];
  assert.equal(sha256, await specHash(new TextEncoder().encode(JSON.stringify(body))));
  assert.ok(body.annotations.$array);
});
test('standalone resolves pinned sources and keeps data and script text inert', async () => {
  const bytes = new Uint8Array(new Float32Array([1, 2, 3]).buffer);
  const data = await loadSpecData({
    url: 'data:application/octet-stream;base64,' + Buffer.from(bytes).toString('base64'),
    sha256: await specHash(bytes),
    dtype: 'Float32Array',
    length: 3,
  });
  const spec = {
    ...empty(),
    annotations: {
      $url: {
        url: 'data:application/octet-stream;base64,' + Buffer.from(bytes).toString('base64'),
        sha256: await specHash(bytes),
        dtype: 'Float32Array',
        length: 3,
      },
    },
  };
  const inline = await inlineShareData(spec);
  assert.deepEqual(inline.annotations, await encodeFigureValue(data));
  assert.equal(JSON.stringify(inline).includes('$url'), false);
  const html = await (
    await exportStandalone(
      { ...empty(), annotations: '</script><script>evil()</script>' },
      { runtime: 'console.log("</script>")', title: '<MRI>' },
    )
  ).text();
  assert.ok(html.includes('&lt;MRI&gt;'));
  assert.ok(html.includes('\\u003c/script>'));
  assert.ok(!html.includes('<script>evil()'));
  await assert.rejects(inlineShareData({ ...spec, sha256: '0'.repeat(64) }), /hash/);
  await assert.rejects(inlineShareData(spec, { maxBytes: 4 }), /maxBytes/);
});
test('view applies to an owned figure and invalid cameras cannot mutate it', async () => {
  const engine = { camera: new Camera(camera), use() {}, onFrame: () => () => {} };
  const fig = Figure.attach(engine, { axes: false });
  await applyShareView(fig, { camera: { ...camera, position: [4, 4, 4] } });
  assert.deepEqual(engine.camera.position, [4, 4, 4]);
  await assert.rejects(applyShareView(fig, { camera: { ...camera, far: -1 } }), /camera/);
  await assert.rejects(applyShareView(fig, { timeIndex: 0 }), /timeIndex/);
  fig.dispose();
  for (const origin of ['*', 'null', 'https://example.test/', 'file:///tmp/a']) {
    assert.throws(() => connectEmbed({ origin }), /origin|URL/i);
    assert.throws(() => serveEmbed({}, { origin }), /origin|URL/i);
  }
});
