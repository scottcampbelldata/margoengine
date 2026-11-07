// KHR_xmp_json_ld against published files from four writers: glTF-Transform (XmpMetadataRoundedCube.glb), the Khronos
// metadata tool's own examples, the OMI group's exports (boom_box, rocket_ship) and Adobe Substance 3D Stager (ScatteringSkull). Expected
// values are read from the files by eye, so a wrong mapping fails. Documents edited in a test are stand-ins for cases
// no published file has, such as a broken reference or a Creative Commons licence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mockGPU } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { GLTFAsset, parseGLTFAsync } from '../dist/index.js';
import { readGLTFMetadata, xmpNamespaces } from '../dist/metadata.js';
import { prepareGLTF } from '../dist/prepare.js';
import { modelFromPrepared } from '../dist/worker.js';

const path = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const json = (name) => JSON.parse(readFileSync(path(name), 'utf8'));
const dc = xmpNamespaces.dc;
/** A document whose packet 0 sits on `asset`, for cases no published file has. */
const standIn = (packet, rest = {}) => ({
  asset: { version: '2.0', extensions: { KHR_xmp_json_ld: { packet: 0 } } },
  extensions: { KHR_xmp_json_ld: { packets: [{ '@context': { dc }, ...packet }] } },
  ...rest,
});

async function withEngine(run) {
  const gpu = mockGPU(),
    store = await TransformStore.create(64),
    renderer = { backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {} },
    engine = new Engine(
      { width: 64, height: 64, clientWidth: 64, clientHeight: 64 },
      store,
      renderer,
      { position: [0, 5, 10], target: [0, 0, 0] },
      null,
    );
  try {
    await run(engine);
  } finally {
    engine.dispose();
  }
}

test('a real GLB loaded as a model gives its author, rights and the mesh packet over the file packet', async () => {
  const bytes = readFileSync(path('metadata/XmpMetadataRoundedCube.glb'));
  await withEngine(async (engine) => {
    const model = await parseGLTFAsync(engine, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)),
      metadata = readGLTFMetadata(model);
    assert.equal(metadata.packets.length, 2);
    assert.deepEqual(metadata.asset.authors, ['CreatorName', 'CreatorEmail@email.com']);
    assert.deepEqual(metadata.asset.contributors, [
      'Creator1Name',
      'Creator2Email@email.com',
      'Creator3Name<Email@email.com>',
    ]);
    assert.deepEqual(metadata.asset.publishers, ['Khronos']);
    assert.equal(metadata.asset.title, 'Sample glTF with XMP metadata');
    assert.equal(metadata.asset.date, '2019-05-16T19:20:30+01:00');
    assert.equal(metadata.asset.copyright, '2017 (c) Adobe Corp');
    assert.equal(metadata.asset.tool, 'glTF-Transform v4.0.8');
    assert.deepEqual(
      metadata.objects.map((o) => [o.kind, o.index, o.name, o.packet]),
      [['mesh', 0, 'MODEL_ROUNDED_CUBE_PART_1', 1]],
    );
    const mesh = metadata.fieldsOf('mesh', 0);
    assert.equal(mesh.title, 'My Cube Mesh');
    // The mesh packet states only a title; the rest still comes from the whole file.
    assert.deepEqual(mesh.authors, ['CreatorName', 'CreatorEmail@email.com']);
    assert.equal(mesh.copyright, '2017 (c) Adobe Corp');
    assert.equal(metadata.packets[1].fields.authors.length, 0, 'a packet alone inherits nothing');
    assert.equal(metadata.packets[0].get(xmpNamespaces.xmp, 'ModifyDate'), '2024-10-04');
    assert.equal(metadata.packets[0].about, '');
    model.dispose();
  });
});

test('the parse-worker job keeps the packets across its structured clone', async () => {
  const bytes = readFileSync(path('metadata/XmpMetadataRoundedCube.glb')),
    prepared = await prepareGLTF(undefined, new Uint8Array(bytes), undefined, 1 << 24);
  await withEngine(async (engine) => {
    const model = modelFromPrepared(engine, structuredClone(prepared));
    assert.equal(readGLTFMetadata(model).fieldsOf('mesh', 0).title, 'My Cube Mesh');
    model.dispose();
  });
});

