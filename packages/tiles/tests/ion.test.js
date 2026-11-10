import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Tileset, TilesRenderer } from '../dist/index.js';
import { TileCredits, contentCopyright, hostedTileset, htmlText, ionAsset } from '../dist/ion.js';
import { b3dm, boxGLB, settle } from './generator.js';

const encoder = new TextEncoder(),
  json = (value) => encoder.encode(JSON.stringify(value));
const asset = (name) =>
  new Uint8Array(readFileSync(new URL(`../../../examples/assets/khronos/${name}`, import.meta.url)));
/** The JSON chunk of a GLB, read here without the entry. */
function gltfOf(glb) {
  const length = new DataView(glb.buffer, glb.byteOffset, glb.byteLength).getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + length)));
}
/** The real glTF `asset.copyright` of a GLB. */
const copyrightOf = (glb) => gltfOf(glb).asset.copyright;

/** A fake server: `routes` maps an absolute URL (no query) to a function of (url, headers) giving a Response. */
function server(routes) {
  const requests = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(input),
      headers = { ...init.headers };
    requests.push({ url: url.href, headers });
    const route = routes[url.origin + url.pathname];
    return route ? route(url, headers) : new Response('missing', { status: 404 });
  };
  return { fetch, requests };
}

function tilesetJSON(children) {
  return {
    asset: { version: '1.1' },
    geometricError: 500,
    root: {
      boundingVolume: { box: [0, 0, 0, 100, 0, 0, 0, 100, 0, 0, 0, 100] },
      geometricError: 100,
      refine: 'ADD',
      children: children.map((uri, i) => ({
        boundingVolume: { box: [i * 10, 0, 0, 5, 0, 0, 0, 5, 0, 0, 0, 5] },
        geometricError: 0,
        content: { uri },
      })),
    },
  };
}

const view = { position: [0, 0, 50], planes: undefined, screenHeight: 900, fov: 60 };
async function loadAll(tileset) {
  let frame = tileset.update(view);
  for (let i = 0; i < 50 && (frame.pending > 0 || tileset.progress.loading + tileset.progress.queued > 0); i++) {
    await settle();
    frame = tileset.update(view);
  }
  return frame;
}

test('ion: the endpoint is asked with a bearer header, and only the asset host gets the asset token', async () => {
  let endpointCalls = 0;
  const { fetch, requests } = server({
    'https://api.cesium.com/v1/assets/96188/endpoint': (_url, headers) => {
      endpointCalls++;
      return headers.Authorization === 'Bearer user-token'
        ? new Response(
            JSON.stringify({
              type: '3DTILES',
              url: 'https://assets.ion.test/96188/tileset.json?v=1',
              accessToken: 'asset-token',
              attributions: [
                {
                  html: '<span>Data &copy; <a href="https://example.test">Example &amp; Co</a></span>',
                  collapsible: false,
                },
                { html: 'Imagery', collapsible: true },
              ],
            }),
          )
        : new Response(JSON.stringify({ code: 'InvalidCredentials', message: 'Invalid access token' }), {
            status: 401,
          });
    },
    'https://assets.ion.test/96188/tileset.json': (_url, headers) =>
      headers.Authorization === 'Bearer asset-token'
        ? new Response(json(tilesetJSON(['a.glb', 'https://elsewhere.test/b.glb'])))
        : new Response('no', { status: 401 }),
    'https://assets.ion.test/96188/a.glb': (_url, headers) =>
      headers.Authorization === 'Bearer asset-token' ? new Response(boxGLB()) : new Response('no', { status: 401 }),
    'https://elsewhere.test/b.glb': () => new Response(boxGLB()),
  });
  const ion = await ionAsset(96188, { accessToken: 'user-token', fetch });
  assert.equal(ion.url, 'https://assets.ion.test/96188/tileset.json?v=1');
  assert.equal(ion.type, '3DTILES');
  assert.deepEqual(
    ion.credits.map((c) => [c.text, c.collapsible]),
    [
      ['Data \u00a9 Example & Co', false],
      ['Imagery', true],
    ],
  );
  assert.match(ion.credits[0].html, /<a href=/);
  assert.equal(endpointCalls, 1);
  assert.ok(!requests[0].url.includes('token'), 'the user token never goes in a URL');
  const tileset = await Tileset.load(ion.url, { fetch: ion.fetch });
  const frame = await loadAll(tileset);
  assert.equal(frame.selected.filter((t) => t.state === 'ready').length, 2); // the two content tiles (the empty root refines)
  for (const r of requests.slice(1)) {
    if (r.url.startsWith('https://elsewhere.test/')) assert.equal(r.headers.Authorization, undefined, r.url);
    else assert.equal(r.headers.Authorization, 'Bearer asset-token', r.url);
  }
  assert.ok(requests.some((r) => r.url === 'https://elsewhere.test/b.glb'));
  tileset.dispose();
});

