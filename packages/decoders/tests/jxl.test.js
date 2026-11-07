// JPEG XL (@margoengine/decoders/jxl): the header reader against libjxl's jxlinfo, and decodes of real conformance files against
// the reference images of the libjxl conformance suite. The worker path runs in tests/decoders-browser.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import init, { JxlImage } from '../dist/jxl/jxl_oxide_wasm.js';
import { JXLDecoder, jxlTextureFile, readJXLHeader } from '../dist/jxl.js';
import { renderJXL } from '../dist/jxl-render.js';
import { decodePNG } from '../dist/png.js';
import { profileToSRGB, readICCProfile } from '../dist/icc.js';

const fixtures = new URL('./fixtures/jxl/', import.meta.url),
  file = (name) => new Uint8Array(readFileSync(new URL(name, fixtures))),
  records = JSON.parse(readFileSync(new URL('records.json', fixtures), 'utf8')),
  glue = { JxlImage };

await init({ module_or_path: readFileSync(new URL('../dist/jxl/jxl_oxide_wasm_bg.wasm', import.meta.url)) });

test('the header says what jxlinfo says, on bare codestreams and containers', () => {
  const expected = {
    alpha_premultiplied: { width: 1024, height: 1024, bitsPerSample: 12, hasAlpha: true, alphaPremultiplied: true, srgb: true },
    alpha_triangles: { width: 1024, height: 1024, bitsPerSample: 9, hasAlpha: true, alphaPremultiplied: false, srgb: true },
    animation_spline: { width: 320, height: 320, bitsPerSample: 8, hasAlpha: false, animated: true },
    bench_oriented_brg: { width: 606, height: 500, bitsPerSample: 8, hasAlpha: false, orientation: 5 },
    bicycles: { width: 1024, height: 631, bitsPerSample: 8, hasAlpha: false, animated: false, xyb: true },
    blendmodes: { width: 1024, height: 1024, bitsPerSample: 12, hasAlpha: true, alphaPremultiplied: false, srgb: true },
    grayscale: { width: 200, height: 200, bitsPerSample: 8, hasAlpha: false, iccProfile: true, srgb: false },
    patches_lossless: { width: 1600, height: 1096, bitsPerSample: 8, hasAlpha: true, iccProfile: true, xyb: false },
    sunset_logo: { width: 924, height: 1386, bitsPerSample: 10, hasAlpha: true, orientation: 7 },
  };
  for (const [name, wanted] of Object.entries(expected)) {
    const header = readJXLHeader(file(`${name}.jxl`));
    for (const [key, value] of Object.entries(wanted)) assert.equal(header[key], value, `${name} ${key}`);
  }
});

test('the header reader refuses what is not a complete JPEG XL header', () => {
  const failed = (error) => error.name === 'MargoError' && error.code === 'failed' && /; pass the complete bytes/.test(error.message);
  assert.throws(() => readJXLHeader(new Uint8Array(16)), failed);
  assert.throws(() => readJXLHeader(file('grayscale.jxl').subarray(0, 3)), failed);
  assert.throws(() => readJXLHeader(file('alpha_premultiplied.jxl').subarray(0, 40)), failed);
  assert.throws(() => readJXLHeader([0xff, 0x0a]), TypeError);
});

test('every fixture decodes to the recorded pixels, at the size its header gives', () => {
  for (const [name, record] of Object.entries(records)) {
    const bytes = file(`${name}.jxl`),
      header = readJXLHeader(bytes),
      image = renderJXL(glue, bytes);
    assert.deepEqual([image.width, image.height], [header.width, header.height], name);
    assert.equal(image.data.length, image.width * image.height * 4, name);
    assert.equal(createHash('sha256').update(image.data).digest('hex'), record.sha256, name);
  }
});

// Both images round one value to 8 bits, so two honest results can sit one level apart and no further.
test('blendmodes equals the reference array of the conformance suite, clipped to 8 bits', () => {
  const image = renderJXL(glue, file('blendmodes.jxl')),
    reference = decodePNG(file('blendmodes-reference.png')).data;
  let worst = 0;
  for (let at = 0; at < reference.length; at++) worst = Math.max(worst, Math.abs(image.data[at] - reference[at]));
  assert.ok(worst <= 1, `worst difference ${worst}`);
});

