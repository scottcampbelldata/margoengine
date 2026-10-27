// Writes examples/assets/parity-clip.webm, the video the p-video parity scene plays (row 6.5, VideoTexture): 3 s of
// a moving test pattern at 1280 x 720, 30 fps, drawn on a canvas in headless Edge and recorded with MediaRecorder (VP8).
// The content is ours, generated here; rerun this script to rebuild it. Usage: node bench/scenes/make-clip.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { launchBrowser } from '../../scripts/lib/browser.mjs';

const out = resolve(import.meta.dirname, '../../examples/assets/parity-clip.webm');
const browser = await launchBrowser({ headless: true, needs: 'none' });
const page = await browser.newPage();
const base64 = await page.evaluate(async () => {
  const canvas = Object.assign(document.createElement('canvas'), { width: 1280, height: 720 }),
    g = canvas.getContext('2d'),
    stream = canvas.captureStream(30),
    recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 4_000_000 }),
    chunks = [];
  recorder.ondataavailable = (e) => chunks.push(e.data);
  const draw = (t) => {
    const grad = g.createLinearGradient(0, 0, 1280, 720);
    grad.addColorStop(0, `hsl(${(t * 40) % 360} 60% 40%)`);
    grad.addColorStop(1, `hsl(${(t * 40 + 180) % 360} 60% 30%)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, 1280, 720);
    for (let i = 0; i < 24; i++) {
      g.fillStyle = `hsl(${i * 15} 70% 60%)`;
      g.beginPath();
      g.arc(
        640 + Math.cos(t * 1.3 + i) * (200 + i * 12),
        360 + Math.sin(t * 0.9 + i * 2) * 250,
        30 + (i % 5) * 8,
        0,
        Math.PI * 2,
      );
      g.fill();
    }
    g.fillStyle = '#fff';
    g.font = 'bold 64px sans-serif';
    g.fillText(`frame ${Math.round(t * 30)}`, 60, 100);
  };
  recorder.start();
  const start = performance.now();
  await new Promise((done) => {
    const frame = () => {
      const t = (performance.now() - start) / 1000;
      draw(t);
      if (t < 3) requestAnimationFrame(frame);
      else done();
    };
    frame();
  });
  recorder.stop();
  await new Promise((r) => (recorder.onstop = r));
  const bytes = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
});
await browser.close();
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.from(base64, 'base64'));
console.log(`${out}: ${Buffer.from(base64, 'base64').length} bytes`);
