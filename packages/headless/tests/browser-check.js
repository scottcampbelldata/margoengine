// The same scene on a page canvas and on the stand-in, each on its own engine and device of the same adapter.
import { Camera, Engine, PbrMaterial, box } from '../../core/src/index.ts';
import { createHeadlessCanvas, installGPU, toPNG } from '../src/index.ts';
import { encodeVideo, renderFrames } from '../src/video.ts';

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
window.ready = true;
