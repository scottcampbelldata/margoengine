import { ready } from './page-harness';
import { Engine } from '@margoengine/core';
import { Figure, type ColormapSource } from '@margoengine/sciviz';
import { SciRenderer } from '@margoengine/sciviz';
import { AudioListener, PositionalAudio, AudioAnalyser } from '@margoengine/audio';
import { Input, bindingLabel } from '@margoengine/input';
import { LabelRenderer } from '@margoengine/labels';
import { Callouts } from '@margoengine/labels/callouts';
import { Declutter } from '@margoengine/labels/declutter';

interface WindowWithTest extends Window {
  renderTest?: {
    isReady: () => boolean;
    getBackend: () => string;
    testAnimateSurface: () => Promise<boolean>;
    testColormapSwitching: () => Promise<boolean>;
    testInputRebind: () => Promise<boolean>;
    testAudioAnalyser: () => Promise<boolean>;
    testCalloutsAndCSS3D: () => Promise<boolean>;
    testExportPNG: () => Promise<number>;
    testExportSVG: () => Promise<number>;
    testMobileResize: () => Promise<boolean>;
    testRecreateScene: () => Promise<boolean>;
    testNativeWebGL2Refusal: () => Promise<{ refusalCaught: boolean; message: string }>;
  };
}

const win = window as unknown as WindowWithTest;

// UI Elements
const viewport = document.getElementById('viewport') as HTMLDivElement;
const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const badgeBackend = document.getElementById('badge-backend') as HTMLSpanElement;
const selectColormap = document.getElementById('select-colormap') as HTMLSelectElement;
const btnToggleWave = document.getElementById('btn-toggle-wave') as HTMLButtonElement;
const btnToggleQuiver = document.getElementById('btn-toggle-quiver') as HTMLButtonElement;
const btnExportPNG = document.getElementById('btn-export-png') as HTMLButtonElement;
const btnExportSVG = document.getElementById('btn-export-svg') as HTMLButtonElement;
const valProbePos = document.getElementById('val-probe-pos') as HTMLSpanElement;
const btnToggleAudio = document.getElementById('btn-toggle-audio') as HTMLButtonElement;
const btnTriggerPing = document.getElementById('btn-trigger-ping') as HTMLButtonElement;
const valAudioFreq = document.getElementById('val-audio-freq') as HTMLSpanElement;
const audioMeterBar = document.getElementById('audio-meter-bar') as HTMLDivElement;
const btnTestRebind = document.getElementById('btn-test-rebind') as HTMLButtonElement;
const btnToggleContext = document.getElementById('btn-toggle-context') as HTMLButtonElement;
const valCalloutsCount = document.getElementById('val-callouts-count') as HTMLSpanElement;
const btnToggleCSS3D = document.getElementById('btn-toggle-css3d') as HTMLButtonElement;
const btnStressRapid = document.getElementById('btn-stress-rapid') as HTMLButtonElement;
const btnTestMobile = document.getElementById('btn-test-mobile') as HTMLButtonElement;
const btnRecreate = document.getElementById('btn-recreate') as HTMLButtonElement;
const btnTestRefusal = document.getElementById('btn-test-refusal') as HTMLButtonElement;
const valFps = document.getElementById('val-fps') as HTMLSpanElement;
const valLayersCount = document.getElementById('val-layers-count') as HTMLSpanElement;
const logEl = document.getElementById('log') as HTMLDivElement;

function log(msg: string) {
  console.log(`[sciviz-spatial-input] ${msg}`);
  logEl.textContent = msg;
}

// Parse backend mode
const params = new URLSearchParams(window.location.search);
const requestedBackend = params.get('backend') || 'webgpu';
const isCompat = requestedBackend === 'webgl2';

let fig: Figure | null = null;
let surfaceLayer: any = null;
let quiverLayer: any = null;
let audioListener: AudioListener | null = null;
let probeSound: PositionalAudio | null = null;
let audioAnalyser: AudioAnalyser | null = null;
let inputHandler: Input | null = null;
let labelRenderer: LabelRenderer | null = null;
let calloutsLayout: Callouts | null = null;
let probePanel3D: any = null;

let isReady = false;
let animateWave = true;
let audioActive = true;
let telemetryContextEnabled = true;

// Grid parameters
const nx = 40;
const ny = 40;
const heights = new Float32Array(nx * ny);

