// Render to file (@margoengine/exporters/capture) in Node: GIF round trips through an independent GIF89a decoder
// written here from the spec, PNG round trips through zlib, JPEG/sequence plumbing and the capture size maths against
// a mocked canvas whose render copies Engine.update's backing-size rule. The real-GPU path is tests/capture-browser.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32, inflateSync } from 'node:zlib';
import { capture, encodeGIF, encodeJPEG, encodePNG, encodeSequence, encodeWEBM } from '@margoengine/exporters/capture';

import { decodeGIF } from './support/gif.mjs';

// Expected GIF pixels: alpha below 128 is transparent (0, 0, 0, 0), anything else opaque.
const flatten = (data) => Uint8Array.from(data, (v, i) => (data[i - (i % 4) + 3] < 128 ? 0 : i % 4 === 3 ? 255 : v));
let seed = 7;
const random = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 8) / 2 ** 24;

test('GIF round trip: exact palette, transparency, cumulative delays, loop forever', async () => {
  const colors = [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [255, 255, 255],
      [17, 34, 51],
    ],
    frames = [0, 1, 2].map((k) => {
      const data = new Uint8ClampedArray(7 * 5 * 4);
      for (let i = 0; i < 35; i++) data.set([...colors[(i + k) % 5], i % 6 === k ? 0 : i % 6 === 5 ? 200 : 255], i * 4);
      return { data, width: 7, height: 5 };
    });
  const asked = [],
    gif = await encodeGIF(
      3,
      async (i) => {
        asked.push(i);
        return frames[i];
      },
      { fps: 30 },
    );
  assert.deepEqual(asked, [0, 1, 2]);
  const decoded = decodeGIF(gif);
  assert.deepEqual([decoded.width, decoded.height, decoded.loop], [7, 5, 0]);
  assert.deepEqual(
    decoded.frames.map((f) => f.delay),
    [3, 4, 3],
    '30 fps in hundredths, rounded cumulatively',
  );
  decoded.frames.forEach((f, k) => {
    assert.deepEqual(f.rgba, flatten(frames[k].data), `frame ${k} pixels`);
    assert.deepEqual([f.hasTransparency, f.transparentIndex, f.disposal], [true, 0, 2]);
    assert.equal(f.used, 6, 'five colours plus the transparent index');
  });
  const opaque = decodeGIF(await encodeGIF(1, () => ({ data: new Uint8Array([9, 8, 7, 255]), width: 1, height: 1 })));
  assert.deepEqual([...opaque.frames[0].rgba], [9, 8, 7, 255]);
  assert.deepEqual([opaque.frames[0].hasTransparency, opaque.frames[0].colors], [false, 2], 'smallest table is 2');
  assert.deepEqual(
    decodeGIF(await encodeGIF(4, () => frames[0], { fps: 7 })).frames.map((f) => f.delay),
    [14, 15, 14, 14],
  );
});

test('GIF LZW keeps exact pixels through code-size growth to 12 bits and table resets', async () => {
  const data = new Uint8Array(160 * 160 * 4),
    palette = Array.from({ length: 256 }, () => [0, 1, 2].map(() => Math.floor(random() * 256)));
  for (let i = 0; i < 160 * 160; i++) data.set([...palette[Math.floor(random() * 256)], 255], i * 4);
  const decoded = decodeGIF(await encodeGIF(1, () => ({ data, width: 160, height: 160 })));
  assert.deepEqual(decoded.frames[0].rgba, data);
  assert.ok(decoded.frames[0].clears > 2, `table resets (${decoded.frames[0].clears} clear codes)`);
  const runs = new Uint8Array(300 * 2 * 4).map((_, i) => (i % 4 === 3 ? 255 : (i >> 9) * 40));
  assert.deepEqual(decodeGIF(await encodeGIF(1, () => ({ data: runs, width: 300, height: 2 }))).frames[0].rgba, runs);
  // Short random rows end on every code count, including those where the end code needs one more bit.
  for (let width = 1; width <= 120; width++) {
    const row = new Uint8Array(width * 4);
    for (let i = 0; i < width; i++) row.set([[0, 90, 200][Math.floor(random() * 3)], 0, 0, 255], i * 4);
    assert.deepEqual(decodeGIF(await encodeGIF(1, () => ({ data: row, width, height: 1 }))).frames[0].rgba, row);
  }
});

