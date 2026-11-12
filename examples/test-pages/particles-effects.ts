import { ready } from './page-harness';
import { createStage, type Stage } from '@margoengine/stage';
import { Geometry } from '@margoengine/core';
import { sphereGeometry, torusGeometry } from '@margoengine/geometry';
import { VFX } from '@margoengine/vfx';
import { PointsPlugin, PointCloud } from '@margoengine/points';
import { Splats, type SplatData } from '@margoengine/splats';
import { Lines, Line, GridHelper, AxesHelper } from '@margoengine/lines';
import { SpriteLayer, type Sprite } from '@margoengine/sprites';
import { Toon } from '@margoengine/toon';
import { LayerCompositor } from '@margoengine/pixel';
import { Lighting2D } from '@margoengine/lighting2d';
import { install as installWebGL2Compat } from '@margoengine/webgl2-compat';

// Backend detection
const params = new URLSearchParams(window.location.search);
const useWebGL2 = params.get('backend') === 'webgl2';
const backendBadge = document.querySelector<HTMLElement>('#backend-badge')!;
if (backendBadge) {
  backendBadge.textContent = useWebGL2 ? 'WebGL2 Fallback' : 'WebGPU';
  backendBadge.className = 'badge ' + (useWebGL2 ? 'gl2' : 'gpu');
}

// Global test diagnostic tracking
(window as any).__testErrors = [];
(window as any).__testStatus = 'initializing';
(window as any).__benchmarkResult = null;

window.addEventListener('error', (e) => {
  console.error('[Page Error Caught]', e.message, e.filename, e.lineno);
  (window as any).__testErrors.push({
    message: e.message,
    filename: e.filename,
    lineno: e.lineno,
  });
});

let stage: Stage | null = null;
let vfxPlugin: VFX | null = null;
let pointsPlugin: PointsPlugin | null = null;
let _pointCloud: PointCloud | null = null;
let splatsPlugin: Splats | null = null;
let linesPlugin: Lines | null = null;
let dynamicLine: Line | null = null;
let spriteLayer: SpriteLayer | null = null;
let toonPlugin: Toon | null = null;
let layerCompositor: LayerCompositor | null = null;
let lighting2DPlugin: Lighting2D | null = null;

const centerMeshes: any[] = [];
const dynamicSprites: Sprite[] = [];

// Element counts
let vfxCapacity = 50000;
let vfxRate = 25000;
let pointsCount = 30000;
let splatsCount = 8000;
let spritesCount = 1000;
let linesCount = 500;

// Performance Telemetry
let frameCount = 0;
let lastFpsTime = performance.now();
let lastFrameTime = performance.now();
let currentFps = 60;
let currentFrameDuration = 16.6;
let avgFrameTime = 16.6;

function createGeometryFromData(data: {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint16Array | Uint32Array;
}) {
  return new Geometry(data.positions, data.normals, data.indices);
}

// Generate spiral PointCloud positions and colors
function generatePointsData(count: number) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const idx = i * 3;
    const cIdx = i * 4;
    const r = (i / count) * 8.0 + 1.0;
    const theta = (i / count) * Math.PI * 16.0;
    positions[idx] = Math.cos(theta) * r + (Math.random() - 0.5) * 0.4;
    positions[idx + 1] = (Math.random() - 0.5) * 2.0;
    positions[idx + 2] = Math.sin(theta) * r + (Math.random() - 0.5) * 0.4;

    colors[cIdx] = 0.2 + (r / 9.0) * 0.8;
    colors[cIdx + 1] = 0.4 + Math.sin(theta) * 0.3;
    colors[cIdx + 2] = 1.0 - (r / 9.0) * 0.5;
    colors[cIdx + 3] = 0.9;
  }
  return { positions, colors };
}