// The file stores colour multiplied by alpha, so a straight result divides once. Samples are 16 bits when divided: an error of
// 2^-17 in each of colour and alpha gives at most 255 * 2^-16 / a levels after the division, which is under 1 for a >= 1/255.
// One level more for the rounding of each image gives 2. Pixels whose alpha rounds to 0 have no colour to compare.
test('a premultiplied file comes out with straight alpha, divided once', () => {
  const { data } = renderJXL(glue, file('alpha_premultiplied.jxl')),
    reference = decodePNG(file('alpha_premultiplied-straight.png')).data;
  let worst = 0,
    worstAlpha = 0;
  for (let at = 0; at < reference.length; at += 4) {
    worstAlpha = Math.max(worstAlpha, Math.abs(data[at + 3] - reference[at + 3]));
    if (reference[at + 3])
      for (let channel = 0; channel < 3; channel++)
        worst = Math.max(worst, Math.abs(data[at + channel] - reference[at + channel]));
  }
  assert.ok(worstAlpha <= 1, `alpha differs by ${worstAlpha}`);
  assert.ok(worst <= 2, `colour differs by ${worst}`);
});

// Pixels of a red bench on grass, read from `sips -m "sRGB Profile.icc"` on macOS 27.2: ColorSync, the engine under Safari,
// on the samples and profile the module hands out. LittleCMS 2.19 gives the same. As stored they are a green bench.
test('a file stored in its own ICC profile comes out in sRGB, as ColorSync gives it', () => {
  const { width, data } = renderJXL(glue, file('bench_oriented_brg.jxl')),
    colorSync = [
      [100, 100, 111, 135, 72],
      [300, 250, 209, 55, 51],
      [500, 400, 48, 45, 54],
      [50, 450, 113, 127, 141],
      [303, 120, 120, 75, 73],
    ];
  for (const [x, y, ...rgb] of colorSync) {
    const at = (y * width + x) * 4;
    assert.deepEqual([...data.subarray(at, at + 3)], rgb, `pixel ${x}, ${y}`);
  }
});

// A profile of the tags named, each `[name, bytes]`, in colour space `space`.
function profile(space, tags) {
  const table = 132 + tags.length * 12,
    size = tags.reduce((sum, [, bytes]) => sum + bytes.length, table),
    out = new Uint8Array(size),
    view = new DataView(out.buffer),
    ascii = (at, text) => out.set(Buffer.from(text, 'latin1'), at);
  ascii(16, space);
  view.setUint32(128, tags.length);
  let at = table;
  tags.forEach(([name, bytes], i) => {
    ascii(132 + i * 12, name);
    view.setUint32(136 + i * 12, at);
    view.setUint32(140 + i * 12, bytes.length);
    out.set(bytes, at);
    at += bytes.length;
  });
  return out;
}

function type(name, length, write) {
  const bytes = new Uint8Array(length);
  bytes.set(Buffer.from(name, 'latin1'));
  write(new DataView(bytes.buffer));
  return bytes;
}

const gamma = (value) => type('curv', 14, (view) => (view.setUint32(8, 1), view.setUint16(12, value * 256))),
  xyz = (x, y, z) =>
    type('XYZ ', 20, (view) => [x, y, z].forEach((value, i) => view.setInt32(8 + i * 4, Math.round(value * 65536)))),
  parametric = (kind, values) =>
    type('para', 12 + values.length * 4, (view) => {
      view.setUint16(8, kind);
      values.forEach((value, i) => view.setInt32(12 + i * 4, Math.round(value * 65536)));
    }),
  table = (values) =>
    type('curv', 12 + values.length * 2, (view) => {
      view.setUint32(8, values.length);
      values.forEach((value, i) => view.setUint16(12 + i * 2, value));
    }),
  srgbColumns = [
    ['rXYZ', xyz(0.4360747, 0.2225045, 0.0139322)],
    ['gXYZ', xyz(0.3850649, 0.7168786, 0.0971045)],
    ['bXYZ', xyz(0.1430804, 0.0606169, 0.7141733)],
  ],
  srgbCurve = parametric(3, [2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045]),
  curves = (curve) => ['rTRC', 'gTRC', 'bTRC'].map((name) => [name, curve]);

test('a profile that is sRGB leaves every level where it was, and alpha is carried over', () => {
  const read = readICCProfile(profile('RGB ', [...srgbColumns, ...curves(srgbCurve)])),
    samples = new Uint16Array(256 * 4);
  for (let level = 0; level < 256; level++) samples.set([level * 257, level * 257, level * 257, level * 257], level * 4);
  const out = profileToSRGB(samples, read);
  for (let level = 0; level < 256; level++)
    for (let channel = 0; channel < 4; channel++) assert.equal(out[level * 4 + channel], level, `level ${level}`);
});

