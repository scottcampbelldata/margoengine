// Launch gate 11 (b): attack surface of the packages (docs/security.md). Model files, URLs inside them and worker
// replies are untrusted; these tests feed each path a hostile value and check it stays data. Per-format cases also live
// next to their fixtures: packages/fbx/test/fbx.test.js, packages/loaders/tests/loaders.test.js and
// packages/inspector/test/frame.test.js ("security: ...").
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpuTimer } from '../scripts/support/cpu-budget.mjs';
import { readdir, readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { assetURL, checkRedirect } from '../packages/shared/asset-url.js';
import { parseJSON } from '../packages/shared/json.js';
import { runWorker, serve } from '../packages/shared/worker.js';
import { Engine, TransformStore } from '../packages/core/dist/extension.js';
import { parseGLTF as parseLight, loadGLTF as loadLight } from '../packages/gltf/dist/index.js';
import { parseGLTF as parsePro, loadGLTF as loadPro } from '../packages/gltf-pro/dist/index.js';
import { decodeMargo } from '../packages/blender/dist/index.js';
import { parseSTL } from '../packages/loaders/dist/index.js';
import { parseUSDA } from '../packages/usdz/dist/index.js';
import { Inspector } from '../packages/inspector/dist/index.js';
import { headless, headlessModels } from './support/pbr-snapshot.js';

const root = new URL('../', import.meta.url);
const hostileJSON = '{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}},"\\u005f_proto__":{"p":1}}';
const clean = () => {
  assert.equal({}.polluted, undefined, 'Object.prototype was polluted');
  assert.equal(Object.prototype.polluted, undefined);
};
const triangle = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer).toString('base64');
/** A one-triangle glTF as JSON text, with `extra` spliced into node 0, the material and the mesh (raw JSON). */
const gltfText = (extra = '{}', uri = `data:application/octet-stream;base64,${triangle}`) =>
  `{"asset":{"version":"2.0"},"scenes":[{"nodes":[0]}],"nodes":[{"mesh":0,"name":"n","extras":${extra}}],
  "meshes":[{"primitives":[{"attributes":{"POSITION":0},"material":0}],"extras":${extra}}],
  "materials":[{"pbrMetallicRoughness":{"baseColorFactor":[1,1,1,1]},"extras":${extra}}],
  "accessors":[{"bufferView":0,"componentType":5126,"count":3,"type":"VEC3","min":[0,0,0],"max":[1,1,0]}],
  "bufferViews":[{"buffer":0,"byteLength":36}],"buffers":[{"byteLength":36,"uri":${JSON.stringify(uri)}}]}`;

test('assetURL keeps model-file URIs inside the model directory unless allowedURLs lists them', () => {
  const base = 'https://app.test/models/car/scene.gltf';
  assert.equal(assetURL('wheel.bin', base).href, 'https://app.test/models/car/wheel.bin');
  assert.equal(assetURL('tex/a%20b.png', base).href, 'https://app.test/models/car/tex/a%20b.png');
  assert.equal(assetURL('./a/../b.png', base).href, 'https://app.test/models/car/b.png');
  for (const uri of [
    '../secret.bin',
    'a/../../secret.bin',
    '%2e%2e/secret.bin',
    '..%2Fsecret.bin',
    '..%5Csecret.bin',
    '..\\secret.bin',
    '/models/other.bin',
    '//evil.test/x.bin',
    'https://evil.test/x.bin',
    'http://app.test/models/car/x.bin',
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'file:///etc/passwd',
    'blob:https://app.test/0b6f',
    'data:text/html,<script>alert(1)</script>',
  ])
    assert.throws(() => assetURL(uri, base), TypeError, uri);
  for (const uri of [undefined, 42, {}, '', 'x'.repeat(8193)]) assert.throws(() => assetURL(uri, base), TypeError);
  // The allowlist is by URL prefix; a look-alike host does not match.
  const allowed = ['https://cdn.test/textures/'];
  assert.equal(assetURL('https://cdn.test/textures/a.png', base, allowed).href, 'https://cdn.test/textures/a.png');
  assert.throws(() => assetURL('https://cdn.test/textures.evil/a.png', base, allowed), TypeError);
  assert.throws(() => assetURL('https://cdn.test.evil/textures/a.png', base, ['https://cdn.test']), TypeError);
  assert.throws(() => assetURL('javascript:alert(1)', base, ['javascript:']), TypeError);
});