function computeWave(time: number): Float32Array {
  for (let j = 0; j < ny; j++) {
    const y = (j / (ny - 1) - 0.5) * 4;
    for (let i = 0; i < nx; i++) {
      const x = (i / (nx - 1) - 0.5) * 4;
      const r = Math.hypot(x, y);
      heights[j * nx + i] = Math.sin(r * 2.5 - time * 2) * Math.cos(x * 1.5 + time * 0.7) * 0.8;
    }
  }
  return heights;
}

async function initScene() {
  isReady = false;
  log(`Initializing scene (Backend: ${requestedBackend})...`);

  if (isCompat) {
    log('Installing WebGL2 compatibility layer with { force: true }...');
    const { install: installCompat } = await import('@margoengine/webgl2-compat');
    const res = await installCompat({ force: true });
    log(`installCompat result: ${JSON.stringify(res)}`);
    badgeBackend.textContent = 'webgl2-compat';
    badgeBackend.className = 'badge compat';
  } else {
    badgeBackend.textContent = 'webgpu';
    badgeBackend.className = 'badge gpu';
  }

  // 1. Create Figure
  fig = await Figure.create(canvas, {
    aspect: [1, 1, 0.75],
    theme: 'dark',
    titles: { x: 'Easting (km)', y: 'Northing (km)', z: 'Elevation (km)' },
    limits: [-2, 2, -2, 2, -1, 1],
  });

  const engine = fig.engine as any;
  log(`Engine created. Active backend: ${engine.backend}`);

  // 2. Add Surface Plot
  const initialHeights = computeWave(0);
  surfaceLayer = fig.surface(initialHeights, {
    nx,
    ny,
    x: [-2, 2],
    y: [-2, 2],
    colormap: selectColormap.value as ColormapSource,
    contours: 8,
    range: [-1, 1],
    name: 'Topography',
  });
  fig.colorbar(selectColormap.value as ColormapSource, [-1, 1], { label: 'Elevation (km)' });

  // 3. Add Quiver Vector Field
  const qx: number[] = [];
  const qy: number[] = [];
  const qu: number[] = [];
  const qv: number[] = [];
  for (let j = 0; j < 6; j++) {
    for (let i = 0; i < 6; i++) {
      const x = (i / 5 - 0.5) * 3;
      const y = (j / 5 - 0.5) * 3;
      qx.push(x);
      qy.push(y);
      qu.push(-y * 0.4);
      qv.push(x * 0.4);
    }
  }
  quiverLayer = await fig.quiver({ x: qx, y: qy, u: qu, v: qv }, { color: '#38bdf8', name: 'Wind Field' });

  // 4. Initialize Spatial Audio
  audioListener = AudioListener.attach(engine, { volume: 0.8 });
  const audioCtx = audioListener.context;
  const sampleRate = audioCtx.sampleRate || 48000;
  const soundBuffer = audioCtx.createBuffer(1, Math.round(sampleRate * 0.15), sampleRate);
  const pcm = soundBuffer.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] = 0.25 * Math.sin((2 * Math.PI * 660 * i) / sampleRate) * Math.exp(-i / (sampleRate * 0.04));
  }

  probeSound = new PositionalAudio(audioListener, {
    refDistance: 1.5,
    distanceModel: 'inverse',
    rolloffFactor: 1.2,
  });
  probeSound.setBuffer(soundBuffer);
  probeSound.loop = true;
  probeSound.play();

  audioAnalyser = new AudioAnalyser(probeSound, 256);

  // 5. Initialize Semantic Input
  inputHandler = new Input(
    {
      panLeft: [
        { type: 'key', code: 'KeyA' },
        { type: 'key', code: 'ArrowLeft' },
      ],
      panRight: [
        { type: 'key', code: 'KeyD' },
        { type: 'key', code: 'ArrowRight' },
      ],
      elevateUp: [
        { type: 'key', code: 'KeyW' },
        { type: 'key', code: 'ArrowUp' },
      ],
      elevateDown: [
        { type: 'key', code: 'KeyS' },
        { type: 'key', code: 'ArrowDown' },
      ],
      probePing: [{ type: 'key', code: 'Space' }],
      snapshot: [{ type: 'key', code: 'KeyS', modifiers: ['ctrl'] }],
      switchColormap: [{ type: 'key', code: 'KeyC' }],
      toggleVectors: [{ type: 'key', code: 'KeyX' }],
    },
    {
      contexts: {
        telemetry: ['probePing', 'snapshot'],
      },
    },
  );

  // 6. Initialize HTML Labels & Callouts
  calloutsLayout = new Callouts({
    layout: new Declutter({ padding: 4 }),
    color: '#38bdf8',
    dot: 3,
  });
  labelRenderer = LabelRenderer.attach(engine, { name: 'sciviz-spatial-labels', layout: calloutsLayout });

  // Add Peak Callouts
  const peak1 = document.createElement('div');
  peak1.className = 'sciviz-peak-label';
  peak1.textContent = 'Peak Alpha (+0.8km)';
  labelRenderer.add(peak1, { position: [1.0, 1.0, 0.8], screenOffset: [60, -40] });

  const peak2 = document.createElement('div');
  peak2.className = 'sciviz-peak-label';
  peak2.textContent = 'Station Beta (-0.7km)';
  labelRenderer.add(peak2, { position: [-1.2, -0.8, -0.7], screenOffset: [-70, 30] });

  // Add CSS 3D panel attached to probe
  const panelEl = document.createElement('div');
  panelEl.className = 'probe-css3d-panel';
  panelEl.innerHTML = `<strong>PROBE-1</strong><br><span id="css3d-pos">ORBITING</span><br><span style="color:#10b981">660 Hz</span>`;
  probePanel3D = labelRenderer.add3D(panelEl, {
    position: [0, 1.2, 0],
    pixelScale: 0.006,
  });

  // 7. Continuous Animation Frame Hook
  let time = 0;
  let lastFrameTime = performance.now();
  let frameCount = 0;
  let fpsTimer = performance.now();

  engine.onFrame(() => {
    const now = performance.now();
    time += 0.016;

    // Frame rate counting
    frameCount++;
    if (now - fpsTimer >= 500) {
      const fps = Math.round((frameCount * 1000) / (now - fpsTimer));
      const delta = (now - lastFrameTime).toFixed(1);
      valFps.textContent = `${fps} fps (${delta}ms)`;
      frameCount = 0;
      fpsTimer = now;
    }
    lastFrameTime = now;

    // 1. Process Semantic Input
    if (inputHandler) {
      inputHandler.update();

      if (inputHandler.state('probePing').pressed) {
        triggerPingSound();
      }
      if (inputHandler.state('switchColormap').pressed) {
        cycleNextColormap();
      }
      if (inputHandler.state('toggleVectors').pressed) {
        toggleQuiverField();
      }
      if (inputHandler.state('snapshot').pressed) {
        void exportPNG();
      }
    }

    // 2. Animate Heightfield Surface (60 FPS)
    if (animateWave && surfaceLayer) {
      surfaceLayer.setHeights(computeWave(time));
    }

    // 3. Orbit Positional Audio & CSS 3D Panel
    const probeAngle = time * 0.8;
    const px = Math.cos(probeAngle) * 1.5;
    const py = Math.sin(probeAngle * 0.5) * 0.5 + 1.0;
    const pz = Math.sin(probeAngle) * 1.5;

    if (probeSound) {
      probeSound.setPosition(px, py, pz);
    }
    if (probePanel3D) {
      probePanel3D.setPose([px, py, pz], [0, 0, 0, 1]);
    }

    // 4. Frequency Analyser Visualizer
    if (audioAnalyser) {
      const avgFreq = audioAnalyser.getAverageFrequency();
      audioMeterBar.style.width = `${Math.min(100, (avgFreq / 128) * 100)}%`;
      valAudioFreq.textContent = `${Math.round(avgFreq * 8)} Hz`;
    }

    valProbePos.textContent = `[${px.toFixed(1)}, ${py.toFixed(1)}, ${pz.toFixed(1)}]`;
    if (calloutsLayout) {
      valCalloutsCount.textContent = `${calloutsLayout.lines} lines`;
    }
    if (fig) {
      valLayersCount.textContent = `${fig.layers.length}`;
    }
  });

  isReady = true;
  log('Scene initialized and running.');
}