test('GIF quantises a frame with more than 256 colours by median cut, optionally dithered', async () => {
  const width = 64,
    height = 64,
    data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) data.set([x * 4, y * 4, (x + y) * 2, 255], (y * width + x) * 4);
  data[3] = 0; // one transparent pixel: 255 colours plus the transparent index
  const error = (rgba) => {
    let max = 0,
      sum = 0;
    for (let i = 4; i < rgba.length; i += 4)
      for (let c = 0; c < 3; c++) {
        const e = Math.abs(rgba[i + c] - data[i + c]);
        max = Math.max(max, e);
        sum += e;
      }
    return { max, mean: sum / ((rgba.length / 4 - 1) * 3) };
  };
  const plain = decodeGIF(await encodeGIF(1, () => ({ data, width, height }))).frames[0],
    dithered = decodeGIF(await encodeGIF(1, () => ({ data, width, height }), { dither: true })).frames[0];
  for (const frame of [plain, dithered]) {
    assert.equal(frame.colors, 256);
    assert.ok(frame.used <= 256);
    assert.deepEqual([...frame.rgba.subarray(0, 4)], [0, 0, 0, 0], 'transparent pixel');
    assert.ok(
      frame.rgba.every((v, i) => i < 4 || i % 4 !== 3 || v === 255),
      'other pixels opaque',
    );
  }
  const a = error(plain.rgba),
    b = error(dithered.rgba);
  assert.ok(a.max <= 24 && a.mean <= 6, `median cut error ${JSON.stringify(a)}`);
  assert.ok(b.max <= 40 && b.mean <= 12, `dithered error ${JSON.stringify(b)}`);
  assert.notDeepEqual(plain.rgba, dithered.rgba);
});

test('GIF rejects frame rates above 50, mismatched frames and bad pixels', async () => {
  const pixel = { data: new Uint8Array(4), width: 1, height: 1 };
  await assert.rejects(
    encodeGIF(1, () => pixel, { fps: 60 }),
    RangeError,
  );
  await assert.rejects(
    encodeGIF(0, () => pixel),
    RangeError,
  );
  await assert.rejects(
    encodeGIF(2, (i) => (i ? { data: new Uint8Array(8), width: 2, height: 1 } : pixel)),
    /frame 1 is 2x1, not 1x1/,
  );
  await assert.rejects(
    encodeGIF(1, () => ({ data: new Uint8Array(3), width: 1, height: 1 })),
    RangeError,
  );
  await assert.rejects(
    encodeGIF(1, () => ({ data: [0, 0, 0, 0], width: 1, height: 1 })),
    TypeError,
  );
});

test('PNG round trip: RGBA8 rows, top row first, valid chunk CRCs', async () => {
  const data = Uint8Array.from({ length: 5 * 3 * 4 }, (_, i) => (i * 53 + 7) % 256),
    bytes = await encodePNG({ data, width: 5, height: 3 });
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer, bytes.byteOffset),
    chunks = {};
  for (let p = 8; p < bytes.length; ) {
    const length = view.getUint32(p),
      type = String.fromCharCode(...bytes.subarray(p + 4, p + 8));
    assert.equal(view.getUint32(p + 8 + length), crc32(bytes.subarray(p + 4, p + 8 + length)), `${type} CRC`);
    chunks[type] = bytes.subarray(p + 8, p + 8 + length);
    p += 12 + length;
  }
  assert.deepEqual([...chunks.IHDR], [0, 0, 0, 5, 0, 0, 0, 3, 8, 6, 0, 0, 0]);
  const rows = inflateSync(chunks.IDAT),
    pixels = [];
  for (let y = 0; y < 3; y++) {
    const row = rows.subarray(y * 21, y * 21 + 21);
    assert.equal(row[0], 1, 'Sub filter');
    for (let x = 0; x < 20; x++) pixels.push((row[1 + x] + (x < 4 ? 0 : pixels[y * 20 + x - 4])) & 255);
  }
  assert.deepEqual(pixels, [...data]);
});

