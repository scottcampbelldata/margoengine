// OpenEXR `colorInteropID`. Known bug it guards (docs/known-bugs.md, KB-EXR-INTEROPID1): no reader looked at the
// attribute, so linear ACEScg data named `lin_ap1_scene` without `chromaticities` decoded as Rec.709: a pixel (1, 0, 0)
// stayed (1, 0, 0) instead of about (1.705, -0.130, -0.024) in linear sRGB.
// Reader order: ASWF Color Interop Forum, "OpenEXR Files", "Reading OpenEXR Files"
// (https://github.com/AcademySoftwareFoundation/ColorInterop/blob/main/Recommendations/04_OpenEXRFiles/OpenEXRFiles.md).
// The expected numbers are the published matrices to linear Rec.709, not the decoder's own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEXR } from '../dist/index.js';
import { encodeEXR } from '../dist/exr-write.js';
import { parseTiledEXR } from '../dist/exr-tiled.js';
import { decodeEXR } from '../dist/exr-codecs.js';

const AP1 = [0.713, 0.293, 0.165, 0.83, 0.128, 0.044, 0.32168, 0.33767];
const AP1_RED = [1.70505, -0.13026, -0.024];

const close = (actual, wanted, label, tolerance = 5e-4) =>
  wanted.forEach((v, i) =>
    assert.ok(Math.abs(actual[i] - v) < tolerance, `${label} [${i}]: ${actual[i]} instead of ${v}`),
  );
const pixel = (rgb, attributes = {}) =>
  encodeEXR({
    width: 1,
    height: 1,
    channels: ['R', 'G', 'B'].map((name, i) => ({ name, type: 'FLOAT', data: new Float32Array([rgb[i]]) })),
    ...attributes,
  });

// Fixture writer (OpenEXR File Layout): 1x1 FLOAT B, G, R parts with NONE compression.
const ints = (...v) => [...new Uint8Array(Int32Array.of(...v).buffer)];
const floats = (...v) => [...new Uint8Array(Float32Array.of(...v).buffer)];
const chars = (s) => [...Buffer.from(s, 'latin1')];
const attribute = (name, type, bytes) => [...chars(name), 0, ...chars(type), 0, ...ints(bytes.length), ...bytes];
const id = (value) => attribute('colorInteropID', 'string', chars(value));
const chromaticities = (values) => attribute('chromaticities', 'chromaticities', floats(...values));
const acesFlag = (value) => attribute('acesImageContainerFlag', 'int', ints(value));

function header(extra) {
  const channels = ['B', 'G', 'R'].flatMap((name) => [...chars(name), 0, ...ints(2, 0, 1, 1)]);
  return [
    ...attribute('channels', 'chlist', [...channels, 0]),
    ...extra,
    ...attribute('compression', 'compression', [0]),
    ...attribute('dataWindow', 'box2i', ints(0, 0, 0, 0)),
    ...attribute('displayWindow', 'box2i', ints(0, 0, 0, 0)),
    ...attribute('lineOrder', 'lineOrder', [0]),
    ...attribute('pixelAspectRatio', 'float', floats(1)),
    ...attribute('screenWindowCenter', 'v2f', floats(0, 0)),
    ...attribute('screenWindowWidth', 'float', floats(1)),
  ];
}
const offsets = (...v) => [...new Uint8Array(BigUint64Array.from(v.map(BigInt)).buffer)];
const line = (rgb) => [...ints(0, 12), ...floats(rgb[2], rgb[1], rgb[0])];

function tiled(rgb, extra) {
  const head = [
    ...ints(20000630, 2 | 0x200),
    ...header([...extra, ...attribute('tiles', 'tiledesc', [...ints(1, 1), 0])]),
    0,
  ];
  return Uint8Array.from([...head, ...offsets(head.length + 8), ...ints(0, 0, 0, 0, 12), ...line(rgb).slice(8)]);
}

function multipart(rgb, parts) {
  const head = [
    ...ints(20000630, 2 | 0x1000),
    ...parts.flatMap((extra, i) => [
      ...header([
        ...extra,
        ...attribute('name', 'string', chars(`part${i}`)),
        ...attribute('type', 'string', chars('scanlineimage')),
        ...attribute('chunkCount', 'int', ints(1)),
      ]),
      0,
    ]),
    0,
  ];
  const first = head.length + parts.length * 8,
    size = 4 + line(rgb).length;
  return Uint8Array.from([
    ...head,
    ...parts.flatMap((_, i) => offsets(first + i * size)),
    ...parts.flatMap((_, i) => [...ints(i), ...line(rgb)]),
  ]);
}

test('lin_ap1_scene without chromaticities converts in all three readers', async () => {
  const file = await pixel([1, 0, 0], { colorInteropID: 'lin_ap1_scene' });
  for (const [label, image] of [
    ['parseEXR', parseEXR(file)],
    ['parseTiledEXR', parseTiledEXR(tiled([1, 0, 0], id('lin_ap1_scene')))],
    ['decodeEXR', await decodeEXR(file)],
  ]) {
    assert.equal(image.colorInteropID, 'lin_ap1_scene', label);
    assert.equal(image.primaries, null, label);
    assert.equal(image.primariesConverted, true, label);
    close(image.data, AP1_RED, label);
    assert.equal(image.data[3], 1);
  }
});