test('a real glTF with its buffer reads through GLTFAsset, with every Dublin Core type of the extension README', () => {
  const doc = json('metadata/Box.gltf'),
    asset = new GLTFAsset(doc, [readFileSync(path('metadata/Box0.bin'))]),
    { packets, asset: fields } = readGLTFMetadata(asset);
  assert.equal(fields.rights, 'BSD');
  assert.equal(fields.license, 'BSD');
  assert.equal(fields.copyright, 'BSD');
  assert.equal(fields.source, 'http://related_resource.org/derived_from_this.gltf');
  assert.equal(fields.tool, 'COLLADA2GLTF');
  assert.equal(fields.description, 'text');
  const title = packets[0].get(dc, 'title');
  assert.deepEqual(title.alternatives, [
    { text: 'MyModel', language: 'en-us' },
    { text: 'Mio Modello', language: 'it-it' },
  ]);
  assert.deepEqual(packets[0].get(dc, 'subject'), ['architecture']);
  assert.equal(packets[0].raw, doc.extensions.KHR_xmp_json_ld.packets[0]);
});

test('language alternatives: exact tag, same language, x-default, then the first listed', () => {
  const doc = json('metadata/language-alternatives.gltf');
  assert.equal(readGLTFMetadata(doc).asset.title, 'MyModel');
  assert.equal(readGLTFMetadata(doc, { language: 'it-it' }).asset.title, 'Mio Modello');
  assert.equal(readGLTFMetadata(doc, { language: 'IT' }).asset.title, 'Mio Modello');
  assert.equal(readGLTFMetadata(doc, { language: 'it-ch' }).asset.title, 'Mio Modello');
  assert.equal(readGLTFMetadata(doc, { language: 'fr' }).asset.title, 'MyModel');
  const alternatives = {
    '@type': 'rdf:Alt',
    'rdf:_10': { '@language': 'de', '@value': 'ten' },
    'rdf:_2': { '@language': 'x-default', '@value': 'two' },
    'rdf:_1': { '@language': 'fr', '@value': 'one' },
  };
  const edited = standIn({ 'dc:title': alternatives });
  edited.extensions.KHR_xmp_json_ld.packets[0]['@context'].rdf = xmpNamespaces.rdf;
  const { packets, asset } = readGLTFMetadata(edited);
  assert.equal(asset.title, 'two', 'x-default wins when no language is asked for');
  assert.deepEqual(
    packets[0].get(dc, 'title').alternatives.map((a) => a.text),
    ['one', 'two', 'ten'],
    'rdf:_N sorts by number, whatever the order of the JSON keys',
  );
});

test('text with a language attribute and a local context, as the Khronos edge-case file writes it', () => {
  const metadata = readGLTFMetadata(json('metadata/language-attribute.gltf')),
    [packet] = metadata.packets;
  assert.deepEqual(packet.get(dc, 'source'), { text: 'Sample files for edge cases', language: 'en-us' });
  assert.equal(metadata.asset.source, 'Sample files for edge cases');
  assert.deepEqual(packet.get(dc, 'subject'), [
    { text: 'Sample File', language: 'en-us' },
    { text: 'Beispieldatei', language: 'de-de' },
  ]);
});

test('the OMI exports write plain strings and a second packet for a sound, which still reads for attribution', () => {
  const boom = readGLTFMetadata(json('metadata/boom_box.gltf'));
  assert.deepEqual(boom.asset.authors, ['The Khronos Group']);
  assert.equal(boom.asset.rights, 'CC0 1.0 Universal');
  assert.equal(boom.asset.copyright, '2023 The Khronos Group', 'glTF asset.copyright is the copyright line');
  assert.equal(boom.asset.license, 'CC0 1.0 Universal');
  assert.equal(boom.asset.title, 'Boom Box with audio and physics');
  const music = boom.packets[1].fields;
  assert.deepEqual(music.authors, ['Kevin MacLeod']);
  assert.equal(music.license, 'CC BY 3.0: Attribution');
  assert.deepEqual(music.publishers, ['Incompetech']);
  const rocket = readGLTFMetadata(json('metadata/rocket_ship.gltf')).asset;
  assert.deepEqual(rocket.authors, ['Poly by Google', 'aaronfranke']);
  assert.equal(rocket.license, 'CC-BY 3.0 Attribution');
  assert.equal(rocket.source, 'https://poly.pizza/m/4mPkOKdzAk-');
});