// A browser canvas stand-in: drawImage remembers which engine frame it copied, getImageData returns
// [frame, x, y, 255] per pixel, convertToBlob returns a stub JPEG.
function mockCanvasGlobals() {
  const log = [];
  globalThis.ImageData = class {
    constructor(data, width, height) {
      Object.assign(this, { data, width, height });
    }
  };
  globalThis.OffscreenCanvas = class {
    constructor(width, height) {
      Object.assign(this, { width, height });
    }
    getContext(type, options) {
      let frame = -1;
      return {
        type,
        options,
        fillStyle: '',
        clearRect: () => log.push(['clear']),
        fillRect(...rect) {
          log.push(['fill', this.fillStyle, ...rect]);
        },
        drawImage: (source) => {
          frame = source.frame;
          log.push(['draw', source.width, source.height]);
        },
        getImageData: (x, y, w, h) => {
          const data = new Uint8ClampedArray(w * h * 4);
          for (let i = 0; i < w * h; i++) data.set([frame, i % w, Math.floor(i / w), 255], i * 4);
          return { data };
        },
        putImageData: (image) => log.push(['put', image]),
      };
    }
    async convertToBlob(options) {
      log.push(['blob', options, this.width, this.height]);
      return new Blob([Uint8Array.of(0xff, 0xd8, 0xff, 0xd9)]);
    }
  };
  return {
    log,
    restore() {
      delete globalThis.OffscreenCanvas;
      delete globalThis.ImageData;
    },
  };
}
// An engine whose render applies Engine.update's backing-size rule (packages/core/src/engine.ts) for a DPR of 1.5.
function mockEngine({ cssWidth = 300, cssHeight = 200, dpr = 1.5, fail = false } = {}) {
  const properties = new Map(),
    style = {
      getPropertyValue: (name) => properties.get(name)?.[0] ?? '',
      getPropertyPriority: (name) => properties.get(name)?.[1] ?? '',
      setProperty: (name, value, priority = '') => properties.set(name, [value, priority]),
      removeProperty: (name) => properties.delete(name),
    },
    hidden = () => style.getPropertyValue('display') === 'none',
    canvas = {
      width: 300,
      height: 150,
      style,
      get clientWidth() {
        return hidden() ? 0 : cssWidth;
      },
      get clientHeight() {
        return hidden() ? 0 : cssHeight;
      },
    },
    camera = { fov: 50, near: 0.5, far: 80, position: [0, 0, 5], target: [0, 0, 0] },
    renders = [];
  const engine = {
    canvas,
    camera,
    render({ camera: view = camera, delta = 0, views } = {}) {
      if (fail) throw new Error('device lost');
      if (views) view = views[0].camera;
      const width = Math.max(1, Math.min(4096, Math.round(canvas.clientWidth * dpr) || canvas.width)),
        height = Math.max(1, Math.min(4096, Math.round(canvas.clientHeight * dpr) || canvas.height));
      canvas.width = width;
      canvas.height = height;
      const projection = new Float64Array(16);
      view.project?.(projection, width / height, true);
      renders.push({ width, height, view, views, delta, projection, display: style.getPropertyValue('display') });
      canvas.frame = renders.length - 1;
    },
  };
  return { engine, canvas, camera, renders, style };
}

test('capture renders at an exact size regardless of CSS size and DPR, then restores the canvas', (t) => {
  const mock = mockCanvasGlobals();
  t.after(mock.restore);
  const { engine, canvas, camera, renders, style } = mockEngine();
  style.setProperty('display', 'block', 'important');
  const shot = capture(engine, { width: 333, height: 77 });
  assert.deepEqual(
    renders.map(({ width, height, view, delta, display }) => [width, height, view === camera, delta, display]),
    [
      [333, 77, true, 0, 'none'],
      [450, 300, true, 0, 'block'],
    ],
    'capture frame at 333x77 hidden, then the normal 450x300 frame shown again',
  );
  assert.deepEqual([shot.width, shot.height, shot.data.length], [333, 77, 333 * 77 * 4]);
  assert.ok(shot.data instanceof Uint8ClampedArray);
  assert.deepEqual([...shot.data.subarray((2 * 333 + 5) * 4, (2 * 333 + 5) * 4 + 4)], [0, 5, 2, 255], 'pixel (5, 2)');
  assert.deepEqual([style.getPropertyValue('display'), style.getPropertyPriority('display')], ['block', 'important']);
  assert.deepEqual([canvas.width, canvas.height], [450, 300]);
  assert.ok(!mock.log.some(([op]) => op === 'fill'), 'no background fill by default');

  const other = { fov: 30, near: 1, far: 9 };
  style.removeProperty('display');
  capture(engine, { width: 20, height: 10, camera: other, background: '#336699', backgroundAlpha: 0.25 });
  assert.equal(renders.at(-2).view, other, 'renders through the given camera');
  assert.equal(renders.at(-1).view, camera, 'redraws the primary camera');
  assert.equal(style.getPropertyValue('display'), '', 'an unset inline display stays unset');
  const fill = mock.log.findLastIndex(([op]) => op === 'fill');
  assert.deepEqual(mock.log[fill], ['fill', 'rgb(51 102 153 / 0.25)', 0, 0, 20, 10]);
  assert.deepEqual(mock.log[fill + 1], ['draw', 20, 10], 'scene drawn over the background');
  capture(engine, { width: 1, height: 1, background: [0.5, 0.5, 0.5] });
  assert.equal(mock.log.findLast(([op]) => op === 'fill')[1], 'rgb(188 188 188 / 1)', 'linear 0.5 is sRGB 188');
});