test('every listed ID converts from its own primaries and transfer function', async () => {
  const cases = [
    ['lin_ap0_scene', [1, 0, 0], [2.52169, -0.27648, -0.01538]],
    ['lin_p3d65_scene', [1, 0, 0], [1.22494, -0.04206, -0.01964]],
    ['lin_rec2020_scene', [1, 0, 0], [1.66049, -0.12455, -0.01815]],
    ['lin_adobergb_scene', [1, 0, 0], [1.39836, 0, 0]],
    // The D65 white in XYZ is Rec.709 white.
    ['lin_ciexyzd65_scene', [0.95046, 1, 1.08906], [1, 1, 1]],
    // Transfer functions: 0.5 decodes by each curve; negative values follow the slope (sRGB) or pass through (power).
    ['srgb_rec709_scene', [0.5, 0.02, -0.5], [0.21404, 0.001548, -0.03869]],
    ['g24_rec709_scene', [0.5, 2, -0.5], [0.18946, 5.27803, -0.5]],
    ['g22_rec709_scene', [0.5, 1, -0.5], [0.21764, 1, -0.5]],
    ['g18_rec709_scene', [0.5, 1, 0], [0.28717, 1, 0]],
    ['srgb_ap1_scene', [1, 0, 0], AP1_RED],
    ['g22_ap1_scene', [0.5, 0, 0], AP1_RED.map((v) => v * 0.217638)],
    ['srgb_p3d65_scene', [1, 0, 0], [1.22494, -0.04206, -0.01964]],
    ['g22_adobergb_scene', [0.5, 0, 0], [1.39836 * 0.5 ** (563 / 256), 0, 0]],
  ];
  for (const [name, rgb, wanted] of cases) {
    const image = parseEXR(await pixel(rgb, { colorInteropID: name }));
    assert.equal(image.primariesConverted, true, name);
    close(image.data, wanted, name);
  }
});

test('a known ID wins over chromaticities; data is never converted', async () => {
  const rec = parseEXR(await pixel([1, 0, 0], { colorInteropID: 'lin_rec709_scene', chromaticities: AP1 }));
  assert.equal(rec.primariesConverted, false);
  assert.deepEqual(Array.from(rec.data), [1, 0, 0, 1]);
  const ap1 = parseEXR(
    await pixel([1, 0, 0], {
      colorInteropID: 'lin_ap1_scene',
      chromaticities: [0.64, 0.33, 0.3, 0.6, 0.15, 0.06, 0.3127, 0.329],
    }),
  );
  close(ap1.data, AP1_RED, 'ID over Rec.709 chromaticities');
  const data = parseEXR(await pixel([1, 0, 0], { colorInteropID: 'data', chromaticities: AP1 }));
  assert.equal(data.primariesConverted, false);
  assert.deepEqual(Array.from(data.data), [1, 0, 0, 1]);
});

test('unknown, unrecognised and absent IDs fall back to chromaticities', async () => {
  for (const name of ['unknown', 'LIN_AP1_SCENE', 'my-config:local:lin_ap0_scene', 'constructor']) {
    const alone = parseEXR(await pixel([1, 0, 0], { colorInteropID: name }));
    assert.equal(alone.colorInteropID, name);
    assert.equal(alone.primariesConverted, false, name);
    assert.deepEqual(Array.from(alone.data), [1, 0, 0, 1], name);
    close(parseEXR(await pixel([1, 0, 0], { colorInteropID: name, chromaticities: AP1 })).data, AP1_RED, name);
  }
  // One namespace is dropped to find the ID ("Color Interop ID", resolution order).
  close(parseEXR(await pixel([1, 0, 0], { colorInteropID: 'my-studio:lin_ap1_scene' })).data, AP1_RED, 'namespace');
});

test('acesImageContainerFlag 1 names ACES2065-1 ahead of the ID and chromaticities', () => {
  const extra = [...acesFlag(1), ...id('lin_rec709_scene'), ...chromaticities(AP1)];
  close(parseTiledEXR(tiled([1, 0, 0], extra)).data, [2.52169, -0.27648, -0.01538], 'flag 1');
  const off = parseTiledEXR(tiled([1, 0, 0], [...acesFlag(0), ...id('lin_ap1_scene')]));
  close(off.data, AP1_RED, 'flag 0');
});

test("a multi-part file's first ID covers the parts that name none, and its data covers the whole file", async () => {
  const inherited = multipart([1, 0, 0], [id('lin_ap1_scene'), []]);
  for (const part of [0, 1]) {
    const image = await decodeEXR(inherited, { part });
    assert.equal(image.colorInteropID, 'lin_ap1_scene', `part ${part}`);
    close(image.data, AP1_RED, `part ${part}`);
  }
  const mask = multipart([1, 0, 0], [id('lin_ap1_scene'), id('data')]);
  assert.deepEqual(Array.from((await decodeEXR(mask, { part: 1 })).data), [1, 0, 0, 1]);
  const allData = multipart([1, 0, 0], [id('data'), id('lin_ap1_scene')]);
  const image = await decodeEXR(allData, { part: 1 });
  assert.equal(image.colorInteropID, 'data');
  assert.deepEqual(Array.from(image.data), [1, 0, 0, 1]);
});
