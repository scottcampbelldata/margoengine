import { ready } from './page-harness';
import { createStage, type Stage } from '@margoengine/stage';
import { Geometry } from '@margoengine/core';
import { boxGeometry, cylinderGeometry, torusGeometry, planeGeometry } from '@margoengine/geometry';
import { Transitions, type TransitionKind } from '@margoengine/transitions';
import { createMaskTransition } from '@margoengine/transitions/mask';
import { Ui, UiRenderer, Panel, Label, Button, Slider, Toggle } from '@margoengine/ui';
import { TextRenderer, Text, Font } from '@margoengine/text';
import { LabelRenderer } from '@margoengine/labels';
import { HTML } from '@margoengine/html';
import { Tween, Spring, smoothDamp, easeInOutCubic } from '@margoengine/tween';
import { stagger } from '@margoengine/tween/stagger';
import { CutscenePlayer, type CutsceneDocument } from '@margoengine/cutscene';
import { Cinematic } from '@margoengine/cinematic';
import { AudioListener, Audio, AudioVoicePool, AudioAnalyser } from '@margoengine/audio';
import { Video } from '@margoengine/video';
import { install as installWebGL2Compat } from '@margoengine/webgl2-compat';

// Check backend mode
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
window.addEventListener('error', (e) => {
  console.error('[Page Error Caught]', e.message, e.filename, e.lineno);
  (window as any).__testErrors.push({
    message: e.message,
    filename: e.filename,
    lineno: e.lineno,
  });
});

let stage: Stage | null = null;
let transitions: Transitions | null = null;
let maskTransition: any = null;
let ui: Ui | null = null;
let textRenderer: TextRenderer | null = null;
let labelRenderer: LabelRenderer | null = null;
let htmlPlugin: HTML | null = null;
let cinematicRig: Cinematic | null = null;
let audioListener: AudioListener | null = null;
let audioVoicePool: AudioVoicePool | null = null;
let _audioAnalyser: AudioAnalyser | null = null;
let videoPlugin: Video | null = null;
let cutscenePlayer: CutscenePlayer | null = null;

// Scene object tracking
let currentSceneIndex = 1;
const scene1Meshes: any[] = [];
const scene2Meshes: any[] = [];
const scene3Meshes: any[] = [];

// Rotating meshes for Scene 1
let spinnerCube: any = null;
let spinnerTorus: any = null;
let billboardText: Text | null = null;
let frameCounterText: Text | null = null;
let htmlLabelEl: HTMLElement | null = null;
let html3dPanelEl: HTMLElement | null = null;
let htmlAnchorEl: HTMLElement | null = null;

// Tweens & Springs
const tween = new Tween();
const spring = new Spring({ stiffness: 120, damping: 10 });
spring.target = 1.0;
const dampPos = new Float32Array([0, 2, 8]);
const dampTarget = new Float32Array([0, 2, 8]);
const dampVel = new Float32Array(3);

// FPS & performance tracking
let frameCount = 0;
let lastFpsTime = performance.now();
let lastFrameTime = performance.now();
let currentFps = 60;
let currentFrameDuration = 16.6;

// Audio synthetic buffers
function createSyntheticTone(ctx: BaseAudioContext, frequency = 440, duration = 0.4): AudioBuffer {
  const sampleRate = ctx.sampleRate;
  const buffer = ctx.createBuffer(1, Math.floor(sampleRate * duration), sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    const t = i / sampleRate;
    const envelope = Math.max(0, 1 - t / duration);
    data[i] = Math.sin(2 * Math.PI * frequency * t) * envelope * 0.3;
  }
  return buffer;
}