function triggerPingSound() {
  if (!audioListener || !probeSound) return;
  const ctx = audioListener.context;
  const sampleRate = ctx.sampleRate || 48000;
  const pingBuffer = ctx.createBuffer(1, Math.round(sampleRate * 0.2), sampleRate);
  const data = pingBuffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    data[i] = 0.35 * Math.sin((2 * Math.PI * 880 * i) / sampleRate) * Math.exp(-i / (sampleRate * 0.03));
  }
  probeSound.setBuffer(pingBuffer);
  probeSound.play();
  log('Triggered spatial audio ping (880 Hz).');
}

const COLORMAPS = ['aurora', 'coolwarm', 'viridis', 'plasma', 'ember'] as const;

function cycleNextColormap() {
  const current = selectColormap.value;
  const nextIdx = (COLORMAPS.findIndex((name) => name === current) + 1) % COLORMAPS.length;
  const nextMap = COLORMAPS[nextIdx];
  selectColormap.value = nextMap;
  applyColormap(nextMap);
}

function applyColormap(mapName: ColormapSource) {
  if (!fig || !surfaceLayer) return;
  log(`Applying colormap: ${mapName}`);
  fig.remove(surfaceLayer);
  surfaceLayer = fig.surface(computeWave(0), {
    nx,
    ny,
    x: [-2, 2],
    y: [-2, 2],
    colormap: mapName,
    contours: 8,
    range: [-1, 1],
    name: 'Topography',
  });
  fig.colorbar(mapName, [-1, 1], { label: 'Elevation (km)' });
}