test('ion: an expired asset token is renewed once for every request that saw it, then the requests retry', async () => {
  let issued = 0,
    valid = 'asset-1';
  const { fetch, requests } = server({
    'https://api.cesium.com/v1/assets/7/endpoint': () =>
      new Response(
        JSON.stringify({
          type: '3DTILES',
          url: 'https://assets.ion.test/7/tileset.json',
          accessToken: `asset-${++issued}`,
        }),
      ),
    'https://assets.ion.test/7/tileset.json': (_url, h) =>
      h.Authorization === `Bearer ${valid}`
        ? new Response(json(tilesetJSON(['a.glb', 'b.glb', 'c.glb'])))
        : new Response('', { status: 401 }),
    ...Object.fromEntries(
      ['a', 'b', 'c', 'd'].map((n) => [
        `https://assets.ion.test/7/${n}.glb`,
        (_url, h) =>
          h.Authorization === `Bearer ${valid}` ? new Response(boxGLB()) : new Response('', { status: 401 }),
      ]),
    ),
  });
  const ion = await ionAsset(7, { accessToken: 'user', fetch });
  const tileset = await Tileset.load(ion.url, { fetch: ion.fetch });
  valid = 'asset-2'; // the first token expires before the tiles are asked for
  const frame = await loadAll(tileset);
  assert.equal(frame.selected.filter((t) => t.state === 'ready').length, 3);
  assert.equal(issued, 2, 'one renewal');
  assert.ok(requests.filter((r) => r.headers.Authorization === 'Bearer asset-1').length >= 2);
  // Three requests in flight when the token expires: one renewal serves all three.
  valid = 'asset-3';
  const answers = await Promise.all(['a', 'b', 'c'].map((n) => ion.fetch(`https://assets.ion.test/7/${n}.glb`)));
  assert.deepEqual(
    answers.map((r) => r.status),
    [200, 200, 200],
  );
  assert.equal(issued, 3);
  // A token ion will not renew: the request fails as the server answered, and the tile reports it.
  valid = 'none';
  const errors = [];
  const again = await Tileset.load(ion.url, {
    fetch: async (u, i) => (u.endsWith('tileset.json') ? new Response(json(tilesetJSON(['d.glb']))) : ion.fetch(u, i)),
  });
  again.on('error', ({ error }) => errors.push(error));
  await loadAll(again);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /401/);
  tileset.dispose();
  again.dispose();
});

test('ion: a refused token, a missing asset and an external asset fail with coded errors that name the fix', async () => {
  const { fetch } = server({
    'https://api.cesium.com/v1/assets/1/endpoint': () =>
      new Response(JSON.stringify({ code: 'InvalidCredentials', message: 'Invalid access token' }), { status: 401 }),
    'https://api.cesium.com/v1/assets/2/endpoint': () => new Response('not json', { status: 404 }),
    'https://api.cesium.com/v1/assets/3/endpoint': () =>
      new Response(JSON.stringify({ type: 'IMAGERY', externalType: 'BING', options: { key: 'k' } })),
  });
  await assert.rejects(
    ionAsset(1, { accessToken: 't', fetch }),
    (e) => e.code === 'failed' && /401 \(Invalid access token\); check the access token/.test(e.message),
  );
  await assert.rejects(
    ionAsset(2, { accessToken: 't', fetch }),
    (e) => e.code === 'failed' && /404; check the asset ID/.test(e.message),
  );
  await assert.rejects(
    ionAsset(3, { accessToken: 't', fetch }),
    (e) => e.code === 'unsupported' && /external BING/.test(e.message),
  );
  await assert.rejects(ionAsset(1.5, { accessToken: 't', fetch }), RangeError);
  await assert.rejects(ionAsset(1, { fetch }), TypeError);
});