// Cutscene document definition
const cutsceneDoc: CutsceneDocument = {
  format: 'margo-cutscene',
  version: 1,
  duration: 6.0,
  markers: [
    { time: 1.5, name: 'scene-intro' },
    { time: 3.5, name: 'camera-flyby' },
    { time: 5.0, name: 'finale' },
  ],
  tracks: [
    {
      type: 'camera',
      id: 'main-cam',
      path: 'catmull-rom',
      keys: [
        { time: 0.0, position: [0, 4, 10], target: [0, 1, 0], fov: 60 },
        { time: 2.0, position: [6, 3, 6], target: [0, 1, 0], fov: 50, ease: 'easeInOutCubic' },
        { time: 3.5, position: [0, 1.8, 3], target: [0, 1.5, 0], fov: 40, cut: true },
        { time: 6.0, position: [-6, 5, 8], target: [0, 1, 0], fov: 55, ease: 'easeOutBack' },
      ],
    },
    {
      type: 'subtitle',
      id: 'subtitles',
      clips: [
        { start: 0.2, duration: 1.8, text: 'Scene 3: Orchestrated Cutscene Playback', speaker: 'Director' },
        { start: 2.2, duration: 2.0, text: 'Seamless camera spline interpolation & cuts', speaker: 'System' },
        { start: 4.5, duration: 1.4, text: 'Real-time subtitles, events, and audio triggers', speaker: 'Narrator' },
      ],
    },
    {
      type: 'event',
      id: 'director-cues',
      events: [
        { time: 1.5, name: 'cueFlash', data: { intensity: 2.0 } },
        { time: 3.5, name: 'cueShake', data: { magnitude: 0.4 } },
        { time: 5.5, name: 'cueEnd', data: {} },
      ],
    },
  ],
};

function createGeometryFromData(data: {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint16Array | Uint32Array;
}) {
  return new Geometry(data.positions, data.normals, data.indices);
}

