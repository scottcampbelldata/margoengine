// Product viewer test page: stress and edge-case testing for:
// @margoengine/staging, @margoengine/environment, @margoengine/shadows,
// @margoengine/post, @margoengine/dof, @margoengine/taa, @margoengine/tonemap,
// @margoengine/oit, @margoengine/materials, @margoengine/decoders,
// using only documented public APIs.
import { ready } from './page-harness';
import { createStage, type Stage } from '@margoengine/stage';
import { loadGLTF, type PBRModel } from '@margoengine/gltf-pro';
import { ContactShadows } from '@margoengine/staging';
import {
  Environment,
  EnvironmentLighting,
  EnvironmentBackground,
  loadEnvironmentImage,
  type EnvironmentSource,
} from '@margoengine/environment';
import { Shadows } from '@margoengine/shadows';
import { PostStack } from '@margoengine/post/stack';
import { SSAO } from '@margoengine/post/ssao';
import { Bloom } from '@margoengine/post/bloom';
import { FXAA } from '@margoengine/post/fxaa';
import { DOF } from '@margoengine/dof';
import { TAA } from '@margoengine/taa';
import { Tonemap } from '@margoengine/tonemap';
import { OIT } from '@margoengine/oit';
import { install as installMaterials } from '@margoengine/materials';
import { DracoDecoder, KTX2Decoder } from '@margoengine/decoders';
import { OrbitControls } from '@margoengine/controls';
import { install as installWebGL2Compat } from '@margoengine/webgl2-compat';

// In-page logger
const logBox = document.getElementById('logBox')!;
function log(msg: string, type: 'error' | 'warn' | 'info' = 'info') {
  const div = document.createElement('div');
  div.className = `log-entry-${type}`;
  const timestamp = new Date().toISOString().substring(11, 19);
  div.textContent = `[${timestamp}] ${msg}`;
  logBox.prepend(div);
  if (type === 'error') console.error(msg);
  else if (type === 'warn') console.warn(msg);
  else console.log(msg);
}

// Global error capture
window.addEventListener('error', (e) => {
  log(`Uncaught error: ${e.message} at ${e.filename}:${e.lineno}`, 'error');
});
window.addEventListener('unhandledrejection', (e) => {
  log(`Unhandled rejection: ${String(e.reason)}`, 'error');
});

// HUD Elements
const hudFps = document.getElementById('hudFps')!;
const hudFrameTime = document.getElementById('hudFrameTime')!;
const hudMemory = document.getElementById('hudMemory')!;
const hudModelName = document.getElementById('hudModelName')!;
const hudPrimitives = document.getElementById('hudPrimitives')!;
const hudHdri = document.getElementById('hudHdri')!;
const hudPostStack = document.getElementById('hudPostStack')!;
const hudSsao = document.getElementById('hudSsao')!;
const hudDof = document.getElementById('hudDof')!;
const hudBloom = document.getElementById('hudBloom')!;
const hudTaa = document.getElementById('hudTaa')!;
const hudContact = document.getElementById('hudContact')!;
const hudDirShadow = document.getElementById('hudDirShadow')!;
const hudOit = document.getElementById('hudOit')!;
const hudTone = document.getElementById('hudTone')!;

// Backend detection
const params = new URLSearchParams(location.search);
const isWebgl2 = params.get('backend') === 'webgl2';
const backendBadge = document.getElementById('backendBadge')!;
const btnToggleBackend = document.getElementById('btnToggleBackend') as HTMLAnchorElement;

if (isWebgl2) {
  backendBadge.textContent = 'Backend: WebGL2 Fallback';
  backendBadge.style.color = '#f85149';
  backendBadge.style.borderColor = '#f8514966';
  btnToggleBackend.textContent = 'Switch to WebGPU';
  btnToggleBackend.href = window.location.pathname;
} else {
  backendBadge.textContent = 'Backend: WebGPU (Native)';
  btnToggleBackend.textContent = 'Switch to WebGL2';
  btnToggleBackend.href = '?backend=webgl2';
}

// Model options
interface ProductModelOption {
  id: string;
  name: string;
  url: string;
  scale: number;
}