function toggleQuiverField() {
  if (!quiverLayer) return;
  quiverLayer.line.visible = !quiverLayer.line.visible;
  log(`Quiver visibility: ${quiverLayer.line.visible}`);
}

async function exportPNG(): Promise<number> {
  if (!fig) return 0;
  log('Exporting figure to PNG...');
  const blob = await fig.toPNG();
  log(`Exported PNG Blob: ${blob.size} bytes (type: ${blob.type})`);
  return blob.size;
}

async function exportSVG(): Promise<number> {
  if (!fig) return 0;
  log('Exporting figure to SVG...');
  const svgText = await fig.toSVG();
  log(`Exported SVG string: ${svgText.length} characters`);
  return svgText.length;
}

// UI Event Handlers
selectColormap.onchange = () => {
  applyColormap(selectColormap.value as ColormapSource);
};

btnToggleWave.onclick = () => {
  animateWave = !animateWave;
  btnToggleWave.textContent = animateWave ? 'Deforming (60 FPS)' : 'Wave Paused';
  btnToggleWave.className = animateWave ? 'active' : '';
};

btnToggleQuiver.onclick = () => {
  toggleQuiverField();
};

btnExportPNG.onclick = async () => {
  await exportPNG();
};

btnExportSVG.onclick = async () => {
  await exportSVG();
};

btnToggleAudio.onclick = () => {
  if (!probeSound) return;
  audioActive = !audioActive;
  if (audioActive) {
    probeSound.play();
    btnToggleAudio.textContent = 'Active (Loop)';
    btnToggleAudio.className = 'active';
  } else {
    probeSound.pause();
    btnToggleAudio.textContent = 'Muted';
    btnToggleAudio.className = '';
  }
};

btnTriggerPing.onclick = () => {
  triggerPingSound();
};

btnTestRebind.onclick = async () => {
  if (!inputHandler) return;
  log('Testing semantic input rebind & import/export...');
  const exported = inputHandler.exportBindings();
  const serialized = JSON.stringify(exported);
  log(`Exported bindings (${serialized.length} chars). Rebinding probePing to KeyP...`);
  inputHandler.rebind('probePing', [{ type: 'key', code: 'KeyP' }]);
  const prompt = bindingLabel(inputHandler.actions.probePing[0]);
  log(`Rebound probePing prompt: "${prompt}". Now importing original bindings...`);
  inputHandler.importBindings(serialized);
  log('Bindings restored successfully.');
};

btnToggleContext.onclick = () => {
  if (!inputHandler) return;
  telemetryContextEnabled = !telemetryContextEnabled;
  inputHandler.setContext('telemetry', telemetryContextEnabled);
  btnToggleContext.textContent = telemetryContextEnabled ? 'Context: Active' : 'Context: Muted';
  log(`Context "telemetry" set to ${telemetryContextEnabled}`);
};