test('Substance 3D Stager leaves xmp out of @context; its prefix keeps the usual meaning', () => {
  const { asset, packets } = readGLTFMetadata(json('scatter/ScatteringSkull.gltf'));
  assert.deepEqual(asset.authors, ['Vladimir Petkovic']);
  assert.equal(asset.title, 'Skattering Skull');
  assert.equal(asset.date, '2025-02-10T21:00:11.896Z');
  assert.equal(asset.tool, 'Adobe Substance 3D Stager');
  assert.equal(asset.copyright, '2025 (c) Adobe Inc., model by Vladimir Petkovic, CC0 1.0 Universal');
  assert.equal(packets[0].properties.find((p) => p.name === 'CreatorTool').namespace, xmpNamespaces.xmp);
});

test('properties resolve by namespace URI: another prefix reads, a redefined prefix does not', () => {
  const renamed = standIn({ '@context': { dc11: dc }, 'dc11:creator': { '@list': ['Ana'] } });
  assert.deepEqual(readGLTFMetadata(renamed).asset.authors, ['Ana']);
  const redefined = standIn({ '@context': { dc: 'https://example.com/other/' }, 'dc:creator': 'Not an author' });
  assert.deepEqual(readGLTFMetadata(redefined).asset.authors, []);
  assert.equal(readGLTFMetadata(redefined).packets[0].get('https://example.com/other/', 'creator'), 'Not an author');
});

test('licence order: cc:license, UsageTerms, WebStatement, then dc:rights', () => {
  const context = { dc, cc: xmpNamespaces.cc, xmpRights: xmpNamespaces.xmpRights };
  const license = (packet) => readGLTFMetadata(standIn({ '@context': context, ...packet })).asset.license;
  const all = {
    'dc:rights': 'rights',
    'xmpRights:WebStatement': 'web',
    'xmpRights:UsageTerms': 'terms',
    'cc:license': 'https://creativecommons.org/licenses/by/4.0/',
  };
  assert.equal(license(all), all['cc:license']);
  delete all['cc:license'];
  assert.equal(license(all), 'terms');
  delete all['xmpRights:UsageTerms'];
  assert.equal(license(all), 'web');
  delete all['xmpRights:WebStatement'];
  assert.equal(license(all), 'rights');
});

test('every object kind takes its packet, and its properties win over the whole file property by property', () => {
  const carrier = { extensions: { KHR_xmp_json_ld: { packet: 1 } } },
    doc = standIn(
      { 'dc:creator': 'File author', 'dc:rights': 'File rights', 'dc:title': 'File title' },
      {
        scenes: [{ ...carrier, name: 'S' }],
        nodes: [{}, { ...carrier, name: 'N' }],
        meshes: [{ ...carrier, primitives: [] }],
        materials: [carrier],
        images: [carrier],
        animations: [carrier],
      },
    );
  doc.extensions.KHR_xmp_json_ld.packets.push({ '@context': { dc }, 'dc:title': 'Part', 'dc:rights': 'Part rights' });
  const metadata = readGLTFMetadata(doc);
  assert.deepEqual(
    metadata.objects.map((o) => [o.kind, o.index, o.name]),
    [
      ['scene', 0, 'S'],
      ['node', 1, 'N'],
      ['mesh', 0, undefined],
      ['material', 0, undefined],
      ['image', 0, undefined],
      ['animation', 0, undefined],
    ],
  );
  for (const { kind, index } of metadata.objects) {
    const fields = metadata.fieldsOf(kind, index);
    assert.equal(fields.title, 'Part');
    assert.equal(fields.copyright, 'Part rights');
    assert.equal(fields.license, 'Part rights');
    assert.deepEqual(fields.authors, ['File author']);
  }
  assert.equal(metadata.fieldsOf('node', 0).title, 'File title', 'an object with no packet has the whole file');
  assert.throws(() => metadata.fieldsOf('node', 2), /No glTF node 2.*below 2/);
  assert.throws(() => metadata.fieldsOf('skin', 0), /Unknown glTF object kind skin/);
});

test('a file without the extension gives what glTF asset states and no packets', () => {
  const metadata = readGLTFMetadata({ asset: { version: '2.0', copyright: 'C', generator: 'G' }, nodes: [{}] });
  assert.deepEqual(metadata.packets, []);
  assert.deepEqual(metadata.objects, []);
  assert.equal(metadata.asset.copyright, 'C');
  assert.equal(metadata.asset.tool, 'G');
  assert.equal(metadata.asset.title, undefined);
  assert.equal(metadata.fieldsOf('node', 0).copyright, 'C');
});