const MODELS: Record<string, ProductModelOption> = {
  'flight-helmet': {
    id: 'flight-helmet',
    name: 'Flight Helmet',
    url: '/examples/assets/flight-helmet.glb',
    scale: 2.5,
  },
  'scifi-helmet': {
    id: 'scifi-helmet',
    name: 'Sci-Fi Helmet',
    url: '/examples/assets/scifi-helmet.glb',
    scale: 1.0,
  },
  'mobile-helmet': {
    id: 'mobile-helmet',
    name: 'Flight Helmet Mobile',
    url: '/examples/assets/flight-helmet-mobile.glb',
    scale: 2.5,
  },
};

// Application State
let stage: Stage | null = null;
let controls: OrbitControls | null = null;
let currentModelOption = MODELS['flight-helmet'];
let currentModel: PBRModel | null = null;

// Plugins
let contactShadows: ContactShadows | null = null;
let shadows: Shadows | null = null;
let environment: Environment | null = null;
let envLighting: EnvironmentLighting | null = null;
let envBackground: EnvironmentBackground | null = null;
let oit: OIT | null = null;
let postStack: PostStack | null = null;
let ssaoEffect: SSAO | null = null;
let dofEffect: DOF | null = null;
let bloomEffect: Bloom | null = null;
let tonemapEffect: Tonemap | null = null;
let fxaaEffect: FXAA | null = null;
let taaPlugin: TAA | null = null;

// Controls State
let isTurntableActive = true;
let turntableAngle = 0;
let isStressAnimationActive = false;
let stressTime = 0;

// Material params
let matRoughness = 0.5;
let matMetallic = 0.5;
let matClearcoat = 0.0;
let matTransmission = 0.0;

// Procedural HDR Generator
function createProceduralHdri(theme: 'warm' | 'cyber', width = 128, height = 64): EnvironmentSource {
  const data = new Float32Array(width * height * 4);
  const softbox = (u: number, v: number, cu: number, cv: number, r: number) =>
    Math.exp(-(((u - cu) * 2) ** 2 + (v - cv) ** 2) / (r * r));

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const v = (y + 0.5) / height;

      if (theme === 'warm') {
        const room = v < 0.5 ? 0.35 + 0.35 * (0.5 - v) * 2 : 0.35 - 0.2 * (v - 0.5) * 2;
        const key = 6.0 * softbox(u, v, 0.35, 0.3, 0.12);
        const fill = 2.5 * softbox(u, v, 0.75, 0.35, 0.15);
        data.set(
          [room + key + fill * 0.9, room + key * 0.95 + fill * 0.95, room + key * 0.85 + fill, 1.0],
          (y * width + x) * 4,
        );
      } else {
        const key = 7.0 * softbox(u, v, 0.25, 0.35, 0.14);
        const rim = 5.0 * softbox(u, v, 0.75, 0.3, 0.1);
        data.set([0.1 + rim * 0.9, 0.15 + key * 0.9, 0.2 + key * 0.95 + rim * 0.8, 1.0], (y * width + x) * 4);
      }
    }
  }
  return { width, height, data };
}

// Load and Attach HDRI Environment
async function setHdriEnvironment(hdriType: 'workshop' | 'studio-warm' | 'studio-cyber') {
  if (!stage) return;
  log(`[Environment] Switching HDRI environment to "${hdriType}"…`, 'info');
  hudHdri.textContent = hdriType;

  // Cleanup old environment
  if (environment) {
    try {
      if (stage.engine.hasPlugin('environment')) {
        stage.engine.removePlugin('environment');
      }
      environment.dispose();
    } catch {}
    environment = null;
  }
  if (envBackground) {
    try {
      if (stage.engine.hasPlugin('environment:background')) {
        stage.engine.removePlugin('environment:background');
      }
      envBackground.dispose();
    } catch {}
    envBackground = null;
  }
  if (envLighting) {
    try {
      if (stage.engine.hasPlugin('environment:lighting')) {
        stage.engine.removePlugin('environment:lighting');
      }
      envLighting.dispose();
    } catch {}
    envLighting = null;
  }

  try {
    let envImage: EnvironmentSource;
    if (hdriType === 'workshop') {
      envImage = await loadEnvironmentImage('/examples/assets/skinning-ik-workshop.hdr');
    } else if (hdriType === 'studio-warm') {
      envImage = createProceduralHdri('warm');
    } else {
      envImage = createProceduralHdri('cyber');
    }

    environment = await Environment.attach(stage.engine, envImage, { rotation: 0 });
    EnvironmentBackground.attach(stage.engine, environment, { exposure: 1 });
    envLighting = EnvironmentLighting.attach(stage.engine, environment);

    if (currentModel) {
      envLighting.add(currentModel);
    }
    log(`[Environment] Environment "${hdriType}" attached successfully.`, 'info');
  } catch (err) {
    log(`[Environment][warning] Environment.attach note: ${(err as Error).message}`, 'warn');
  }
}