test('capture with a view renders its camera, scene and layers at the size of its rectangle', (t) => {
  const mock = mockCanvasGlobals();
  t.after(mock.restore);
  const { engine, canvas, camera, renders } = mockEngine(),
    top = { fov: 40, near: 0.1, far: 50 },
    scene = { name: 'hud' };
  engine.render();
  const view = { camera: top, viewport: [0.5, 0, 0.5, 0.5], scene, layers: 2, scissor: [0.5, 0, 0.25, 0.5] },
    shot = capture(engine, { view });
  assert.deepEqual([shot.width, shot.height], [225, 150], 'default size: the view rectangle at the canvas size');
  const drawn = renders.at(-2);
  assert.deepEqual([drawn.width, drawn.height, drawn.view], [225, 150, top]);
  assert.deepEqual(drawn.views, [
    { camera: top, viewport: [0, 0, 1, 1], pixels: false, scissor: undefined, target: undefined, scene, layers: 2 },
  ]);
  engine.views = [{ camera, viewport: [0, 0, 1, 1] }];
  capture(engine, { view: { camera: top, viewport: [10, 20, 64, 32], pixels: true }, width: 128 });
  assert.deepEqual([renders.at(-2).width, renders.at(-2).height], [128, 32], 'pixels give the default height');
  assert.equal(renders.at(-1).views, engine.views, 'the page redraws its own views afterwards');
  assert.deepEqual([canvas.width, canvas.height], [450, 300]);
});

test('capture tiles sizes above 4096 through a view offset on the full projection', (t) => {
  t.after(mockCanvasGlobals().restore);
  const { engine, camera, renders } = mockEngine(),
    shot = capture(engine, { width: 5000, height: 9 });
  assert.deepEqual(
    renders.map((r) => [r.width, r.height, r.display]),
    [
      [2500, 9, 'none'],
      [2500, 9, 'none'],
      [450, 300, ''],
    ],
  );
  assert.equal(camera.project, undefined, 'camera projection restored');
  assert.deepEqual([...shot.data.subarray((3 * 5000 + 2600) * 4, (3 * 5000 + 2600) * 4 + 4)], [1, 100, 3, 255]);
  // Every view-space point lands on the same full-image pixel through either tile as through the full perspective.
  const f = 1 / Math.tan((50 * Math.PI) / 360),
    full = (v) => [((f / (5000 / 9)) * v[0]) / -v[2], (f * v[1]) / -v[2]],
    pixel = (m, v, x0) => {
      const clip = [0, 1, 3].map((r) => m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r]);
      return [((clip[0] / clip[2] + 1) / 2) * 2500 + x0, ((1 - clip[1] / clip[2]) / 2) * 9];
    };
  for (const v of [
    [0, 0, -5],
    [3, 0.01, -2],
    [-40, -0.02, -7],
  ]) {
    const [nx, ny] = full(v),
      expected = [((nx + 1) / 2) * 5000, ((1 - ny) / 2) * 9];
    for (const [tile, x0] of [
      [0, 0],
      [1, 2500],
    ])
      pixel(renders[tile].projection, v, x0).forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-6));
  }
  // A custom projection (orthographic, say) is called with the full image's aspect, then offset.
  const aspects = [],
    ortho = (out, aspect) => {
      aspects.push(aspect);
      out[0] = 1 / aspect;
      out[5] = 1;
      out[15] = 1;
    };
  camera.project = ortho;
  capture(engine, { width: 8193, height: 4097 });
  assert.equal(camera.project, ortho);
  assert.deepEqual(
    renders.slice(3).map((r) => [r.width, r.height]),
    [
      [2731, 2049],
      [2731, 2049],
      [2731, 2049],
      [2731, 2048],
      [2731, 2048],
      [2731, 2048],
      [450, 300],
    ],
    '3 x 2 tiles, rows of 2049 and 2048',
  );
  assert.ok(
    aspects.slice(0, 6).every((a) => a === 8193 / 4097),
    'called with the full aspect',
  );
  // Orthographic x/y offsets: tile (0, 0) shows NDC [-1, -1/3] x [1 - 2 * 2049 / 4097, 1].
  const [m0, m5] = [renders[3].projection, renders[8].projection];
  assert.ok(Math.abs(m0[0] - 3 * (4097 / 8193)) < 1e-12 && Math.abs(m0[12] - 2) < 1e-12, 'first column');
  assert.ok(Math.abs(m5[12] + 2) < 1e-12, 'last column');
  assert.ok(Math.abs(m0[13] + 2048 / 2049) < 1e-12 && Math.abs(m5[13] - 2049 / 2048) < 1e-12, 'rows');
});

