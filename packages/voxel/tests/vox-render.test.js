// readVoxRenderDictionaries: rOBJ/rCAM decoding from a parsed scene, bounded, with diagnostics, leaving bytes untouched.
// The reference below is Margo Voxel Studio's frozen reader (src/editor/render-look.ts readVoxRenderObjects) and its
// fixture (src/editor/render-look.test.ts); the engine must give the same dictionaries for every chunk it reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVox, readVoxRenderDictionaries, writeVox } from '../dist/vox.js';

function studioRead(source) {
  const result = { objects: [], cameras: [], unsupported: [] };
  for (const chunk of source.chunks ?? []) {
    if (chunk.id !== 'rOBJ' && chunk.id !== 'rCAM') continue;
    try {
      const bytes = chunk.content;
      if (!bytes || bytes.byteLength > 1_048_576) throw new RangeError('render dictionary is missing or too large');
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let offset = 0;
      const int = () => {
        if (offset + 4 > bytes.length) throw new RangeError('truncated render dictionary');
        const value = view.getInt32(offset, true);
        offset += 4;
        return value;
      };
      const text = () => {
        const length = int();
        if (length < 0 || length > bytes.length - offset)
          throw new RangeError('render dictionary string exceeds its chunk');
        const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset, offset + length));
        offset += length;
        return value;
      };
      const id = chunk.id === 'rCAM' ? int() : undefined,
        count = int();
      if (count < 0 || count > 4096 || count > (bytes.length - offset) / 8)
        throw new RangeError('invalid render dictionary count');
      const attributes = new Map();
      for (let i = 0; i < count; i++) attributes.set(text(), text());
      if (offset !== bytes.length) throw new RangeError('trailing render dictionary bytes');
      if (id === undefined) result.objects.push(attributes);
      else result.cameras.push({ id, attributes });
    } catch {
      result.unsupported.push(`A malformed ${chunk.id} render dictionary was retained but could not be applied.`);
    }
  }
  return result;
}
// The Studio fixture encoder (render-look.test.ts dictionary()).
function dictionary(attributes, id) {
  const encoded = Object.entries(attributes).map(([key, value]) => [
    new TextEncoder().encode(key),
    new TextEncoder().encode(value),
  ]);
  const length = (id === undefined ? 4 : 8) + encoded.reduce((n, [key, value]) => n + 8 + key.length + value.length, 0),
    bytes = new Uint8Array(length),
    view = new DataView(bytes.buffer);
  let offset = 0;
  if (id !== undefined) {
    view.setInt32(offset, id, true);
    offset += 4;
  }
  view.setInt32(offset, encoded.length, true);
  offset += 4;
  for (const pair of encoded)
    for (const text of pair) {
      view.setInt32(offset, text.length, true);
      offset += 4;
      bytes.set(text, offset);
      offset += text.length;
    }
  return bytes;
}
const studioScene = () => {
  const palette = new Uint8Array(1024);
  palette.set([128, 64, 32, 255], 4);
  return parseVox(
    writeVox({
      version: 200,
      models: [{ size: [1, 1, 1], voxels: new Uint8Array([0, 0, 0, 1]) }],
      palette,
      materials: [],
      nodes: [],
      layers: [],
      chunks: [
        { id: 'rOBJ', content: dictionary({ _type: '_inf', _i: '2' }) },
        { id: 'rOBJ', content: dictionary({ _type: '_lens', _fov: '35' }) },
        { id: 'rCAM', content: dictionary({ _focus: '0 0 0', _angle: '90 0 0', _radius: '10' }, 1) },
      ],
    }),
  );
};
const plain = (result) => ({
  objects: result.objects.map((map) => [...map]),
  cameras: result.cameras.map(({ id, attributes }) => [id, [...attributes]]),
});

test('the Studio fixture decodes the same, camera slot one is identified, and the bytes stay as they were', () => {
  const scene = studioScene(),
    before = structuredClone(scene),
    bytes = writeVox(scene),
    parsed = readVoxRenderDictionaries(scene);
  assert.equal(parsed.objects.length, 2);
  assert.equal(parsed.objects[0].get('_type'), '_inf');
  assert.equal(parsed.cameras[0].id, 1);
  assert.deepEqual(
    parsed.cameras[0].attributes,
    new Map([
      ['_focus', '0 0 0'],
      ['_angle', '90 0 0'],
      ['_radius', '10'],
    ]),
  );
  assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual(plain(parsed), plain(studioRead(scene)));
  assert.deepEqual(scene, before);
  assert.deepEqual(writeVox(scene), bytes);
  scene.chunks.push({ id: 'rOBJ', content: new Uint8Array([255, 255, 255, 127]) });
  const malformed = readVoxRenderDictionaries(scene);
  assert.equal(malformed.objects.length, 2);
  assert.deepEqual(
    malformed.diagnostics.map(({ kind, id, chunk }) => [kind, id, chunk]),
    [['malformed', 'rOBJ', scene.chunks.length - 1]],
  );
  assert.match(
    malformed.diagnostics[0].message,
    /^rOBJ chunk \d+ counts 2147483647 attributes, more than its bytes hold/,
  );
  assert.equal(studioRead(scene).unsupported.length, 1);
});