// Setup PostStack and all Post Effects
function setupPostStack() {
  if (!stage) return;

  // Clean up existing stack and TAA
  if (taaPlugin) {
    try {
      taaPlugin.dispose();
    } catch {}
    taaPlugin = null;
  }
  if (postStack) {
    try {
      postStack.dispose();
    } catch {}
    postStack = null;
  }

  log('[Post] Attaching PostStack (SSAO, DOF, Bloom, Tonemap, FXAA)…', 'info');
  try {
    ssaoEffect = new SSAO({ radius: 0.5 });
    dofEffect = new DOF({ focalDistance: 2.5, aperture: 2.8 });
    bloomEffect = new Bloom({ strength: 0.6, threshold: 0.8, radius: 0.4 });
    tonemapEffect = new Tonemap({ curve: 'neutral', exposure: 0 });
    fxaaEffect = new FXAA();

    postStack = PostStack.attach(stage.engine, [ssaoEffect, dofEffect, bloomEffect, tonemapEffect, fxaaEffect]);
    hudPostStack.textContent = 'Active';
    log('[Post] PostStack attached successfully.', 'info');

    // Attach TAA wrapping PostStack
    try {
      taaPlugin = TAA.attach(stage.engine, {
        historyWeight: 0.9,
        depth: () => postStack?.depthTexture,
      });
      hudTaa.textContent = 'Active';
      log('[TAA] TAA attached wrapping PostStack depthTexture.', 'info');
    } catch (taaErr) {
      hudTaa.textContent = 'Refused';
      log(`[TAA][warning] TAA.attach error: ${(taaErr as Error).message}`, 'warn');
    }
  } catch (err) {
    hudPostStack.textContent = 'Refused';
    log(`[Post][warning] PostStack.attach error: ${(err as Error).message}`, 'warn');
  }
}

// Setup Shadows & Staging ContactShadows
function setupShadowsAndStaging() {
  if (!stage) return;

  // 1. Staging ContactShadows
  try {
    contactShadows = ContactShadows.attach(stage.engine, {
      opacity: 0.6,
      blur: 0.08,
      resolution: 256,
    });
    hudContact.textContent = 'Active';
    log('[Staging] ContactShadows attached.', 'info');
  } catch (err) {
    hudContact.textContent = 'Refused';
    log(`[Staging][warning] ContactShadows.attach error: ${(err as Error).message}`, 'warn');
  }

  // 2. Cascaded Directional Shadows
  try {
    shadows = Shadows.attach(stage.engine, {
      resolution: 1024,
      distance: 50,
      lightSize: 0.02,
      filter: 'soft',
    });
    hudDirShadow.textContent = 'Active';
    log('[Shadows] Directional Cascaded Shadows attached.', 'info');
  } catch (err) {
    hudDirShadow.textContent = 'Refused';
    log(`[Shadows][warning] Shadows.attach error: ${(err as Error).message}`, 'warn');
  }

  // 3. Order-Independent Transparency (OIT)
  try {
    oit = OIT.attach(stage.engine);
    hudOit.textContent = 'Active';
    log('[OIT] Order-Independent Transparency attached.', 'info');
  } catch (err) {
    hudOit.textContent = 'Refused';
    log(`[OIT][warning] OIT.attach error: ${(err as Error).message}`, 'warn');
  }
}