btnToggleCSS3D.onclick = () => {
  if (!probePanel3D) return;
  probePanel3D.visible = !probePanel3D.visible;
  btnToggleCSS3D.textContent = probePanel3D.visible ? 'Enabled' : 'Disabled';
  btnToggleCSS3D.className = probePanel3D.visible ? 'active' : '';
  log(`CSS 3D Panel visible: ${probePanel3D.visible}`);
};

btnStressRapid.onclick = async () => {
  log('Running rapid stress cycle (Colormaps, Inputs, Layers)...');
  const start = performance.now();
  for (let i = 0; i < 5; i++) {
    cycleNextColormap();
    if (inputHandler) {
      inputHandler.update();
    }
  }
  const dur = (performance.now() - start).toFixed(1);
  log(`Rapid stress cycle finished in ${dur}ms.`);
};

let isMobile = false;
btnTestMobile.onclick = () => {
  isMobile = !isMobile;
  viewport.classList.toggle('mobile-view', isMobile);
  if (fig) {
    const engine = fig.engine as any;
    engine.resize?.(isMobile ? 390 : window.innerWidth, isMobile ? 844 : window.innerHeight);
  }
  log(`Viewport mode: ${isMobile ? 'Mobile 390x844' : 'Desktop full'}`);
};

btnRecreate.onclick = async () => {
  log('Recreating entire scene...');
  if (fig) {
    fig.dispose();
    fig = null;
  }
  await initScene();
  log('Scene recreated successfully.');
};

async function testNativeWebGL2Refusal(): Promise<{ refusalCaught: boolean; message: string }> {
  log('Testing small preview tier native WebGL2 refusal behavior...');
  const testCanvas = document.createElement('canvas');
  let refusalCaught = false;
  let message = '';
  try {
    const testEngine = await Engine.create(testCanvas, { backend: 'webgl2' });
    try {
      SciRenderer.attach(testEngine);
      message = 'ERROR: SciRenderer attached to native WebGL2 engine without throwing!';
    } catch (err: any) {
      refusalCaught = true;
      message = err.message || String(err);
      log(`Expected refusal caught: "${message}"`);
    } finally {
      testEngine.dispose();
    }
  } catch (err: any) {
    refusalCaught = true;
    message = `Engine.create refusal: ${err.message || String(err)}`;
    log(`Refusal caught at Engine.create: "${message}"`);
  }
  return { refusalCaught, message };
}

btnTestRefusal.onclick = async () => {
  const result = await testNativeWebGL2Refusal();
  log(`Refusal check result: caught=${result.refusalCaught}, msg="${result.message}"`);
};

// Window Test Interface for Playwright Automation
win.renderTest = {
  isReady: () => isReady,
  getBackend: () => (fig ? (fig.engine as any).backend : 'none'),
  testAnimateSurface: async () => {
    if (!surfaceLayer) return false;
    surfaceLayer.setHeights(computeWave(1.0));
    return true;
  },
  testColormapSwitching: async () => {
    for (const map of COLORMAPS) {
      applyColormap(map);
    }
    return true;
  },
  testInputRebind: async () => {
    if (!inputHandler) return false;
    const initial = inputHandler.exportBindings();
    inputHandler.rebind('probePing', [{ type: 'key', code: 'KeyP' }]);
    const label = bindingLabel(inputHandler.actions.probePing[0]);
    inputHandler.importBindings(initial);
    return label === 'P';
  },
  testAudioAnalyser: async () => {
    if (!audioAnalyser) return false;
    const freqData = audioAnalyser.getFrequencyData();
    return freqData.length > 0;
  },
  testCalloutsAndCSS3D: async () => {
    if (!calloutsLayout || !probePanel3D) return false;
    return typeof calloutsLayout.lines === 'number' && probePanel3D.visible;
  },
  testExportPNG: async () => {
    return await exportPNG();
  },
  testExportSVG: async () => {
    return await exportSVG();
  },
  testMobileResize: async () => {
    btnTestMobile.click();
    await new Promise((r) => setTimeout(r, 100));
    btnTestMobile.click();
    return true;
  },
  testRecreateScene: async () => {
    if (fig) {
      fig.dispose();
      fig = null;
    }
    await initScene();
    return isReady;
  },
  testNativeWebGL2Refusal,
};

// Start application
ready(initScene()).catch((err) => {
  console.error('[sciviz-spatial-input] Initialization error:', err);
  log(`Init failed: ${err.message}`);
});
