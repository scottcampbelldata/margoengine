import { ready } from './page-harness';
import { Engine, box, PbrMaterial } from '@margoengine/core';
import { install as installCompat } from '@margoengine/webgl2-compat';
import { VoxelPathTracer, type VoxelTraceScene } from '@margoengine/voxel-pathtracer';
import { XR } from '@margoengine/xr';
import { MargoError } from '@margoengine/math/errors';

// UI element references
const badgeBackend = document.getElementById('badge-backend')!;
const valTracerStatus = document.getElementById('val-tracer-status')!;
const valSamplesCount = document.getElementById('val-samples-count')!;
const barSamplesProgress = document.getElementById('bar-samples-progress') as HTMLElement;
const valXrSupport = document.getElementById('val-xr-support')!;
const valXrError = document.getElementById('val-xr-error')!;
const valFps = document.getElementById('val-fps')!;
const elLog = document.getElementById('log')!;

const btnToggleTrace = document.getElementById('btn-toggle-trace') as HTMLButtonElement;
const btnResetTrace = document.getElementById('btn-reset-trace') as HTMLButtonElement;
const btnCaptureStill = document.getElementById('btn-capture-still') as HTMLButtonElement;
const btnStartXR = document.getElementById('btn-start-xr') as HTMLButtonElement;
const btnTestBadScene = document.getElementById('btn-test-bad-scene') as HTMLButtonElement;
const btnTestBadXR = document.getElementById('btn-test-bad-xr') as HTMLButtonElement;
const btnStressPause = document.getElementById('btn-stress-pause') as HTMLButtonElement;
const btnTestMobile = document.getElementById('btn-test-mobile') as HTMLButtonElement;
const btnRecreate = document.getElementById('btn-recreate') as HTMLButtonElement;
const viewportEl = document.getElementById('viewport')!;
const currentCanvas = document.getElementById('canvas') as HTMLCanvasElement;

function log(msg: string) {
  elLog.textContent = msg;
  console.log(`[PathTracerXR] ${msg}`);
}

const params = new URLSearchParams(window.location.search);
const requestedBackend = params.get('backend') || 'webgpu';
badgeBackend.textContent = requestedBackend.toUpperCase();

let engine: Engine | null = null;
let tracer: VoxelPathTracer | null = null;
let xrManager: XR | null = null;
let tracerSupported = true;
const _isWebGPU = requestedBackend !== 'webgl2';
const MAX_SAMPLES = 256;

// Voxel models
// 1. Pedestal 4x4x4 (palette index 1)
const pedestalVoxels = new Uint8Array(4 * 4 * 4).fill(1);
// 2. Glowing Orb / Crystal 2x2x2 (palette index 2)
const crystalVoxels = new Uint8Array(2 * 2 * 2).fill(2);

const initialVoxelScene: VoxelTraceScene = {
  revision: 1,
  models: [
    { id: 'pedestal', revision: 1, size: [4, 4, 4], voxels: pedestalVoxels },
    { id: 'crystal', revision: 1, size: [2, 2, 2], voxels: crystalVoxels },
  ],
  instances: [
    {
      id: 'inst-pedestal',
      modelId: 'pedestal',
      matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -2, 0, -2, 1],
    },
    {
      id: 'inst-crystal',
      modelId: 'crystal',
      matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -1, 4.5, -1, 1],
    },
  ],
  materials: [
    { id: 1, type: 'diffuse', color: [0.85, 0.82, 0.8] },
    { id: 2, type: 'emit', color: [1.0, 0.6, 0.2], emission: 8.0 },
    { id: 3, type: 'glass', color: [0.95, 0.98, 1.0], ior: 1.5 },
  ],
  environment: {
    skyColor: [0.1, 0.15, 0.3],
    sunIntensity: 2.5,
    sunDirection: [0.4, 0.8, 0.3],
    groundColor: [0.08, 0.08, 0.1],
  },
};