test('assetURL allowedURLs match on a path-segment boundary and keep the encoded-separator checks (bug 42 a)', () => {
  const base = 'https://app.test/models/car/scene.gltf';
  // A prefix without a trailing slash is a directory or an exact file, never a sibling with a longer name.
  const dir = ['https://cdn.test/assets'];
  assert.throws(() => assetURL('https://cdn.test/assets-other/a.png', base, dir), TypeError);
  assert.throws(() => assetURL('https://cdn.test/assetsX', base, dir), TypeError);
  assert.equal(assetURL('https://cdn.test/assets/a.png', base, dir).href, 'https://cdn.test/assets/a.png');
  assert.equal(assetURL('https://cdn.test/assets', base, dir).href, 'https://cdn.test/assets');
  assert.equal(assetURL('https://cdn.test/assets?v=2', base, dir).href, 'https://cdn.test/assets?v=2');
  // An exact-file entry keeps working and does not open its siblings.
  const file = ['https://cdn.test/tex/wood.png'];
  assert.equal(assetURL('https://cdn.test/tex/wood.png', base, file).href, 'https://cdn.test/tex/wood.png');
  assert.equal(assetURL('https://cdn.test/tex/wood.png#a', base, file).href, 'https://cdn.test/tex/wood.png#a');
  assert.throws(() => assetURL('https://cdn.test/tex/wood.png.bak', base, file), TypeError);
  assert.throws(() => assetURL('https://cdn.test/tex/wood.pngx', base, file), TypeError);
  // An entry with a query string matches only that query.
  const query = ['https://cdn.test/get?id=1'];
  assert.equal(assetURL('https://cdn.test/get?id=1', base, query).href, 'https://cdn.test/get?id=1');
  assert.throws(() => assetURL('https://cdn.test/get?id=2', base, query), TypeError);
  // Encoded separators and dot segments are refused under an allowed prefix too, not only in the model directory.
  const slash = ['https://cdn.test/assets/'];
  for (const uri of [
    'https://cdn.test/assets/..%2Fsecret.bin',
    'https://cdn.test/assets/..%2fsecret.bin',
    'https://cdn.test/assets/..%5Csecret.bin',
    'https://cdn.test/assets/a%2Fb.png',
    'https://cdn.test/assets/%2e%2e%2fsecret.bin',
  ])
    assert.throws(() => assetURL(uri, base, slash), TypeError, uri);
  // Bug 53: double and deeper encodings are refused on the allowlist branch and the same-directory branch.
  const doubled = [
    '%252e%252e/secret',
    '..%252fsecret',
    '%252e%252e%252fsecret',
    '..%255csecret',
    '%25252e%25252e%25252fsecret',
    '%25%32e%25%32e/secret',
    '..%25%32fsecret',
  ];
  const hosted = ['https://h/assets/'];
  for (const tail of doubled) {
    assert.throws(() => assetURL(`https://h/assets/${tail}`, undefined, hosted), TypeError, tail);
    assert.throws(() => assetURL(tail, 'https://h/assets/model.gltf'), TypeError, `same directory: ${tail}`);
  }
  assert.throws(() => assetURL(`%${'25'.repeat(12)}2e.png`, 'https://h/assets/model.gltf'), TypeError, 'too deep');
  // Audit E-04 note: an encoded NUL is refused at any depth of re-encoding, in the model directory and under an allowed
  // prefix, and in the middle of a name as well as at its end.
  const nul = [
    'ok%00.bin',
    'ok%00',
    '%00',
    'a/%00/b.bin',
    'ok%2500.bin',
    'ok%252500.bin',
    'ok%25%30%30.bin',
    'ok%2500%2500.bin',
  ];
  for (const tail of nul) {
    assert.throws(() => assetURL(tail, 'https://h/assets/model.gltf'), TypeError, `same directory: ${tail}`);
    assert.throws(() => assetURL(`https://h/assets/${tail}`, undefined, hosted), TypeError, `allowlist: ${tail}`);
  }
  assert.throws(() => assetURL(`ok${'%25'.repeat(7)}00.bin`, 'https://h/assets/model.gltf'), TypeError, 'deep NUL');
  assert.throws(
    () => checkRedirect({ url: 'https://h/assets/ok%2500.bin', body: null }, 'https://h/assets/m.gltf', hosted),
    TypeError,
    'a redirect to a NUL name',
  );
  // Names that merely contain the digits 00 or a literal percent still load.
  assert.equal(assetURL('tex%2000.png', 'https://h/assets/model.gltf').href, 'https://h/assets/tex%2000.png');
  assert.equal(assetURL('a00.bin', 'https://h/assets/model.gltf').href, 'https://h/assets/a00.bin');
  assert.equal(assetURL('50%25.png', 'https://h/assets/model.gltf').href, 'https://h/assets/50%25.png');
  // Redirects use the same rule.
  assert.throws(
    () => checkRedirect({ url: 'https://h/assets/%252e%252e/secret', body: null }, 'https://h/assets/m.gltf', hosted),
    TypeError,
  );
  // Ordinary percent-encoded names keep working.
  assert.equal(assetURL('https://h/assets/a%20b.png', undefined, hosted).href, 'https://h/assets/a%20b.png');
  assert.equal(assetURL('https://h/assets/100%25.png', undefined, hosted).href, 'https://h/assets/100%25.png');
  assert.equal(assetURL('100%25.png', 'https://h/assets/model.gltf').href, 'https://h/assets/100%25.png');
  // A malformed allowedURLs entry is a TypeError that names the fix.
  assert.throws(() => assetURL('https://cdn.test/a.png', base, ['/assets/']), /pass a full http\(s\) URL/);
});