test('a file requiring the extension loads: metadata never changes what is drawn', () => {
  const doc = standIn({ 'dc:creator': 'Ana' }, { extensionsRequired: ['KHR_xmp_json_ld'] });
  assert.deepEqual(readGLTFMetadata(new GLTFAsset(doc, [])).asset.authors, ['Ana']);
});

test('structures keep their properties, and null reads as no value as in JSON-LD', () => {
  const { packets } = readGLTFMetadata(
    standIn({
      '@context': { dc, stRef: 'http://ns.adobe.com/xap/1.0/sType/ResourceRef#', xmpMM: 'http://ns.adobe.com/xap/1.0/mm/' },
      'xmpMM:DerivedFrom': { 'stRef:documentID': 'id', 'stRef:partial': null, 'stRef:count': 3, 'stRef:ok': true },
      'dc:creator': { '@list': ['A', null, 'B'] },
      'dc:title': null,
      plain: ['x'],
    }),
  );
  assert.deepEqual(
    packets[0].get('http://ns.adobe.com/xap/1.0/mm/', 'DerivedFrom').properties.map((p) => [p.name, p.value]),
    [
      ['documentID', 'id'],
      ['count', 3],
      ['ok', true],
    ],
  );
  assert.deepEqual(packets[0].fields.authors, ['A', 'B']);
  assert.equal(packets[0].fields.title, undefined);
  assert.deepEqual(packets[0].properties.find((p) => p.name === 'plain').value, ['x']);
  assert.equal(packets[0].properties.find((p) => p.name === 'plain').namespace, undefined);
});

test('names from the file never reach the prototype chain', () => {
  const hostile = JSON.parse(`{
    "@context": {"dc": "${dc}", "__proto__": "https://example.com/p/"},
    "constructor:creator": "x",
    "toString:title": "y",
    "__proto__:rights": "z",
    "dc:creator": {"@type": "constructor:Alt"},
    "dc:title": {"@language": "__proto__", "@value": "t"}
  }`);
  const doc = standIn({});
  doc.extensions.KHR_xmp_json_ld.packets = [hostile];
  const { packets, asset } = readGLTFMetadata(doc);
  assert.equal(packets[0].properties.find((p) => p.prefix === 'constructor').namespace, undefined);
  assert.equal(packets[0].properties.find((p) => p.prefix === '__proto__').namespace, 'https://example.com/p/');
  assert.deepEqual(asset.authors, []);
  assert.equal(asset.title, 't');
  assert.equal({}.text, undefined);
});

test('invalid packets and references are refused with the fix, and nesting past 64 levels is refused', () => {
  const fix = /the file is not valid glTF 2\.0, re-export it/;
  const refused = (doc, what) =>
    assert.throws(
      () => readGLTFMetadata(doc),
      (e) => e instanceof TypeError && e.message.includes(what) && fix.test(e.message),
    );
  refused({ asset: { version: '2.0' }, extensions: { KHR_xmp_json_ld: {} } }, 'packets is not an array');
  refused({ asset: { version: '2.0' }, extensions: { KHR_xmp_json_ld: { packets: [7] } } }, 'packet 0');
  refused({ asset: { version: '2.0' }, extensions: { KHR_xmp_json_ld: { packets: [{}] } } }, 'no @context');
  refused(standIn({ '@context': { dc: 5 } }), '@context entry dc');
  for (const packet of [1, -1, 0.5, '0', null, undefined]) {
    const doc = standIn({});
    doc.asset.extensions.KHR_xmp_json_ld = { packet };
    refused(doc, 'reference on asset');
  }
  const doc = standIn({}, { nodes: [{ extensions: { KHR_xmp_json_ld: 3 } }] });
  refused(doc, 'reference on node 0');
  let deep = 'leaf';
  for (let i = 0; i < 65; i++) deep = { '@list': [deep] };
  refused(standIn({ 'dc:creator': deep }), 'deeper than 64');
  let fits = 'leaf';
  for (let i = 0; i < 30; i++) fits = { '@list': [fits] };
  assert.deepEqual(readGLTFMetadata(standIn({ 'dc:creator': fits })).asset.authors, ['leaf']);
});