// Load Model
async function loadProduct(option: ProductModelOption) {
  if (!stage) return;
  currentModelOption = option;
  hudModelName.textContent = option.name;
  log(`[Model] Loading model "${option.name}" (${option.url})…`, 'info');

  if (currentModel) {
    try {
      currentModel.destroy();
    } catch {}
    currentModel = null;
  }

  const t0 = performance.now();
  const loadEngine = stage.engine;
  try {
    currentModel = await loadGLTF(loadEngine, option.url);
    const ms = performance.now() - t0;
    hudPrimitives.textContent = String(currentModel.primitives.length);
    log(
      `[GLTF-Pro] Loaded "${option.name}" in ${ms.toFixed(1)} ms. Primitives: ${currentModel.primitives.length}`,
      'info',
    );

    // Scale
    if (option.scale !== 1.0) {
      currentModel.nodes[0].scale.set(option.scale, option.scale, option.scale);
    }

    // Install materials extensions (Clearcoat, Transmission, etc.)
    try {
      installMaterials(currentModel);
      log('[Materials] Materials extensions installed on model primitives.', 'info');
    } catch (matErr) {
      log(`[Materials][warning] installMaterials error: ${(matErr as Error).message}`, 'warn');
    }

    // Register with Shadow casters and Staging
    if (contactShadows) {
      contactShadows.fit(currentModel.bounds);
      contactShadows.add(currentModel);
    }
    if (shadows) {
      shadows.add(currentModel);
    }
    if (oit) {
      oit.add(currentModel);
    }
    if (envLighting) {
      envLighting.add(currentModel);
    }

    // Apply live material sliders
    applyLiveMaterials();

    // Frame camera to model
    const b = currentModel.bounds;
    stage.engine.camera.fitToBoundingBox([b[0], b[1], b[2]], [b[3], b[4], b[5]], { duration: 0.3 });
  } catch (err) {
    // A load whose engine the page disposed meanwhile (scene recreate) rejects with code disposed, as it should.
    const stopped = (err as { code?: unknown }).code === 'disposed' && loadEngine !== stage?.engine;
    if (stopped) log(`[Model] Load of "${option.name}" stopped: its engine was disposed.`, 'info');
    else log(`[GLTF-Pro][error] Failed to load "${option.name}": ${(err as Error).message}`, 'error');
  }
}

// Apply Material Tuning Live
function applyLiveMaterials() {
  if (!currentModel) return;
  for (const p of currentModel.primitives) {
    const mat = p.material as unknown as Record<string, unknown>;
    if (mat) {
      mat.roughnessFactor = matRoughness;
      mat.metallicFactor = matMetallic;
      mat.clearcoatFactor = matClearcoat;
      mat.transmissionFactor = matTransmission;
    }
  }
}

// Apply Color Tint Preset
function applyColorPreset(preset: 'default' | 'gold' | 'chrome' | 'ruby' | 'emerald' | 'ceramic') {
  if (!currentModel) return;
  log(`[Materials] Applying color preset "${preset}"…`, 'info');

  const configs: Record<
    string,
    { color?: [number, number, number, number]; r: number; m: number; c: number; t: number }
  > = {
    default: { color: [1, 1, 1, 1], r: 0.5, m: 0.5, c: 0.0, t: 0.0 },
    gold: { color: [1.0, 0.766, 0.336, 1.0], r: 0.15, m: 1.0, c: 0.2, t: 0.0 },
    chrome: { color: [0.95, 0.95, 0.95, 1.0], r: 0.05, m: 1.0, c: 0.5, t: 0.0 },
    ruby: { color: [0.9, 0.05, 0.15, 0.75], r: 0.1, m: 0.05, c: 0.8, t: 0.85 },
    emerald: { color: [0.05, 0.85, 0.25, 0.8], r: 0.15, m: 0.05, c: 0.8, t: 0.8 },
    ceramic: { color: [0.95, 0.95, 0.9, 1.0], r: 0.3, m: 0.0, c: 1.0, t: 0.0 },
  };

  const cfg = configs[preset];
  if (!cfg) return;

  matRoughness = cfg.r;
  matMetallic = cfg.m;
  matClearcoat = cfg.c;
  matTransmission = cfg.t;

  (document.getElementById('rngRoughness') as HTMLInputElement).value = String(cfg.r);
  document.getElementById('valRoughness')!.textContent = cfg.r.toFixed(2);
  (document.getElementById('rngMetallic') as HTMLInputElement).value = String(cfg.m);
  document.getElementById('valMetallic')!.textContent = cfg.m.toFixed(2);
  (document.getElementById('rngClearcoat') as HTMLInputElement).value = String(cfg.c);
  document.getElementById('valClearcoat')!.textContent = cfg.c.toFixed(2);
  (document.getElementById('rngTransmission') as HTMLInputElement).value = String(cfg.t);
  document.getElementById('valTransmission')!.textContent = cfg.t.toFixed(2);

  for (const p of currentModel.primitives) {
    const mat = p.material as unknown as Record<string, unknown>;
    if (mat) {
      if (cfg.color) mat.baseColorFactor = cfg.color;
      mat.roughnessFactor = cfg.r;
      mat.metallicFactor = cfg.m;
      mat.clearcoatFactor = cfg.c;
      mat.transmissionFactor = cfg.t;
    }
  }
}