test('hostedTileset: a key goes on every request to the host, and the session a tile URL hands out goes on to its children', async () => {
  // As a photorealistic tiles service lays it out: root.json?key=K links a child tileset with ?session=S, whose own
  // relative URIs drop the query.
  const root = tilesetJSON(['/v1/3dtiles/datasets/X/files/child.json?session=S1']),
    child = tilesetJSON(['leaf.glb', 'deeper/leaf2.glb']);
  const { fetch, requests } = server({
    'https://tiles.example.test/v1/3dtiles/root.json': () => new Response(json(root)),
    'https://tiles.example.test/v1/3dtiles/datasets/X/files/child.json': () => new Response(json(child)),
    'https://tiles.example.test/v1/3dtiles/datasets/X/files/leaf.glb': () => new Response(boxGLB()),
    'https://tiles.example.test/v1/3dtiles/datasets/X/files/deeper/leaf2.glb': () => new Response(boxGLB()),
  });
  const hosted = hostedTileset('https://tiles.example.test/v1/3dtiles/root.json', {
    query: { key: 'K' },
    credits: [{ text: 'Service', collapsible: false, count: 0 }],
    fetch,
  });
  const tileset = await Tileset.load(hosted.url, { fetch: hosted.fetch });
  await loadAll(tileset);
  const leaves = requests.filter((r) => r.url.includes('.glb'));
  assert.equal(leaves.length, 2);
  for (const r of requests) assert.equal(new URL(r.url).searchParams.get('key'), 'K', r.url);
  for (const r of leaves) assert.equal(new URL(r.url).searchParams.get('session'), 'S1', r.url);
  assert.equal(new URL(requests[0].url).searchParams.get('session'), null);
  assert.deepEqual(
    hosted.credits.map((c) => c.text),
    ['Service'],
  );
  // Headers instead of a query; another host is not signed.
  const seen = [];
  const signed = hostedTileset('https://a.test/t.json', {
    headers: { 'X-Api-Key': 'H' },
    fetch: async (u, i) => (seen.push([u, i?.headers?.['X-Api-Key']]), new Response('{}')),
  });
  await signed.fetch('https://a.test/x.glb', { headers: { Accept: 'model/gltf-binary' } });
  await signed.fetch('https://b.test/x.glb');
  assert.deepEqual(seen, [
    ['https://a.test/x.glb', 'H'],
    ['https://b.test/x.glb', undefined],
  ]);
  assert.throws(() => hostedTileset('tiles/root.json'), TypeError);
  tileset.dispose();
});

test("credits, real files: the drawn tiles' glTF copyright, most frequent first, after the service's own", async () => {
  // Khronos's real Fox and AlphaBlendModeTest GLBs (examples/assets/khronos), each with its own asset.copyright.
  const fox = asset('Fox/Fox.glb'),
    blend = asset('AlphaBlendModeTest/AlphaBlendModeTest.glb'),
    shared = boxGLB(),
    // A generated GLB whose copyright names two holders, one of them the Fox's, split on the semicolon.
    both = (() => {
      const glb = boxGLB(),
        gltf = gltfOf(glb);
      gltf.asset.copyright = `Survey Office; ${copyrightOf(fox)}`;
      return rebuildGLB(gltf, glb);
    })();
  const files = {
    'https://t.test/tileset.json': () =>
      new Response(json(tilesetJSON(['fox.glb', 'fox.b3dm', 'blend.glb', 'both.glb', 'plain.glb']))),
    'https://t.test/fox.glb': () => new Response(fox),
    'https://t.test/fox.b3dm': () => new Response(b3dm(fox)),
    'https://t.test/blend.glb': () => new Response(blend),
    'https://t.test/both.glb': () => new Response(both),
    'https://t.test/plain.glb': () => new Response(shared),
  };
  const { fetch } = server(files);
  const tileset = await Tileset.load('https://t.test/tileset.json', { fetch });
  const frame = await loadAll(tileset);
  const credits = new TileCredits([{ text: 'Service', html: '<b>Service</b>', collapsible: true, count: 0 }]);
  assert.equal(credits.update(frame.selected), true);
  assert.deepEqual(
    credits.list.map((c) => [c.text, c.count]),
    [
      ['Service', 0],
      [copyrightOf(fox), 3],
      [copyrightOf(blend), 1], // ties by text: 'Copyright 2018 ...' before 'Survey Office'
      ['Survey Office', 1],
    ],
  );
  assert.equal(credits.update(frame.selected), false, 'the same view changes nothing');
  assert.equal(credits.text(' | ', true).split(' | ').length, 3, 'required leaves out the collapsible');
  // Fewer tiles drawn: their credits go.
  assert.equal(credits.update(frame.selected.filter((t) => t.contentUrls[0]?.endsWith('blend.glb'))), true);
  assert.deepEqual(
    credits.list.map((c) => c.text),
    ['Service', copyrightOf(blend)],
  );
  tileset.dispose();
});