test('gamma, table and every parametric curve give their value, and grey needs one curve', () => {
  const curveOf = (curve) => readICCProfile(profile('GRAY', [['kTRC', curve]])).curves[0],
    close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-4, `${actual} against ${expected}`);
  close(curveOf(gamma(2))(0.5), 0.25);
  close(curveOf(table([0, 65535, 0]))(0.25), 0.5);
  close(curveOf(table([]))(0.3), 0.3);
  close(curveOf(parametric(0, [2]))(0.5), 0.25);
  close(curveOf(parametric(1, [2, 2, -0.5]))(0.5), 0.25);
  close(curveOf(parametric(1, [2, 2, -0.5]))(0.1), 0);
  close(curveOf(parametric(2, [2, 2, -0.5, 0.25]))(0.1), 0.25);
  close(curveOf(parametric(3, [2, 1, 0, 0.5, 0.5]))(0.25), 0.125);
  close(curveOf(parametric(4, [2, 1, 0, 0.5, 0.5, 0.25, 0.125]))(0.25), 0.25);
  close(curveOf(parametric(4, [2, 1, 0, 0.5, 0.5, 0.25, 0.125]))(0.5), 0.5);
});

test('a lookup table profile, a CMYK profile, an unknown curve and a damaged profile are not read', () => {
  const pointsOutside = profile('GRAY', [['kTRC', gamma(2)]]);
  new DataView(pointsOutside.buffer).setUint32(136, 1 << 20);
  assert.equal(readICCProfile(profile('RGB ', [['A2B0', new Uint8Array(32)]])), undefined);
  assert.equal(readICCProfile(profile('CMYK', [['kTRC', gamma(2)]])), undefined);
  assert.equal(readICCProfile(profile('GRAY', [['kTRC', parametric(9, [])]])), undefined);
  assert.equal(readICCProfile(pointsOutside), undefined);
  assert.equal(readICCProfile(new Uint8Array(0)), undefined);
});

test('an animation gives its first frame', () => {
  const bytes = file('animation_spline.jxl'),
    image = new JxlImage();
  image.feedBytes(bytes);
  image.tryInit();
  image.forceSrgb = true;
  const first = decodePNG(image.render(0).encodeToPng()),
    later = decodePNG(image.render(30).encodeToPng());
  image.free();
  const { data } = renderJXL(glue, bytes);
  assert.deepEqual(data, first.data);
  assert.notDeepEqual(data, later.data);
});

test('a file cut short, a CMYK file and a file over maxPixels are refused with the fix in the message', () => {
  const bytes = file('bicycles.jxl'),
    failed = (pattern) => (error) => error.name === 'MargoError' && error.code === 'failed' && pattern.test(error.message);
  assert.throws(() => renderJXL(glue, bytes.subarray(0, bytes.length - 1)), failed(/cut short; pass the complete bytes/));
  assert.throws(() => renderJXL(glue, bytes.subarray(0, 20)), failed(/cut short|ends inside/));
  assert.throws(() => renderJXL(glue, file('cmyk_layers.jxl')), failed(/convert CMYK images to RGB/));
  assert.throws(() => renderJXL(glue, bytes, 1024), /over maxPixels 1024; raise maxPixels/);
});

test('a damaged file gives pixels or a MargoError, and the module keeps working', () => {
  const source = file('grayscale.jxl'),
    clean = createHash('sha256').update(renderJXL(glue, source).data).digest('hex');
  let seed = 7,
    decoded = 0,
    refused = 0;
  const next = (below) => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return Math.floor((seed / 2 ** 32) * below);
  };
  for (let round = 0; round < 300; round++) {
    const bytes = source.slice();
    bytes[next(bytes.length)] = next(256);
    try {
      renderJXL(glue, bytes);
      decoded++;
    } catch (error) {
      assert.equal(error.name, 'MargoError', `round ${round}: ${error}`);
      refused++;
    }
  }
  assert.ok(decoded > 0 && refused > 0, `${decoded} decoded, ${refused} refused`);
  assert.equal(createHash('sha256').update(renderJXL(glue, source).data).digest('hex'), clean);
});

test('jxlTextureFile is one sRGB level for uploadTexture', () => {
  const image = renderJXL(glue, file('sunset_logo.jxl')),
    texture = jxlTextureFile({ ...image, hasAlpha: true });
  assert.equal(texture.format, 'rgba8unorm-srgb');
  assert.equal(texture.target, 'jxl');
  assert.equal(texture.mipmaps.length, 1);
  assert.equal(texture.mipmaps[0].data, image.data);
  assert.equal(texture.mipmaps[0].byteLength, image.width * image.height * 4);
});

test('JXLDecoder costs nothing to build, and names what it needs where there are no workers', async () => {
  const decoder = new JXLDecoder({ workerLimit: 1 });
  await assert.rejects(decoder.decode(file('grayscale.jxl')), (error) => error.code === 'unsupported');
  await assert.rejects(decoder.decode(new Uint8Array(16)), (error) => error.code === 'failed');
  await assert.rejects(decoder.decode(file('grayscale.jxl'), { maxPixels: 10 }), RangeError);
  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(decoder.decode(file('grayscale.jxl'), { signal: stopped.signal }), { name: 'AbortError' });
  decoder.dispose();
});