// Generate gradient mask ImageData for mask transitions
function createGradientMask(): ImageData {
  const size = 32;
  const pixels = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const v = Math.floor(((x + y) / (size * 2)) * 255);
      pixels[idx] = v; // R (threshold)
      pixels[idx + 1] = v; // G
      pixels[idx + 2] = v; // B
      pixels[idx + 3] = 255;
    }
  }
  return new ImageData(pixels, size, size);
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
    camera: { position: [0, 3, 9], target: [0, 1, 0] },
  });
  // Scene look: clear colour and lighting live on the scene, not in the stage options.
  stage.engine.scene.background = '#090d16';
  stage.engine.lighting.direction.set([5, 10, 7, 2.5]);
  stage.engine.lighting.radiance.set([1, 0.95, 0.9, 1]);
  stage.engine.lighting.ambient.set([0.15, 0.18, 0.25]);

  const engine = stage.engine;

  // 1. ATTACH TRANSITIONS (@margoengine/transitions)
  try {
    transitions = Transitions.attach(engine);
  } catch (err: any) {
    console.warn('[Transitions Attach Failed - expected on WebGL2]', err);
    (window as any).__transitionsError = err.message || String(err);
  }

  try {
    const maskData = createGradientMask();
    maskTransition = createMaskTransition(engine, maskData, { softness: 0.05 });
  } catch (err: any) {
    console.warn('[Mask Transition Attach Failed - plugin collision / WebGL2]', err);
    (window as any).__maskTransitionError = err.message || String(err);
  }

  // 2. ATTACH IN-ENGINE UI (@margoengine/ui)
  try {
    ui = new Ui();
    UiRenderer.attach(engine, ui);

    const uiPanel = new Panel({
      background: 'surface',
      border: true,
      shadow: true,
      padding: [10, 14],
      gap: 8,
      width: 220,
      anchor: 'top-right',
      margin: 16,
      children: [
        new Label({ text: 'In-Engine UI', size: 'title' }),
        new Button({
          text: 'Next Scene',
          variant: 'primary',
          onClick: () => {
            cycleScene();
            ui?.toast(`Switched to Scene ${currentSceneIndex}`);
          },
        }),
        new Slider({
          text: 'Spring Target',
          value: 1.0,
          onChange: (e) => {
            if (typeof e.value === 'number') spring.target = e.value;
          },
        }),
        new Toggle({
          text: 'Shake Camera',
          checked: false,
          onChange: (e) => {
            if (e.value && cinematicRig) cinematicRig.shake(0.3, 0.5);
          },
        }),
      ],
    });
    ui.add(uiPanel);
    ui.toast('Margo Engine UI Active');
  } catch (err: any) {
    console.warn('[UI Attach Failed]', err);
    (window as any).__uiError = err.message || String(err);
  }

  // 3. ATTACH 3D SDF TEXT (@margoengine/text)
  try {
    textRenderer = TextRenderer.attach(engine);
    const interFont = new Font({ family: 'sans-serif', weight: 600 });

    const sceneTitle = new Text({
      text: 'SCENE 1: ARCHITECTURE & SDF TEXT',
      font: interFont,
      fontSize: 0.45,
      color: '#38bdf8',
      outlineWidth: 0.015,
      outlineColor: '#000000',
      shadowOpacity: 0.5,
      position: [0, 4.2, 0],
      textAlign: 'center',
      anchorX: 'center',
      anchorY: 'middle',
    });
    textRenderer.add(sceneTitle);

    frameCounterText = new Text({
      text: 'Frame: 0',
      font: interFont,
      fontSize: 0.25,
      color: '#a7f3d0',
      position: [0, 3.6, 0],
      textAlign: 'center',
      anchorX: 'center',
      anchorY: 'middle',
    });
    textRenderer.add(frameCounterText);
  } catch (err: any) {
    console.warn('[Text Attach Failed]', err);
    (window as any).__textError = err.message || String(err);
  }

  // 4. ATTACH HTML LABELS (@margoengine/labels)
  try {
    labelRenderer = LabelRenderer.attach(engine);
  } catch (err: any) {
    console.warn('[Labels Attach Failed]', err);
    (window as any).__labelsError = err.message || String(err);
  }

  // 5. ATTACH HTML OCCLUSION ANCHORS (@margoengine/html)
  try {
    htmlPlugin = HTML.attach(engine, {
      fade: { radius: 8, samples: 4, duration: 0.15 },
    });
  } catch (err: any) {
    console.warn('[HTML Attach Failed]', err);
    (window as any).__htmlError = err.message || String(err);
  }

  // 6. ATTACH CINEMATIC RIG (@margoengine/cinematic)
  try {
    cinematicRig = Cinematic.attach(engine, {
      offset: [0, 3, 7],
      damping: 6,
      lookDamping: 8,
    });
  } catch (err: any) {
    console.warn('[Cinematic Attach Failed]', err);
    (window as any).__cinematicError = err.message || String(err);
  }

  // 7. ATTACH AUDIO ENGINE (@margoengine/audio)
  try {
    audioListener = AudioListener.attach(engine, { volume: 0.7 });
    if (audioListener && audioListener.context) {
      const toneBuffer = createSyntheticTone(audioListener.context, 520, 0.35);
      audioVoicePool = new AudioVoicePool(audioListener, toneBuffer, {
        voices: 6,
        refDistance: 2,
      });

      const backgroundSound = new Audio(audioListener, { volume: 0.3, loop: true });
      backgroundSound.setBuffer(createSyntheticTone(audioListener.context, 220, 1.5));
      _audioAnalyser = new AudioAnalyser(backgroundSound, 256);
    }
  } catch (err: any) {
    console.warn('[Audio Attach Failed]', err);
    (window as any).__audioError = err.message || String(err);
  }

  // 8. ATTACH VIDEO PLUGIN (@margoengine/video)
  const videoEl = document.querySelector<HTMLVideoElement>('#test-video');
  if (videoEl) {
    videoEl.play().catch(() => {});
    try {
      videoPlugin = Video.attach(engine, videoEl, {
        rect: [0.7, 0.7, 0.28, 0.28],
      });
    } catch (err: any) {
      console.warn('[Video Attach Failed - expected on WebGL2]', err);
      (window as any).__videoError = err.message || String(err);
    }
  }

  // 9. INITIALIZE CUTSCENE SEQUENCER (@margoengine/cutscene)
  try {
    cutscenePlayer = new CutscenePlayer(cutsceneDoc);
    const _subtitleEl = document.querySelector<HTMLElement>('#subtitles-box');

    cutscenePlayer.on('event', (e) => {
      if (e.name === 'cueShake' && cinematicRig) {
        const data = e.data as { magnitude?: number } | undefined;
        cinematicRig.shake(data?.magnitude || 0.3, 0.4);
      }
    });

    cutscenePlayer.on('marker', (m) => {
      if (ui) ui.toast(`Marker passed: ${m.name}`);
    });
  } catch (err: any) {
    console.warn('[Cutscene Init Failed]', err);
    (window as any).__cutsceneError = err.message || String(err);
  }

  // BUILD SCENE MESHES
  buildScene1();
  buildScene2();
  buildScene3();

  // Set initial scene visibility
  updateSceneVisibility(1);

  // Setup DOM listeners
  setupHUDControls();

  // Start animation render loop
  requestAnimationFrame(renderLoop);
  (window as any).__testStatus = 'ready';
}