test('every truncation, trailing byte and corrupted length gives what the Studio reader gives, or a diagnostic', () => {
  const sources = [
    dictionary({ _type: '_setting', _ground: '1', _grid: '0', _edge: '1' }),
    dictionary({ _type: '_sun', _i: '0.7', _k: '1 0.9 0.8', _angle: '50 50', _area: '0.07', _disk: '0' }),
    dictionary({}),
    dictionary({ _mode: 'pers', _focus: '0 0 5', _angle: '30 45 0', _radius: '60', _frustum: '0.414', _fov: '45' }, 0),
    dictionary({ _mode: 'orth' }, -3),
  ];
  const ids = ['rOBJ', 'rOBJ', 'rOBJ', 'rCAM', 'rCAM'];
  let checked = 0;
  sources.forEach((source, s) => {
    const variants = [];
    for (let cut = 0; cut < source.length; cut++) variants.push(source.subarray(0, cut));
    variants.push(Uint8Array.from([...source, 0]));
    for (let at = 0; at + 4 <= source.length; at += 4)
      for (const value of [-1, 0x7fffffff, 1, 3]) {
        const copy = source.slice();
        new DataView(copy.buffer).setInt32(at, value, true);
        variants.push(copy);
      }
    for (const content of variants) {
      const scene = {
        version: 200,
        models: [],
        palette: new Uint8Array(1024),
        materials: [],
        nodes: [],
        layers: [],
        chunks: [{ id: ids[s], content }],
      };
      const engine = readVoxRenderDictionaries(scene),
        studio = studioRead(scene);
      // Skip the two documented differences: non-UTF-8 text (the engine decodes it as windows-1252, like parseVox)
      // and repeated keys (malformed in the engine). Neither occurs in files MagicaVoxel writes.
      const maps = engine.objects.concat(engine.cameras.map((camera) => camera.attributes)),
        texts = maps.flatMap((map) => [...map].flat());
      if (texts.some((text) => /[^\x00-\x7f]/.test(text))) continue;
      if (engine.diagnostics.some(({ message }) => message.includes(' twice '))) continue;
      assert.deepEqual(plain(engine), plain(studio), `${ids[s]} variant ${checked}`);
      assert.equal(engine.diagnostics.length, studio.unsupported.length, `${ids[s]} variant ${checked}`);
      checked++;
    }
  });
  assert.ok(checked > 300, `${checked} variants`);
});

test('limits, child chunks and missing content are reported, never thrown', () => {
  const big = dictionary({ _type: '_bloom', _mix: '0.5' });
  const scene = {
    version: 200,
    models: [],
    palette: new Uint8Array(1024),
    materials: [],
    nodes: [],
    layers: [],
    chunks: [
      { id: 'NOTE', content: new Uint8Array([1, 2, 3]) },
      { id: 'rOBJ', content: big },
      { id: 'rOBJ', content: big, children: new Uint8Array([1, 2, 3, 4]) },
      { id: 'rCAM' },
      { id: 'SIZE' },
    ],
  };
  const all = readVoxRenderDictionaries(scene);
  assert.equal(all.objects.length, 2, 'content next to child chunks is still read');
  assert.deepEqual(
    all.diagnostics.map(({ kind, chunk }) => [kind, chunk]),
    [
      ['unsupported', 2],
      ['malformed', 3],
    ],
  );
  const small = readVoxRenderDictionaries(scene, { maxBytes: big.length - 1 });
  assert.equal(small.objects.length, 0);
  assert.deepEqual(
    small.diagnostics.map(({ kind }) => kind),
    ['unsupported', 'unsupported', 'malformed'],
  );
  assert.match(small.diagnostics[0].message, /over maxBytes/);
  const few = readVoxRenderDictionaries(scene, { maxEntries: 1 });
  assert.equal(few.objects.length, 0);
  assert.match(few.diagnostics[0].message, /counts 2 attributes, over maxEntries 1/);
  assert.equal(readVoxRenderDictionaries(scene, { maxEntries: 2 }).objects.length, 2);
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => readVoxRenderDictionaries(scene, { maxBytes: bad }), RangeError);
    assert.throws(() => readVoxRenderDictionaries(scene, { maxEntries: bad }), RangeError);
  }
  assert.throws(() => readVoxRenderDictionaries(undefined), TypeError);
  assert.throws(() => readVoxRenderDictionaries({ chunks: 'rOBJ' }), TypeError);
  assert.deepEqual(readVoxRenderDictionaries({ version: 150, models: [] }), {
    objects: [],
    cameras: [],
    diagnostics: [],
  });
});

test('strings decode as parseVox decodes dictionaries; a repeated key is malformed', () => {
  // Documented differences from the Studio reader: windows-1252 text is decoded (Studio: malformed) and a repeated
  // key is malformed (Studio: the last value wins).
  const key = new TextEncoder().encode('_path'),
    value = Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x2e, 0x68, 0x64, 0x72]), // "café.hdr" in windows-1252
    content = new Uint8Array(4 + 8 + key.length + value.length),
    view = new DataView(content.buffer);
  view.setInt32(0, 1, true);
  view.setInt32(4, key.length, true);
  content.set(key, 8);
  view.setInt32(8 + key.length, value.length, true);
  content.set(value, 12 + key.length);
  const scene = { chunks: [{ id: 'rOBJ', content }] };
  assert.equal(readVoxRenderDictionaries(scene).objects[0].get('_path'), 'café.hdr');
  const twice = dictionary({ _type: '_env' }),
    doubled = new Uint8Array(twice.length + 4 + 5 + 4 + 4);
  doubled.set(twice);
  new DataView(doubled.buffer).setInt32(0, 2, true);
  doubled.set(dictionary({ _type: '_ibl' }).subarray(4), twice.length);
  const repeated = readVoxRenderDictionaries({
    chunks: [{ id: 'rOBJ', content: doubled.subarray(0, twice.length + 17) }],
  });
  assert.equal(repeated.objects.length, 0);
  assert.match(repeated.diagnostics[0].message, /attribute "_type" twice/);
});