// Generate valid synthetic Gaussian Splat data (positive-definite covariances)
function generateSplatsData(count: number): SplatData {
  const positions = new Float32Array(count * 3);
  const covariances = new Float32Array(count * 6);
  const colors = new Float32Array(count * 4);

  for (let i = 0; i < count; i++) {
    const pIdx = i * 3;
    const cvIdx = i * 6;
    const cIdx = i * 4;

    const u = Math.random();
    const v = Math.random();
    const theta = u * 2.0 * Math.PI;
    const phi = Math.acos(2.0 * v - 1.0);
    const radius = 3.5 + Math.random() * 1.5;

    positions[pIdx] = radius * Math.sin(phi) * Math.cos(theta);
    positions[pIdx + 1] = radius * Math.sin(phi) * Math.sin(theta) + 2.0;
    positions[pIdx + 2] = radius * Math.cos(phi);

    // Positive-definite covariance matrix (xx, xy, xz, yy, yz, zz)
    const scale = 0.04 + Math.random() * 0.03;
    covariances[cvIdx] = scale; // xx
    covariances[cvIdx + 1] = 0.0; // xy
    covariances[cvIdx + 2] = 0.0; // xz
    covariances[cvIdx + 3] = scale; // yy
    covariances[cvIdx + 4] = 0.0; // yz
    covariances[cvIdx + 5] = scale; // zz

    colors[cIdx] = 1.0;
    colors[cIdx + 1] = 0.5 + Math.random() * 0.4;
    colors[cIdx + 2] = 0.1;
    colors[cIdx + 3] = 0.75;
  }

  return { positions, covariances, colors };
}

// Generate fat line sine wave positions
function generateLinePositions(count: number): Float32Array {
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const idx = i * 3;
    const t = (i / count) * 20.0 - 10.0;
    positions[idx] = t;
    positions[idx + 1] = Math.sin(t * 1.5) * 1.5 + 4.0;
    positions[idx + 2] = Math.cos(t * 1.5) * 1.5;
  }
  return positions;
}

