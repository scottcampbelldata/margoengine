// 10,000,000 points: Margo's Potree reader against potree-core.
// The rival is driven from its README and its published types: Potree, loadPointCloud,
// pointBudget, updatePointClouds, minNodePixelSize, material.size, PointSizeType.FIXED.
// This file does not read that library's source.
import { PointSizeType, Potree } from 'potree-core';
import * as THREE from 'three';
import { Engine } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { PointsPlugin } from '@margoengine/points';
import { OctreeCloud } from '@margoengine/points/octree';
import { PotreeSource } from '@margoengine/points/potree';
import { waitForPipelines } from './support/gpu-ready.js';
import { POINTS_SCENE } from './rival-points-scene.mjs';

const COUNT = POINTS_SCENE.nx * POINTS_SCENE.ny * POINTS_SCENE.nz;
const ROUNDS = 7;
const { camera: cam, budget, pointSize } = POINTS_SCENE;

const fail = (error) => {
  window.__rival = { error: String(error && error.message ? error.message : error), stack: error && error.stack };
};

const canvasOf = () => {
  const canvas = document.createElement('canvas');
  canvas.width = cam.width;
  canvas.height = cam.height;
  document.body.append(canvas);
  return canvas;
};

const settleRival = async (potree, clouds, camera, renderer, scene) => {
  let stable = 0;
  let last = -1;
  const started = performance.now();
  for (let i = 0; i < 4000; i++) {
    const update = potree.updatePointClouds(clouds, camera, renderer);
    renderer.render(scene, camera);
    const drawn = update.numVisiblePoints;
    if (update.nodeLoadFailed) throw new Error('rival node load failed');
    const pending = update.nodeLoadPromises.length > 0 || update.exceededMaxLoadsToGPU;
    if (!pending && drawn === last && drawn > 0) stable++;
    else stable = 0;
    last = drawn;
    if (stable >= 3 && drawn === COUNT) return drawn;
    if (performance.now() - started > 180_000) {
      throw new Error(`rival did not draw ${COUNT}; visible ${drawn} pending ${pending}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`rival selection did not settle; visible ${last}`);
};

try {
  const margoCanvas = canvasOf();
  const engine = await Engine.create(margoCanvas, {
    backend: 'webgpu',
    powerPreference: 'high-performance',
    camera: {
      position: cam.position,
      target: cam.target,
      fov: cam.fov,
      near: cam.near,
      far: cam.far,
    },
  });
  engine.stop();
  const device = engineRuntime(engine).gpu;
  const points = PointsPlugin.attach(engine, { pointBudget: budget });
  const source = await PotreeSource.open('/rival-data/metadata.json');
  const octree = OctreeCloud.attach(engine, points, source, {
    pointBudget: budget,
    maxLoadedPoints: budget,
    minNodePixels: 1,
    maxConcurrentLoads: 8,
    material: { size: pointSize, sizeAttenuation: false },
  });
  const frame = async () => {
    engine.render();
    await device.queue.onSubmittedWorkDone();
  };
  await waitForPipelines(frame, {
    ready: () => octree.stats.drawn === COUNT && octree.stats.loading === 0,
    timeoutMs: 180_000,
    describe: () => JSON.stringify(octree.stats),
  });

  const rivalCanvas = canvasOf();
  const renderer = new THREE.WebGLRenderer({ canvas: rivalCanvas, antialias: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(cam.width, cam.height, false);
  const camera = new THREE.PerspectiveCamera(cam.fov, cam.width / cam.height, cam.near, cam.far);
  camera.position.set(cam.position[0], cam.position[1], cam.position[2]);
  camera.up.set(cam.up[0], cam.up[1], cam.up[2]);
  camera.lookAt(cam.target[0], cam.target[1], cam.target[2]);
  camera.updateMatrixWorld();
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  const potree = new Potree();
  potree.pointBudget = budget;
  const cloud = await potree.loadPointCloud('metadata.json', '/rival-data/');
  cloud.minNodePixelSize = 1;
  cloud.material.size = pointSize;
  cloud.material.pointSizeType = PointSizeType.FIXED;
  cloud.material.shape = 0;
  scene.add(cloud);
  const rivalDrawn = await settleRival(potree, [cloud], camera, renderer, scene);
  const gl = renderer.getContext();
  const stallPixel = new Uint8Array(4);
  // fenceSync returns WAIT_FAILED in this browser. One pixel read back stalls until the draw is done.
  const waitGpu = () => {
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, stallPixel);
  };

  const timeMargo = async () => {
    const t0 = performance.now();
    engine.render();
    await device.queue.onSubmittedWorkDone();
    return performance.now() - t0;
  };
  const timeRival = () => {
    const t0 = performance.now();
    const update = potree.updatePointClouds([cloud], camera, renderer);
    renderer.render(scene, camera);
    waitGpu();
    return { ms: performance.now() - t0, drawn: update.numVisiblePoints };
  };

  for (let i = 0; i < 2; i++) {
    await timeMargo();
    timeRival();
  }
  renderer.info.autoReset = false;
  renderer.info.reset();
  const roundsA = [];
  const roundsB = [];
  let rivalFrameDrawn = 0;
  for (let i = 0; i < ROUNDS; i++) {
    if (i % 2 === 0) {
      roundsA.push(await timeMargo());
      const rival = timeRival();
      roundsB.push(rival.ms);
      rivalFrameDrawn = rival.drawn;
    } else {
      const rival = timeRival();
      roundsB.push(rival.ms);
      rivalFrameDrawn = rival.drawn;
      roundsA.push(await timeMargo());
    }
  }
  const info = renderer.info.render;
  if (info.calls !== ROUNDS || info.points !== COUNT * ROUNDS) {
    throw new Error(`rival draw was ${info.calls} calls and ${info.points} points over ${ROUNDS} frames`);
  }
  window.__rival = {
    margoDrawn: octree.stats.drawn,
    margoLoaded: octree.stats.loaded,
    rivalDrawn,
    rivalFrameDrawn,
    sourcePoints: source.points,
    calls: info.calls,
    renderPoints: info.points,
    minA: Math.min(...roundsA),
    minB: Math.min(...roundsB),
    roundsA,
    roundsB,
  };
} catch (error) {
  fail(error);
}
