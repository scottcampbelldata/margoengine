// The same scene on a page canvas and on the stand-in, each on its own engine and device of the same adapter.
import { Camera, Engine, PbrMaterial, box } from '@margoengine/core';
import { createHeadlessCanvas, installGPU, readPixels, toPNG } from '../src/index.ts';
import { encodeEXR, encodeJPEG, encodeWebP, readTexture } from '../src/formats.ts';
import { parseEXR } from '../../environment/src/exr.ts';
import { PostStack } from '../../post/src/stack.ts';
import { Bloom } from '../../post/src/bloom.ts';
import { encodeVideo, renderFrames } from '../src/video.ts';
import { createHeadlessStage } from '../src/stage.ts';
import { createStage } from '../../stage/src/index.ts';
import { addSky } from '../../stage/src/sky.ts';

const scene = (engine) => {
  engine
    .createMesh()
    .setGeometry(box())
    .setMaterial(new PbrMaterial({ color: '#84d6bd', roughness: 0.3 }));
  return new Camera({ position: [1.6, 1.4, 2.6], target: [0, 0, 0] });
};
window.check = {
  async page() {
    const engine = await Engine.create(document.querySelector('#page'), { backend: 'webgpu' });
    engine.render({ camera: scene(engine) });
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    window.pageEngine = engine;
  },
  async headless() {
    const installed = installGPU({ gpu: navigator.gpu }),
      canvas = createHeadlessCanvas({ width: 256, height: 192 }),
      engine = await Engine.create(canvas, { backend: 'webgpu' }),
      errors = [];
    engine.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
    engine.render({ camera: scene(engine) });
    const png = await toPNG(engine),
      format = canvas.getContext('webgpu').getConfiguration().format;
    engine.dispose();
    installed.dispose();
    return { png: [...png], format, errors };
  },
};
// One stage scene with a lazily loaded feature, in a 16:9 image so a square fit would show.
const stageScene = async (stage) => {
  stage.box({ color: '#84d6bd', size: [2, 1, 1] });
  stage.sphere({ color: '#d68484', radius: 0.5, position: [1.5, 0, 0] });
  await addSky(stage);
  stage.fit();
};
window.check.stagePage = async () => {
  const stage = await createStage('#stage', { backend: 'webgpu', controls: false, autoStart: false });
  await stageScene(stage);
  stage.engine.render();
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
};
window.check.stageHeadless = async () => {
  const errors = [],
    stage = await createHeadlessStage({ width: 320, height: 180 });
  stage.engine.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  await stageScene(stage);
  const png = await stage.toPNG();
  let ticks = 0;
  stage.onTick(() => ticks++);
  let frames = 0;
  stage.engine.onFrame(() => frames++);
  stage.step(1 / 30);
  if (frames !== 1) throw new Error(`engine.onFrame ran ${frames} times on one step`);
  stage.resize(64, 48);
  const { width, height } = await stage.readPixels();
  stage.dispose();
  return { png: [...png], ticks, size: [width, height], errors };
};
/** Mean absolute difference per channel of two RGBA arrays, alpha left out. */
const difference = (a, b) => {
  let sum = 0;
  for (let i = 0; i < a.length; i += 4)
    sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  return sum / ((a.length / 4) * 3);
};
/** The picture a player shows at `time`, from the browser's own demuxer and decoder. */
async function shown(video, time) {
  const seeked = new Promise((done) => video.addEventListener('seeked', done, { once: true }));
  video.currentTime = time;
  await seeked;
  const canvas = new OffscreenCanvas(video.videoWidth, video.videoHeight),
    context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(video, 0, 0);
  return context.getImageData(0, 0, canvas.width, canvas.height).data;
}
// Render a turning cube, encode it with the browser's real encoder, play the file back through a <video> element and
// compare what it shows with what was rendered. Proves the muxers against an independent parser and decoder.
window.check.video = async (format) => {
  const FRAMES = 60,
    FPS = 30,
    installed = installGPU({ gpu: navigator.gpu }),
    canvas = createHeadlessCanvas({ width: 256, height: 192 }),
    engine = await Engine.create(canvas, { backend: 'webgpu' }),
    errors = [],
    camera = scene(engine),
    mesh = [...engine.scene.meshes.values()][0],
    source = [];
  engine.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  async function* keep() {
    for await (const frame of renderFrames(engine, {
      frames: FRAMES,
      fps: FPS,
      camera,
      update: ({ progress }) => mesh.setRotation([0, progress * Math.PI * 2, 0]),
    })) {
      source.push(frame.data);
      yield frame;
    }
  }
  const encoded = await encodeVideo(keep(), { format, fps: FPS, keyFrameInterval: 0.5, bitrate: 4_000_000 });
  engine.dispose();
  installed.dispose();
  const video = document.createElement('video');
  video.muted = true;
  video.src = URL.createObjectURL(new Blob([encoded.bytes], { type: encoded.mimeType }));
  await new Promise((done, fail) => {
    video.addEventListener('loadeddata', done, { once: true });
    video.addEventListener('error', () => fail(new Error(video.error?.message ?? 'video error')), { once: true });
  });
  // Mid-frame times, so a rounding of half a frame cannot pick the neighbour.
  const at = (index) => (index + 0.5) / FPS,
    same = [];
  for (const index of [0, 7, 15, 31, 45, 59]) same.push(difference(await shown(video, at(index)), source[index]));
  const other = difference(await shown(video, at(31)), source[15]);
  return {
    codec: encoded.codec,
    frames: encoded.frames,
    bytes: encoded.bytes.length,
    file: [...encoded.bytes],
    width: video.videoWidth,
    height: video.videoHeight,
    duration: video.duration,
    expected: encoded.duration,
    same,
    other,
    errors,
  };
};
/** The browser's own decode of a file, as straight RGBA with no colour management (WebCodecs). */
async function decoded(bytes, type) {
  const decoder = new ImageDecoder({ data: bytes, type, colorSpaceConversion: 'none' }),
    { image } = await decoder.decode(),
    out = new Uint8Array(image.allocationSize({ format: 'RGBA' }));
  await image.copyTo(out, { format: 'RGBA' });
  const size = [image.displayWidth, image.displayHeight];
  image.close();
  decoder.close();
  return { size, data: out };
}
/** The same pixels premultiplied: the browser's decoders keep colour premultiplied, so a straight pixel of low alpha
 * comes back rounded, and only its premultiplied value is a fact of the file. */