// Test Draco and KTX2 Decoders
async function testCompressedDecoders() {
  log('[Decoders] Running Draco and KTX2 Decoder test…', 'info');
  const valDraco = document.getElementById('valDracoStatus')!;
  const valKtx2 = document.getElementById('valKtx2Status')!;

  // 1. Draco Decoder
  valDraco.textContent = 'Decoding…';
  let draco: DracoDecoder | null = null;
  try {
    draco = new DracoDecoder({ workerLimit: 2 });
    const resp = await fetch('/packages/decoders/tests/fixtures/readme/avocado.drc');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const bytes = new Uint8Array(await resp.arrayBuffer());

    const geom = await draco.decode(bytes, { attributeIds: { POSITION: 3, NORMAL: 1, TEXCOORD_0: 0 } });
    valDraco.textContent = `Decoded (${geom.positions.length / 3} pts)`;
    log(
      `[Decoders] Draco decoded Avocado bufferView: ${geom.positions.length / 3} vertices, ${geom.indices?.length ?? 0} indices.`,
      'info',
    );
  } catch (err) {
    valDraco.textContent = 'Error';
    log(`[Decoders][error] Draco decode error: ${(err as Error).message}`, 'error');
  } finally {
    try {
      draco?.dispose();
    } catch {}
  }

  // 2. KTX2 Decoder
  valKtx2.textContent = 'Transcoding…';
  let ktx2: KTX2Decoder | null = null;
  try {
    const device = stage?.engine.gpu;
    if (!device) throw new Error('GPUDevice not available (WebGL2 or missing GPU)');
    ktx2 = new KTX2Decoder({ device, workerLimit: 2 });
    const resp = await fetch('/packages/decoders/tests/fixtures/Dot_C.ktx2');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const bytes = await resp.arrayBuffer();

    const texture = await ktx2.createTexture(bytes);
    valKtx2.textContent = `Transcoded (${texture.width}x${texture.height})`;
    log(
      `[Decoders] KTX2 transcoded Dot_C.ktx2 texture: ${texture.width}x${texture.height}, format: ${texture.format}`,
      'info',
    );
  } catch (err) {
    valKtx2.textContent = 'Error';
    log(`[Decoders][error] KTX2 transcode error: ${(err as Error).message}`, 'error');
  } finally {
    try {
      ktx2?.dispose();
    } catch {}
  }
}

// Rapid Load/Unload 10x Stress Test
async function stressLoadUnload() {
  log('[Stress] Starting Rapid Load / Unload (10x) stress loop…', 'info');
  const options = Object.values(MODELS);
  const t0 = performance.now();

  for (let i = 0; i < 10; i++) {
    const opt = options[i % options.length];
    log(`[Stress] Load/Unload ${i + 1}/10: Loading "${opt.name}"…`, 'info');
    await loadProduct(opt);
  }

  const ms = performance.now() - t0;
  log(`[Stress] 10x Load/Unload completed in ${ms.toFixed(1)} ms.`, 'info');
}

// Rapid Toggle All Post Effects 20x Stress Test
async function stressToggleAllPost() {
  log('[Stress] Starting Rapid Toggle All Post Effects (20x)…', 'info');
  const t0 = performance.now();

  for (let i = 0; i < 20; i++) {
    const state = i % 2 === 0;
    if (ssaoEffect) ssaoEffect.enabled = state;
    if (dofEffect) dofEffect.enabled = state;
    if (bloomEffect) bloomEffect.options.strength = state ? 0.8 : 0.0;
    if (tonemapEffect) tonemapEffect.options.exposure = state ? 0.5 : -0.5;
    if (contactShadows) contactShadows.options.opacity = state ? 0.8 : 0.0;
    if (shadows) shadows.options.lightSize = state ? 0.05 : 0.005;
  }

  const ms = performance.now() - t0;
  log(`[Stress] 20x Rapid Post Toggle completed in ${ms.toFixed(1)} ms.`, 'info');
}

