import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { dirname } from 'node:path';
import { parseShot } from '../../tools/shot/shot-file.mjs';
import { colourSidecar } from './video-range.mjs';
import { openShotPage, CLOCK_START } from '../../tools/shot/render.mjs';

const [spec, output, limit] = process.argv.slice(2);
if (!spec || !output) throw new Error('Pass a shot file and an H.264 output path.');
const file = parseShot(JSON.parse(await readFile(spec, 'utf8')));
const { shot } = file;
const frames = Math.min(Math.round(shot.seconds * shot.fps), limit === undefined ? Infinity : Number(limit));
const browser = await openShotPage(file);
const errors = [];
const streamConfig = {
  codec: 'avc1.640029',
  width: shot.size[0],
  height: shot.size[1],
  bitrate: 28_000_000,
  framerate: shot.fps,
  hardwareAcceleration: 'prefer-hardware',
  latencyMode: 'realtime',
  avc: { format: 'annexb' },
};
const begin = Date.now();
const { page, server } = browser;
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (entry) => {
  if (entry.type() === 'error') errors.push(entry.text());
});
await mkdir(dirname(output), { recursive: true });
const out = createWriteStream(output);
try {
  const query = new URLSearchParams({ ...shot.page.query, quality: shot.tier });
  await page.goto('http://127.0.0.1:' + server.config.server.port + '/' + shot.page.path + '?' + query);
  await page.waitForFunction((key) => typeof window.__margoShot.get(key) === 'function', shot.page.apply, {
    timeout: 30_000,
    polling: 120,
  });
  const state = await page.evaluate(
    async ({ options, count, clock, target }) => {
      const driver = window.__margoShot;
      const paint = driver.get(target.apply);
      const canvas = document.querySelector(target.canvas);
      const { supported } = await VideoEncoder.isConfigSupported(options);
      if (!supported) throw new Error('Browser cannot encode requested H.264 spec.');
      for (let i = 0; i < count; i++) {
        await paint({ time: 0 }, { time: 0, kept: null });
        if (!driver.frame(clock)) throw new Error('No engine frame queued for warmup.');
        await driver.settle();
      }
      const encoded = [];
      let failure;
      // The encoder's own colour space (range and matrix) goes beside the stream, so export.mjs converts from it.
      window.captureColour = null;
      const encoder = new VideoEncoder({
        output(chunk, metadata) {
          if (metadata?.decoderConfig?.colorSpace) window.captureColour = { ...metadata.decoderConfig.colorSpace };
          const bytes = new Uint8Array(chunk.byteLength);
          chunk.copyTo(bytes);
          encoded.push(bytes);
        },
        error(error) {
          failure = error;
        },
      });
      encoder.configure(options);
      window.captureFilm = async (from, to) => {
        for (let i = from; i < to; i++) {
          if (failure) throw failure;
          const time = i / options.framerate;
          await paint({ time }, { time, kept: i });
          if (!driver.frame(clock + time * 1000)) throw new Error('No engine frame queued at ' + time);
          const timestamp = Math.round(1e6 * time);
          const duration = Math.round((1e6 * (i + 1)) / options.framerate) - timestamp;
          const frame = new VideoFrame(canvas, { timestamp, duration });
          try {
            encoder.encode(frame, { keyFrame: i % (options.framerate / 2) === 0 });
          } finally {
            frame.close();
          }
          if (encoder.encodeQueueSize >= 6)
            await new Promise((resolve) => encoder.addEventListener('dequeue', resolve, { once: true }));
        }
        await encoder.flush();
        if (!window.captureColour) throw new Error('The encoder reported no colour space.');
        const packets = encoded.splice(0);
        const all = new Uint8Array(packets.reduce((sum, bytes) => sum + bytes.length, 0));
        let offset = 0;
        for (const packet of packets) {
          all.set(packet, offset);
          offset += packet.length;
        }
        let binary = '';
        for (let i = 0; i < all.length; i += 16384) binary += String.fromCharCode(...all.subarray(i, i + 16384));
        return { count: packets.length, base64: btoa(binary), colour: window.captureColour };
      };
      return { width: canvas.width, height: canvas.height, hardware: driver.get(target.engine).gpu.adapterInfo };
    },
    { options: streamConfig, count: shot.warmup, clock: CLOCK_START, target: shot.page },
  );
  console.log('Capture', state);
  for (let i = 0; i < frames; i += 24) {
    const end = Math.min(i + 24, frames);
    const batch = await page.evaluate(({ from, to }) => window.captureFilm(from, to), { from: i, to: end });
    if (errors.length) throw new Error(errors.join('\n'));
    if (batch.count !== end - i) throw new Error('Missing encoded frames in batch ' + i);
    if (i === 0) await writeFile(colourSidecar(output), JSON.stringify(batch.colour) + '\n');
    if (!out.write(Buffer.from(batch.base64, 'base64'))) await once(out, 'drain');
    console.log(end + '/' + frames + ' frames in ' + ((Date.now() - begin) / 1000).toFixed(2) + ' s');
  }
  out.end();
  await once(out, 'finish');
} finally {
  out.destroy();
  await browser.close();
}