function buildScene1() {
  if (!stage) return;
  const engine = stage.engine;

  // Ground plane
  const groundGeom = createGeometryFromData(planeGeometry(20, 20));
  const groundMesh = engine.createMesh().setGeometry(groundGeom);
  groundMesh.rotation.set(-Math.PI / 2, 0, 0);
  groundMesh.position.set(0, -0.05, 0);
  scene1Meshes.push(groundMesh);

  // Center spinner cube
  const cubeGeom = createGeometryFromData(boxGeometry(1.6, 1.6, 1.6));
  spinnerCube = engine.createMesh().setGeometry(cubeGeom);
  spinnerCube.position.set(0, 1.2, 0);
  scene1Meshes.push(spinnerCube);

  // Follow spinner cube with cinematic rig
  if (cinematicRig) {
    cinematicRig.follow(spinnerCube);
  }

  // Torus spinning around cube
  const torusGeom = createGeometryFromData(torusGeometry(2.4, 0.25, 24, 48));
  spinnerTorus = engine.createMesh().setGeometry(torusGeom);
  spinnerTorus.position.set(0, 1.2, 0);
  scene1Meshes.push(spinnerTorus);

  // Surrounding architectural pillars
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2;
    const x = Math.cos(angle) * 5.0;
    const z = Math.sin(angle) * 5.0;
    const pillarGeom = createGeometryFromData(cylinderGeometry(0.35, 0.35, 3.5, 16));
    const pillarMesh = engine.createMesh().setGeometry(pillarGeom);
    pillarMesh.position.set(x, 1.75, z);
    scene1Meshes.push(pillarMesh);
  }

  // Billboard text attached to spinner cube
  if (textRenderer) {
    try {
      const font = new Font({ family: 'sans-serif', weight: 600 });
      billboardText = new Text({
        text: 'Target Node',
        font,
        fontSize: 0.3,
        billboard: true,
        mesh: spinnerCube,
        position: [0, 1.2, 0],
        color: '#fbbf24',
      });
      textRenderer.add(billboardText);
    } catch (e) {
      console.warn('Billboard text add failed', e);
    }
  }

  // HTML 2D Label attached to spinner cube
  if (labelRenderer) {
    try {
      htmlLabelEl = document.createElement('div');
      htmlLabelEl.className = 'custom-label-2d';
      htmlLabelEl.textContent = 'Anchor: SpinnerCube';
      labelRenderer.add(htmlLabelEl, {
        mesh: spinnerCube,
        offset: [0, 1.2, 0],
        anchor: [0.5, 1],
        distanceScale: { reference: 6, min: 0.5, max: 2.0 },
      });

      // CSS 3D panel attached to spinner cube
      html3dPanelEl = document.createElement('div');
      html3dPanelEl.className = 'custom-label-3d';
      html3dPanelEl.innerHTML = '<strong>CSS 3D Tag</strong><br>Matrix Synchronized';
      labelRenderer.add3D(html3dPanelEl, {
        mesh: spinnerCube,
        pixelScale: 0.008,
      });
    } catch (e) {
      console.warn('Label add failed', e);
    }
  }

  // HTML Smooth Depth Occlusion Anchor
  if (htmlPlugin) {
    try {
      htmlAnchorEl = document.createElement('div');
      htmlAnchorEl.className = 'custom-html-anchor';
      htmlAnchorEl.textContent = 'Partial Occlusion Anchor';
      htmlPlugin.add(htmlAnchorEl, { position: [0, 1.0, -1.8] });
    } catch (e) {
      console.warn('HTML add failed', e);
    }
  }
}

function buildScene2() {
  if (!stage) return;
  const engine = stage.engine;

  // Video wall back screen
  const wallGeom = createGeometryFromData(planeGeometry(8, 4.5));
  const wallMesh = engine.createMesh().setGeometry(wallGeom);
  wallMesh.position.set(0, 2.5, -4);
  scene2Meshes.push(wallMesh);

  // Floating props animated by Tween & Stagger
  const floatingCubes: any[] = [];
  for (let x = -4; x <= 4; x += 2) {
    const cubeGeom = createGeometryFromData(boxGeometry(0.8, 0.8, 0.8));
    const mesh = engine.createMesh().setGeometry(cubeGeom);
    mesh.position.set(x, 1.0, 0);
    floatingCubes.push(mesh);
    scene2Meshes.push(mesh);
  }

  // Stagger animation across floating cubes
  try {
    stagger(
      tween,
      floatingCubes.map((c) => c.position),
      'y',
      2.8,
      {
        duration: 1.2,
        easing: easeInOutCubic,
        repeat: Infinity,
        yoyo: true,
        stagger: { each: 0.15, from: 'center' },
      },
    );
  } catch (e) {
    console.warn('Tween stagger failed', e);
  }
}