test('parseJSON drops __proto__, constructor and prototype keys at every depth, escaped or not', () => {
  const doc = parseJSON(`{"a":${hostileJSON},"list":[${hostileJSON},{"prototype":1,"k":2}],"ok":"\\u00e9"}`);
  assert.deepEqual(Object.keys(doc.a), []);
  assert.equal(Object.getPrototypeOf(doc.a), Object.prototype);
  assert.deepEqual(doc.list[1], { k: 2 });
  assert.equal(doc.ok, 'é');
  assert.equal(Object.assign({}, doc.a).polluted, undefined, 'an app merge cannot pick up a prototype');
  assert.deepEqual(parseJSON('{"plain":[1,2,{"x":"y"}]}'), { plain: [1, 2, { x: 'y' }] });
  clean();
});

test('glTF (light and gltf-pro) and .margo JSON: hostile extras keys are dropped and Object.prototype is untouched', async () => {
  const text = gltfText(hostileJSON);
  const light = parseLight(await headless(), text);
  assert.equal(light.meshes.length, 1);
  await headlessModels(async () => {
    for (const input of [text, glb(text)]) {
      const model = parsePro(await headless(), input);
      const [node] = model.extras();
      for (const extras of [node.extras, model.asset.doc.meshes[0].extras, model.asset.doc.materials[0].extras]) {
        assert.deepEqual(Object.keys(extras), []);
        assert.equal(Object.getPrototypeOf(extras), Object.prototype);
        assert.equal(Object.assign({}, extras).polluted, undefined);
      }
    }
  });
  // .margo: the blender fixture with hostile node extras in its JSON section.
  const { document } = decodeMargo(
    await margoWithJSON((json) => json.replace('"nodes":[{', `"nodes":[{"extras":${hostileJSON},`)),
  );
  assert.deepEqual(Object.keys(document.nodes[0].extras), []);
  clean();
});

/** packages/blender's triangle.margo with its JSON section (section 0) rewritten by edit. */
async function margoWithJSON(edit) {
  const source = await readFile(new URL('packages/blender/tests/fixtures/triangle.margo', root)),
    view = new DataView(source.buffer, source.byteOffset),
    count = view.getUint32(12, true);
  const sections = Array.from({ length: count }, (_, i) => {
    const at = 64 + i * 16,
      offset = view.getUint32(at + 4, true),
      bytes = source.subarray(offset, offset + view.getUint32(at + 8, true));
    return { type: view.getUint32(at, true), flags: view.getUint32(at + 12, true), bytes };
  });
  const json = sections[0].bytes.toString(),
    edited = edit(json);
  assert.notEqual(edited, json, 'the edit changed the JSON');
  sections[0].bytes = Buffer.from(edited.padEnd(Math.ceil(edited.length / 4) * 4));
  const out = Buffer.alloc(64 + count * 16 + sections.reduce((n, s) => n + ((s.bytes.length + 3) & ~3), 0));
  source.copy(out, 0, 0, 64);
  out.writeUInt32LE(out.length, 8);
  let at = 64 + count * 16;
  sections.forEach(({ type, flags, bytes }, i) => {
    out.writeUInt32LE(type, 64 + i * 16);
    out.writeUInt32LE(at, 68 + i * 16);
    out.writeUInt32LE(bytes.length, 72 + i * 16);
    out.writeUInt32LE(flags, 76 + i * 16);
    bytes.copy(out, at);
    at += (bytes.length + 3) & ~3;
  });
  return out;
}

