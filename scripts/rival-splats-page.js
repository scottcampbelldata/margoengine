// Truck view 000001: Margo splats against the published photograph, and a frame against GaussianSplats3D.
// The rival is driven from its README (Viewer, selfDrivenMode, addSplatScene, update, render).
// This file does not read that library's source.
import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d';
import * as THREE from 'three';
import { Engine } from '@margoengine/core';
import { Splats } from '@margoengine/splats';
import { parsePly } from '@margoengine/splats/data';
import { waitForPipelines } from './support/gpu-ready.js';
import { maeRgb, paperPose, psnrRgb } from './rival-splats-camera.mjs';

const NEAR = 0.01;
const FAR = 100;
const ROUNDS = 7;

const fail = (error) => {
  window.__rival = { error: String(error && error.message ? error.message : error), stack: error && error.stack };
};

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

const photoPixels = async () => {
  const blob = await (await fetch('/rival-data/truck-000001.jpg')).blob();
  const bitmap = await createImageBitmap(blob);
  const out = new OffscreenCanvas(bitmap.width, bitmap.height);
  const g = out.getContext('2d', { willReadFrequently: true });
  g.drawImage(bitmap, 0, 0);
  const data = g.getImageData(0, 0, bitmap.width, bitmap.height).data;
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return { data, ...size };
};

const applyThree = (camera, pose) => {
  camera.fov = pose.fov;
  camera.near = NEAR;
  camera.far = FAR;
  camera.position.set(pose.position[0], pose.position[1], pose.position[2]);
  camera.up.set(pose.up[0], pose.up[1], pose.up[2]);
  camera.lookAt(pose.target[0], pose.target[1], pose.target[2]);
  camera.updateProjectionMatrix();
};

const applyMargo = (engine, pose) => {
  engine.camera.fov = pose.fov;
  engine.camera.near = NEAR;
  engine.camera.far = FAR;
  engine.camera.position = pose.position;
  engine.camera.target = pose.target;
  engine.camera.up = pose.up;
};

const stats = (data) => {
  let r = 0;
  let g = 0;
  let b = 0;
  let nonzero = 0;
  const pixels = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    if (data[i] | data[i + 1] | data[i + 2]) nonzero++;
  }
  return { mean: [r / pixels, g / pixels, b / pixels], nonzero, pixels };
};

const fence = async (gl) => {
  const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  gl.flush();
  await new Promise((resolve) => {
    const spin = () => {
      const status = gl.clientWaitSync(sync, 0, 0);
      if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) {
        gl.deleteSync(sync);
        resolve();
      } else setTimeout(spin, 0);
    };
    spin();
  });
};

try {
  const cam = (await (await fetch('/rival-data/truck-cameras.json')).json()).find((row) => row.img_name === '000001');
  const photoShot = await photoPixels();
  const photo = photoShot.data;
  const width = photoShot.width;
  const height = photoShot.height;
  const canvas = document.getElementById('margo');
  canvas.width = width;
  canvas.height = height;
  canvas.style.cssText = `position:absolute;left:0;top:0;width:${width}px;height:${height}px`;
  const root = document.getElementById('rival');
  root.style.cssText = `position:absolute;left:0;top:${height + 4}px;width:${width}px;height:${height}px`;

  const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true, alpha: false });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  renderer.setClearColor(0x000000, 1);
  root.appendChild(renderer.domElement);
  const camera = new THREE.PerspectiveCamera(60, width / height, NEAR, FAR);
  const isolated = typeof crossOriginIsolated === 'boolean' && crossOriginIsolated;
  const viewer = new GaussianSplats3D.Viewer({
    selfDrivenMode: false,
    renderer,
    camera,
    useBuiltInControls: false,
    ignoreDevicePixelRatio: true,
    gpuAcceleratedSort: false,
    sharedMemoryForWorkers: false,
    integerBasedSort: false,
    sphericalHarmonicsDegree: 3,
    antialiased: false,
    sceneRevealMode: GaussianSplats3D.SceneRevealMode.Instant,
    renderMode: GaussianSplats3D.RenderMode.Always,
    logLevel: GaussianSplats3D.LogLevel.None,
  });
  const loaded = viewer.addSplatScene('/rival-data/truck-7k-fit.ply', {
    splatAlphaRemovalThreshold: 0,
    showLoadingUI: false,
  });

  const bytes = await (await fetch('/rival-data/truck-7k-fit.ply')).arrayBuffer();
  const data = parsePly(bytes);
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
  await loaded;
  engine.scene.background = '#ff0000';
  await draw();
  const probe = stats(await pixelsOf(canvas));
  engine.scene.background = '#000000';
  renderer.setClearColor(0xff0000, 1);
  renderer.clear();
  await fence(renderer.getContext());
  const rivalProbe = stats(await pixelsOf(renderer.domElement));
  renderer.setClearColor(0x000000, 1);

  const poses = {};
  let winner = 'w2c';
  for (const mode of ['w2c', 'c2w']) {
    const pose = paperPose(cam, mode);
    applyMargo(engine, pose);
    await draw();
    await draw();
    const image = await pixelsOf(canvas);
    poses[mode] = { psnr: psnrRgb(image, photo), mae: maeRgb(image, photo), fov: pose.fov, ...stats(image) };
    if (poses[mode].psnr > poses[winner].psnr) winner = mode;
  }
  const pose = paperPose(cam, winner);
  applyMargo(engine, pose);
  applyThree(camera, pose);
  const gl = renderer.getContext();
  let reveal = 0;
  let revealStats = null;
  for (; reveal < 40; reveal++) {
    viewer.update();
    viewer.render();
    await fence(gl);
    revealStats = stats(await pixelsOf(renderer.domElement));
    if (revealStats.nonzero > 1000) break;
  }

  const timeMargo = async () => {
    const t0 = performance.now();
    engine.render({ delta: 1 / 60 });
    await engine.gpu.queue.onSubmittedWorkDone();
    return performance.now() - t0;
  };
  const timeRival = async () => {
    const t0 = performance.now();
    viewer.update();
    viewer.render();
    await fence(gl);
    return performance.now() - t0;
  };
  for (let i = 0; i < 2; i++) {
    await timeMargo();
    await timeRival();
  }
  const roundsA = [];
  const roundsB = [];
  for (let i = 0; i < ROUNDS; i++) {
    if (i % 2 === 0) {
      roundsA.push(await timeMargo());
      roundsB.push(await timeRival());
    } else {
      roundsB.push(await timeRival());
      roundsA.push(await timeMargo());
    }
  }
  await draw();
  viewer.update();
  viewer.render();
  await fence(gl);
  const margoImage = await pixelsOf(canvas);
  const rivalImage = await pixelsOf(renderer.domElement);
  window.__rival = {
    count: data.positions.length / 3,
    width,
    height,
    isolated,
    winner,
    poses,
    minA: Math.min(...roundsA),
    minB: Math.min(...roundsB),
    roundsA,
    roundsB,
    psnr: psnrRgb(margoImage, photo),
    mae: maeRgb(margoImage, photo),
    rivalPsnr: psnrRgb(rivalImage, photo),
    rivalMae: maeRgb(rivalImage, photo),
    frame: stats(margoImage),
    rivalFrame: stats(rivalImage),
    probe,
    rivalProbe,
    reveal,
    revealStats,
    drawCalls: renderer.info.render.calls,
    canvases: document.querySelectorAll('canvas').length,
    sameRenderer: viewer.renderer === renderer,
    sortPath: 'cpu',
    ink: cloud.count,
  };
} catch (error) {
  fail(error);
}