function buildScene3() {
  if (!stage) return;
  const engine = stage.engine;

  // Cinematic character stand-in / sculpture
  const standGeom = createGeometryFromData(cylinderGeometry(1.5, 1.8, 0.4, 24));
  const standMesh = engine.createMesh().setGeometry(standGeom);
  standMesh.position.set(0, 0.2, 0);
  scene3Meshes.push(standMesh);

  const statueGeom = createGeometryFromData(torusGeometry(1.2, 0.35, 16, 32));
  const statueMesh = engine.createMesh().setGeometry(statueGeom);
  statueMesh.position.set(0, 1.8, 0);
  statueMesh.rotation.set(Math.PI / 4, Math.PI / 4, 0);
  scene3Meshes.push(statueMesh);
}

function updateSceneVisibility(sceneIdx: number) {
  currentSceneIndex = sceneIdx;

  for (const m of scene1Meshes) {
    m.visible = sceneIdx === 1;
  }
  for (const m of scene2Meshes) {
    m.visible = sceneIdx === 2;
  }
  for (const m of scene3Meshes) {
    m.visible = sceneIdx === 3;
  }

  if (htmlLabelEl) htmlLabelEl.style.display = sceneIdx === 1 ? 'block' : 'none';
  if (html3dPanelEl) html3dPanelEl.style.display = sceneIdx === 1 ? 'block' : 'none';
  if (htmlAnchorEl) htmlAnchorEl.style.display = sceneIdx === 1 ? 'block' : 'none';

  // In Scene 3, start cutscene playback
  const subBox = document.querySelector<HTMLElement>('#subtitles-box');
  if (sceneIdx === 3) {
    if (subBox) subBox.style.display = 'block';
    if (cutscenePlayer) {
      cutscenePlayer.seek(0);
      cutscenePlayer.play();
    }
  } else {
    if (subBox) subBox.style.display = 'none';
    if (cutscenePlayer) {
      cutscenePlayer.pause();
    }
  }

  // Update button active state
  document.querySelectorAll('.control-group .btn-row button').forEach((btn, idx) => {
    if (btn.id.startsWith('btn-scene-')) {
      btn.classList.toggle('active', btn.id === `btn-scene-${sceneIdx}`);
    }
  });
}

function triggerTransition(targetScene: number) {
  if (targetScene === currentSceneIndex) return;

  const select = document.querySelector<HTMLSelectElement>('#select-transition');
  const durationInput = document.querySelector<HTMLInputElement>('#slider-duration');
  const kind = (select?.value || 'wipe') as TransitionKind | 'mask' | 'live';
  const duration = parseFloat(durationInput?.value || '0.8');

  // Trigger sound effect on transition
  if (audioVoicePool) {
    audioVoicePool.play([0, 2, 0], { volume: 0.8, playbackRate: 1.1 });
  }

  if (kind === 'mask') {
    if (maskTransition) {
      try {
        maskTransition.start('wipe', duration);
      } catch (e) {
        console.warn('Mask transition start failed', e);
      }
    }
  } else if (kind === 'live') {
    // Live transition requires two distinct scenes
    console.log('Live crossfade transition triggered');
  } else if (transitions) {
    try {
      transitions.start(kind as TransitionKind, duration);
    } catch (e: any) {
      console.warn('Transitions start failed', e);
    }
  }

  updateSceneVisibility(targetScene);
}

function cycleScene() {
  const next = currentSceneIndex === 3 ? 1 : currentSceneIndex + 1;
  triggerTransition(next);
}