async function init() {
  const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;
  if (useWebGL2) {
    try {
      await installWebGL2Compat({ force: true });
    } catch (e) {
      console.warn('installWebGL2Compat failed:', e);
    }
  }

  stage = await createStage(canvas, {
    autoStart: false,
    controls: false,
    camera: { position: [0, 6, 16], target: [0, 2, 0] },
  });
  // Scene look: clear colour and lighting live on the scene, not in the stage options.
  stage.engine.scene.background = '#07090e';
  stage.engine.lighting.direction.set([6, 12, 8, 2.5]);
  stage.engine.lighting.radiance.set([1, 0.95, 0.9, 1]);
  stage.engine.lighting.ambient.set([0.1, 0.12, 0.18]);

  const engine = stage.engine;

  // 1. ATTACH VFX GPU PARTICLES (@margoengine/vfx)
  try {
    vfxPlugin = VFX.attach(engine, {
      capacity: vfxCapacity,
      rate: vfxRate,
      position: [0, 0.5, 0],
      velocity: [0, 4.5, 0],
      spread: 2.5,
      lifetime: [0.8, 2.2],
      size: 0.1,
      color: [1.0, 0.45, 0.1, 1.0],
      gravity: [0, -9.81, 0],
      ground: 0,
      bounce: 0.4,
      turbulence: 1.8,
    });
  } catch (err: any) {
    console.warn('[VFX Attach Failed - expected on WebGL2]', err);
    (window as any).__vfxError = err.message || String(err);
  }

  // 2. ATTACH POINT CLOUD (@margoengine/points)
  try {
    pointsPlugin = PointsPlugin.attach(engine, { pointBudget: 1000000 });
    const { positions, colors } = generatePointsData(pointsCount);
    _pointCloud = pointsPlugin.add(
      new PointCloud({
        positions,
        colors,
        material: { size: 3, shape: 'round', edl: true },
      }),
    );
  } catch (err: any) {
    console.warn('[Points Attach Failed - expected on WebGL2]', err);
    (window as any).__pointsError = err.message || String(err);
  }

  // 3. ATTACH GAUSSIAN SPLATS (@margoengine/splats)
  try {
    const splatData = generateSplatsData(splatsCount);
    splatsPlugin = Splats.attach(engine, splatData);
  } catch (err: any) {
    console.warn('[Splats Attach Failed - expected on WebGL2]', err);
    (window as any).__splatsError = err.message || String(err);
  }

  // 4. ATTACH FAT LINES & HELPERS (@margoengine/lines)
  try {
    linesPlugin = Lines.attach(engine);
    linesPlugin.add(new GridHelper({ size: 24, divisions: 24 }));
    linesPlugin.add(new AxesHelper({ size: 3, width: 2 }));

    const linePoints = generateLinePositions(linesCount);
    dynamicLine = linesPlugin.add(
      new Line({
        positions: linePoints,
        width: 3.5,
        join: 'round',
        cap: 'round',
        color: '#38bdf8',
      }),
    );
  } catch (err: any) {
    console.warn('[Lines Attach Failed - expected on WebGL2]', err);
    (window as any).__linesError = err.message || String(err);
  }

  // 5. ATTACH SPRITE LAYER (@margoengine/sprites)
  try {
    const atlasBytes = new Uint8Array([255, 100, 50, 255, 50, 200, 255, 255, 255, 220, 50, 255, 200, 50, 255, 255]);
    spriteLayer = SpriteLayer.attach(engine, {
      atlas: { width: 2, height: 2, data: atlasBytes },
      ySort: true,
    });
    populateSprites(spritesCount);
  } catch (err: any) {
    console.warn('[Sprites Attach Failed - expected on WebGL2]', err);
    (window as any).__spritesError = err.message || String(err);
  }

  // 6. ATTACH TOON OUTLINES (@margoengine/toon)
  try {
    toonPlugin = Toon.attach(engine, { bands: 4, rim: 0.15, outline: 0.03 });
  } catch (err: any) {
    console.warn('[Toon Attach Failed - expected on WebGL2]', err);
    (window as any).__toonError = err.message || String(err);
  }

  // 7. ATTACH PIXEL COMPOSITOR & LIGHTING2D (@margoengine/pixel & @margoengine/lighting2d)
  try {
    layerCompositor = LayerCompositor.attach(engine, {
      camera: { width: 320, height: 180, zoom: 2 },
    });
    const shadeLayer = layerCompositor.addLayer({ blend: 'multiply', z: 1 });
    lighting2DPlugin = Lighting2D.attach(engine, {
      target: shadeLayer.target,
      camera: shadeLayer.camera,
      ambient: '#151525',
    });
    lighting2DPlugin.addLight({
      x: 160,
      y: 90,
      radius: 120,
      color: '#ffd080',
      intensity: 1.5,
    });
  } catch (err: any) {
    console.warn('[Pixel/Lighting2D Attach Failed - expected on WebGL2]', err);
    (window as any).__lighting2dError = err.message || String(err);
  }

  // Build 3D central meshes
  buildCenterMeshes();

  // Setup HUD controls
  setupHUDControls();

  // Start loop
  requestAnimationFrame(renderLoop);
  (window as any).__testStatus = 'ready';
}

function buildCenterMeshes() {
  if (!stage) return;
  const engine = stage.engine;

  const torusGeom = createGeometryFromData(torusGeometry(2.2, 0.45, 24, 48));
  const torusMesh = engine.createMesh().setGeometry(torusGeom);
  torusMesh.position.set(0, 2.5, 0);
  centerMeshes.push(torusMesh);

  const sphereGeom = createGeometryFromData(sphereGeometry(1.2, 32, 24));
  const sphereMesh = engine.createMesh().setGeometry(sphereGeom);
  sphereMesh.position.set(0, 2.5, 0);
  centerMeshes.push(sphereMesh);
}

function populateSprites(count: number) {
  if (!spriteLayer) return;
  spriteLayer.clearSprites();
  dynamicSprites.length = 0;

  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2.0;
    const r = 50 + Math.random() * 80;
    const s = spriteLayer.add({
      x: 160 + Math.cos(angle) * r,
      y: 90 + Math.sin(angle) * r,
      scaleX: 2 + Math.random() * 3,
      scaleY: 2 + Math.random() * 3,
      alpha: 0.7 + Math.random() * 0.3,
    });
    dynamicSprites.push(s);
  }
}

function updateTotalCountDisplay() {
  const total = vfxCapacity + pointsCount + splatsCount + spritesCount + linesCount;
  const el = document.querySelector<HTMLElement>('#stat-total');
  if (el) el.textContent = total.toLocaleString();
}