const premultiplied = (data) => {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) out[i + c] = Math.round((data[i + c] * data[i + 3]) / 255);
    out[i + 3] = data[i + 3];
  }
  return out;
};
/** Largest and mean channel difference between two RGBA arrays, alpha counted. */
const distance = (a, b) => {
  let largest = 0,
    sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    sum += d;
    if (d > largest) largest = d;
  }
  return { largest, mean: sum / a.length };
};
// The encoders against the browser's decoders: JPEG in both samplings, lossless WebP bit for bit (odd sizes, alpha),
// lossy WebP, and an EXR of the linear scene capture with a value over 1, parsed back.
window.check.formats = async () => {
  const installed = installGPU({ gpu: navigator.gpu }),
    canvas = createHeadlessCanvas({ width: 256, height: 192 }),
    engine = await Engine.create(canvas, { backend: 'webgpu' }),
    errors = [],
    out = {};
  engine.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  // Bright light, so the linear frame holds values over 1 that a display image cannot.
  engine.lighting.radiance.set([30, 30, 30, 0.15]);
  const stack = PostStack.attach(engine, [new Bloom({ strength: 0.1 })]),
    camera = scene(engine);
  engine.render({ camera });
  const pixels = await readPixels(engine);
  for (const subsampling of ['420', '444']) {
    const file = encodeJPEG(pixels, { quality: 95, subsampling }),
      seen = await decoded(file, 'image/jpeg');
    out['jpeg' + subsampling] = { size: seen.size, bytes: file.length, ...distance(seen.data, pixels.data) };
  }
  const paint = (width, height) => {
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        data.set([x * 7 + y, y * 13, (x * y) & 255, ((x + y) * 9) & 255], (y * width + x) * 4);
    return { width, height, data };
  };
  out.lossless = [];
  for (const [w, h] of [[1, 1], [37, 21], [101, 3], [64, 64]]) {
    const source = paint(w, h),
      seen = await decoded(await encodeWebP(source), 'image/webp');
    out.lossless.push({ size: seen.size, want: [w, h], ...distance(premultiplied(seen.data), premultiplied(source.data)) });
  }
  const opaque = await decoded(await encodeWebP(pixels), 'image/webp');
  out.opaque = distance(opaque.data, pixels.data);
  // Lossy WebP is the browser's own encoder. Where its canvas has none (WebKit hands back a PNG), the library must say
  // so with its coded error; where it has one, the encode must work.
  const probeCanvas = new OffscreenCanvas(1, 1);
  probeCanvas.getContext('2d');
  const probe = await probeCanvas.convertToBlob({ type: 'image/webp' });
  if (probe.type === 'image/webp') {
    const lossy = await encodeWebP(pixels, { quality: 0.9 });
    out.lossy = { bytes: lossy.length, ...distance((await decoded(lossy, 'image/webp')).data, pixels.data) };
  } else {
    const refusal = await encodeWebP(pixels, { quality: 0.9 }).then(
      () => 'encoded',
      (error) => ({ code: error.code, message: error.message }),
    );
    out.lossyUnsupported = refusal;
  }
  const texture = stack.sceneTexture,
    hdr = await readTexture(engine, texture),
    file = await encodeEXR(hdr),
    parsed = parseEXR(file);
  let high = 0;
  for (let i = 0; i < hdr.data.length; i++) if (hdr.data[i] > high) high = hdr.data[i];
  out.exr = {
    size: [parsed.width, parsed.height],
    want: [hdr.width, hdr.height],
    high,
    mean: distance(parsed.data, hdr.data).mean,
    exact: distance(parsed.data, hdr.data).largest,
  };
  stack.dispose();
  engine.dispose();
  installed.dispose();
  return { ...out, errors };
};
window.ready = true;