async function initScene() {
  log('Trace 1: disposing tracer');
  if (tracer) {
    try {
      tracer.dispose();
    } catch {}
    tracer = null;
  }
  log('Trace 2: disposing xrManager');
  if (xrManager) {
    try {
      xrManager.dispose();
    } catch {}
    xrManager = null;
  }
  log('Trace 3: disposing engine');
  if (engine) {
    try {
      engine.dispose();
    } catch {}
    engine = null;
  }
  log('Trace 4: starting create');

  log(`Initializing engine with backend: ${requestedBackend}...`);

  if (requestedBackend === 'webgl2') {
    const res = await installCompat({ force: true });
    log(`WebGL2 compat installed: ${JSON.stringify(res)}`);
  }

  try {
    engine = await Engine.create(currentCanvas, {
      powerPreference: 'high-performance',
    });
  } catch (err: any) {
    log(`Engine create failed: ${err.message}`);
    throw err;
  }

  // Camera setup
  engine.camera.position = [0, 3.5, 9];
  engine.camera.target = [0, 2.5, 0];

  // Raster fallback mesh (shown while compiling, or if path tracer is paused or on WebGL2)
  const standInGeom = box(2);
  const standInMat = new PbrMaterial({ color: '#f59e0b', roughness: 0.3, metalness: 0.2 });
  engine.createMesh().setGeometry(standInGeom).setMaterial(standInMat).setPosition([0, 2, 0]);

  // 1. Initialize Voxel Path Tracer (@margoengine/voxel-pathtracer)
  const isWebGL2 = requestedBackend === 'webgl2';
  if (isWebGL2) {
    tracer = null;
    tracerSupported = false;
    valTracerStatus.textContent = 'Refused on WebGL2';
    log('VoxelPathTracer: WebGL2 fallback path tracer disabled.');
  } else {
    try {
      log('Attaching VoxelPathTracer...');
      valTracerStatus.textContent = 'Compiling pipelines...';
      tracer = VoxelPathTracer.attach(engine, {
        scene: initialVoxelScene,
        maxSamples: MAX_SAMPLES,
        resolutionScale: 1,
        denoise: true,
      });
      btnToggleTrace.classList.toggle('active', tracer.enabled);
      btnToggleTrace.textContent = tracer.enabled ? 'Pause Trace' : 'Resume Trace';
      tracerSupported = true;

      const currentTracer = tracer;
      tracer.ready
        .then(() => {
          if (tracer !== currentTracer) return;
          valTracerStatus.textContent = 'Converging...';
          log('VoxelPathTracer pipelines compiled and ready.');
        })
        .catch((err) => {
          if (tracer !== currentTracer) return;
          if (err.code !== 'disposed') {
            tracerSupported = false;
            valTracerStatus.textContent = `Refused: ${err.code || 'error'}`;
          }
          log(`VoxelPathTracer: [${err.code || 'ERROR'}] ${err.message}`);
        });
    } catch (err: any) {
      tracerSupported = false;
      valTracerStatus.textContent = `Refused: ${err.code || 'unsupported'}`;
      log(`VoxelPathTracer attach error: [${err.code || 'ERROR'}] ${err.message}`);
    }
  }

  // 2. Check WebXR Capability (@margoengine/xr)
  try {
    const isSupported = await XR.isSupported('immersive-vr');
    valXrSupport.textContent = isSupported ? 'Available' : 'No Headset / Unsupported';
    log(`XR.isSupported('immersive-vr'): ${isSupported}`);
  } catch (err: any) {
    valXrSupport.textContent = 'Error querying WebXR';
    log(`XR.isSupported query error: ${err.message}`);
  }

  // Render & Telemetry loop
  let frameCount = 0;
  let fpsTimer = 0;

  engine.onFrame((_, delta) => {
    frameCount++;
    fpsTimer += delta;
    if (fpsTimer >= 0.5) {
      const fps = Math.round(frameCount / fpsTimer);
      const ms = ((delta || 0.016) * 1000).toFixed(1);
      valFps.textContent = `${fps} fps (${ms}ms)`;
      frameCount = 0;
      fpsTimer = 0;

      // Update path tracer samples
      if (tracer && tracerSupported) {
        const samples = tracer.stats.samples;
        valSamplesCount.textContent = `${samples} / ${MAX_SAMPLES}`;
        const pct = Math.min(100, Math.round((samples / MAX_SAMPLES) * 100));
        barSamplesProgress.style.width = `${pct}%`;
        if (tracer.stats.converged) {
          valTracerStatus.textContent = 'Converged';
        } else if (tracer.enabled) {
          valTracerStatus.textContent = `Refining (${samples}s)`;
        } else {
          valTracerStatus.textContent = `Paused (${samples}s)`;
        }
      }
    }
  });

  engine.start();
  log(`Path-traced still and XR scene ready on ${requestedBackend}.`);
}

// --- Path Tracer Controls (@margoengine/voxel-pathtracer) ---
btnToggleTrace.onclick = () => {
  if (!tracer) {
    log('VoxelPathTracer is not available on this backend.');
    return;
  }
  tracer.enabled = !tracer.enabled;
  btnToggleTrace.classList.toggle('active', tracer.enabled);
  btnToggleTrace.textContent = tracer.enabled ? 'Pause Trace' : 'Resume Trace';
  log(`Path tracer ${tracer.enabled ? 'RESUMED' : 'PAUSED'}. Current samples: ${tracer.stats.samples}`);
};

btnResetTrace.onclick = () => {
  if (!tracer) return;
  tracer.reset();
  valSamplesCount.textContent = `0 / ${MAX_SAMPLES}`;
  barSamplesProgress.style.width = '0%';
  valTracerStatus.textContent = 'Reset (0s)';
  log('Path tracer accumulation reset to sample 0.');
};