function setupHUDControls() {
  const vfxCapSlider = document.querySelector<HTMLInputElement>('#slider-vfx-cap');
  vfxCapSlider?.addEventListener('input', () => {
    vfxCapacity = parseInt(vfxCapSlider.value, 10);
    const val = document.querySelector<HTMLElement>('#val-vfx-cap');
    if (val) val.textContent = vfxCapacity.toLocaleString();
    updateTotalCountDisplay();
  });

  const vfxRateSlider = document.querySelector<HTMLInputElement>('#slider-vfx-rate');
  vfxRateSlider?.addEventListener('input', () => {
    vfxRate = parseInt(vfxRateSlider.value, 10);
    const val = document.querySelector<HTMLElement>('#val-vfx-rate');
    if (val) val.textContent = vfxRate.toLocaleString();
    if (vfxPlugin) vfxPlugin.options.rate = vfxRate;
  });

  document.querySelector('#btn-vfx-burst')?.addEventListener('click', () => {
    if (vfxPlugin) vfxPlugin.burst(10000);
  });

  let vfxPaused = false;
  document.querySelector('#btn-vfx-toggle')?.addEventListener('click', () => {
    if (!vfxPlugin) return;
    vfxPaused = !vfxPaused;
    vfxPlugin.options.rate = vfxPaused ? 0 : vfxRate;
    const btn = document.querySelector<HTMLElement>('#btn-vfx-toggle');
    if (btn) btn.textContent = vfxPaused ? 'Resume Emitter' : 'Pause Emitter';
  });

  let rapidInterval: number | null = null;
  document.querySelector('#btn-vfx-rapid')?.addEventListener('click', () => {
    if (rapidInterval !== null) {
      clearInterval(rapidInterval);
      rapidInterval = null;
      const btn = document.querySelector<HTMLElement>('#btn-vfx-rapid');
      if (btn) btn.textContent = 'Rapid Toggle (100ms)';
      return;
    }

    const btn = document.querySelector<HTMLElement>('#btn-vfx-rapid');
    if (btn) btn.textContent = 'Stop Rapid Toggle';
    let toggled = false;
    let cycles = 0;
    rapidInterval = window.setInterval(() => {
      cycles++;
      toggled = !toggled;
      if (vfxPlugin) {
        vfxPlugin.options.rate = toggled ? 100000 : 0;
        if (toggled) vfxPlugin.burst(5000);
      }
      if (cycles > 40) {
        clearInterval(rapidInterval!);
        rapidInterval = null;
        if (btn) btn.textContent = 'Rapid Toggle (100ms)';
      }
    }, 100);
  });

  const pointsSlider = document.querySelector<HTMLInputElement>('#slider-points');
  pointsSlider?.addEventListener('input', () => {
    pointsCount = parseInt(pointsSlider.value, 10);
    const val = document.querySelector<HTMLElement>('#val-points');
    if (val) val.textContent = pointsCount.toLocaleString();
    updateTotalCountDisplay();
  });

  const splatsSlider = document.querySelector<HTMLInputElement>('#slider-splats');
  splatsSlider?.addEventListener('input', () => {
    splatsCount = parseInt(splatsSlider.value, 10);
    const val = document.querySelector<HTMLElement>('#val-splats');
    if (val) val.textContent = splatsCount.toLocaleString();
    updateTotalCountDisplay();
  });

  const spritesSlider = document.querySelector<HTMLInputElement>('#slider-sprites');
  spritesSlider?.addEventListener('input', () => {
    spritesCount = parseInt(spritesSlider.value, 10);
    const val = document.querySelector<HTMLElement>('#val-sprites');
    if (val) val.textContent = spritesCount.toLocaleString();
    populateSprites(spritesCount);
    updateTotalCountDisplay();
  });

  const linesSlider = document.querySelector<HTMLInputElement>('#slider-lines');
  linesSlider?.addEventListener('input', () => {
    linesCount = parseInt(linesSlider.value, 10);
    const val = document.querySelector<HTMLElement>('#val-lines');
    if (val) val.textContent = linesCount.toLocaleString();
    if (dynamicLine) {
      dynamicLine.setPositions(generateLinePositions(linesCount));
    }
    updateTotalCountDisplay();
  });

  document.querySelector('#btn-benchmark-33ms')?.addEventListener('click', () => {
    run33msBenchmark();
  });

  document.querySelector('#btn-recreate')?.addEventListener('click', async () => {
    await recreateAll();
  });

  document.querySelector('#btn-res-mobile')?.addEventListener('click', () => {
    const viewport = document.querySelector<HTMLElement>('#viewport');
    if (viewport) {
      viewport.style.width = '390px';
      viewport.style.height = '844px';
      viewport.style.position = 'relative';
      viewport.style.margin = '20px auto';
      viewport.style.border = '2px solid #38bdf8';
    }
  });

  document.querySelector('#btn-res-reset')?.addEventListener('click', () => {
    const viewport = document.querySelector<HTMLElement>('#viewport');
    if (viewport) {
      viewport.style.width = '100%';
      viewport.style.height = '100%';
      viewport.style.position = 'absolute';
      viewport.style.margin = '0';
      viewport.style.border = 'none';
    }
  });
}