// Initialize Scene and Stage
async function initScene() {
  if (stage) {
    try {
      if (currentModel) currentModel.destroy();
      if (taaPlugin) taaPlugin.dispose();
      if (postStack) postStack.dispose();
      if (contactShadows) contactShadows.dispose();
      if (shadows) shadows.dispose();
      if (environment) environment.dispose();
      if (oit) oit.dispose();
      stage.dispose();
      log('[Lifecycle] Previous stage disposed cleanly.', 'info');
    } catch (e) {
      log(`[Lifecycle] stage.dispose() error: ${(e as Error).message}`, 'error');
    }
    stage = null;
    currentModel = null;
    taaPlugin = null;
    postStack = null;
    contactShadows = null;
    shadows = null;
    environment = null;
    oit = null;
  }

  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  log(`[Init] Creating Stage (backend: ${isWebgl2 ? 'webgl2' : 'auto'})…`, 'info');

  try {
    if (isWebgl2) {
      await installWebGL2Compat({ force: true });
    }
    stage = await createStage(canvas, {
      camera: { position: [0, 1.2, 2.5], target: [0, 0.4, 0], near: 0.01, far: 500 },
      controls: false,
      onError: (err) => log(`Stage engine error: ${String(err)}`, 'error'),
    });
    log('[Init] Stage initialized successfully.', 'info');
  } catch (err) {
    log(`Failed to create stage: ${(err as Error).message}`, 'error');
    return;
  }

  // Controls
  try {
    controls = OrbitControls.attach(stage.engine);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    log('[Controls] OrbitControls attached.', 'info');
  } catch (err) {
    log(`[Controls] OrbitControls error: ${(err as Error).message}`, 'error');
  }

  // Setup Shadows & Staging
  setupShadowsAndStaging();

  // Setup PostStack
  setupPostStack();

  // Setup HDRI
  await setHdriEnvironment('workshop');

  // Load Model
  await loadProduct(currentModelOption);

  // Frame tick
  stage.onTick((delta) => {
    onFrameTick(delta);
  });
}

// Frame Tick & Telemetry
let lastFrameTime = performance.now();
let frameCount = 0;
let lastFpsUpdate = performance.now();

function onFrameTick(delta: number) {
  const now = performance.now();
  const frameMs = now - lastFrameTime;
  lastFrameTime = now;
  frameCount++;

  if (now - lastFpsUpdate >= 250) {
    const fps = Math.round((frameCount * 1000) / (now - lastFpsUpdate));
    hudFps.textContent = String(fps);
    hudFrameTime.textContent = `${frameMs.toFixed(1)} ms`;
    frameCount = 0;
    lastFpsUpdate = now;

    const mem = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory;
    if (mem?.usedJSHeapSize) {
      hudMemory.textContent = `${(mem.usedJSHeapSize / 1048576).toFixed(1)} MB`;
    }
  }

  if (controls) {
    controls.update();
  }

  // Turntable Rotation
  if (isTurntableActive && currentModel?.nodes[0]) {
    turntableAngle += delta * 0.5;
    currentModel.nodes[0].rotation.set(0, turntableAngle, 0);
  }

  // 60 FPS Continuous Stress Loop
  if (isStressAnimationActive) {
    stressTime += delta * 2.0;

    // Modulate roughness & metallic
    matRoughness = 0.5 + Math.sin(stressTime) * 0.45;
    matMetallic = 0.5 + Math.cos(stressTime * 0.8) * 0.45;
    applyLiveMaterials();

    // Modulate exposure
    if (tonemapEffect) {
      tonemapEffect.options.exposure = Math.sin(stressTime * 1.5) * 1.2;
    }
  }
}