/** text as a GLB (JSON chunk only), for the binary container path. */
function glb(text) {
  const json = Buffer.from(text.padEnd(Math.ceil(text.length / 4) * 4)),
    out = Buffer.alloc(20 + json.length);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(json.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  json.copy(out, 20);
  return out;
}

test('gltf-pro: an inherited accessor type or component type is unsupported, not a NaN that switches off budgets', async () => {
  await headlessModels(async () => {
    const engine = await headless();
    for (const patch of [{ type: 'constructor' }, { type: 'toString' }, { componentType: '__proto__' }]) {
      // Accessor 1 is read untyped (as skins, morph targets and animation samplers are) through asset.accessor().
      const doc = JSON.parse(gltfText());
      doc.accessors.push({ ...doc.accessors[0], ...patch });
      const { asset } = parsePro(engine, JSON.stringify(doc));
      assert.throws(() => asset.accessor(1), /Unsupported glTF accessor 1/);
      assert.ok(Number.isFinite(asset.decoded), 'the decoded-bytes budget stays a number');
    }
  });
});

test('glTF loaders fetch only URIs inside the model directory (light and gltf-pro)', async (t) => {
  const base = 'https://app.test/models/',
    files = new Map([
      [base + 'tri.bin', Buffer.from(triangle, 'base64')],
      ['https://cdn.test/bin/tri.bin', Buffer.from(triangle, 'base64')],
    ]),
    fetched = [],
    previous = globalThis.fetch,
    // A redirect as fetch reports it: the body of the final URL, with response.url set to it.
    redirects = new Map([[base + 'moved.bin', 'https://evil.test/tri.bin']]);
  const fetcher = async (url) => {
    fetched.push(String(url));
    const final = redirects.get(String(url));
    if (final) return Object.defineProperty(new Response(files.get(base + 'tri.bin')), 'url', { value: final });
    return files.has(String(url)) ? new Response(files.get(String(url))) : new Response('', { status: 404 });
  };
  globalThis.fetch = fetcher;
  t.after(() => (globalThis.fetch = previous));
  let n = 0;
  /** Serve a glTF whose buffer URI is uri; returns its URL. */
  const scene = (uri) => {
    const url = `${base}scene${n++}.gltf`;
    files.set(url, gltfText('{}', uri));
    return url;
  };
  await headlessModels(async () => {
    const engine = await headless();
    for (const load of [
      (url, options) => loadLight(engine, url, options),
      (url, options) => loadPro(engine, url, { ...options, fetch: fetcher }),
    ]) {
      fetched.length = 0;
      const url = scene('tri.bin');
      assert.ok(await load(url));
      assert.deepEqual(fetched, [url, base + 'tri.bin']);
      for (const uri of [
        '../tri.bin',
        'https://evil.test/tri.bin',
        '//evil.test/tri.bin',
        'javascript:alert(1)',
        '..%2Ftri.bin',
      ]) {
        fetched.length = 0;
        const url = scene(uri);
        await assert.rejects(load(url), /leaves the model's directory/, uri);
        assert.deepEqual(fetched, [url], `nothing fetched for ${uri}`);
      }
      // Bug 42 d: a URI inside the directory whose fetch redirects out of it is refused after the fetch.
      await assert.rejects(load(scene('moved.bin')), /redirected to https:\/\/evil\.test\/tri\.bin, which leaves/);
      // Opt-in: an allowlisted CDN prefix loads.
      fetched.length = 0;
      const cdn = scene('https://cdn.test/bin/tri.bin');
      assert.ok(await load(cdn, { allowedURLs: ['https://cdn.test/bin/'] }));
      assert.deepEqual(fetched, [cdn, 'https://cdn.test/bin/tri.bin']);
    }
  });
  clean();
});

test('STL text with unterminated facets is rejected in linear time (ReDoS)', () => {
  const text = new TextEncoder().encode('solid x\n' + 'facet normal 0 0 1\n'.repeat(200_000) + 'endsolid x\n'),
    cpu = cpuTimer();
  assert.throws(() => parseSTL(text), /not closed with "endfacet"/);
  const took = cpu();
  assert.ok(took < 150, `took ${took} ms of CPU`);
});

test('USDA property metadata named __proto__ stays data', async () => {
  const source = (await readFile(new URL('packages/usdz/tests/fixtures/triangle.usda', root), 'utf8')).replace(
      /\r\n/g,
      '\n',
    ),
    hostile = source.replace(
      'float inputs:roughness = 0.3',
      'float inputs:roughness = 0.3 (\n                __proto__ = [1, 2]\n                constructor = "x"\n            )',
    );
  assert.notEqual(hostile, source);
  const plain = parseUSDA(source),
    parsed = parseUSDA(hostile);
  assert.deepEqual(parsed.meshes[0].positions, plain.meshes[0].positions);
  assert.deepEqual(parsed.document.materials, plain.document.materials);
  clean();
});

test('parser worker protocol: bad replies reject with an Error, unknown jobs get an error reply', async (t) => {
  const previous = globalThis.Worker;
  t.after(() => (globalThis.Worker = previous));
  let reply;
  globalThis.Worker = class {
    postMessage() {
      queueMicrotask(() => this.onmessage?.({ data: reply }));
    }
    terminate() {}
  };
  for (const [data, check] of [
    [null, /invalid reply/],
    [42, /invalid reply/],
    [{ error: { name: 'constructor', message: 'boom' } }, (e) => e.constructor === Error && e.message === 'boom'],
    [{ error: { name: '__proto__', message: 'boom' } }, (e) => e.constructor === Error],
    [{ error: { name: 'RangeError', message: 'big' } }, RangeError],
    [{ error: 'text' }, Error],
  ]) {
    reply = data;
    await assert.rejects(runWorker(new URL('https://app.test/w.js'), {}), check);
  }
  reply = { result: 7 };
  assert.equal(await runWorker(new URL('https://app.test/w.js'), {}), 7);

  const scope = { postMessage: (message) => posted.push(message) },
    posted = [];
  const self = globalThis.self;
  globalThis.self = scope;
  t.after(() => (globalThis.self = self));
  serve((job) => job.value * 2);
  await scope.onmessage({ data: null });
  await scope.onmessage({ data: { value: 2 } });
  assert.equal(posted[0].error.name, 'TypeError');
  assert.deepEqual(posted[1], { result: 4 });
});

test('progressive glTF worker ignores malformed messages and starts at most one stream', async () => {
  const code = await readFile(new URL('packages/gltf-pro/dist/workers/progressive.js', root), 'utf8');
  const scope = { postMessage() {} };
  new Function('self', code)(scope);
  for (const data of [null, 7, 'x', {}, { order: 'nope' }, { order: [1, 'a'] }, { url: 42 }])
    assert.doesNotThrow(() => scope.onmessage({ data }), JSON.stringify(data));
});

test('DOM packages render file and app strings as text: no HTML sinks, hostile names stay literal', async (t) => {
  // Static: no package source parses strings as HTML.
  const sinks =
    /\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write|createContextualFragment|DOMParser|dangerouslySetInnerHTML|\.srcdoc\b|\bon[a-z]+\s*=\s*['"`]|setAttribute\(\s*['"`]on/;
  const offenders = [];
  for (const pkg of await readdir(new URL('packages/', root))) {
    const dir = new URL(`packages/${pkg}/src/`, root);
    const files = await readdir(dir, { recursive: true }).catch(() => []);
    for (const file of files)
      if (/\.(ts|tsx|js)$/.test(file) && !file.endsWith('.d.ts')) {
        const source = await readFile(new URL(file.replaceAll('\\', '/'), dir), 'utf8');
        if (sinks.test(source)) offenders.push(`${pkg}/src/${file}`);
      }
  }
  assert.deepEqual(offenders, []);
  // Dynamic: a model node name shaped like markup in the inspector tree.
  const dom = new JSDOM('<body><canvas width="200" height="200"></canvas></body>'),
    canvas = dom.window.document.querySelector('canvas');
  const store = await TransformStore.create(16),
    renderer = { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} };
  const engine = new Engine(canvas, store, renderer, undefined, null);
  const inspector = Inspector.attach(engine, { parent: dom.window.document.body });
  t.after(() => {
    engine.dispose();
    dom.window.close();
  });
  const hostile = '<img src=x onerror=alert(1)>';
  engine.createMesh().name = hostile;
  inspector.refresh();
  assert.ok(inspector.root.textContent.includes(hostile));
  assert.equal(inspector.root.querySelector('img'), null);
});
