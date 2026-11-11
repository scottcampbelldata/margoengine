// Truck view 000001: Margo splats against the published photograph, correctness only (no rival, no clock).
// The cloud file comes from the query (`?ply=truck-7k.ply`, the whole 7,000-iteration cloud, by default).
import { Engine } from '@margoengine/core';
import { Splats } from '@margoengine/splats';
import { parsePly } from '@margoengine/splats/data';
import { waitForPipelines } from './support/gpu-ready.js';
import { maeRgb, paperPose, psnrRgb } from './rival-splats-camera.mjs';

const NEAR = Number(new URLSearchParams(location.search).get('near') ?? 0.01);
const FAR = 100;

const pixelsOf = async (canvas) => {
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const blob = await (await fetch(canvas.toDataURL('image/png'))).blob();
  const bitmap = await createImageBitmap(blob);
  const out = new OffscreenCanvas(bitmap.width, bitmap.height);
  const g = out.getContext('2d', { willReadFrequently: true });
  g.drawImage(bitmap, 0, 0);
  bitmap.close();
  return g.getImageData(0, 0, out.width, out.height).data;
};

try {
  const params = new URLSearchParams(location.search);
  const ply = params.get('ply') ?? 'truck-7k.ply';
  const cam = (await (await fetch('/rival-data/truck-cameras.json')).json()).find((row) => row.img_name === '000001');
  const shot = await createImageBitmap(await (await fetch('/rival-data/truck-000001.jpg')).blob());
  const { width, height } = shot;
  const photoCanvas = new OffscreenCanvas(width, height);
  const pg = photoCanvas.getContext('2d', { willReadFrequently: true });
  pg.drawImage(shot, 0, 0);
  const photo = pg.getImageData(0, 0, width, height).data;
  shot.close();
  const canvas = document.getElementById('margo');
  canvas.width = width;
  canvas.height = height;
  canvas.style.cssText = `position:absolute;left:0;top:0;width:${width}px;height:${height}px`;
  const data = parsePly(await (await fetch(`/rival-data/${ply}`)).arrayBuffer());
  const engine = await Engine.create(canvas, {
    backend: 'webgpu',
    preserveDrawingBuffer: true,
    camera: { position: cam.position, target: [0, 0, 0], near: NEAR, far: FAR, fov: 60 },
  });
  engine.scene.background = '#000000';
  const cloud = Splats.attach(engine, data);
  const draw = async () => {
    engine.render({ delta: 1 / 60 });
    await engine.gpu.queue.onSubmittedWorkDone();
  };
  await waitForPipelines(draw, { timeoutMs: 120000 });
  const poses = {};
  for (const mode of ['w2c', 'c2w']) {
    const pose = paperPose(cam, mode);
    engine.camera.fov = pose.fov;
    engine.camera.near = NEAR;
    engine.camera.far = FAR;
    engine.camera.position = pose.position;
    engine.camera.target = pose.target;
    engine.camera.up = pose.up;
    await draw();
    await draw();
    const image = await pixelsOf(canvas);
    poses[mode] = { psnr: psnrRgb(image, photo), mae: maeRgb(image, photo) };
    if (params.has('save')) poses[mode].png = canvas.toDataURL('image/png');
  }
  window.__photo = { ply, count: data.positions.length / 3, drawn: cloud.count, width, height, poses };
} catch (error) {
  window.__photo = { error: String(error && error.message ? error.message : error), stack: error && error.stack };
}
