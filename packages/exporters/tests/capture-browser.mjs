// @margoengine/exporters/capture on a real engine in a browser (WebGPU where available): exact-size captures of a
// known scene at sizes unlike the canvas, the canvas restored afterwards, tiles above 4096 against a direct render,
// transparent backgrounds, a GIF decoded by the browser's own ImageDecoder, JPEG, and WebM frame pacing.
// Run after building the packages: node scripts/gpu-lock.mjs run --owner=<id> -- node packages/exporters/tests/capture-browser.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({
  configFile: resolve(root, 'vite.config.js'),
  logLevel: 'error',
  server: { port: 0 },
});
await server.listen();
let browser;
try {
  browser = await launchBrowser({ headless: true });
  const page = await browser.newPage({ viewport: { width: 320, height: 240 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  await page.goto(`${server.resolvedUrls.local[0]}tests/capture.html`);
  await page.waitForFunction(() => window.margo);
  const report = await page.evaluate(async () => {
    const { Engine, PbrMaterial, box, TransparentCanvas, capture, encodeGIF, encodeJPEG, encodeWEBM } = window.margo;
    const canvas = document.getElementById('view'),
      engine = await Engine.create(canvas, { camera: { position: [0, 0, 6], target: [0, 0, 0], fov: 40 } });
    engine
      .createMesh()
      .setGeometry(box(1, 1, 1))
      .setMaterial(new PbrMaterial({ color: '#e03030', roughness: 0.6 }));
    engine.render();
    const at = (shot, x, y) => Array.from(shot.data.subarray((y * shot.width + x) * 4, (y * shot.width + x) * 4 + 4));
    // The cube's front face: bounding box of pixels unlike the top-left corner.
    const extent = (shot) => {
      const bg = at(shot, 0, 0);
      let x0 = Infinity,
        x1 = -1,
        y0 = Infinity,
        y1 = -1;
      for (let y = 0; y < shot.height; y++)
        for (let x = 0; x < shot.width; x++) {
          const p = at(shot, x, y);
          if (Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]) + Math.abs(p[3] - bg[3]) > 60) {
            x0 = Math.min(x0, x);
            x1 = Math.max(x1, x);
            y0 = Math.min(y0, y);
            y1 = Math.max(y1, y);
          }
        }
      return { cx: (x0 + x1 + 1) / 2, cy: (y0 + y1 + 1) / 2, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    };
    const report = { backend: engine.backend, before: [canvas.width, canvas.height] };
    const shot = capture(engine, { width: 333, height: 111 });
    report.after = [canvas.width, canvas.height, canvas.style.display];
    report.shot = { width: shot.width, height: shot.height, corner: at(shot, 0, 0), centre: at(shot, 166, 55) };
    report.cube = extent(shot);
    // Above the 4096 cap: two 2100-wide tiles, compared with a direct 2100x50 render after a 2x2 box filter.
    const big = capture(engine, { width: 4200, height: 100 }),
      small = capture(engine, { width: 2100, height: 50 });
    let differing = 0;
    for (let y = 0; y < 50; y++)
      for (let x = 0; x < 2100; x++) {
        let error = 0;
        for (let c = 0; c < 4; c++) {
          const mean =
            (at(big, 2 * x, 2 * y)[c] +
              at(big, 2 * x + 1, 2 * y)[c] +
              at(big, 2 * x, 2 * y + 1)[c] +
              at(big, 2 * x + 1, 2 * y + 1)[c]) /
            4;
          error += Math.abs(mean - at(small, x, y)[c]);
        }
        if (error > 40) differing++;
      }
    report.tiled = { cube: extent(big), smallCube: extent(small), differing, after: [canvas.width, canvas.height] };
    // Transparent canvas: empty pixels have alpha 0, and a background composites under them.
    const transparent = TransparentCanvas.attach(engine),
      clear = capture(engine, { width: 64, height: 48 }),
      green = capture(engine, { width: 64, height: 48, background: '#00ff00', backgroundAlpha: 0.5 });
    report.transparent = { clear: [at(clear, 0, 0), at(clear, 32, 24)], green: [at(green, 0, 0), at(green, 32, 24)] };
    // Pixel art and a captured spin through the GIF encoder, decoded by the browser.
    const pixelArt = [0, 1, 2].map((k) => {
      const data = new Uint8ClampedArray(9 * 4 * 4);
      for (let i = 0; i < 36; i++)
        data.set(
          [
            [255, 0, 0],
            [0, 128, 255],
            [250, 250, 250],
          ][(i + k) % 3].concat(i % 7 === k ? 0 : 255),
          i * 4,
        );
      return { data, width: 9, height: 4 };
    });
    const decode = async (bytes) => {
      const decoder = new ImageDecoder({ data: bytes, type: 'image/gif' });
      await decoder.tracks.ready;
      const track = decoder.tracks.selectedTrack,
        frames = [];
      for (let i = 0; i < track.frameCount; i++) {
        const { image } = await decoder.decode({ frameIndex: i }),
          context = new OffscreenCanvas(image.displayWidth, image.displayHeight).getContext('2d');
        context.drawImage(image, 0, 0);
        frames.push({
          duration: image.duration,
          data: Array.from(context.getImageData(0, 0, image.displayWidth, image.displayHeight).data),
        });
        image.close();
      }
      decoder.close();
      return { repetitionCount: String(track.repetitionCount), frames };
    };
    const art = await decode(await encodeGIF(3, (i) => pixelArt[i], { fps: 25 })),
      spin = await decode(
        await encodeGIF(4, (i) => {
          engine.camera.position = [6 * Math.sin(i * 0.4), 1, 6 * Math.cos(i * 0.4)];
          return capture(engine, { width: 96, height: 64, background: '#202830' });
        }),
      );
    report.gif = {
      art: {
        repetitionCount: art.repetitionCount,
        durations: art.frames.map((f) => f.duration),
        exact: art.frames.every((f, k) =>
          f.data.every((v, i) => {
            const source = pixelArt[k].data,
              alpha = source[i - (i % 4) + 3];
            return v === (alpha < 128 ? 0 : i % 4 === 3 ? 255 : source[i]);
          }),
        ),
      },
      spin: { frames: spin.frames.length, durations: spin.frames.map((f) => f.duration) },
    };
    transparent.dispose();
    engine.camera.position = [0, 0, 6];
    // JPEG: decodes at the captured size with the captured colours; what transparency becomes.
    const decodeImage = async (bytes, type) => {
      const bitmap = await createImageBitmap(new Blob([bytes], { type })),
        context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
      context.drawImage(bitmap, 0, 0);
      return {
        width: bitmap.width,
        height: bitmap.height,
        data: context.getImageData(0, 0, bitmap.width, bitmap.height).data,
      };
    };
    const jpeg = await decodeImage(await encodeJPEG(shot, 0.9), 'image/jpeg'),
      hole = await decodeImage(
        await encodeJPEG({
          data: new Uint8ClampedArray(16 * 16 * 4).fill(255).map((v, i) => (i % 4 === 3 ? 0 : v)),
          width: 16,
          height: 16,
        }),
        'image/jpeg',
      );
    report.jpeg = {
      width: jpeg.width,
      height: jpeg.height,
      centre: at(jpeg, 166, 55),
      transparentWhite: at(hole, 8, 8),
    };
    // WebM: frames take 150 ms each to produce at 20 fps; the recorder pauses meanwhile, so the video lasts ~0.3 s.
    const started = performance.now(),
      webm = await encodeWEBM(
        6,
        async (i) => {
          await new Promise((resolve) => setTimeout(resolve, 150));
          engine.camera.position = [6 * Math.sin(i * 0.3), 0, 6 * Math.cos(i * 0.3)];
          return capture(engine, { width: 160, height: 90 });
        },
        { fps: 20 },
      );
    const video = document.createElement('video');
    video.muted = true;
    video.src = URL.createObjectURL(new Blob([webm], { type: 'video/webm' }));
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new Error(`video error ${video.error?.code}`));
    });
    if (!Number.isFinite(video.duration)) {
      // MediaRecorder WebM has no duration header; seeking past the end makes the browser find it.
      video.currentTime = 1e6;
      await new Promise((resolve) => (video.ondurationchange = () => Number.isFinite(video.duration) && resolve()));
    }
    report.webm = {
      bytes: webm.length,
      magic: Array.from(webm.subarray(0, 4)),
      duration: video.duration,
      size: [video.videoWidth, video.videoHeight],
      wall: (performance.now() - started) / 1000,
    };
    report.final = [canvas.width, canvas.height, canvas.style.display];
    engine.dispose();
    return report;
  });
  console.log(JSON.stringify({ browser: browser.version(), ...report }, null, 2));
  assert.deepEqual(
    errors.filter((error) => !/^Failed to load resource/.test(error)),
    [],
  );
  const near = (a, b, tolerance, message) => assert.ok(Math.abs(a - b) <= tolerance, `${message}: ${a} vs ${b}`);
  // Exact size, square cube in the middle (the camera saw the capture's aspect), canvas untouched afterwards.
  assert.deepEqual([report.shot.width, report.shot.height], [333, 111]);
  assert.deepEqual(report.after, [...report.before, 'block'], 'inline display: block restored');
  assert.deepEqual(report.final, [...report.before, 'block']);
  near(report.cube.cx, 166.5, 1, 'cube centre x');
  near(report.cube.cy, 55.5, 1, 'cube centre y');
  near(report.cube.w, report.cube.h, 2, 'cube is square');
  assert.ok(
    report.shot.corner[3] === 255 && report.shot.centre[0] > report.shot.centre[2] + 40,
    'red cube on opaque clear',
  );
  // Tiles: the same picture as a direct render at half size, cube centred across the seam.
  near(report.tiled.cube.cx, 2100, 1, 'tiled cube centre x');
  near(report.tiled.cube.w, report.tiled.cube.h, 2, 'tiled cube is square');
  near(report.tiled.cube.h, 2 * report.tiled.smallCube.h, 2, 'tiled cube twice the half-size cube');
  assert.ok(report.tiled.differing < 2100 * 50 * 0.01, `${report.tiled.differing} pixels differ after the box filter`);
  assert.deepEqual(report.tiled.after, report.before);
  // Transparency and background.
  assert.equal(report.transparent.clear[0][3], 0, 'empty pixel transparent');
  assert.equal(report.transparent.clear[1][3], 255, 'cube opaque');
  report.transparent.green[0].forEach((v, i) => near(v, [0, 255, 0, 128][i], 2, 'half-transparent green background'));
  assert.equal(report.transparent.green[1][3], 255);
  // GIF through the browser's decoder.
  assert.equal(report.gif.art.repetitionCount, 'Infinity', 'loops forever');
  assert.deepEqual(report.gif.art.durations, [40000, 40000, 40000], '25 fps: 4/100 s');
  assert.ok(report.gif.art.exact, 'pixel art decodes exactly, transparent pixels clear');
  assert.equal(report.gif.spin.frames, 4);
  assert.deepEqual(report.gif.spin.durations, [30000, 40000, 30000, 30000]);
  // JPEG.
  assert.deepEqual([report.jpeg.width, report.jpeg.height], [333, 111]);
  report.jpeg.centre.slice(0, 3).forEach((v, i) => near(v, report.shot.centre[i], 12, 'JPEG centre colour'));
  // WebM.
  assert.deepEqual(report.webm.magic, [0x1a, 0x45, 0xdf, 0xa3], 'EBML header');
  assert.deepEqual(report.webm.size, [160, 90]);
  assert.ok(
    report.webm.duration > 0.2 && report.webm.duration < 0.6,
    `WebM lasts ${report.webm.duration} s, not ~1.2 s`,
  );
  console.log(`capture-browser: all checks passed (${report.backend})`);
} finally {
  await browser?.close();
  await server.close();
}