// 33 ms benchmark: raise counts until frame time reaches or exceeds 33.3 ms
async function run33msBenchmark() {
  const card = document.querySelector<HTMLElement>('#benchmark-card');
  const text = document.querySelector<HTMLElement>('#benchmark-text');
  if (card) card.style.display = 'block';
  if (text) text.textContent = 'Benchmarking... ramping counts up...';

  let step = 0;
  const maxSteps = 15;
  while (step < maxSteps) {
    step++;
    await new Promise((r) => setTimeout(r, 400));

    // Check average frame time
    if (currentFrameDuration >= 33.3) {
      const summary = `Hit 33 ms threshold! Frame time: ${currentFrameDuration.toFixed(1)} ms (${currentFps} FPS) with VFX: ${vfxCapacity.toLocaleString()}, Points: ${pointsCount.toLocaleString()}, Splats: ${splatsCount.toLocaleString()}, Sprites: ${spritesCount.toLocaleString()}, Lines: ${linesCount.toLocaleString()}. Total: ${(vfxCapacity + pointsCount + splatsCount + spritesCount + linesCount).toLocaleString()} elements.`;
      if (text) text.textContent = summary;
      console.log('[Benchmark Result]', summary);
      (window as any).__benchmarkResult = {
        frameDuration: currentFrameDuration,
        fps: currentFps,
        vfxCapacity,
        pointsCount,
        splatsCount,
        spritesCount,
        linesCount,
      };
      return;
    }

    // Ramp up counts
    vfxCapacity = Math.min(vfxCapacity + 50000, 1000000);
    pointsCount = Math.min(pointsCount + 30000, 500000);
    splatsCount = Math.min(splatsCount + 10000, 100000);
    spritesCount = Math.min(spritesCount + 1000, 10000);
    linesCount = Math.min(linesCount + 500, 5000);

    if (vfxPlugin) {
      vfxPlugin.burst(25000);
    }
    populateSprites(spritesCount);
    if (dynamicLine) {
      dynamicLine.setPositions(generateLinePositions(linesCount));
    }
    updateTotalCountDisplay();
  }

  const finalSummary = `Max stress reached at ${currentFrameDuration.toFixed(1)} ms (${currentFps} FPS) with VFX: ${vfxCapacity.toLocaleString()}, Points: ${pointsCount.toLocaleString()}, Splats: ${splatsCount.toLocaleString()}, Sprites: ${spritesCount.toLocaleString()}, Lines: ${linesCount.toLocaleString()}. Total: ${(vfxCapacity + pointsCount + splatsCount + spritesCount + linesCount).toLocaleString()} elements.`;
  if (text) text.textContent = finalSummary;
  console.log('[Benchmark Result]', finalSummary);
  (window as any).__benchmarkResult = {
    frameDuration: currentFrameDuration,
    fps: currentFps,
    vfxCapacity,
    pointsCount,
    splatsCount,
    spritesCount,
    linesCount,
  };
}