// Setup Event Listeners
function setupUI() {
  // Model Selector
  const selModel = document.getElementById('selProductModel') as HTMLSelectElement;
  selModel.addEventListener('change', () => {
    const opt = MODELS[selModel.value];
    if (opt) loadProduct(opt);
  });

  document.getElementById('btnRapidLoadUnload')!.addEventListener('click', () => {
    stressLoadUnload();
  });

  // Turntable Toggle
  const btnTurntable = document.getElementById('btnToggleTurntable')!;
  btnTurntable.addEventListener('click', () => {
    isTurntableActive = !isTurntableActive;
    btnTurntable.textContent = `Turntable: ${isTurntableActive ? 'ON' : 'OFF'}`;
    btnTurntable.classList.toggle('active', isTurntableActive);
  });

  // HDRI Selector
  const selHdri = document.getElementById('selHdri') as HTMLSelectElement;
  selHdri.addEventListener('change', () => {
    setHdriEnvironment(selHdri.value as 'workshop' | 'studio-warm' | 'studio-cyber');
  });

  const rngEnvInt = document.getElementById('rngEnvIntensity') as HTMLInputElement;
  const valEnvInt = document.getElementById('valEnvIntensity')!;
  rngEnvInt.addEventListener('input', () => {
    const v = parseFloat(rngEnvInt.value);
    valEnvInt.textContent = v.toFixed(2);
    if (environment) environment.intensity = v;
  });

  const rngEnvRot = document.getElementById('rngEnvRotation') as HTMLInputElement;
  const valEnvRot = document.getElementById('valEnvRotation')!;
  rngEnvRot.addEventListener('input', () => {
    const deg = parseFloat(rngEnvRot.value);
    valEnvRot.textContent = `${deg.toFixed(0)}°`;
    if (environment) environment.rotation = (deg * Math.PI) / 180;
  });

  // Materials Sliders
  const rngR = document.getElementById('rngRoughness') as HTMLInputElement;
  const valR = document.getElementById('valRoughness')!;
  rngR.addEventListener('input', () => {
    matRoughness = parseFloat(rngR.value);
    valR.textContent = matRoughness.toFixed(2);
    applyLiveMaterials();
  });

  const rngM = document.getElementById('rngMetallic') as HTMLInputElement;
  const valM = document.getElementById('valMetallic')!;
  rngM.addEventListener('input', () => {
    matMetallic = parseFloat(rngM.value);
    valM.textContent = matMetallic.toFixed(2);
    applyLiveMaterials();
  });

  const rngC = document.getElementById('rngClearcoat') as HTMLInputElement;
  const valC = document.getElementById('valClearcoat')!;
  rngC.addEventListener('input', () => {
    matClearcoat = parseFloat(rngC.value);
    valC.textContent = matClearcoat.toFixed(2);
    applyLiveMaterials();
  });

  const rngT = document.getElementById('rngTransmission') as HTMLInputElement;
  const valT = document.getElementById('valTransmission')!;
  rngT.addEventListener('input', () => {
    matTransmission = parseFloat(rngT.value);
    valT.textContent = matTransmission.toFixed(2);
    applyLiveMaterials();
  });

  // Color Preset Buttons
  document.getElementById('btnMatDefault')!.addEventListener('click', () => applyColorPreset('default'));
  document.getElementById('btnMatGold')!.addEventListener('click', () => applyColorPreset('gold'));
  document.getElementById('btnMatChrome')!.addEventListener('click', () => applyColorPreset('chrome'));
  document.getElementById('btnMatRuby')!.addEventListener('click', () => applyColorPreset('ruby'));
  document.getElementById('btnMatEmerald')!.addEventListener('click', () => applyColorPreset('emerald'));
  document.getElementById('btnMatCeramic')!.addEventListener('click', () => applyColorPreset('ceramic'));

  // Post Effects Toggles
  const chkPostStack = document.getElementById('chkPostStack') as HTMLInputElement;
  chkPostStack.addEventListener('change', () => {
    if (chkPostStack.checked) setupPostStack();
    else {
      postStack?.dispose();
      postStack = null;
      hudPostStack.textContent = 'Off';
    }
  });

  document.getElementById('btnStressTogglePost')!.addEventListener('click', () => {
    stressToggleAllPost();
  });

  const chkSsao = document.getElementById('chkSsao') as HTMLInputElement;
  chkSsao.addEventListener('change', () => {
    if (ssaoEffect) ssaoEffect.enabled = chkSsao.checked;
    hudSsao.textContent = chkSsao.checked ? 'On' : 'Off';
  });

  const chkDof = document.getElementById('chkDof') as HTMLInputElement;
  chkDof.addEventListener('change', () => {
    if (dofEffect) dofEffect.enabled = chkDof.checked;
    hudDof.textContent = chkDof.checked ? 'On' : 'Off';
  });

  const rngDof = document.getElementById('rngDofDistance') as HTMLInputElement;
  const valDofDist = document.getElementById('valDofDistance')!;
  rngDof.addEventListener('input', () => {
    const d = parseFloat(rngDof.value);
    valDofDist.textContent = `${d.toFixed(1)} m`;
    if (dofEffect) dofEffect.options.focalDistance = d;
  });

  const chkBloom = document.getElementById('chkBloom') as HTMLInputElement;
  chkBloom.addEventListener('change', () => {
    if (bloomEffect) bloomEffect.options.strength = chkBloom.checked ? 0.6 : 0.0;
    hudBloom.textContent = chkBloom.checked ? 'On' : 'Off';
  });

  const chkTaa = document.getElementById('chkTaa') as HTMLInputElement;
  chkTaa.addEventListener('change', () => {
    if (taaPlugin) taaPlugin.options.historyWeight = chkTaa.checked ? 0.9 : 0.0;
    hudTaa.textContent = chkTaa.checked ? 'On' : 'Off';
  });

  const chkContact = document.getElementById('chkContactShadows') as HTMLInputElement;
  chkContact.addEventListener('change', () => {
    if (contactShadows) contactShadows.options.opacity = chkContact.checked ? 0.6 : 0.0;
    hudContact.textContent = chkContact.checked ? 'On' : 'Off';
  });

  const chkDirShadows = document.getElementById('chkDirectionalShadows') as HTMLInputElement;
  chkDirShadows.addEventListener('change', () => {
    if (shadows) shadows.options.lightSize = chkDirShadows.checked ? 0.02 : 0.0001;
    hudDirShadow.textContent = chkDirShadows.checked ? 'On' : 'Off';
  });

  const selTone = document.getElementById('selTonemapCurve') as HTMLSelectElement;
  selTone.addEventListener('change', () => {
    if (tonemapEffect) {
      tonemapEffect.options.curve = selTone.value as 'neutral' | 'agx' | 'acescg';
      hudTone.textContent = selTone.value;
    }
  });

  const rngExp = document.getElementById('rngExposure') as HTMLInputElement;
  const valExp = document.getElementById('valExposure')!;
  rngExp.addEventListener('input', () => {
    const e = parseFloat(rngExp.value);
    valExp.textContent = e.toFixed(1);
    if (tonemapEffect) tonemapEffect.options.exposure = e;
  });

  // Decoders Button
  document.getElementById('btnTestDecoders')!.addEventListener('click', () => {
    testCompressedDecoders();
  });

  // Stress Animation
  const btnStress = document.getElementById('btnToggleStressAnimation')!;
  btnStress.addEventListener('click', () => {
    isStressAnimationActive = !isStressAnimationActive;
    btnStress.classList.toggle('active', isStressAnimationActive);
    log(`[Stress] 60 FPS continuous stress animation: ${isStressAnimationActive}`, 'info');
  });

  // 390px Mobile View
  const viewportWrapper = document.getElementById('viewportWrapper')!;
  const btnResizeMobile = document.getElementById('btnResizeMobile')!;
  btnResizeMobile.addEventListener('click', () => {
    viewportWrapper.classList.toggle('mobile-view');
    const isMobile = viewportWrapper.classList.contains('mobile-view');
    btnResizeMobile.textContent = isMobile ? 'Restore Viewport (100%)' : 'Toggle 390px Mobile View';
    btnResizeMobile.classList.toggle('active', isMobile);
    log(`[Stress] Viewport resized to ${isMobile ? '390px (Mobile)' : '100%'}`, 'info');
  });

  // Focus Loss Simulation
  document.getElementById('btnSimulateFocusLoss')!.addEventListener('click', () => {
    log('[Stress] Simulating window blur / focus loss…', 'info');
    window.dispatchEvent(new Event('blur'));
    setTimeout(() => {
      log('[Stress] Simulating window focus restore…', 'info');
      window.dispatchEvent(new Event('focus'));
    }, 800);
  });

  // Re-create Scene
  document.getElementById('btnRecreateScene')!.addEventListener('click', () => {
    log('[Stress] Re-creating scene from scratch…', 'info');
    initScene();
  });
}

// Start
setupUI();
ready(initScene());
