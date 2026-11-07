// A real render: a cutscene drives a scene on a real GPU, the browser's encoders make the file through Margo's
// containers, and the browser's demuxers and decoders read it back.
import { Camera, Engine, PbrMaterial, box } from '@margoengine/core';
import { createHeadlessCanvas, installGPU } from '@margoengine/headless';
import { Cutscene, CutscenePlayer } from '../src/index.ts';
import { renderCutscene } from '../src/render.ts';
import { shotTrack } from '../src/shots.ts';

const FPS = 30,
  TONE = 440,
  RATE = 48_000;

/** One second of a sine, as an AudioBuffer: a real one, the type people pass. */
function tone() {
  const buffer = new AudioBuffer({ length: RATE, sampleRate: RATE, numberOfChannels: 1 }),
    data = buffer.getChannelData(0);
  for (let i = 0; i < RATE; i++) data[i] = 0.5 * Math.sin((2 * Math.PI * TONE * i) / RATE);
  return buffer;
}

const scene = () => ({
  format: 'margo-cutscene',
  version: 1,
  duration: 2,
  markers: [{ time: 1, name: 'half' }],
  tracks: [
    {
      type: 'shot',
      id: 'edit',
      cameras: {
        front: { position: [0, 0, 4], target: [0, 0, 0] },
        close: { position: [0, 0, 2], target: [0, 0, 0] },
      },
      clips: [
        { start: 0, duration: 1, camera: 'front' },
        { start: 1, duration: 1, camera: 'close' },
      ],
    },
    {
      type: 'transform',
      id: 'move',
      target: 'cube',
      keys: [
        { time: 0, position: [-1, 0, 0] },
        { time: 2, position: [1, 0, 0] },
      ],
    },
    { type: 'event', id: 'cues', events: [{ time: 0.5, name: 'early' }, { time: 1.5, name: 'late' }] },
    { type: 'audio', id: 'music', clips: [{ start: 1, duration: 1, sound: 'tone' }] },
  ],
});

async function shown(video, time) {
  const seeked = new Promise((done) => video.addEventListener('seeked', done, { once: true }));
  video.currentTime = time;
  await seeked;
  const canvas = new OffscreenCanvas(video.videoWidth, video.videoHeight),
    context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(video, 0, 0);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

/** Mean column of the pixels that differ from the corner: where the cube is across the picture, 0 to 1. */
function centre({ data, width, height }) {
  let sum = 0,
    count = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (Math.abs(data[i] - data[0]) + Math.abs(data[i + 1] - data[1]) + Math.abs(data[i + 2] - data[2]) > 48) {
        sum += x;
        count++;
      }
    }
  return { at: count ? sum / count / width : -1, covered: count / (width * height) };
}

window.check = async (format) => {
  const installed = installGPU({ gpu: navigator.gpu }),
    canvas = createHeadlessCanvas({ width: 256, height: 192 }),
    engine = await Engine.create(canvas, { backend: 'webgpu' }),
    errors = [],
    camera = new Camera(),
    cube = engine.createMesh().setGeometry(box()).setMaterial(new PbrMaterial({ color: '#e8d44d', roughness: 0.4 })),
    cutscene = new Cutscene(scene(), { tracks: [shotTrack()] }),
    player = new CutscenePlayer(cutscene),
    fired = [],
    times = [],
    progress = [];
  engine.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  player.on('*', (event) => fired.push(`${event.kind}:${event.name}@${event.time}`));
  const file = await renderCutscene(engine, player, {
    format,
    fps: FPS,
    camera,
    bitrate: 4_000_000,
    keyFrameInterval: 0.5,
    sounds: { tone: tone() },
    apply(state, frame) {
      times.push(frame.time);
      cube.setPosition(state.transforms.cube.position);
    },
    onProgress: (done) => progress.push(done),
  });
  engine.dispose();
  installed.dispose();

  const blob = new Blob([file.bytes], { type: file.mimeType }),
    video = document.createElement('video');
  video.muted = true;
  video.src = URL.createObjectURL(blob);
  await new Promise((done, fail) => {
    video.addEventListener('loadeddata', done, { once: true });
    video.addEventListener('error', () => fail(new Error(video.error?.message ?? 'video error')), { once: true });
  });
  const before = centre(await shown(video, 0.25)),
    middle = centre(await shown(video, 0.75)),
    after = centre(await shown(video, 1.25));

  // The browser's own read of the sound in the file.
  const context = new OfflineAudioContext(1, RATE, RATE),
    sound = await context.decodeAudioData(await blob.arrayBuffer()),
    data = sound.getChannelData(0),
    rms = (from, to) => {
      let sum = 0;
      const a = Math.round(from * sound.sampleRate),
        b = Math.round(to * sound.sampleRate);
      for (let i = a; i < b; i++) sum += data[i] ** 2;
      return Math.sqrt(sum / (b - a));
    };
  // Where the tone starts: the first sample above a tenth of its height.
  let onset = -1;
  for (let i = 0; i < data.length; i++)
    if (Math.abs(data[i]) > 0.05) {
      onset = i / sound.sampleRate;
      break;
    }
  let crossings = 0;
  const from = Math.round(1.2 * sound.sampleRate),
    to = Math.round(1.8 * sound.sampleRate);
  for (let i = from + 1; i < to; i++) if (data[i - 1] < 0 !== data[i] < 0) crossings++;
  return {
    codec: file.codec,
    audioCodec: file.audioCodec,
    frames: file.frames,
    bytes: file.bytes.length,
    file: [...file.bytes],
    duration: video.duration,
    width: video.videoWidth,
    fired,
    times,
    progress,
    before,
    middle,
    after,
    errors,
    sound: {
      length: sound.duration,
      rate: sound.sampleRate,
      quiet: rms(0.1, 0.9),
      loud: rms(1.2, 1.8),
      onset,
      hertz: crossings / 2 / 0.6,
    },
  };
};
window.ready = true;