test('capture validates its options and restores the canvas when a render fails', (t) => {
  t.after(mockCanvasGlobals().restore);
  const { engine, renders } = mockEngine();
  for (const options of [
    { width: 0, height: 1 },
    { width: 2.5, height: 1 },
    { width: 1, height: Number.NaN },
  ])
    assert.throws(() => capture(engine, options), RangeError);
  assert.throws(() => capture(engine, { width: 1, height: 1, backgroundAlpha: 1.5 }), /backgroundAlpha 1.5/);
  assert.equal(renders.length, 0);
  const failing = mockEngine({ fail: true });
  assert.throws(() => capture(failing.engine, { width: 5000, height: 2 }), /device lost/);
  assert.deepEqual(
    [failing.canvas.width, failing.canvas.height, failing.style.getPropertyValue('display')],
    [300, 150, ''],
  );
  assert.equal(failing.camera.project, undefined);
});

test('JPEG and image sequences: options reach the browser encoder, names are zero-padded', async (t) => {
  await assert.rejects(encodeJPEG({ data: new Uint8Array(4), width: 1, height: 1 }), {
    name: 'MargoError',
    code: 'unsupported',
  });
  const mock = mockCanvasGlobals();
  t.after(mock.restore);
  const pixels = { data: new Uint8Array(2 * 3 * 4), width: 2, height: 3 },
    jpeg = await encodeJPEG(pixels, 0.4);
  assert.deepEqual([...jpeg], [0xff, 0xd8, 0xff, 0xd9]);
  assert.deepEqual(mock.log.at(-1), ['blob', { type: 'image/jpeg', quality: 0.4 }, 2, 3]);
  assert.equal(mock.log.at(-2)[1].data.buffer, pixels.data.buffer, 'pixels are put without a copy');
  await encodeJPEG(pixels);
  assert.equal(mock.log.at(-1)[1].quality, 0.92);
  await assert.rejects(encodeJPEG(pixels, 2), RangeError);

  const asked = [],
    frame = (i) => {
      asked.push(i);
      return pixels;
    },
    sequence = encodeSequence(12, frame, { name: 'walk_', pad: 3 }),
    first = await sequence.next();
  assert.deepEqual(asked, [0], 'one frame at a time');
  assert.equal(first.value.name, 'walk_000.png');
  assert.deepEqual([...first.value.data.subarray(1, 4)], [80, 78, 71]);
  const names = [first.value.name];
  for await (const file of sequence) names.push(file.name);
  assert.deepEqual(names.slice(-3), ['walk_009.png', 'walk_010.png', 'walk_011.png']);
  const plain = [];
  for await (const file of encodeSequence(11, () => pixels, { format: 'jpg', quality: 0.5 })) plain.push(file.name);
  assert.deepEqual([plain[0], plain[10]], ['frame0.jpg', 'frame10.jpg']);
  assert.equal(mock.log.at(-1)[1].quality, 0.5);
  await assert.rejects(encodeSequence(1, frame, { format: 'gif' }).next(), TypeError);
  await assert.rejects(encodeSequence(1, frame, { pad: -1 }).next(), RangeError);
});

test('WebM is browser-only: Node reports MediaRecorder as unsupported', async () => {
  await assert.rejects(
    encodeWEBM(1, () => ({ data: new Uint8Array(4), width: 1, height: 1 })),
    {
      name: 'MargoError',
      code: 'unsupported',
    },
  );
});