test('credits: HTML output escapes tile text, text output strips tags, and follow writes an element each change', async () => {
  const glb = boxGLB(),
    gltf = gltfOf(glb);
  gltf.asset.copyright = '<img src=x onerror=alert(1)> & Co';
  const evil = rebuildGLB(gltf, glb);
  assert.deepEqual(contentCopyright({ type: 'glb', gltf: evil, byteLength: evil.byteLength }), [
    '<img src=x onerror=alert(1)> & Co',
  ]);
  assert.deepEqual(contentCopyright({ type: 'glb', gltf: new Uint8Array([1, 2, 3]), byteLength: 3 }), []);
  assert.deepEqual(
    contentCopyright({
      type: 'cmpt',
      tiles: [{ type: 'glb', gltf: evil, byteLength: 1 }, { type: 'pnts' }],
      byteLength: 1,
    }),
    ['<img src=x onerror=alert(1)> & Co'],
  );
  assert.equal(htmlText('<p>A&nbsp;&amp;&#66;&#x43; <br/>D</p>'), 'A &BC D');
  const tile = { contents: [{ type: 'glb', gltf: evil, byteLength: 1 }] };
  const listeners = new Set(),
    source = { last: { selected: [] }, onUpdate: (l) => (listeners.add(l), () => listeners.delete(l)) },
    element = { textContent: null };
  const credits = TileCredits.follow(source, {
    credits: [{ text: 'ion', html: '<a href="https://ion.test">ion</a>', collapsible: false, count: 0 }],
    element,
  });
  assert.equal(element.textContent, 'ion');
  source.last = { selected: [tile] };
  for (const l of listeners) l();
  assert.equal(element.textContent, 'ion | <img src=x onerror=alert(1)> & Co');
  assert.equal(credits.html(), '<a href="https://ion.test">ion</a> | &lt;img src=x onerror=alert(1)&gt; &amp; Co');
  credits.dispose();
  assert.equal(listeners.size, 0);
  {
    using again = TileCredits.follow(source);
    assert.equal(listeners.size, 1);
    assert.equal(again.text(), '<img src=x onerror=alert(1)> & Co');
  }
  assert.equal(listeners.size, 0, 'using stops following');
});

test('credits: TilesRenderer.onUpdate runs after each selection update with last current', async () => {
  const { fetch } = server({ 'https://r.test/tileset.json': () => new Response(json(tilesetJSON([]))) });
  const engine = {
    camera: { position: [0, 0, 50], fov: 60, planes: new Float32Array(24), matrix: new Float32Array(16) },
    canvas: { height: 900 },
    use(p) {
      p.setup?.(this);
    },
    hasPlugin: () => false,
    sceneOf: () => undefined,
    removePlugin() {},
  };
  const tiles = await TilesRenderer.load(engine, 'https://r.test/tileset.json', { fetch, frame: 'local' });
  const seen = [];
  const off = tiles.onUpdate(() => seen.push(tiles.last.selected.length));
  tiles.update();
  off();
  tiles.update();
  assert.equal(seen.length, 1, 'called once per update until unsubscribed');
  tiles.dispose();
});

/** A GLB with `gltf` as its JSON chunk and the BIN chunk of `glb`. */
function rebuildGLB(gltf, glb) {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength),
    jsonLength = view.getUint32(12, true),
    bin = glb.subarray(20 + jsonLength);
  let text = JSON.stringify(gltf);
  while (encoder.encode(text).length % 4) text += ' ';
  const chunk = encoder.encode(text),
    out = new Uint8Array(12 + 8 + chunk.length + bin.length),
    o = new DataView(out.buffer);
  o.setUint32(0, 0x46546c67, true);
  o.setUint32(4, 2, true);
  o.setUint32(8, out.length, true);
  o.setUint32(12, chunk.length, true);
  o.setUint32(16, 0x4e4f534a, true);
  out.set(chunk, 20);
  out.set(bin, 20 + chunk.length);
  return out;
}
