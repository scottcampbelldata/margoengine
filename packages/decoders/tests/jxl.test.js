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