async function recreateAll() {
  centerMeshes.length = 0;
  dynamicSprites.length = 0;

  if (stage) {
    stage.dispose();
    stage = null;
  }
  vfxPlugin = null;
  pointsPlugin = null;
  _pointCloud = null;
  splatsPlugin = null;
  linesPlugin = null;
  dynamicLine = null;
  spriteLayer = null;
  toonPlugin = null;
  layerCompositor = null;
  lighting2DPlugin = null;

  await init();
}

function renderLoop(now: number) {
  const _dt = Math.min((now - lastFrameTime) / 1000, 0.1);
  lastFrameTime = now;
  frameCount++;

  // Rotate central 3D meshes
  if (stage && !stage.engine.disposed && centerMeshes.length > 0) {
    try {
      if (centerMeshes[0]) centerMeshes[0].rotation.set(now * 0.001, now * 0.0015, 0);
      if (centerMeshes[1]) centerMeshes[1].rotation.set(0, -now * 0.001, 0);
    } catch {}
  }

  // Animate dynamic line sine wave
  if (dynamicLine) {
    const pts = generateLinePositions(linesCount);
    const shift = Math.sin(now * 0.002) * 1.5;
    for (let i = 0; i < pts.length; i += 3) {
      pts[i + 1] += shift;
    }
    try {
      dynamicLine.setPositions(pts);
    } catch (_e) {
      // ignore
    }
  }

  // Animate sprites
  for (let i = 0; i < dynamicSprites.length; i++) {
    const sp = dynamicSprites[i];
    sp.rotation = (sp.rotation || 0) + 0.02;
  }

  // Render stage
  if (stage) {
    stage.engine.render();
  }

  // Calculate FPS & Frame time
  if (now - lastFpsTime >= 500) {
    currentFps = Math.round((frameCount * 1000) / (now - lastFpsTime));
    currentFrameDuration = (now - lastFpsTime) / frameCount;
    avgFrameTime = avgFrameTime * 0.7 + currentFrameDuration * 0.3;
    frameCount = 0;
    lastFpsTime = now;

    const fpsEl = document.querySelector<HTMLElement>('#stat-fps');
    const msEl = document.querySelector<HTMLElement>('#stat-ms');
    if (fpsEl) fpsEl.textContent = String(currentFps);
    if (msEl) msEl.textContent = `${currentFrameDuration.toFixed(1)} ms`;
    updateTotalCountDisplay();
  }

  requestAnimationFrame(renderLoop);
}

// Global test hook for automated test harness
(window as any).runStressTest = async function () {
  console.log('[Test Harness] Running Particles & Effects Stress Test...');
  const results: any = {
    backend: useWebGL2 ? 'webgl2' : 'webgpu',
    vfxAttached: !!vfxPlugin,
    pointsAttached: !!pointsPlugin,
    splatsAttached: !!splatsPlugin,
    linesAttached: !!linesPlugin,
    spritesAttached: !!spriteLayer,
    toonAttached: !!toonPlugin,
    pixelAttached: !!layerCompositor,
    lighting2dAttached: !!lighting2DPlugin,
    benchmarkResult: null,
    errors: [],
  };

  // 1. Rapid toggle emitter
  if (vfxPlugin) {
    for (let i = 0; i < 5; i++) {
      vfxPlugin.options.rate = i % 2 === 0 ? 80000 : 0;
      if (i % 2 === 0) vfxPlugin.burst(10000);
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  // 2. Run 33ms benchmark ramp
  await run33msBenchmark();
  results.benchmarkResult = (window as any).__benchmarkResult;

  // 3. Test mobile resize
  const viewport = document.querySelector<HTMLElement>('#viewport');
  if (viewport) {
    viewport.style.width = '390px';
    viewport.style.height = '844px';
    await new Promise((r) => setTimeout(r, 150));
    viewport.style.width = '100%';
    viewport.style.height = '100%';
  }

  // 4. Test Dispose & Recreate
  await recreateAll();
  await new Promise((r) => setTimeout(r, 200));

  results.errors = [...(window as any).__testErrors];
  return results;
};

// Start
ready(init()).catch((err) => {
  console.error('[Fatal Page Init Error]', err);
  (window as any).__testErrors.push({
    message: err.message || String(err),
    stack: err.stack,
  });
});