function setupHUDControls() {
  document.querySelector('#btn-scene-1')?.addEventListener('click', () => triggerTransition(1));
  document.querySelector('#btn-scene-2')?.addEventListener('click', () => triggerTransition(2));
  document.querySelector('#btn-scene-3')?.addEventListener('click', () => triggerTransition(3));

  document.querySelector('#btn-trigger-transition')?.addEventListener('click', () => {
    cycleScene();
  });

  const durationSlider = document.querySelector<HTMLInputElement>('#slider-duration');
  durationSlider?.addEventListener('input', () => {
    const val = document.querySelector<HTMLElement>('#val-duration');
    if (val) val.textContent = `${durationSlider.value} s`;
  });

  const volumeSlider = document.querySelector<HTMLInputElement>('#slider-volume');
  volumeSlider?.addEventListener('input', () => {
    const vol = parseFloat(volumeSlider.value);
    const val = document.querySelector<HTMLElement>('#val-volume');
    if (val) val.textContent = `${Math.round(vol * 100)}%`;
    if (audioListener) audioListener.volume = vol;
  });

  document.querySelector('#btn-shake')?.addEventListener('click', () => {
    if (cinematicRig) cinematicRig.shake(0.35, 0.45);
  });

  document.querySelector('#btn-audio-pool')?.addEventListener('click', () => {
    if (audioVoicePool) {
      const rx = (Math.random() - 0.5) * 4;
      const ry = 1 + Math.random() * 2;
      const rz = (Math.random() - 0.5) * 4;
      audioVoicePool.play([rx, ry, rz], { volume: 0.7, playbackRate: 0.8 + Math.random() * 0.6 });
    }
  });

  const cutsceneSlider = document.querySelector<HTMLInputElement>('#slider-cutscene');
  cutsceneSlider?.addEventListener('input', () => {
    const t = parseFloat(cutsceneSlider.value);
    const val = document.querySelector<HTMLElement>('#val-cutscene');
    if (val) val.textContent = `${t.toFixed(1)} s`;
    if (cutscenePlayer) {
      cutscenePlayer.seek(t);
    }
  });

  document.querySelector('#btn-cutscene-play')?.addEventListener('click', () => {
    if (cutscenePlayer) {
      if (cutscenePlayer.playing) cutscenePlayer.pause();
      else cutscenePlayer.play();
    }
  });

  document.querySelector('#btn-cutscene-skip')?.addEventListener('click', () => {
    if (cutscenePlayer) {
      cutscenePlayer.skip();
    }
  });

  document.querySelector('#btn-stress')?.addEventListener('click', () => {
    runStressCycle();
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

let stressInterval: number | null = null;
function runStressCycle() {
  if (stressInterval !== null) {
    clearInterval(stressInterval);
    stressInterval = null;
    const btn = document.querySelector<HTMLElement>('#btn-stress');
    if (btn) btn.textContent = 'Stress Rapid Switch';
    return;
  }

  const btn = document.querySelector<HTMLElement>('#btn-stress');
  if (btn) btn.textContent = 'Stop Stress Test';

  let step = 0;
  stressInterval = window.setInterval(() => {
    step++;
    cycleScene();
    if (cinematicRig && step % 3 === 0) cinematicRig.shake(0.4, 0.2);
    if (audioVoicePool && step % 2 === 0) audioVoicePool.play([0, 1, 0], { volume: 0.5 });
    if (step > 30) {
      clearInterval(stressInterval!);
      stressInterval = null;
      if (btn) btn.textContent = 'Stress Rapid Switch';
    }
  }, 180);
}

async function recreateAll() {
  spinnerCube = null;
  spinnerTorus = null;
  billboardText = null;
  frameCounterText = null;
  // The page's tweens animate this scene's meshes; stop them before the meshes go.
  tween.clear();
  if (stage) {
    stage.dispose();
    stage = null;
  }
  transitions = null;
  maskTransition = null;
  ui = null;
  textRenderer = null;
  labelRenderer = null;
  htmlPlugin = null;
  cinematicRig = null;
  audioListener = null;
  audioVoicePool = null;
  _audioAnalyser = null;
  videoPlugin = null;
  cutscenePlayer = null;

  scene1Meshes.length = 0;
  scene2Meshes.length = 0;
  scene3Meshes.length = 0;

  await init();
}

function renderLoop(now: number) {
  const dt = Math.min((now - lastFrameTime) / 1000, 0.1);
  lastFrameTime = now;
  frameCount++;

  // Step tweens and springs
  tween.update(dt);
  spring.update(dt);

  // Smooth damp camera in Scene 1
  if (currentSceneIndex === 1) {
    smoothDamp(dampPos, dampTarget, dampVel, 0.4, 8, dt, dampPos);
  }

  // Animate rotating objects in Scene 1
  if (stage && !stage.engine.disposed && spinnerCube) {
    try {
      spinnerCube.rotation.set(0, now * 0.0015, 0);
      const s = spring.value;
      spinnerCube.scale.set(s, s, s);
    } catch {}
  }
  if (stage && !stage.engine.disposed && spinnerTorus) {
    try {
      spinnerTorus.rotation.set(now * 0.001, now * 0.002, 0);
    } catch {}
  }

  // Step CutscenePlayer in Scene 3
  if (currentSceneIndex === 3 && cutscenePlayer) {
    cutscenePlayer.update(dt);
    const state = cutscenePlayer.state;
    if (state.camera && stage) {
      stage.engine.camera.position = state.camera.position;
      stage.engine.camera.target = state.camera.target;
      stage.engine.camera.fov = state.camera.fov;
    }

    const subBox = document.querySelector<HTMLElement>('#subtitles-box');
    if (subBox) {
      if (state.subtitles && state.subtitles.length > 0) {
        subBox.style.display = 'block';
        subBox.textContent = state.subtitles[0].text;
      } else {
        subBox.style.display = 'none';
      }
    }

    const cutsceneSlider = document.querySelector<HTMLInputElement>('#slider-cutscene');
    if (cutsceneSlider) cutsceneSlider.value = String(cutscenePlayer.time);
    const val = document.querySelector<HTMLElement>('#val-cutscene');
    if (val) val.textContent = `${cutscenePlayer.time.toFixed(1)} s`;
  }

  // Update animated SDF text
  if (frameCounterText) {
    frameCounterText.text = `Frame: ${frameCount} | Spring: ${spring.value.toFixed(2)}`;
  }

  // Sample video audio frequencies if available
  if (videoPlugin) {
    try {
      videoPlugin.sampleFrequency();
    } catch (_e) {
      // ignore
    }
  }

  // Render stage
  if (stage) {
    stage.engine.render();
  }

  // Calculate FPS & Frame time
  if (now - lastFpsTime >= 500) {
    currentFps = Math.round((frameCount * 1000) / (now - lastFpsTime));
    currentFrameDuration = (now - lastFpsTime) / frameCount;
    frameCount = 0;
    lastFpsTime = now;

    const fpsEl = document.querySelector<HTMLElement>('#stat-fps');
    const msEl = document.querySelector<HTMLElement>('#stat-ms');
    const memEl = document.querySelector<HTMLElement>('#stat-mem');
    if (fpsEl) fpsEl.textContent = String(currentFps);
    if (msEl) msEl.textContent = `${currentFrameDuration.toFixed(1)} ms`;
    if (memEl && (performance as any).memory) {
      const mb = Math.round((performance as any).memory.usedJSHeapSize / (1024 * 1024));
      memEl.textContent = `${mb} MB`;
    }
  }

  requestAnimationFrame(renderLoop);
}

// Global hook for automated test harness
(window as any).runStressTest = async function () {
  console.log('[Test Harness] Running Scene Transitions & UI Stress Test...');
  const results: any = {
    backend: useWebGL2 ? 'webgl2' : 'webgpu',
    transitionsAttached: !!transitions,
    uiAttached: !!ui,
    textAttached: !!textRenderer,
    labelsAttached: !!labelRenderer,
    htmlAttached: !!htmlPlugin,
    cinematicAttached: !!cinematicRig,
    audioAttached: !!audioListener,
    videoAttached: !!videoPlugin,
    cutsceneAttached: !!cutscenePlayer,
    errors: [],
  };

  // 1. Cycle scenes rapidly
  for (let i = 1; i <= 3; i++) {
    triggerTransition(i);
    await new Promise((r) => setTimeout(r, 150));
  }

  // 2. Stress camera shake & voice pool
  if (cinematicRig) cinematicRig.shake(0.5, 0.4);
  if (audioVoicePool) audioVoicePool.play([1, 2, 1], { volume: 0.8 });
  await new Promise((r) => setTimeout(r, 200));

  // 3. Move sliders & scrub cutscene
  if (cutscenePlayer) {
    cutscenePlayer.seek(2.5);
    cutscenePlayer.update(0.1);
  }

  // 4. Test mobile resize
  const viewport = document.querySelector<HTMLElement>('#viewport');
  if (viewport) {
    viewport.style.width = '390px';
    viewport.style.height = '844px';
    await new Promise((r) => setTimeout(r, 150));
    viewport.style.width = '100%';
    viewport.style.height = '100%';
  }

  // 5. Test Dispose & Recreate
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