btnCaptureStill.onclick = async () => {
  if (!tracer) {
    log('Cannot capture still: tracer not available.');
    return;
  }
  log('Capturing offscreen path-traced PNG still (256x256, 32 samples)...');
  btnCaptureStill.disabled = true;
  const t0 = performance.now();
  try {
    const pngBytes = await tracer.capture({
      width: 256,
      height: 256,
      samples: 32,
    });
    const elapsed = (performance.now() - t0).toFixed(1);
    log(`Still captured in ${elapsed}ms! PNG size: ${pngBytes.size} bytes.`);
  } catch (err: any) {
    log(`Capture error: ${err.message}`);
  } finally {
    btnCaptureStill.disabled = false;
  }
};

// --- WebXR Headset Negotiation & Fallback (@margoengine/xr) ---
btnStartXR.onclick = async () => {
  if (!engine) return;
  log('Attempting to start WebXR immersive-vr session on browser without headset...');
  valXrError.textContent = 'Negotiating...';

  try {
    xrManager = await XR.create(engine);
    log('XR.create succeeded. Requesting immersive-vr session...');
    const session = await xrManager.requestSession('immersive-vr');
    valXrError.textContent = 'Session active (Unexpected)';
    log(`Unexpectedly granted XR session: ${session}`);
  } catch (err: any) {
    const _isMargo = err instanceof MargoError;
    const code = err.code || 'DOMException';
    valXrError.textContent = `[${code}] ${err.name || 'Error'}`;
    log(`Expected XR Refusal: code="${code}", message="${err.message}"`);
  } finally {
    if (xrManager) {
      try {
        xrManager.dispose();
      } catch {}
      xrManager = null;
    }
  }
};

// --- Input Validation Stress Tests ---
btnTestBadScene.onclick = () => {
  if (!tracer) {
    log('Tracer not available to test bad scene.');
    return;
  }
  log('Testing invalid scene input rejection (negative model dimension)...');
  try {
    const badScene: any = {
      ...initialVoxelScene,
      revision: 99,
      models: [{ id: 'bad', revision: 1, size: [-4, 4, 4], voxels: pedestalVoxels }],
    };
    tracer.setScene(badScene);
    log('FAIL: Bad scene was accepted without error!');
  } catch (err: any) {
    const code = err.code || 'RangeError';
    log(`PASS: Bad scene rejected as expected: [${code}] ${err.message}`);
  }
};

btnTestBadXR.onclick = async () => {
  if (!engine) return;
  log('Testing invalid XR mode input rejection...');
  let tempXr: XR | null = null;
  try {
    tempXr = await XR.create(engine);
    await (tempXr as any).requestSession('invalid-magic-mode');
    log('FAIL: Bad XR mode accepted!');
  } catch (err: any) {
    log(`PASS: Bad XR rejected as expected: ${err.message}`);
  } finally {
    if (tempXr) {
      try {
        tempXr.dispose();
      } catch {}
    }
  }
};

// --- Stress Tests ---
btnStressPause.onclick = () => {
  if (!tracer) return;
  log('Running 5x rapid pause/resume cycles on path tracer...');
  for (let i = 0; i < 5; i++) {
    btnToggleTrace.click();
  }
  log(`Completed 5x toggles. Tracer enabled: ${tracer.enabled}`);
};

btnTestMobile.onclick = () => {
  viewportEl.classList.toggle('mobile-view');
  const isMobile = viewportEl.classList.contains('mobile-view');
  btnTestMobile.classList.toggle('active', isMobile);
  log(`Resized viewport to ${isMobile ? '390x844 (Mobile)' : 'Full Window'}`);
};

btnRecreate.onclick = async () => {
  log('Recreating engine and tracer...');
  await initScene();
  log('Engine and tracer recreated successfully.');
};

// Expose test harness hooks on window
(window as any).__TEST_HARNESS__ = {
  getStats: () => ({
    backend: requestedBackend,
    tracerSupported,
    hasTracer: !!tracer,
    samples: tracer?.stats.samples ?? 0,
    isConverged: tracer?.stats.converged ?? false,
    enabled: tracer?.enabled ?? false,
  }),
  toggleTrace: () => btnToggleTrace.click(),
  resetTrace: () => btnResetTrace.click(),
  captureStill: () => btnCaptureStill.click(),
  startXR: () => btnStartXR.click(),
  testBadScene: () => btnTestBadScene.click(),
  testBadXR: () => btnTestBadXR.click(),
  recreate: async () => {
    log('Recreating engine and tracer...');
    await initScene();
    log('Engine and tracer recreated successfully.');
  },
};

// Launch
ready(initScene()).catch((err) => {
  console.error('Fatal initialization error:', err);
  log(`FATAL: ${err.message}`);
});
